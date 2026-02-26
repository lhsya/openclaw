// ============================================
// AGP (Agent Gateway Protocol) 类型定义
// ============================================
// 基于 websocket.md 协议文档定义

// ============================================
// AGP 消息信封
// ============================================
/**
 * AGP 统一消息信封
 * 所有 WebSocket 消息（上行和下行）均使用此格式
 */
export interface AGPEnvelope<T = unknown> {
  /** 全局唯一消息 ID（UUID），用于幂等去重 */
  msg_id: string;
  /** 设备 GUID */
  guid: string;
  /** 用户账户 ID */
  user_id: string;
  /** 消息类型 */
  method: AGPMethod;
  /** 消息载荷 */
  payload: T;
}

// ============================================
// Method 枚举
// ============================================
/**
 * AGP 消息方法枚举
 * - session.prompt: 下发用户指令（服务端 → 客户端）
 * - session.cancel: 取消 Prompt Turn（服务端 → 客户端）
 * - session.update: 流式中间更新（客户端 → 服务端）
 * - session.promptResponse: 最终结果（客户端 → 服务端）
 */
export type AGPMethod =
  | "session.prompt"
  | "session.cancel"
  | "session.update"
  | "session.promptResponse"
  | "ping";

// ============================================
// 通用数据结构
// ============================================

/**
 * 内容块
 * 当前仅支持 text 类型
 */
export interface ContentBlock {
  type: "text";
  text: string;
}

/**
 * 工具调用状态枚举
 */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * 工具调用类型枚举
 */
export type ToolCallKind = "read" | "edit" | "delete" | "execute" | "search" | "fetch" | "think" | "other";

/**
 * 工具操作路径
 */
export interface ToolLocation {
  path: string;
}

/**
 * 工具调用
 */
export interface ToolCall {
  /** 工具调用唯一 ID */
  tool_call_id: string;
  /** 工具调用标题（展示用） */
  title?: string;
  /** 工具类型 */
  kind?: ToolCallKind;
  /** 工具调用状态 */
  status: ToolCallStatus;
  /** 工具调用结果内容 */
  content?: ContentBlock[];
  /** 工具操作路径 */
  locations?: ToolLocation[];
}

// ============================================
// 下行消息（服务端 → 客户端）
// ============================================

/**
 * session.prompt 载荷 — 下发用户指令
 */
export interface PromptPayload {
  /** 所属 Session ID */
  session_id: string;
  /** 本次 Turn 唯一 ID */
  prompt_id: string;
  /** 目标 AI 应用标识 */
  agent_app: string;
  /** 用户指令内容（数组） */
  content: ContentBlock[];
}

/**
 * session.cancel 载荷 — 取消 Prompt Turn
 */
export interface CancelPayload {
  /** 所属 Session ID */
  session_id: string;
  /** 要取消的 Turn ID */
  prompt_id: string;
  /** 目标 AI 应用标识 */
  agent_app: string;
}

// ============================================
// 上行消息（客户端 → 服务端）
// ============================================

/**
 * session.update 的更新类型
 * - message_chunk: 增量文本/内容（Agent 消息片段）
 * - tool_call: AI 正在调用工具
 * - tool_call_update: 工具执行状态变更
 */
export type UpdateType = "message_chunk" | "tool_call" | "tool_call_update";

/**
 * session.update 载荷 — 流式中间更新
 */
export interface UpdatePayload {
  /** 所属 Session ID */
  session_id: string;
  /** 所属 Turn ID */
  prompt_id: string;
  /** 更新类型 */
  update_type: UpdateType;
  /** update_type=message_chunk 时使用，单个对象（非数组） */
  content?: ContentBlock;
  /** update_type=tool_call 或 tool_call_update 时使用 */
  tool_call?: ToolCall;
}

/**
 * 停止原因枚举
 * - end_turn: 正常完成
 * - cancelled: 被取消
 * - refusal: AI 应用拒绝执行
 * - error: 技术错误
 */
export type StopReason = "end_turn" | "cancelled" | "refusal" | "error";

/**
 * session.promptResponse 载荷 — 最终结果
 */
export interface PromptResponsePayload {
  /** 所属 Session ID */
  session_id: string;
  /** 所属 Turn ID */
  prompt_id: string;
  /** 停止原因 */
  stop_reason: StopReason;
  /** 最终结果内容（数组） */
  content?: ContentBlock[];
  /** 错误描述（stop_reason 为 error / refusal 时附带） */
  error?: string;
}

// ============================================
// 类型别名（方便使用）
// ============================================

/** 下行：session.prompt 消息 */
export type PromptMessage = AGPEnvelope<PromptPayload>;
/** 下行：session.cancel 消息 */
export type CancelMessage = AGPEnvelope<CancelPayload>;
/** 上行：session.update 消息 */
export type UpdateMessage = AGPEnvelope<UpdatePayload>;
/** 上行：session.promptResponse 消息 */
export type PromptResponseMessage = AGPEnvelope<PromptResponsePayload>;

// ============================================
// WebSocket 客户端配置
// ============================================

/**
 * WebSocket 客户端配置
 */
export interface WebSocketClientConfig {
  /** WebSocket 服务端地址（如 ws://21.0.62.97:8080/） */
  url: string;
  /** 设备唯一标识 */
  guid: string;
  /** 用户账户 ID */
  userId: string;
  /** 鉴权 token（可选，当前未校验） */
  token?: string;
  /** 重连间隔（毫秒），默认 3000 */
  reconnectInterval?: number;
  /** 最大重连次数，0 表示无限重连，默认 0 */
  maxReconnectAttempts?: number;
  /** 心跳间隔（毫秒），默认 240000（4分钟，小于服务端 5 分钟超时） */
  heartbeatInterval?: number;
}

/**
 * WebSocket 连接状态
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * WebSocket 客户端事件回调
 */
export interface WebSocketClientCallbacks {
  /** 连接成功 */
  onConnected?: () => void;
  /** 连接断开 */
  onDisconnected?: (reason?: string) => void;
  /** 收到 session.prompt 消息 */
  onPrompt?: (message: PromptMessage) => void;
  /** 收到 session.cancel 消息 */
  onCancel?: (message: CancelMessage) => void;
  /** 发生错误 */
  onError?: (error: Error) => void;
}
