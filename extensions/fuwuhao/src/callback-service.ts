import type { CallbackPayload } from "./types.js";

// ============================================
// 后置回调服务
// ============================================

// 后置回调服务 URL（可配置）
const CALLBACK_SERVICE_URL = process.env.FUWUHAO_CALLBACK_URL || "http://localhost:3001/api/fuwuhao/callback";

/**
 * 发送结果到后置服务
 */
export const sendToCallbackService = async (payload: CallbackPayload): Promise<void> => {
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
