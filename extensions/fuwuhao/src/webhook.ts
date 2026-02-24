import type { IncomingMessage, ServerResponse } from "node:http";
import { getWecomRuntime } from "./runtime.js";

// AgentEventPayload 类型定义（与 src/infra/agent-events.ts 保持一致）
type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

// 简化的消息类型定义
interface FuwuhaoMessage {
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

// 简化的账号配置
interface SimpleAccount {
  token: string;
  encodingAESKey: string;
  receiveId: string;
}

// 模拟账号存储
const mockAccount: SimpleAccount = {
  token: "your_token_here",
  encodingAESKey: "your_encoding_aes_key_here", 
  receiveId: "your_receive_id_here"
};

// 简化的签名验证（实际项目中需要真实实现）
const verifySignature = (params: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
  signature: string;
}): boolean => {
  // 这里应该实现真实的签名验证逻辑
  // 为了 demo 简化，直接返回 true
  console.log("[fuwuhao] 验证签名参数:", params);
  return true;
};

// 简化的解密函数（实际项目中需要真实实现）
const decryptMessage = (params: {
  encodingAESKey: string;
  receiveId: string;
  encrypt: string;
}): string => {
  // 这里应该实现真实的解密逻辑
  // 为了 demo 简化，直接返回模拟的解密结果
  console.log("[fuwuhao] 解密参数:", params);
  return '{"msgtype":"text","Content":"Hello from 服务号","MsgId":"123456","FromUserName":"user001","ToUserName":"gh_test","CreateTime":1234567890}';
};

// 解析查询参数
const parseQuery = (req: IncomingMessage): URLSearchParams => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  return url.searchParams;
};

// 读取请求体
const readBody = async (req: IncomingMessage): Promise<string> => {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", reject);
  });
};

// 构建消息上下文（类似 LINE 的 ctxPayload）
const buildMessageContext = (message: FuwuhaoMessage) => {
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

// ============================================
// 后置回调服务配置（Demo）
// ============================================
interface CallbackPayload {
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

// 后置回调服务 URL（可配置）
const CALLBACK_SERVICE_URL = process.env.FUWUHAO_CALLBACK_URL || "http://localhost:3001/api/fuwuhao/callback";

// 发送结果到后置服务
const sendToCallbackService = async (payload: CallbackPayload): Promise<void> => {
  try {
    console.log("[fuwuhao] 发送后置回调:", {
      url: CALLBACK_SERVICE_URL,
      userId: payload.userId,
      hasReply: !!payload.aiReply,
    });

    const response = await fetch(CALLBACK_SERVICE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 可以添加认证头
        // "Authorization": `Bearer ${process.env.CALLBACK_AUTH_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("[fuwuhao] 后置回调服务返回错误:", {
        status: response.status,
        statusText: response.statusText,
      });
      return;
    }

    const result = await response.json().catch(() => ({}));
    console.log("[fuwuhao] 后置回调成功:", result);
  } catch (err) {
    // 后置回调失败不影响主流程，只记录日志
    console.error("[fuwuhao] 后置回调失败:", err);
  }
};

