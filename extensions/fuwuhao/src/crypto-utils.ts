// ============================================
// 加密解密工具
// ============================================

/**
 * 验证签名参数
 */
export interface VerifySignatureParams {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
  signature: string;
}

/**
 * 解密消息参数
 */
export interface DecryptMessageParams {
  encodingAESKey: string;
  receiveId: string;
  encrypt: string;
}

/**
 * 验证签名（简化版，实际项目中需要真实实现）
 */
export const verifySignature = (params: VerifySignatureParams): boolean => {
  // 这里应该实现真实的签名验证逻辑
  // 为了 demo 简化，直接返回 true
  console.log("[fuwuhao] 验证签名参数:", params);
  return true;
};

/**
 * 解密消息（简化版，实际项目中需要真实实现）
 */
export const decryptMessage = (params: DecryptMessageParams): string => {
  // 这里应该实现真实的解密逻辑
  // 为了 demo 简化，直接返回模拟的解密结果
  console.log("[fuwuhao] 解密参数:", params);
  return '{"msgtype":"text","Content":"Hello from 服务号","MsgId":"123456","FromUserName":"user001","ToUserName":"gh_test","CreateTime":1234567890}';
};
