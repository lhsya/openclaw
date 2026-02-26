import type {
  PromptMessage,
  CancelMessage,
  ContentBlock,
  ToolCall,
} from "./types.js";
import type { AgentEventPayload } from "../http/types.js";
import type { FuwuhaoWebSocketClient } from "./websocket-client.js";
import { getWecomRuntime } from "../common/runtime.js";
import {
  extractTextFromContent,
  buildWebSocketMessageContext,
} from "./message-adapter.js";

// ============================================
// WebSocket 消息处理器
// ============================================
// 接收 AGP 下行消息 → 调用 OpenClaw Agent → 发送 AGP 上行消息

/**
 * 活跃的 Prompt Turn 追踪器
 * 用于管理当前正在处理的请求，支持取消操作
 */
interface ActiveTurn {
  sessionId: string;
  promptId: string;
  /** 是否已被取消 */
  cancelled: boolean;
  /** Agent 事件取消订阅函数 */
  unsubscribe?: () => void;
}

/** 当前活跃的 Turn 映射（promptId → ActiveTurn） */
const activeTurns = new Map<string, ActiveTurn>();

/**
 * 处理 session.prompt 消息 — 接收用户指令并调用 Agent
 * @param message - AGP session.prompt 消息
 * @param client - WebSocket 客户端实例（用于发送上行消息）
 * @description
 * 处理流程：
 * 1. 解析 prompt 载荷，提取用户指令
 * 2. 注册活跃 Turn（支持后续取消）
 * 3. 转换为 OpenClaw 消息上下文
 * 4. 订阅 Agent 事件（流式输出）
 * 5. 调用 Agent 处理消息
 * 6. 通过 WebSocket 实时推送中间结果（session.update）
 * 7. 推送最终结果（session.promptResponse）
 */
