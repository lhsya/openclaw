/**
 * Telegram 通道插件核心实现
 *
 * 本文件定义了 ChannelPlugin 对象，这是 OpenClaw 通道插件的核心接口。
 * 它包含了 Telegram 通道所需的所有适配器实现：
 *
 * - config: 账号配置管理（增删查改账号）
 * - outbound: 消息发送（文本、媒体）
 * - gateway: 消息接收（轮询或 Webhook）
 * - status: 状态检测和健康检查
 * - security: 安全策略（DM 策略、群组策略）
 * - pairing: 用户配对/授权机制
 * - onboarding: CLI 配置向导
 * - setup: 账号设置流程
 * - groups: 群组配置
 * - threading: 线程/回复配置
 * - messaging: 消息目标解析
 * - directory: 通讯录
 * - actions: 消息动作（发送、投票等）
 */

import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  collectTelegramStatusIssues,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  listTelegramAccountIds,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  looksLikeTelegramTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeTelegramMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
  resolveTelegramGroupRequireMention,
  resolveTelegramGroupToolPolicy,
  setAccountEnabledInConfigSection,
  telegramOnboardingAdapter,
  TelegramConfigSchema,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedTelegramAccount,
} from "openclaw/plugin-sdk";
import { getTelegramRuntime } from "./runtime.js";

// ============================================================================
// 元数据和辅助定义
// ============================================================================

/**
 * 获取 Telegram 通道的元数据
 * 包括：标签、文档路径、图标、描述等 UI 展示信息
 */
const meta = getChatChannelMeta("telegram");

/**
 * Telegram 消息动作适配器
 * 处理消息相关的动作，如：发送消息、投票等
 *
 * - listActions: 列出可用的消息动作
 * - extractToolSend: 从工具调用中提取发送参数
 * - handleAction: 执行消息动作
 */
const telegramMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => getTelegramRuntime().channel.telegram.messageActions.listActions(ctx),
  extractToolSend: (ctx) =>
    getTelegramRuntime().channel.telegram.messageActions.extractToolSend(ctx),
  handleAction: async (ctx) =>
    await getTelegramRuntime().channel.telegram.messageActions.handleAction(ctx),
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 解析回复消息 ID
 * 将字符串形式的消息 ID 转换为数字
 *
 * @param replyToId - 回复目标消息的 ID（字符串或 null）
 * @returns 解析后的数字 ID，无效则返回 undefined
 */
