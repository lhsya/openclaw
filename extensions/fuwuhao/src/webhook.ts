import type { IncomingMessage, ServerResponse } from "node:http";
import type { FuwuhaoMessage, SimpleAccount } from "./types.js";
import { verifySignature, decryptMessage } from "./crypto-utils.js";
import { parseQuery, readBody, isFuwuhaoWebhookPath } from "./http-utils.js";
import { handleMessage, handleMessageStream } from "./message-handler.js";

// ============================================
// 账号配置
// ============================================

// 模拟账号存储
const mockAccount: SimpleAccount = {
  token: "your_token_here",
  encodingAESKey: "your_encoding_aes_key_here", 
  receiveId: "your_receive_id_here"
};

// ============================================
// Webhook 处理器
// ============================================
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