// 处理消息并转发给 Agent
const handleMessage = async (message: FuwuhaoMessage): Promise<string | null> => {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  
  const content = message.Content || message.text?.content || "";
  const userId = message.FromUserName || message.userid || "unknown";
  const messageId = String(message.MsgId || message.msgid || Date.now());
  const messageType = message.msgtype || "text";
  const timestamp = message.CreateTime || Date.now();
  
  console.log("[fuwuhao] 收到消息:", {
    类型: messageType,
    消息ID: messageId,
    内容: content,
    用户ID: userId,
    时间戳: timestamp
  });

  // 构建消息上下文
  const { ctx, route, storePath } = buildMessageContext(message);
  
  console.log("[fuwuhao] 路由信息:", {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    accountId: route.accountId,
  });
  
  // 记录会话元数据
  void runtime.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctx.SessionKey ?? route.sessionKey,
    ctx,
  }).catch((err: unknown) => {
    console.log(`[fuwuhao] 记录会话元数据失败: ${String(err)}`);
  });
  
  // 记录频道活动
  runtime.channel.activity.record({
    channel: "fuwuhao",
    accountId: "default",
    direction: "inbound",
  });
  
  // 调用 OpenClaw 的消息分发系统
  try {
    let responseText: string | null = null;
    
    // 获取响应前缀配置
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);
    
    console.log("[fuwuhao] 开始调用 Agent...");
    
    const { queuedFinal } = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (
          payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean; channelData?: unknown },
          info: { kind: string }
        ) => {
          console.log(`[fuwuhao] Agent ${info.kind} 回复:`, payload, info);

          if (info.kind === "tool") {
            // 工具调用结果（如 write、read_file 等），仅记录日志
            console.log("[fuwuhao] 工具调用结果:", payload);
          } else if (info.kind === "block") {
            // 流式分块回复，累积文本
            if (payload.text) {
              responseText = payload.text;
            }
          } else if (info.kind === "final") {
            // 最终完整回复
            if (payload.text) {
              responseText = payload.text;
            }
            console.log("[fuwuhao] 最终回复:", payload);
          }

          // 记录出站活动
          runtime.channel.activity.record({
            channel: "fuwuhao",
            accountId: "default",
            direction: "outbound",
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[fuwuhao] ${info.kind} 回复失败:`, err);
        },
      },
      replyOptions: {},
    });
    
    if (!queuedFinal) {
      console.log("[fuwuhao] Agent 没有生成回复");
    }
    
      // ============================================
    // 后置处理：将结果发送到回调服务
    // ============================================
    const callbackPayload: CallbackPayload = {
      userId,
      messageId,
      messageType,
      userMessage: content,
      aiReply: responseText,
      timestamp,
      sessionKey: route.sessionKey,
      success: true,
    };
    
    // 异步发送，不阻塞返回
    // void sendToCallbackService(callbackPayload);
    
    return responseText;
  } catch (err) {
    console.error("[fuwuhao] 消息分发失败:", err);
    
    // 即使失败也发送回调（带错误信息）
    const callbackPayload: CallbackPayload = {
      userId,
      messageId,
      messageType,
      userMessage: content,
      aiReply: null,
      timestamp,
      sessionKey: route.sessionKey,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
    
    // void sendToCallbackService(callbackPayload);
    
    return null;
  }
};

// ============================================
// 流式消息处理（SSE 支持）
// ============================================
interface StreamChunk {
  type: "block" | "tool" | "tool_start" | "tool_update" | "tool_result" | "final" | "error" | "done";
  text?: string;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: Record<string, unknown>;
  toolMeta?: Record<string, unknown>;
  isError?: boolean;
  timestamp: number;
}

type StreamCallback = (chunk: StreamChunk) => void;

// 处理消息并流式返回结果
const handleMessageStream = async (
  message: FuwuhaoMessage,
  onChunk: StreamCallback
): Promise<void> => {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  
  const content = message.Content || message.text?.content || "";
  const userId = message.FromUserName || message.userid || "unknown";
  const messageId = String(message.MsgId || message.msgid || Date.now());
  const messageType = message.msgtype || "text";

  console.log("[fuwuhao] 流式处理消息:", {
    类型: messageType,
    消息ID: messageId,
    内容: content,
    用户ID: userId,
  });

  // 构建消息上下文
  const { ctx, route, storePath } = buildMessageContext(message);
  
  // 记录会话元数据
  void runtime.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctx.SessionKey ?? route.sessionKey,
    ctx,
  }).catch((err: unknown) => {
    console.log(`[fuwuhao] 记录会话元数据失败: ${String(err)}`);
  });
  
  // 记录频道活动
  runtime.channel.activity.record({
    channel: "fuwuhao",
    accountId: "default",
    direction: "inbound",
  });
  
  // 订阅全局 Agent 事件，捕获流式文本和工具调用信息
  console.log("[fuwuhao] 注册 onAgentEvent 监听器...");
  let lastEmittedText = ""; // 用于去重，只发送增量文本
  
  const unsubscribeAgentEvents = runtime.events.onAgentEvent((evt: AgentEventPayload) => {
    // 记录所有事件（调试用）
    console.log(`[fuwuhao] 收到 AgentEvent: stream=${evt.stream}, runId=${evt.runId}`);
    
    const data = evt.data as Record<string, unknown>;
    
    // ============================================
    // 处理流式文本（assistant 流）
    // ============================================
    if (evt.stream === "assistant") {
      const delta = data.delta as string | undefined;
      const text = data.text as string | undefined;
      
      // 优先使用 delta（增量文本），如果没有则计算增量
      let textToSend = delta;
      if (!textToSend && text && text !== lastEmittedText) {
        textToSend = text.slice(lastEmittedText.length);
        lastEmittedText = text;
      } else if (delta) {
        lastEmittedText += delta;
      }
      
      if (textToSend) {
        console.log(`[fuwuhao] 流式文本:`, textToSend.slice(0, 50) + (textToSend.length > 50 ? "..." : ""));
        onChunk({
          type: "block",
          text: textToSend,
          timestamp: evt.ts,
        });
      }
      return;
    }
    
    // ============================================
    // 处理工具调用事件（tool 流）
    // ============================================
    if (evt.stream === "tool") {
      const phase = data.phase as string | undefined;
      const toolName = data.name as string | undefined;
      const toolCallId = data.toolCallId as string | undefined;
      
      console.log(`[fuwuhao] 工具事件 [${phase}]:`, toolName, toolCallId);
      
      if (phase === "start") {
        // 工具开始执行
        onChunk({
          type: "tool_start",
          toolName,
          toolCallId,
          toolArgs: data.args as Record<string, unknown> | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      } else if (phase === "update") {
        // 工具执行中间状态更新
        onChunk({
          type: "tool_update",
          toolName,
          toolCallId,
          text: data.text as string | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      } else if (phase === "result") {
        // 工具执行完成
        onChunk({
          type: "tool_result",
          toolName,
          toolCallId,
          text: data.result as string | undefined,
          isError: data.isError as boolean | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      }
      return;
    }
    
    // ============================================
    // 处理生命周期事件（lifecycle 流）
    // ============================================
    if (evt.stream === "lifecycle") {
      const phase = data.phase as string | undefined;
      console.log(`[fuwuhao] 生命周期事件 [${phase}]`);
      // 可以在这里处理 start/end/error 事件，例如：
      // if (phase === "error") { onChunk({ type: "error", text: data.error as string, timestamp: evt.ts }); }
    }
  });
  
  try {
    // 获取响应前缀配置
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);
    
    console.log("[fuwuhao] 开始流式调用 Agent...");
    console.log("[fuwuhao] ctx:", JSON.stringify(ctx));
    
    const dispatchResult = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (
          payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean; channelData?: unknown },
          info: { kind: string }
        ) => {
          console.log(`[fuwuhao] 流式 ${info.kind} 回复:`, payload, info);

          if (info.kind === "tool") {
            // 工具调用结果
            onChunk({
              type: "tool",
              text: payload.text,
              isError: payload.isError,
              timestamp: Date.now(),
            });
          } else if (info.kind === "block") {
            // 流式分块回复
            onChunk({
              type: "block",
              text: payload.text,
              timestamp: Date.now(),
            });
          } else if (info.kind === "final") {
            // 最终完整回复
            onChunk({
              type: "final",
              text: payload.text,
              timestamp: Date.now(),
            });
          }

          // 记录出站活动
          runtime.channel.activity.record({
            channel: "fuwuhao",
            accountId: "default",
            direction: "outbound",
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[fuwuhao] 流式 ${info.kind} 回复失败:`, err);
          onChunk({
            type: "error",
            text: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
        },
      },
      replyOptions: {},
    });
    
    console.log("[fuwuhao] dispatchReplyWithBufferedBlockDispatcher 完成, 结果:", dispatchResult);
    
    // 取消订阅 Agent 事件
    unsubscribeAgentEvents();
    
    // 发送完成信号
    onChunk({
      type: "done",
      timestamp: Date.now(),
    });
    
  } catch (err) {
    // 确保在异常时也取消订阅
    unsubscribeAgentEvents();
    console.error("[fuwuhao] 流式消息分发失败:", err);
    onChunk({
      type: "error",
      text: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    });
  }
};