function parseReplyToMessageId(replyToId?: string | null) {
  if (!replyToId) {
    return undefined;
  }
  const parsed = Number.parseInt(replyToId, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 解析线程 ID
 * Telegram 的 Forum Topic（论坛主题）使用线程 ID 来组织消息
 *
 * @param threadId - 线程 ID（字符串、数字或 null）
 * @returns 解析后的整数 ID，无效则返回 undefined
 */
function parseThreadId(threadId?: string | number | null) {
  if (threadId == null) {
    return undefined;
  }
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
  }
  const trimmed = threadId.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
// ============================================================================
// Telegram 通道插件主定义
// ============================================================================

/**
 * Telegram 通道插件定义
 *
 * ChannelPlugin 是 OpenClaw 通道系统的核心接口，泛型参数 ResolvedTelegramAccount
 * 表示解析后的账号配置类型，包含 token、配置项等信息。
 *
 * 插件通过各种"适配器"来实现不同的功能：
 * - 每个适配器负责一个特定的功能领域
 * - OpenClaw 核心会在适当的时候调用这些适配器
 */
export const telegramPlugin: ChannelPlugin<ResolvedTelegramAccount> = {
  // ==========================================================================
  // 基础信息
  // ==========================================================================

  /** 通道唯一标识符，用于配置和 API 调用 */
  id: "telegram",

  /**
   * 通道元数据
   * - label: 显示名称
   * - docsPath: 文档路径
   * - systemImage: 图标
   * - quickstartAllowFrom: 快速开始时是否提示配置 allowFrom
   */
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },

  // ==========================================================================
  // onboarding 适配器 - CLI 配置向导
  // ==========================================================================

  /**
   * CLI 配置向导适配器
   * 当用户运行 `openclaw onboard` 或 `openclaw channel setup telegram` 时，
   * 会调用此适配器引导用户完成配置流程。
   */
  onboarding: telegramOnboardingAdapter,

  // ==========================================================================
  // pairing 适配器 - 用户配对/授权
  // ==========================================================================

  /**
   * 用户配对适配器
   * 当 dmPolicy="pairing" 时，新用户需要被管理员批准才能使用。
   *
   * - idLabel: 用户 ID 的标签（显示为 "telegramUserId"）
   * - normalizeAllowEntry: 标准化 allowFrom 条目（移除 "telegram:" 或 "tg:" 前缀）
   * - notifyApproval: 当用户被批准后，发送通知消息
   */
  pairing: {
    idLabel: "telegramUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^(telegram|tg):/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const { token } = getTelegramRuntime().channel.telegram.resolveTelegramToken(cfg);
      if (!token) {
        throw new Error("telegram token not configured");
      }
      await getTelegramRuntime().channel.telegram.sendMessageTelegram(
        id,
        PAIRING_APPROVED_MESSAGE,
        {
          token,
        },
      );
    },
  },

  // ==========================================================================
  // capabilities - 通道能力声明
  // ==========================================================================

  /**
   * 通道能力声明
   * 告诉 OpenClaw 核心此通道支持哪些功能
   *
   * - chatTypes: 支持的聊天类型（私聊、群组、频道、线程）
   * - reactions: 支持表情反应
   * - threads: 支持线程/回复
   * - media: 支持媒体（图片、文件等）
   * - nativeCommands: 支持原生命令（/start 等）
   * - blockStreaming: 阻止流式输出（Telegram 不支持编辑消息的流式更新）
   */
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    nativeCommands: true,
    blockStreaming: true,
  },

  // ==========================================================================
  // reload - 配置热重载
  // ==========================================================================

  /**
   * 配置热重载设置
   * 当这些配置前缀的值发生变化时，触发通道重载
   */
  reload: { configPrefixes: ["channels.telegram"] },

  // ==========================================================================
  // configSchema - 配置 Schema
  // ==========================================================================

  /**
   * 通道配置的 JSON Schema
   * 用于验证 channels.telegram 下的配置是否合法
   */
  configSchema: buildChannelConfigSchema(TelegramConfigSchema),

  // ==========================================================================
  // config 适配器 - 账号配置管理【必须】
  // ==========================================================================

  /**
   * 账号配置适配器
   * 管理通道账号的增删查改操作
   *
   * 这是通道插件的核心适配器之一，用于：
   * - 列出已配置的账号
   * - 解析账号配置
   * - 启用/禁用账号
   * - 删除账号
   * - 描述账号状态
   */
  config: {
    /** 列出所有已配置的账号 ID */
    listAccountIds: (cfg) => listTelegramAccountIds(cfg),

    /** 解析指定账号的完整配置（包含 token、配置项等） */
    resolveAccount: (cfg, accountId) => resolveTelegramAccount({ cfg, accountId }),

    /** 获取默认账号 ID */
    defaultAccountId: (cfg) => resolveDefaultTelegramAccountId(cfg),

    /** 设置账号的启用/禁用状态 */
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "telegram",
        accountId,
        enabled,
        allowTopLevel: true,
      }),

    /** 删除账号配置 */
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "telegram",
        accountId,
        clearBaseFields: ["botToken", "tokenFile", "name"],
      }),

    /** 判断账号是否已配置（有 token） */
    isConfigured: (account) => Boolean(account.token?.trim()),

    /** 生成账号描述快照（用于状态展示） */
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),

    /** 解析账号的 allowFrom 列表 */
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTelegramAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),

    /** 格式化 allowFrom 条目（标准化、去重、小写） */
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^(telegram|tg):/i, ""))
        .map((entry) => entry.toLowerCase()),
  },

  // ==========================================================================
  // security 适配器 - 安全策略
  // ==========================================================================

  /**
   * 安全策略适配器
   * 定义私聊和群组的访问控制策略
   */
  security: {
    /**
     * 解析私聊策略
     * - policy: "open" | "allowlist" | "pairing"
     * - allowFrom: 允许的用户列表
     */
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.telegram?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.telegram.accounts.${resolvedAccountId}.`
        : "channels.telegram.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("telegram"),
        normalizeEntry: (raw) => raw.replace(/^(telegram|tg):/i, ""),
      };
    },

    /**
     * 收集安全警告
     * 当配置可能存在安全风险时，生成警告信息
     */
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      const groupAllowlistConfigured =
        account.config.groups && Object.keys(account.config.groups).length > 0;
      if (groupAllowlistConfigured) {
        return [
          `- Telegram groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.telegram.groupPolicy="allowlist" + channels.telegram.groupAllowFrom to restrict senders.`,
        ];
      }
      return [
        `- Telegram groups: groupPolicy="open" with no channels.telegram.groups allowlist; any group can add + ping (mention-gated). Set channels.telegram.groupPolicy="allowlist" + channels.telegram.groupAllowFrom or configure channels.telegram.groups.`,
      ];
    },
  },

  // ==========================================================================
  // groups 适配器 - 群组配置
  // ==========================================================================

  /**
   * 群组配置适配器
   * 处理群组相关的设置
   */
  groups: {
    /** 解析群组是否需要 @提及 才能触发 */
    resolveRequireMention: resolveTelegramGroupRequireMention,

    /** 解析群组的工具使用策略 */
    resolveToolPolicy: resolveTelegramGroupToolPolicy,
  },

  // ==========================================================================
  // threading 适配器 - 线程/回复配置
  // ==========================================================================

  /**
   * 线程配置适配器
   * 处理消息回复的行为
   */
  threading: {
    /**
     * 解析回复模式
     * - "first": 回复第一条消息
     * - "last": 回复最后一条消息
     * - "none": 不回复
     */
    resolveReplyToMode: ({ cfg }) => cfg.channels?.telegram?.replyToMode ?? "first",
  },

  // ==========================================================================
  // messaging 适配器 - 消息目标解析
  // ==========================================================================

  /**
   * 消息目标解析适配器
   * 处理发送消息时的目标地址解析
   */
  messaging: {
    /** 标准化消息目标（如 @username 转换为 chat_id） */
    normalizeTarget: normalizeTelegramMessagingTarget,

    /** 目标解析器配置 */
    targetResolver: {
      /** 判断字符串是否看起来像 Telegram 的目标 ID */
      looksLikeId: looksLikeTelegramTargetId,

      /** 输入提示 */
      hint: "<chatId>",
    },
  },

  // ==========================================================================
  // directory 适配器 - 通讯录
  // ==========================================================================

  /**
   * 通讯录适配器
   * 提供联系人和群组列表查询功能
   */
  directory: {
    /** 获取当前 bot 的信息（Telegram 不支持，返回 null） */
    self: async () => null,

    /** 列出配置中的联系人 */
    listPeers: async (params) => listTelegramDirectoryPeersFromConfig(params),

    /** 列出配置中的群组 */
    listGroups: async (params) => listTelegramDirectoryGroupsFromConfig(params),
  },

  // ==========================================================================
  // actions 适配器 - 消息动作
  // ==========================================================================

  /** 消息动作适配器（发送、投票等） */
  actions: telegramMessageActions,

  // ==========================================================================
  // setup 适配器 - 账号设置流程
  // ==========================================================================

  /**
   * 账号设置适配器
   * 处理 `openclaw channel setup telegram` 命令的逻辑
   */
  setup: {
    /** 标准化账号 ID */
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),

    /** 应用账号名称到配置 */
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "telegram",
        accountId,
        name,
      }),

    /**
     * 验证输入参数
     * 返回错误信息字符串，或 null 表示验证通过
     */
    validateInput: ({ accountId, input }) => {
      // 环境变量方式只能用于默认账号
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "TELEGRAM_BOT_TOKEN can only be used for the default account.";
      }
      // 必须提供 token 来源
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "Telegram requires token or --token-file (or --use-env).";
      }
      return null;
    },

    /**
     * 应用账号配置
     * 将用户输入的配置写入到 OpenClaw 配置文件
     */
    applyAccountConfig: ({ cfg, accountId, input }) => {
      // 先应用账号名称
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "telegram",
        accountId,
        name: input.name,
      });

      // 如果是非默认账号，需要迁移基础配置
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "telegram",
            })
          : namedConfig;

      // 默认账号：配置写在 channels.telegram 根级别
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            telegram: {
              ...next.channels?.telegram,
              enabled: true,
              // 根据输入选择 token 来源
              ...(input.useEnv
                ? {} // 使用环境变量，不写入配置
                : input.tokenFile
                  ? { tokenFile: input.tokenFile } // 使用文件
                  : input.token
                    ? { botToken: input.token } // 直接写入 token
                    : {}),
            },
          },
        };
      }

      // 非默认账号：配置写在 channels.telegram.accounts.<accountId> 下
      return {
        ...next,
        channels: {
          ...next.channels,
          telegram: {
            ...next.channels?.telegram,
            enabled: true,
            accounts: {
              ...next.channels?.telegram?.accounts,
              [accountId]: {
                ...next.channels?.telegram?.accounts?.[accountId],
                enabled: true,
                ...(input.tokenFile
                  ? { tokenFile: input.tokenFile }
                  : input.token
                    ? { botToken: input.token }
                    : {}),
              },
            },
          },
        },
      };
    },
  },

  // ==========================================================================
  // outbound 适配器 - 消息发送【必须】
  // ==========================================================================

  /**
   * 消息发送适配器
   * 处理向 Telegram 发送消息的逻辑
   */
  outbound: {
    /**
     * 投递模式
     * - "direct": 直接通过 API 发送
     * - "gateway": 通过网关发送
     * - "hybrid": 混合模式
     */
    deliveryMode: "direct",

    /** 长文本分块器（Telegram 单条消息限制 4096 字符） */
    chunker: (text, limit) => getTelegramRuntime().channel.text.chunkMarkdownText(text, limit),

    /** 分块模式：使用 Markdown 感知的分块 */
    chunkerMode: "markdown",

    /** 单条消息的文本长度限制 */
    textChunkLimit: 4000,

    /**
     * 发送文本消息
     *
     * @param to - 目标 chat_id
     * @param text - 消息文本
     * @param accountId - 使用的账号 ID
     * @param deps - 依赖注入（用于测试）
     * @param replyToId - 回复的消息 ID
     * @param threadId - 线程 ID（Forum Topic）
     */
    sendText: async ({ to, text, accountId, deps, replyToId, threadId }) => {
      const send = deps?.sendTelegram ?? getTelegramRuntime().channel.telegram.sendMessageTelegram;
      const replyToMessageId = parseReplyToMessageId(replyToId);
      const messageThreadId = parseThreadId(threadId);
      const result = await send(to, text, {
        verbose: false,
        messageThreadId,
        replyToMessageId,
        accountId: accountId ?? undefined,
      });
      return { channel: "telegram", ...result };
    },

    /**
     * 发送媒体消息（图片、文件等）
     *
     * @param mediaUrl - 媒体文件 URL
     * 其他参数同 sendText
     */
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId, threadId }) => {
      const send = deps?.sendTelegram ?? getTelegramRuntime().channel.telegram.sendMessageTelegram;
      const replyToMessageId = parseReplyToMessageId(replyToId);
      const messageThreadId = parseThreadId(threadId);
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        messageThreadId,
        replyToMessageId,
        accountId: accountId ?? undefined,
      });
      return { channel: "telegram", ...result };
    },
  },

  // ==========================================================================
  // status 适配器 - 状态检测
  // ==========================================================================

  /**
   * 状态检测适配器
   * 用于 `openclaw channels status` 命令，检测通道运行状态
   */
  status: {
    /** 默认运行时状态 */
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    /** 收集状态问题（配置错误、连接问题等） */
    collectStatusIssues: collectTelegramStatusIssues,

    /** 构建通道摘要信息 */
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),

    /**
     * 探测账号连接状态
     * 调用 Telegram API 的 getMe 方法验证 token 有效性
     */
    probeAccount: async ({ account, timeoutMs }) =>
      getTelegramRuntime().channel.telegram.probeTelegram(
        account.token,
        timeoutMs,
        account.config.proxy,
      ),

    /**
     * 审计账号配置
     * 检查 bot 是否在配置的群组中，以及群组权限设置
     */
    auditAccount: async ({ account, timeoutMs, probe, cfg }) => {
      // 获取配置的群组列表
      const groups =
        cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
        cfg.channels?.telegram?.groups;

      // 收集需要检查的群组 ID
      const { groupIds, unresolvedGroups, hasWildcardUnmentionedGroups } =
        getTelegramRuntime().channel.telegram.collectUnmentionedGroupIds(groups);

      // 如果没有需要检查的群组，跳过审计
      if (!groupIds.length && unresolvedGroups === 0 && !hasWildcardUnmentionedGroups) {
        return undefined;
      }

      // 从探测结果中获取 bot ID
      const botId =
        (probe as { ok?: boolean; bot?: { id?: number } })?.ok &&
        (probe as { bot?: { id?: number } }).bot?.id != null
          ? (probe as { bot: { id: number } }).bot.id
          : null;

      if (!botId) {
        return {
          ok: unresolvedGroups === 0 && !hasWildcardUnmentionedGroups,
          checkedGroups: 0,
          unresolvedGroups,
          hasWildcardUnmentionedGroups,
          groups: [],
          elapsedMs: 0,
        };
      }

      // 执行群组成员资格审计
      const audit = await getTelegramRuntime().channel.telegram.auditGroupMembership({
        token: account.token,
        botId,
        groupIds,
        proxyUrl: account.config.proxy,
        timeoutMs,
      });
      return { ...audit, unresolvedGroups, hasWildcardUnmentionedGroups };
    },

    /**
     * 构建账号快照
     * 生成完整的账号状态信息，用于状态展示
     */
    buildAccountSnapshot: ({ account, cfg, runtime, probe, audit }) => {
      const configured = Boolean(account.token?.trim());

      // 获取群组配置
      const groups =
        cfg.channels?.telegram?.accounts?.[account.accountId]?.groups ??
        cfg.channels?.telegram?.groups;

      // 检查是否有不需要 @提及 的群组
      const allowUnmentionedGroups =
        Boolean(
          groups?.["*"] && (groups["*"] as { requireMention?: boolean }).requireMention === false,
        ) ||
        Object.entries(groups ?? {}).some(
          ([key, value]) =>
            key !== "*" &&
            Boolean(value) &&
            typeof value === "object" &&
            (value as { requireMention?: boolean }).requireMention === false,
        );

      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
        probe,
        audit,
        allowUnmentionedGroups,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },

  // ==========================================================================
  // gateway 适配器 - 消息接收【必须】
  // ==========================================================================

  /**
   * 网关适配器
   * 处理消息接收（监听 Telegram 更新）和登出逻辑
   */
  gateway: {
    /**
     * 启动账号监听
     * 开始接收 Telegram 消息（轮询或 Webhook 模式）
     *
     * @param ctx.account - 账号配置
     * @param ctx.cfg - 完整配置
     * @param ctx.runtime - 运行时环境
     * @param ctx.abortSignal - 中止信号（用于优雅关闭）
     * @param ctx.log - 日志器
     */
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.token.trim();

      // 尝试获取 bot 用户名用于日志显示
      let telegramBotLabel = "";
      try {
        const probe = await getTelegramRuntime().channel.telegram.probeTelegram(
          token,
          2500,
          account.config.proxy,
        );
        const username = probe.ok ? probe.bot?.username?.trim() : null;
        if (username) {
          telegramBotLabel = ` (@${username})`;
        }
      } catch (err) {
        if (getTelegramRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }

      ctx.log?.info(`[${account.accountId}] starting provider${telegramBotLabel}`);

      // 启动 Telegram 消息监听器
      return getTelegramRuntime().channel.telegram.monitorTelegramProvider({
        token,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        useWebhook: Boolean(account.config.webhookUrl),
        webhookUrl: account.config.webhookUrl,
        webhookSecret: account.config.webhookSecret,
        webhookPath: account.config.webhookPath,
      });
    },

    /**
     * 登出账号
     * 清除配置中的 token，停止消息接收
     *
     * @param accountId - 要登出的账号 ID
     * @param cfg - 当前配置
     * @returns { cleared, envToken, loggedOut }
     */
    logoutAccount: async ({ accountId, cfg }) => {
      const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextTelegram = cfg.channels?.telegram ? { ...cfg.channels.telegram } : undefined;
      let cleared = false;
      let changed = false;

      if (nextTelegram) {
        // 处理默认账号的 token
        if (accountId === DEFAULT_ACCOUNT_ID && nextTelegram.botToken) {
          delete nextTelegram.botToken;
          cleared = true;
          changed = true;
        }

        // 处理多账号配置
        const accounts =
          nextTelegram.accounts && typeof nextTelegram.accounts === "object"
            ? { ...nextTelegram.accounts }
            : undefined;

        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...entry } as Record<string, unknown>;

            // 删除 botToken
            if ("botToken" in nextEntry) {
              const token = nextEntry.botToken;
              if (typeof token === "string" ? token.trim() : token) {
                cleared = true;
              }
              delete nextEntry.botToken;
              changed = true;
            }

            // 如果账号配置为空，删除整个账号条目
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry as typeof entry;
            }
          }
        }

        // 清理空的 accounts 对象
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextTelegram.accounts;
            changed = true;
          } else {
            nextTelegram.accounts = accounts;
          }
        }
      }

      // 更新配置文件
      if (changed) {
        if (nextTelegram && Object.keys(nextTelegram).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, telegram: nextTelegram };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete nextChannels.telegram;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
      }

      // 检查是否真正登出（没有任何 token 来源了）
      const resolved = resolveTelegramAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";

      // 写入配置文件
      if (changed) {
        await getTelegramRuntime().config.writeConfigFile(nextCfg);
      }

      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
};
