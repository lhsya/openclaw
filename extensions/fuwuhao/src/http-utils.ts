import type { IncomingMessage } from "node:http";

// ============================================
// HTTP 工具方法
// ============================================

/**
 * 解析查询参数
 */
export const parseQuery = (req: IncomingMessage): URLSearchParams => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  return url.searchParams;
};

/**
 * 读取请求体
 */
export const readBody = async (req: IncomingMessage): Promise<string> => {
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

/**
 * 检查是否是 fuwuhao webhook 路径
 */
export const isFuwuhaoWebhookPath = (url: string): boolean => {
  const pathname = new URL(url, "http://localhost").pathname;
  // 支持多种路径格式
  return pathname === "/fuwuhao" || 
         pathname === "/fuwuhao/webhook" ||
         pathname.startsWith("/fuwuhao/");
};
