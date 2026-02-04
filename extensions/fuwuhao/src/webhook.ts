import type { IncomingMessage, ServerResponse } from "node:http";
import { getWecomRuntime } from "./runtime.js";

// 简化的消息类型定义
interface SimpleWecomMessage {
  msgtype?: string;
  msgid?: string;
  text?: {
    content?: string;
  };
  chattype?: string;
  chatid?: string;
  userid?: string;
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
  console.log("验证签名参数:", params);
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
  console.log("解密参数:", params);
  return '{"msgtype":"text","text":{"content":"Hello from WeCom"},"msgid":"123456","userid":"user001"}';
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

// 处理消息的核心逻辑
const handleMessage = (message: SimpleWecomMessage): void => {
  const runtime = getWecomRuntime();
  
  console.log("收到消息:", {
    类型: message.msgtype,
    消息ID: message.msgid,
    内容: message.text?.content,
    聊天类型: message.chattype,
    聊天ID: message.chatid,
    用户ID: message.userid
  });

  // 这里可以添加您的业务逻辑
  // 例如：调用 AI 模型、存储消息、转发消息等
  
  runtime.log?.(`处理消息: ${message.text?.content || "无文本内容"}`);
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
      } catch (error) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("解密失败");
        return true;
      }
    }

    // POST 请求 - 处理消息
    if (req.method === "POST") {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const encrypt = data.encrypt || data.Encrypt || "";

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

      // 解密消息
      try {
        const decrypted = decryptMessage({
          encodingAESKey: mockAccount.encodingAESKey,
          receiveId: mockAccount.receiveId,
          encrypt
        });

        const message: SimpleWecomMessage = JSON.parse(decrypted);
        
        // 处理消息
        handleMessage(message);

        // 返回成功响应
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ success: true }));
        return true;
      } catch (error) {
        console.error("处理消息失败:", error);
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("处理消息失败");
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("Webhook 处理异常:", error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("服务器内部错误");
    return true;
  }
};