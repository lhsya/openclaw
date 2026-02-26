import { randomUUID } from "node:crypto";
import type {
  AGPEnvelope,
  AGPMethod,
  WebSocketClientConfig,
  ConnectionState,
  WebSocketClientCallbacks,
  PromptMessage,
  CancelMessage,
  UpdatePayload,
  PromptResponsePayload,
  ContentBlock,
  ToolCall,
} from "./types.js";

// ============================================
// WebSocket 客户端核心
// ============================================
// 负责 WebSocket 连接管理、消息收发、自动重连、心跳保活

/**
 * 服务号 WebSocket 客户端
 * @description 
 * 连接到 AGP WebSocket 服务端，处理双向通信：
 * - 接收下行消息：session.prompt / session.cancel
 * - 发送上行消息：session.update / session.promptResponse
 * - 自动重连：连接断开后自动尝试重连
 * - 心跳保活：定期发送 ping 防止空闲超时
 * - 消息去重：通过 msg_id 实现幂等处理
 */
export class FuwuhaoWebSocketClient {
  private config: Required<Omit<WebSocketClientConfig, "token">> & { token?: string };
  private callbacks: WebSocketClientCallbacks;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  /** 已处理的消息 ID 集合（用于去重） */
  private processedMsgIds = new Set<string>();
  /** 消息 ID 过期清理间隔（防止内存泄漏） */
  private msgIdCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** 消息 ID 最大保留数量 */
  private static readonly MAX_MSG_ID_CACHE = 1000;

  constructor(config: WebSocketClientConfig, callbacks: WebSocketClientCallbacks = {}) {
    this.config = {
      url: config.url,
      guid: config.guid,
      userId: config.userId,
      token: config.token,
      reconnectInterval: config.reconnectInterval ?? 3000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 0,
      heartbeatInterval: config.heartbeatInterval ?? 240_000, // 4 分钟
    };
    this.callbacks = callbacks;
  }

  // ============================================
  // 公共方法
  // ============================================

  /**
   * 启动 WebSocket 连接
   */
  start = (): void => {
    if (this.state === "connected" || this.state === "connecting") {
      console.log("[fuwuhao-ws] 已连接或正在连接，跳过");
      return;
    }
    this.connect();
    this.startMsgIdCleanup();
  };

  /**
   * 停止 WebSocket 连接
   */
  stop = (): void => {
    console.log("[fuwuhao-ws] 正在停止...");
    this.state = "disconnected";
    this.clearReconnectTimer();
    this.clearHeartbeat();
    this.clearMsgIdCleanup();
    this.processedMsgIds.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log("[fuwuhao-ws] 已停止");
  };

  /**
   * 获取当前连接状态
   */
  getState = (): ConnectionState => this.state;

  /**
   * 更新事件回调
   */
  setCallbacks = (callbacks: Partial<WebSocketClientCallbacks>): void => {
    this.callbacks = { ...this.callbacks, ...callbacks };
  };

