/**
 * Telegram 通道插件入口文件
 *
 * 这个文件是 OpenClaw 插件系统的入口点，负责：
 * 1. 定义插件的元数据（id、名称、描述）
 * 2. 提供配置 Schema（用于验证插件配置）
 * 3. 注册插件到 OpenClaw 核心系统
 *
 * 插件加载流程：
 * 1. OpenClaw 启动时扫描 extensions/ 目录
 * 2. 读取每个插件的 package.json 中的 openclaw.extensions 字段找到入口文件
 * 3. 调用 register() 方法，传入 OpenClawPluginApi
 * 4. 插件通过 api.registerChannel() 注册自己为消息通道
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { telegramPlugin } from "./src/channel.js";
import { setTelegramRuntime } from "./src/runtime.js";

/**
 * 插件定义对象
 *
 * @property id - 插件唯一标识符，用于配置文件中引用此插件
 * @property name - 插件显示名称，用于 CLI 和 UI 展示
 * @property description - 插件描述，帮助用户了解插件功能
 * @property configSchema - 配置 Schema，定义插件接受的配置项结构
 *                          emptyPluginConfigSchema() 表示此插件不需要额外的插件级配置
 *                          （通道配置在 channels.telegram 下，由 telegramPlugin.configSchema 定义）
 * @property register - 注册函数，OpenClaw 加载插件时调用
 */
const plugin = {
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  configSchema: emptyPluginConfigSchema(),

  /**
   * 插件注册函数
   *
   * @param api - OpenClaw 提供的插件 API，包含：
   *   - api.runtime: 运行时环境，提供日志、配置读写、通道操作等能力
   *   - api.registerChannel(): 注册消息通道插件
   *   - api.registerTool(): 注册 Agent 工具
   *   - api.registerHook(): 注册生命周期钩子
   *   - api.registerHttpHandler(): 注册 HTTP 处理器
   *   - 等等...
   */
  register(api: OpenClawPluginApi) {
    // 保存运行时引用，供插件其他模块使用（如 channel.ts 中的消息发送）
    // 这是一种依赖注入模式，避免在模块间传递 runtime 参数
    setTelegramRuntime(api.runtime);

    // 将 Telegram 通道插件注册到 OpenClaw
    // telegramPlugin 定义了通道的所有适配器：
    // - config: 账号配置管理（增删查改）
    // - outbound: 消息发送（sendText, sendMedia）
    // - gateway: 消息接收（监听 Telegram 更新）
    // - status: 状态检测和健康检查
    // - onboarding: CLI 配置向导
    // - pairing: 用户配对/授权
    // - security: 安全策略
    // - 等等...
    api.registerChannel({ plugin: telegramPlugin });
  },
};

export default plugin;
