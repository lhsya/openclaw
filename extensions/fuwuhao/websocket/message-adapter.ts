import type { PromptPayload, ContentBlock } from "./types.js";
import type { FuwuhaoMessage } from "../http/types.js";
import { getWecomRuntime } from "../common/runtime.js";
import { buildMessageContext } from "../http/message-context.js";

// ============================================
// 消息适配器
// ============================================
// 负责 AGP 协议消息与 OpenClaw 内部格式之间的转换

/**
 * 从 ContentBlock 数组中提取纯文本
 * @param content - AGP 协议的内容块数组
 * @returns 合并后的纯文本字符串
 */
export const extractTextFromContent = (content: ContentBlock[]): string => {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
};

/**
 * 将 AGP session.prompt 载荷转换为 FuwuhaoMessage 格式
 * @param payload - AGP 协议的 prompt 载荷
 * @param userId - 用户 ID
 * @returns OpenClaw 内部消息格式
 * @description
 * 将 WebSocket 协议的消息格式转换为与 HTTP 模块兼容的 FuwuhaoMessage
 * 这样可以复用现有的 buildMessageContext 和消息处理逻辑
 */
export const promptPayloadToFuwuhaoMessage = (
  payload: PromptPayload,
  userId: string
): FuwuhaoMessage => {
  const textContent = extractTextFromContent(payload.content);

  return {
    msgtype: "text",
    MsgId: payload.prompt_id,
    Content: textContent,
    FromUserName: userId,
    ToUserName: "fuwuhao_bot",
    CreateTime: Math.floor(Date.now() / 1000),
  };
};

/**
 * 构建 WebSocket 消息的完整上下文
 * @param payload - AGP 协议的 prompt 载荷
 * @param userId - 用户 ID
 * @returns 消息上下文（与 HTTP 模块的 buildMessageContext 返回格式一致）
 * @description
 * 将 AGP 消息转换为 FuwuhaoMessage，然后调用 buildMessageContext 构建标准上下文
 * 确保 WebSocket 通道和 HTTP 通道使用相同的 Agent 路由和会话管理逻辑
 */
export const buildWebSocketMessageContext = (payload: PromptPayload, userId: string) => {
  const message = promptPayloadToFuwuhaoMessage(payload, userId);
  return buildMessageContext(message);
};
