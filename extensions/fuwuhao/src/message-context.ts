import type { FuwuhaoMessage } from "./types.js";
import { getWecomRuntime } from "./runtime.js";

// ============================================
// 消息上下文构建
// ============================================

/**
 * 消息上下文返回类型
 */
export interface MessageContext {
  ctx: Record<string, unknown>;
  route: {
    sessionKey: string;
    agentId: string;
    accountId: string;
  };
  storePath: string;
}

/**
 * 构建消息上下文（类似 LINE 的 ctxPayload）
 */
export const buildMessageContext = (message: FuwuhaoMessage): MessageContext => {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  
  const userId = message.FromUserName || message.userid || "unknown";
  const toUser = message.ToUserName || "unknown";
  // 要保证唯一
  const messageId = message.MsgId || message.msgid || `${Date.now()}`;
  // todo 放开这里
  // const timestamp = message.CreateTime ? message.CreateTime * 1000 : Date.now();
  const timestamp = Date.now();
  const content = message.Content || message.text?.content || "";
  
  // 使用 runtime 解析路由
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: "fuwuhao",
    accountId: "default",
    peer: {
      kind: "dm",
      id: userId,
    },
  });
  
  // 获取格式化选项
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  
  // 获取会话存储路径
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  
  // 读取上次会话时间
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  
  // 格式化入站消息
  const body = runtime.channel.reply.formatInboundEnvelope({
    channel: "fuwuhao",
    from: userId,
    timestamp,
    body: content,
    chatType: "direct",
    sender: {
      id: userId,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });
  
  // 使用 finalizeInboundContext 构建完整上下文
  const ctx = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: content,
    CommandBody: content,
    From: `fuwuhao:${userId}`,
    To: `fuwuhao:${toUser}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct" as const,
    ConversationLabel: userId,
    SenderId: userId,
    Provider: "fuwuhao",
    Surface: "fuwuhao",
    MessageSid: messageId,
    Timestamp: timestamp,
    OriginatingChannel: "fuwuhao" as const,
    OriginatingTo: `fuwuhao:${userId}`,
  });
  
  return { ctx, route, storePath };
};
