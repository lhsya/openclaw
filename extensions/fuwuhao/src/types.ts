// ============================================
// Agent 事件类型
// ============================================
export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

// ============================================
// 消息类型
// ============================================
export interface FuwuhaoMessage {
  msgtype?: string;
  msgid?: string;
  MsgId?: string;
  text?: {
    content?: string;
  };
  Content?: string;
  chattype?: string;
  chatid?: string;
  userid?: string;
  FromUserName?: string;
  ToUserName?: string;
  CreateTime?: number;
}

// ============================================
// 账号配置类型
// ============================================
export interface SimpleAccount {
  token: string;
  encodingAESKey: string;
  receiveId: string;
}

// ============================================
// 回调相关类型
// ============================================
export interface CallbackPayload {
  // 用户信息
  userId: string;
  // 消息信息
  messageId: string;
  messageType: string;
  // 用户发送的原始内容
  userMessage: string;
  // AI 回复的内容
  aiReply: string | null;
  // 时间戳
  timestamp: number;
  // 会话信息
  sessionKey: string;
  // 是否成功
  success: boolean;
  // 错误信息（如果有）
  error?: string;
}

// ============================================
// 流式消息类型
// ============================================
export interface StreamChunk {
  type: "block" | "tool" | "tool_start" | "tool_update" | "tool_result" | "final" | "error" | "done";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  toolMeta?: Record<string, unknown>;
  isError?: boolean;
  timestamp: number;
}

export type StreamCallback = (chunk: StreamChunk) => void;