export const handlePrompt = async (
  message: PromptMessage,
  client: FuwuhaoWebSocketClient
): Promise<void> => {
  const { payload } = message;
  const { session_id: sessionId, prompt_id: promptId } = payload;
  const userId = message.user_id;

  const textContent = extractTextFromContent(payload.content);
  console.log("[fuwuhao-ws] 收到 prompt:", {
    sessionId,
    promptId,
    userId,
    agentApp: payload.agent_app,
    内容: textContent.slice(0, 100),
  });

  // ============================================
  // 1. 注册活跃 Turn
  // ============================================
  const turn: ActiveTurn = {
    sessionId,
    promptId,
    cancelled: false,
  };
  activeTurns.set(promptId, turn);

  try {
    const runtime = getWecomRuntime();
    const cfg = runtime.config.loadConfig();

    // ============================================
    // 2. 构建消息上下文
    // ============================================
    const { ctx, route, storePath } = buildWebSocketMessageContext(payload, userId);

    console.log("[fuwuhao-ws] 路由信息:", {
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      accountId: route.accountId,
    });

    // ============================================
    // 3. 记录会话元数据
    // ============================================
    void runtime.channel.session
      .recordSessionMetaFromInbound({
        storePath,
        sessionKey: (ctx.SessionKey as string) ?? route.sessionKey,
        ctx,
      })
      .catch((err: unknown) => {
        console.log(`[fuwuhao-ws] 记录会话元数据失败: ${String(err)}`);
      });

    // ============================================
    // 4. 记录入站活动
    // ============================================
    runtime.channel.activity.record({
      channel: "fuwuhao",
      accountId: "default",
      direction: "inbound",
    });

    // ============================================
    // 5. 订阅 Agent 事件（流式输出）
    // ============================================
    let lastEmittedText = "";
    let toolCallCounter = 0;

    const unsubscribe = runtime.events.onAgentEvent((evt: AgentEventPayload) => {
      // 如果 Turn 已被取消，忽略后续事件
      if (turn.cancelled) return;

      const data = evt.data as Record<string, unknown>;

      // --- 处理流式文本（assistant 流）---
      if (evt.stream === "assistant") {
        const delta = data.delta as string | undefined;
        const text = data.text as string | undefined;

        let textToSend = delta;
        if (!textToSend && text && text !== lastEmittedText) {
          textToSend = text.slice(lastEmittedText.length);
          lastEmittedText = text;
        } else if (delta) {
          lastEmittedText += delta;
        }

        if (textToSend) {
          // 发送 session.update（message_chunk）
          client.sendMessageChunk(sessionId, promptId, {
            type: "text",
            text: textToSend,
          });
        }
        return;
      }

      // --- 处理工具调用事件（tool 流）---
      if (evt.stream === "tool") {
        const phase = data.phase as string | undefined;
        const toolName = data.name as string | undefined;
        const toolCallId = (data.toolCallId as string) || `tc-${++toolCallCounter}`;

        if (phase === "start") {
          // 发送 session.update（tool_call）
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            kind: mapToolKind(toolName),
            status: "in_progress",
          };
          client.sendToolCall(sessionId, promptId, toolCall);
        } else if (phase === "update") {
          // 发送 session.update（tool_call_update）
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            status: "in_progress",
            content: data.text
              ? [{ type: "text" as const, text: data.text as string }]
              : undefined,
          };
          client.sendToolCallUpdate(sessionId, promptId, toolCall);
        } else if (phase === "result") {
          // 发送 session.update（tool_call_update，状态为 completed/failed）
          const isError = data.isError as boolean | undefined;
          const toolCall: ToolCall = {
            tool_call_id: toolCallId,
            title: toolName,
            status: isError ? "failed" : "completed",
            content: data.result
              ? [{ type: "text" as const, text: data.result as string }]
              : undefined,
          };
          client.sendToolCallUpdate(sessionId, promptId, toolCall);
        }
        return;
      }
    });

    turn.unsubscribe = unsubscribe;

    // ============================================
    // 6. 调用 Agent 处理消息
    // ============================================
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(
      cfg,
      route.agentId
    );

    let finalText: string | null = null;

    const { queuedFinal } = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (
          payload: {
            text?: string;
            mediaUrl?: string;
            mediaUrls?: string[];
            isError?: boolean;
            channelData?: unknown;
          },
          info: { kind: string }
        ) => {
          if (turn.cancelled) return;

          console.log(`[fuwuhao-ws] Agent ${info.kind} 回复:`, payload.text?.slice(0, 50));

          if (info.kind === "final" && payload.text) {
            finalText = payload.text;
          }

          // 记录出站活动
          runtime.channel.activity.record({
            channel: "fuwuhao",
            accountId: "default",
            direction: "outbound",
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[fuwuhao-ws] Agent ${info.kind} 回复失败:`, err);
        },
      },
      replyOptions: {},
    });

    // ============================================
    // 7. 发送最终结果
    // ============================================
    unsubscribe();
    activeTurns.delete(promptId);

    if (turn.cancelled) {
      // 如果已被取消，发送 cancelled 响应
      client.sendPromptResponse({
        session_id: sessionId,
        prompt_id: promptId,
        stop_reason: "cancelled",
      });
      return;
    }

    const responseContent: ContentBlock[] = finalText
      ? [{ type: "text", text: finalText }]
      : [];

    client.sendPromptResponse({
      session_id: sessionId,
      prompt_id: promptId,
      stop_reason: "end_turn",
      content: responseContent,
    });

    console.log("[fuwuhao-ws] prompt 处理完成:", { promptId, hasReply: !!finalText });
  } catch (err) {
    // ============================================
    // 错误处理
    // ============================================
    console.error("[fuwuhao-ws] prompt 处理失败:", err);

    // 清理活跃 Turn
    const currentTurn = activeTurns.get(promptId);
    currentTurn?.unsubscribe?.();
    activeTurns.delete(promptId);

    // 发送错误响应
    client.sendPromptResponse({
      session_id: sessionId,
      prompt_id: promptId,
      stop_reason: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

/**
 * 处理 session.cancel 消息 — 取消正在处理的 Prompt Turn
 * @param message - AGP session.cancel 消息
 * @param client - WebSocket 客户端实例
 * @description
 * 1. 查找对应的活跃 Turn
 * 2. 标记为已取消
 * 3. 取消 Agent 事件订阅
 * 4. 发送 cancelled 响应
 */
export const handleCancel = (
  message: CancelMessage,
  client: FuwuhaoWebSocketClient
): void => {
  const { session_id: sessionId, prompt_id: promptId } = message.payload;

  console.log("[fuwuhao-ws] 收到 cancel:", { sessionId, promptId });

  const turn = activeTurns.get(promptId);
  if (!turn) {
    console.warn(`[fuwuhao-ws] 未找到活跃 Turn: ${promptId}`);
    // 即使找不到也发送 cancelled 响应
    client.sendPromptResponse({
      session_id: sessionId,
      prompt_id: promptId,
      stop_reason: "cancelled",
    });
    return;
  }

  // 标记取消并清理
  turn.cancelled = true;
  turn.unsubscribe?.();
  activeTurns.delete(promptId);

  // 发送 cancelled 响应
  client.sendPromptResponse({
    session_id: sessionId,
    prompt_id: promptId,
    stop_reason: "cancelled",
  });

  console.log("[fuwuhao-ws] Turn 已取消:", promptId);
};

// ============================================
// 辅助函数
// ============================================

/**
 * 将工具名称映射为 AGP 协议的 ToolCallKind
 */
const mapToolKind = (toolName?: string): ToolCall["kind"] => {
  if (!toolName) return "other";

  const name = toolName.toLowerCase();
  if (name.includes("read") || name.includes("get") || name.includes("view")) return "read";
  if (name.includes("write") || name.includes("edit") || name.includes("replace")) return "edit";
  if (name.includes("delete") || name.includes("remove")) return "delete";
  if (name.includes("search") || name.includes("find") || name.includes("grep")) return "search";
  if (name.includes("fetch") || name.includes("request") || name.includes("http")) return "fetch";
  if (name.includes("think") || name.includes("reason")) return "think";
  if (name.includes("exec") || name.includes("run") || name.includes("terminal")) return "execute";
  return "other";
};
