import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { handleSimpleWecomWebhook } from "./src/webhook.js";
import { setWecomRuntime } from "./src/runtime.js";

// 类型定义
type NormalizedChatType = "direct" | "group" | "channel";
// 模拟发送消息
// curl -X POST "http://127.0.0.1:19001/fuwuhao?timestamp=1234567890&nonce=abc123&msg_signature=test_sig" \
//   -H "Content-Type: application/json" \
//   -d '{"encrypt": "test_encrypted_content"}'
// 渠道元数据
const meta = {
  id: "fuwuhao",
  label: "服务号",
  selectionLabel: "微信服务号",
  detailLabel: "微信服务号 Bot",
  docsPath: "/channels/fuwuhao",
  docsLabel: "fuwuhao",
  blurb: "微信服务号智能机器人（API 模式）通过加密 Webhook 接收消息。",
  systemImage: "message.fill",
  order: 85,
};

// 渠道插件
const fuwuhaoPlugin = {
  id: "fuwuhao",
  meta,
  
  // 配置 schema
  config: {
    schema: {},
  },
  
  // 能力声明
  capabilities: {
    chatTypes: ["direct"] as NormalizedChatType[],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  
  // 启动账号时的处理
  startAccount: (params: any) => {
    console.log("启动 服务号 账号:", params.account.accountId);
    return Promise.resolve();
  },
  
  // 停止账号时的处理
  stopAccount: (params: any) => {
    console.log("停止 服务号 账号:", params.account.accountId);
    return Promise.resolve();
  }
};

const index = {
  id: "fuwuhao",
  name: "微信服务号",
  description: "微信服务号 Webhook 接收消息插件",
  configSchema: emptyPluginConfigSchema(),
  
  /**
   * 插件注册入口点
   */
  register(api: OpenClawPluginApi) {
    // 1. 设置运行时环境
    setWecomRuntime(api.runtime);
    
    // 2. 注册渠道插件
    // 使用 as any 绕过严格类型检查（简化版插件不需要完整的 config 适配器）
    api.registerChannel({ plugin: fuwuhaoPlugin as any });
    
    // 3. 注册 HTTP 处理器
    api.registerHttpHandler(handleSimpleWecomWebhook);
    
    console.log("微信服务号插件已注册");
  },
};

export default index;