  /**
   * 发送 session.update 消息 — 流式中间更新（文本块）
   */
  sendMessageChunk = (sessionId: string, promptId: string, content: ContentBlock): void => {
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "message_chunk",
      content,
    };
    this.sendEnvelope("session.update", payload);
  };

  /**
   * 发送 session.update 消息 — 工具调用
   */
  sendToolCall = (sessionId: string, promptId: string, toolCall: ToolCall): void => {
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "tool_call",
      tool_call: toolCall,
    };
    this.sendEnvelope("session.update", payload);
  };

  /**
   * 发送 session.update 消息 — 工具调用状态变更
   */
  sendToolCallUpdate = (sessionId: string, promptId: string, toolCall: ToolCall): void => {
    const payload: UpdatePayload = {
      session_id: sessionId,
      prompt_id: promptId,
      update_type: "tool_call_update",
      tool_call: toolCall,
    };
    this.sendEnvelope("session.update", payload);
  };

  /**
   * 发送 session.promptResponse 消息 — 最终结果
   */
  sendPromptResponse = (payload: PromptResponsePayload): void => {
    this.sendEnvelope("session.promptResponse", payload);
  };

  // ============================================
  // 连接管理
  // ============================================

  private connect = (): void => {
    this.state = "connecting";
    const wsUrl = this.buildConnectionUrl();
    console.log(`[fuwuhao-ws] 正在连接: ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);
      this.setupEventHandlers();
    } catch (error) {
      console.error("[fuwuhao-ws] 创建连接失败:", error);
      this.handleConnectionError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /**
   * 构建 WebSocket 连接 URL
   * 格式：ws://host:port/?guid={guid}&user_id={user_id}&token={token}
   */
  private buildConnectionUrl = (): string => {
    const url = new URL(this.config.url);
    url.searchParams.set("guid", this.config.guid);
    url.searchParams.set("user_id", this.config.userId);
    if (this.config.token) {
      url.searchParams.set("token", this.config.token);
    }
    return url.toString();
  };

  /**
   * 设置 WebSocket 事件处理器
   */
  private setupEventHandlers = (): void => {
    if (!this.ws) return;

    this.ws.addEventListener("open", this.handleOpen);
    this.ws.addEventListener("message", this.handleRawMessage);
    this.ws.addEventListener("close", this.handleClose);
    this.ws.addEventListener("error", this.handleError);
  };

  // ============================================
  // 事件处理
  // ============================================

  private handleOpen = (): void => {
    console.log("[fuwuhao-ws] 连接成功");
    this.state = "connected";
    this.reconnectAttempts = 0;
    this.startHeartbeat();
    this.callbacks.onConnected?.();
  };

  private handleRawMessage = (event: MessageEvent): void => {
    try {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      const envelope = JSON.parse(data) as AGPEnvelope;

      // 消息去重
      if (this.processedMsgIds.has(envelope.msg_id)) {
        console.log(`[fuwuhao-ws] 重复消息，跳过: ${envelope.msg_id}`);
        return;
      }
      this.processedMsgIds.add(envelope.msg_id);

      console.log(`[fuwuhao-ws] 收到消息: method=${envelope.method}, msg_id=${envelope.msg_id}`);

      // 根据 method 分发消息
      switch (envelope.method) {
        case "session.prompt":
          this.callbacks.onPrompt?.(envelope as PromptMessage);
          break;
        case "session.cancel":
          this.callbacks.onCancel?.(envelope as CancelMessage);
          break;
        default:
          console.warn(`[fuwuhao-ws] 未知消息类型: ${envelope.method}`);
      }
    } catch (error) {
      console.error("[fuwuhao-ws] 消息解析失败:", error, "原始数据:", event.data);
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(`消息解析失败: ${String(error)}`)
      );
    }
  };

  private handleClose = (event: CloseEvent): void => {
    const reason = event.reason || `code=${event.code}`;
    console.log(`[fuwuhao-ws] 连接关闭: ${reason}`);
    this.clearHeartbeat();
    this.ws = null;

    // 仅在非主动关闭的情况下尝试重连
    if (this.state !== "disconnected") {
      this.callbacks.onDisconnected?.(reason);
      this.scheduleReconnect();
    }
  };

  private handleError = (event: Event): void => {
    const error = new Error(`WebSocket 连接错误`);
    console.error("[fuwuhao-ws] 连接错误:", event);
    this.callbacks.onError?.(error);
  };

  private handleConnectionError = (error: Error): void => {
    this.callbacks.onError?.(error);
    this.scheduleReconnect();
  };

  // ============================================
  // 重连机制
  // ============================================

  private scheduleReconnect = (): void => {
    // 检查是否超过最大重连次数
    if (
      this.config.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.config.maxReconnectAttempts
    ) {
      console.error(`[fuwuhao-ws] 已达最大重连次数 (${this.config.maxReconnectAttempts})，停止重连`);
      this.state = "disconnected";
      return;
    }

    this.state = "reconnecting";
    this.reconnectAttempts++;

    // 使用指数退避策略，最大 30 秒
    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1),
      30_000
    );

    console.log(
      `[fuwuhao-ws] ${delay}ms 后尝试第 ${this.reconnectAttempts} 次重连...`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  };

  private clearReconnectTimer = (): void => {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  };

  // ============================================
  // 心跳保活
  // ============================================

  private startHeartbeat = (): void => {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.state === "connected") {
        // WebSocket 标准 ping（某些环境不支持，降级为空消息）
        try {
          this.ws.send("");
          console.log("[fuwuhao-ws] 💓 心跳发送");
        } catch {
          console.warn("[fuwuhao-ws] 心跳发送失败");
        }
      }
    }, this.config.heartbeatInterval);
  };

  private clearHeartbeat = (): void => {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  };

  // ============================================
  // 消息发送
  // ============================================

  /**
   * 发送 AGP 信封消息
   */
  private sendEnvelope = <T>(method: AGPMethod, payload: T): void => {
    if (!this.ws || this.state !== "connected") {
      console.warn(`[fuwuhao-ws] 无法发送消息，当前状态: ${this.state}`);
      return;
    }

    const envelope: AGPEnvelope<T> = {
      msg_id: randomUUID(),
      guid: this.config.guid,
      user_id: this.config.userId,
      method,
      payload,
    };

    try {
      const data = JSON.stringify(envelope);
      this.ws.send(data);
      console.log(`[fuwuhao-ws] 发送消息: method=${method}, msg_id=${envelope.msg_id}`);
    } catch (error) {
      console.error("[fuwuhao-ws] 消息发送失败:", error);
      this.callbacks.onError?.(
        error instanceof Error ? error : new Error(`消息发送失败: ${String(error)}`)
      );
    }
  };

  // ============================================
  // 消息 ID 缓存清理
  // ============================================

  private startMsgIdCleanup = (): void => {
    this.clearMsgIdCleanup();
    // 每 5 分钟清理一次过期的消息 ID
    this.msgIdCleanupTimer = setInterval(() => {
      if (this.processedMsgIds.size > FuwuhaoWebSocketClient.MAX_MSG_ID_CACHE) {
        console.log(
          `[fuwuhao-ws] 清理消息 ID 缓存: ${this.processedMsgIds.size} → ${FuwuhaoWebSocketClient.MAX_MSG_ID_CACHE / 2}`
        );
        // 保留最新的一半
        const entries = [...this.processedMsgIds];
        this.processedMsgIds.clear();
        entries.slice(-FuwuhaoWebSocketClient.MAX_MSG_ID_CACHE / 2).forEach((id) => {
          this.processedMsgIds.add(id);
        });
      }
    }, 5 * 60 * 1000);
  };

  private clearMsgIdCleanup = (): void => {
    if (this.msgIdCleanupTimer) {
      clearInterval(this.msgIdCleanupTimer);
      this.msgIdCleanupTimer = null;
    }
  };
}