// 检查是否是 fuwuhao webhook 路径
const isFuwuhaoWebhookPath = (url: string): boolean => {
  const pathname = new URL(url, "http://localhost").pathname;
  // 支持多种路径格式
  return pathname === "/fuwuhao" || 
         pathname === "/fuwuhao/webhook" ||
         pathname.startsWith("/fuwuhao/");
};

// 简化的 Webhook 处理器
export const handleSimpleWecomWebhook = async (
  req: IncomingMessage, 
  res: ServerResponse
): Promise<boolean> => {
  // 检查路径是否匹配
  if (!isFuwuhaoWebhookPath(req.url || "")) {
    return false; // 不是我们的路径，交给其他处理器
  }

  console.log(`[fuwuhao] 收到请求: ${req.method} ${req.url}`);

  try {
    const query = parseQuery(req);
    const timestamp = query.get("timestamp") || "";
    const nonce = query.get("nonce") || "";
    const signature = query.get("msg_signature") || query.get("signature") || "";

    // GET 请求 - 验证 URL
    if (req.method === "GET") {
      const echostr = query.get("echostr") || "";
      
      const isValid = verifySignature({
        token: mockAccount.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature
      });

      if (!isValid) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("签名验证失败");
        return true;
      }

      // 解密 echostr 并返回
      try {
        const decrypted = decryptMessage({
          encodingAESKey: mockAccount.encodingAESKey,
          receiveId: mockAccount.receiveId,
          encrypt: echostr
        });
        
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(decrypted);
        return true;
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("解密失败");
        return true;
      }
    }

    // POST 请求 - 处理消息
    if (req.method === "POST") {
      const body = await readBody(req);
      
      let message: FuwuhaoMessage;
      
      // 尝试解析 JSON 格式
      try {
        const data = JSON.parse(body);
        const encrypt = data.encrypt || data.Encrypt || "";
        
        if (encrypt) {
          // 加密消息，需要解密
          const isValid = verifySignature({
            token: mockAccount.token,
            timestamp,
            nonce,
            encrypt,
            signature
          });

          if (!isValid) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("签名验证失败");
            return true;
          }

          const decrypted = decryptMessage({
            encodingAESKey: mockAccount.encodingAESKey,
            receiveId: mockAccount.receiveId,
            encrypt
          });
          message = JSON.parse(decrypted);
        } else {
          // 直接是明文 JSON（用于测试）
          message = data;
        }
      } catch {
        // 可能是 XML 格式，简单处理
        console.log("[fuwuhao] 收到非JSON格式数据，尝试简单解析");
        message = {
          msgtype: "text",
          Content: body,
          FromUserName: "unknown",
          MsgId: `${Date.now()}`
        };
      }

      // ============================================
      // 检查是否请求流式返回（SSE）
      // ============================================
      const acceptHeader = req.headers.accept || "";
      const wantsStream = acceptHeader.includes("text/event-stream") || 
                          query.get("stream") === "true" ||
                          query.get("stream") === "1";
      console.log('adam-sssss-markoint===wantsStreamwantsStreamwantsStream', wantsStream)
      if (wantsStream) {
        // 流式返回（Server-Sent Events）
        console.log("[fuwuhao] 使用流式返回模式 (SSE)");
        
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // 禁用 nginx 缓冲
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.flushHeaders(); // 立即发送 headers
        
        // 发送初始连接确认
        const connectedEvent = `data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`;
        console.log("[fuwuhao] SSE 发送连接确认:", connectedEvent.trim());
        res.write(connectedEvent);
        
        try {
          await handleMessageStream(message, (chunk) => {
            // 发送 SSE 格式的数据
            const sseData = `data: ${JSON.stringify(chunk)}\n\n`;
            console.log("[fuwuhao] SSE 发送数据:", chunk.type, chunk.text?.slice(0, 50));
            res.write(sseData);
            
            // 如果是完成或错误，关闭连接
            if (chunk.type === "done" || chunk.type === "error") {
              console.log("[fuwuhao] SSE 连接关闭:", chunk.type);
              res.end();
            }
          });
        } catch (streamErr) {
          console.error("[fuwuhao] SSE 流式处理异常:", streamErr);
          const errorData = `data: ${JSON.stringify({ type: "error", text: String(streamErr), timestamp: Date.now() })}\n\n`;
          res.write(errorData);
          res.end();
        }
        
        return true;
      }

      // ============================================
      // 普通同步返回
      // ============================================
      const reply = await handleMessage(message);

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ 
        success: true,
        reply: reply || "消息已接收，正在处理中..."
      }));
      return true;
    }

    return false;
  } catch (error) {
    console.error("[fuwuhao] Webhook 处理异常:", error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("服务器内部错误");
    return true;
  }
};