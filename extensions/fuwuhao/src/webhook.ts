import type { IncomingMessage, ServerResponse } from "node:http";
import { getWecomRuntime } from "./runtime.js";

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
  const timestamp = message.CreateTime ? message.CreateTime * 1000 : Date.now();
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

// 处理消息并转发给 Agent
const handleMessage = async (message: FuwuhaoMessage): Promise<string | null> => {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  
  const content = message.Content || message.text?.content || "";
  const userId = message.FromUserName || message.userid || "unknown";
  
  console.log("[fuwuhao] 收到消息:", {
    类型: message.msgtype || "text",
    消息ID: message.MsgId || message.msgid,
    内容: content,
    用户ID: userId,
    时间戳: message.CreateTime
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
  }).catch((err) => {
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
        deliver: async (payload) => {
          // 收集 Agent 的回复
          if (payload.text) {
            responseText = payload.text;
            console.log("[fuwuhao] Agent 回复:", payload.text.slice(0, 200) + (payload.text.length > 200 ? "..." : ""));
          }
          
          // 记录出站活动
          runtime.channel.activity.record({
            channel: "fuwuhao",
            accountId: "default",
            direction: "outbound",
          });
        },
        onError: (err, info) => {
          console.error(`[fuwuhao] ${info.kind} 回复失败:`, err);
        },
      },
      replyOptions: {},
    });
    
    if (!queuedFinal) {
      console.log("[fuwuhao] Agent 没有生成回复");
    }
    
    return responseText;
  } catch (err) {
    console.error("[fuwuhao] 消息分发失败:", err);
    return null;
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
        // 实际项目中需要解析 XML
        console.log("[fuwuhao] 收到非JSON格式数据，尝试简单解析");
        message = {
          msgtype: "text",
          Content: body,
          FromUserName: "unknown",
          MsgId: `${Date.now()}`
        };
      }

      // 处理消息并获取回复
      const reply = await handleMessage(message);

      // 返回响应
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
