import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { FuwuhaoWebSocketClient, handlePrompt, handleCancel } from "./websocket";
// import { handleSimpleWecomWebhook } from "./http/webhook.js";
import { setWecomRuntime } from "./common/runtime";

// 类型定义
type NormalizedChatType = "direct" | "group" | "channel";

// WebSocket 客户端实例
let wsClient: FuwuhaoWebSocketClient | null = null;

// WebSocket 配置（从环境变量读取）
const WS_CONFIG = {
  url: "",
  token: "",
  guid: "",
  userId: "",
  reconnectInterval: 3000,
  maxReconnectAttempts: 0,
  heartbeatInterval: 20000,
};
// 渠道元数据
const meta = {
  id: "tencent-access",
  label: "腾讯通路",
  /** 选择时的显示文本 */
  selectionLabel: "腾讯通路",
  detailLabel: "腾讯通路",
  /** 文档路径 */
  docsPath: "/channels/tencent-access",
  docsLabel: "tencent-access",
  /** 简介 */
  blurb: "通用通路",
  /** 图标 */
  systemImage: "message.fill",
  /** 排序权重 */
  order: 85,
};

// 渠道插件
const tencentAccessPlugin = {
  id: "tencent-access",
  meta,
  
  // 能力声明
  capabilities: {
    chatTypes: ["direct"] as NormalizedChatType[],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  
  // 配置适配器（必需）
  // listAccountIds 和 resolveAccount 是 channel plugin 的必需方法
  // 缺少这两个方法会导致 health check 报错和 Agent 路由失败
  config: {
    listAccountIds: (cfg: any) => {
      const accounts = cfg.channels?.["tencent-access"]?.accounts;
      if (accounts && typeof accounts === "object") {
        return Object.keys(accounts);
      }
      // 没有配置账号时，返回默认账号
      return ["default"];
    },
    resolveAccount: (cfg: any, accountId: string) => {
      const accounts = cfg.channels?.["tencent-access"]?.accounts;
      const account = accounts?.[accountId ?? "default"];
      return account ?? { accountId: accountId ?? "default" };
    },
  },
  
  // 出站适配器（必需）
  // 微信服务号是 webhook 模式，不需要主动发送消息
  // 但 deliveryMode 必须声明
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async () => ({ ok: true }),
  },
};

const index = {
  id: "tencent-access",
  name: "通用通路插件",
  description: "腾讯通用通路插件",
  configSchema: emptyPluginConfigSchema(),
  
  /**
   * 插件注册入口点
   */
  register(api: OpenClawPluginApi) {
    // 1. 设置运行时环境
    setWecomRuntime(api.runtime);
    
    // 2. 注册渠道插件
    // 使用 as any 绕过严格类型检查（简化版插件不需要完整的 config 适配器）
    api.registerChannel({ plugin: tencentAccessPlugin as any });
    
    // 3. 从配置中读取 token 和 wsUrl，写入 WS_CONFIG
    const tencentAccessConfig = (api.config as any)?.channels?.["tencent-access"];
    if (tencentAccessConfig?.token) {
      WS_CONFIG.token = String(tencentAccessConfig.token);
    }
    if (tencentAccessConfig?.wsUrl) {
      WS_CONFIG.url = String(tencentAccessConfig.wsUrl);
    }
    // 4. 注册 HTTP 处理器
    // api.registerHttpHandler(handleSimpleWecomWebhook);
    // 4. 初始化并启动 WebSocket 客户端
    wsClient = new FuwuhaoWebSocketClient(WS_CONFIG, {
      onConnected: () => {
        console.log("[tencent-access] WebSocket 连接成功");
      },
      onDisconnected: (reason) => {
        console.log(`[tencent-access] WebSocket 连接断开: ${reason}`);
      },
      onPrompt: (message) => {
        // 异步处理，不阻塞 WebSocket 消息循环
        void handlePrompt(message, wsClient!).catch((err) => {
          console.error("[tencent-access] 处理 prompt 失败:", err);
        });
      },
      onCancel: (message) => {
        handleCancel(message, wsClient!);
      },
      onError: (error) => {
        console.error("[tencent-access] WebSocket 错误:", error.message);
      },
    });
    wsClient.start();

    console.log("[tencent-access] 微信服务号插件已注册");
  },
};

export default index;