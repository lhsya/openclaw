/**
 * OpenClaw 引导向导 (Onboarding Wizard)
 *
 * 本模块实现了 `openclaw onboard` 命令的交互式引导流程。
 * 主要功能包括：
 * - 安全风险确认
 * - 选择引导模式 (QuickStart / Manual)
 * - 选择 AI Provider 和认证方式
 * - 选择默认模型
 * - 配置 Gateway（本地/远程）
 * - 设置消息通道 (Channels)
 * - 配置技能 (Skills) 和钩子 (Hooks)
 *
 * 执行流程:
 * install.sh → openclaw onboard → runOnboardingWizard()
 */

// ============================================================================
// 类型导入
// ============================================================================
import type {
  GatewayAuthChoice,   // Gateway 认证方式: "token" | "password"
  OnboardMode,         // 引导模式: "local" | "remote"
  OnboardOptions,      // 引导命令的选项参数
  ResetScope,          // 重置范围: "config" | "config+creds+sessions" | "full"
} from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { QuickstartGatewayDefaults, WizardFlow } from "./onboarding.types.js";

// ============================================================================
// 功能模块导入
// ============================================================================
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { formatCliCommand } from "../cli/command-format.js";

// 认证选择相关
import { promptAuthChoiceGrouped } from "../commands/auth-choice-prompt.js";
import {
  applyAuthChoice,                      // 应用认证配置
  resolvePreferredProviderForAuthChoice, // 根据认证方式推断首选 Provider
  warnIfModelConfigLooksOff,            // 检查模型配置是否合理
} from "../commands/auth-choice.js";

// 模型选择器
import { applyPrimaryModel, promptDefaultModel } from "../commands/model-picker.js";

// 引导流程各步骤
import { setupChannels } from "../commands/onboard-channels.js";
import {
  applyWizardMetadata,      // 添加向导元数据到配置
  DEFAULT_WORKSPACE,        // 默认工作区路径
  ensureWorkspaceAndSessions, // 确保工作区和会话目录存在
  handleReset,              // 处理配置重置
  printWizardHeader,        // 打印向导标题
  probeGatewayReachable,    // 探测 Gateway 是否可达
  summarizeExistingConfig,  // 总结现有配置
} from "../commands/onboard-helpers.js";
import { setupInternalHooks } from "../commands/onboard-hooks.js";
import { promptRemoteGatewayConfig } from "../commands/onboard-remote.js";
import { setupSkills } from "../commands/onboard-skills.js";

// 配置文件操作
import {
  DEFAULT_GATEWAY_PORT,     // 默认 Gateway 端口 (18789)
  readConfigFileSnapshot,   // 读取配置文件快照
  resolveGatewayPort,       // 解析 Gateway 端口
  writeConfigFile,          // 写入配置文件
} from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

// 向导完成和 Gateway 配置
import { finalizeOnboardingWizard } from "./onboarding.finalize.js";
import { configureGatewayForOnboarding } from "./onboarding.gateway-config.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

// ============================================================================
// 安全风险确认
// ============================================================================

/**
 * 要求用户确认安全风险
 *
 * 在开始引导流程之前，向用户展示安全警告并要求确认。
 * 如果用户通过命令行参数 --accept-risk 已经确认，则跳过此步骤。
 *
 * @param params.opts - 引导选项，包含 acceptRisk 标志
 * @param params.prompter - 交互式提示器
 * @throws {WizardCancelledError} 如果用户拒绝确认风险
 */
async function requireRiskAcknowledgement(params: {
  opts: OnboardOptions;
  prompter: WizardPrompter;
}) {
  // 如果已通过命令行参数确认风险，直接返回
  if (params.opts.acceptRisk === true) {
    return;
  }

  // 显示安全警告信息
  await params.prompter.note(
    [
      "Security warning — please read.",
      "",
      "OpenClaw is a hobby project and still in beta. Expect sharp edges.",
      "This bot can read files and run actions if tools are enabled.",
      "A bad prompt can trick it into doing unsafe things.",
      "",
      "If you're not comfortable with basic security and access control, don't run OpenClaw.",
      "Ask someone experienced to help before enabling tools or exposing it to the internet.",
      "",
      "Recommended baseline:",
      "- Pairing/allowlists + mention gating.",
      "- Sandbox + least-privilege tools.",
      "- Keep secrets out of the agent's reachable filesystem.",
      "- Use the strongest available model for any bot with tools or untrusted inboxes.",
      "",
      "Run regularly:",
      "openclaw security audit --deep",
      "openclaw security audit --fix",
      "",
      "Must read: https://docs.openclaw.ai/gateway/security",
    ].join("\n"),
    "Security",
  );

  // 要求用户确认
  const ok = await params.prompter.confirm({
    message: "I understand this is powerful and inherently risky. Continue?",
    initialValue: false,
  });

  // 用户拒绝则抛出取消错误
  if (!ok) {
    throw new WizardCancelledError("risk not accepted");
  }
}

// ============================================================================
// 主引导向导流程
// ============================================================================

/**
 * 运行交互式引导向导
 *
 * 这是 `openclaw onboard` 命令的核心实现，引导用户完成 OpenClaw 的初始配置。
 *
 * 完整流程:
 * 1. 显示向导标题和安全警告
 * 2. 读取并验证现有配置
 * 3. 选择引导模式 (QuickStart / Manual)
 * 4. 处理现有配置 (保留/更新/重置)
 * 5. 选择 AI Provider 和认证方式 (OpenAI, Anthropic, MiniMax 等)
 * 6. 选择默认模型 (GPT-4, Claude, Kimi 等)
 * 7. 配置 Gateway (端口、绑定地址、认证)
 * 8. 设置消息通道 (Telegram, Discord, Slack 等)
 * 9. 设置技能和钩子
 * 10. 完成并启动
 *
 * @param opts - 引导选项 (来自命令行参数)
 * @param runtime - 运行时环境 (日志、退出等)
 * @param prompter - 交互式提示器 (用于用户输入)
 */
export async function runOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
) {
  // ========================================
  // 步骤 1: 显示向导标题和安全确认
  // ========================================
  printWizardHeader(runtime);
  await prompter.intro("OpenClaw onboarding");
  await requireRiskAcknowledgement({ opts, prompter });

  // ========================================
  // 步骤 2: 读取并验证现有配置
  // ========================================
  const snapshot = await readConfigFileSnapshot();
  let baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};

  // 如果配置文件存在但无效，提示用户运行 doctor 修复
  if (snapshot.exists && !snapshot.valid) {
    await prompter.note(summarizeExistingConfig(baseConfig), "Invalid config");
    if (snapshot.issues.length > 0) {
      await prompter.note(
        [
          ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
          "",
          "Docs: https://docs.openclaw.ai/gateway/configuration",
        ].join("\n"),
        "Config issues",
      );
    }
    await prompter.outro(
      `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run onboarding.`,
    );
    runtime.exit(1);
    return;
  }

  // ========================================
  // 步骤 3: 选择引导模式 (QuickStart / Manual)
  // ========================================
  const quickstartHint = `Configure details later via ${formatCliCommand("openclaw configure")}.`;
  const manualHint = "Configure port, network, Tailscale, and auth options.";

  // 处理命令行参数中的 flow 选项
  const explicitFlowRaw = opts.flow?.trim();
  const normalizedExplicitFlow = explicitFlowRaw === "manual" ? "advanced" : explicitFlowRaw;

  // 验证 flow 参数
  if (
    normalizedExplicitFlow &&
    normalizedExplicitFlow !== "quickstart" &&
    normalizedExplicitFlow !== "advanced"
  ) {
    runtime.error("Invalid --flow (use quickstart, manual, or advanced).");
    runtime.exit(1);
    return;
  }

  const explicitFlow: WizardFlow | undefined =
    normalizedExplicitFlow === "quickstart" || normalizedExplicitFlow === "advanced"
      ? normalizedExplicitFlow
      : undefined;

  // 如果未指定 flow，则提示用户选择
  let flow: WizardFlow =
    explicitFlow ??
    (await prompter.select({
      message: "Onboarding mode",
      options: [
        { value: "quickstart", label: "QuickStart", hint: quickstartHint },
        { value: "advanced", label: "Manual", hint: manualHint },
      ],
      initialValue: "quickstart",
    }));

  // 远程模式不支持 QuickStart，自动切换到 Manual
  if (opts.mode === "remote" && flow === "quickstart") {
    await prompter.note(
      "QuickStart only supports local gateways. Switching to Manual mode.",
      "QuickStart",
    );
    flow = "advanced";
  }

  // ========================================
  // 步骤 4: 处理现有配置 (保留/更新/重置)
  // ========================================
  if (snapshot.exists) {
    await prompter.note(summarizeExistingConfig(baseConfig), "Existing config detected");

    const action = await prompter.select({
      message: "Config handling",
      options: [
        { value: "keep", label: "Use existing values" },
        { value: "modify", label: "Update values" },
        { value: "reset", label: "Reset" },
      ],
    });

    // 用户选择重置配置
    if (action === "reset") {
      const workspaceDefault = baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE;

      // 选择重置范围
      const resetScope = (await prompter.select({
        message: "Reset scope",
        options: [
          { value: "config", label: "Config only" },
          {
            value: "config+creds+sessions",
            label: "Config + creds + sessions",
          },
          {
            value: "full",
            label: "Full reset (config + creds + sessions + workspace)",
          },
        ],
      })) as ResetScope;

      await handleReset(resetScope, resolveUserPath(workspaceDefault), runtime);
      baseConfig = {}; // 重置后清空基础配置
    }
  }

  // ========================================
  // 步骤 5: 构建 QuickStart 模式的 Gateway 默认配置
  // ========================================
  const quickstartGateway: QuickstartGatewayDefaults = (() => {
    // 检查是否有现有的 Gateway 配置
    const hasExisting =
      typeof baseConfig.gateway?.port === "number" ||
      baseConfig.gateway?.bind !== undefined ||
      baseConfig.gateway?.auth?.mode !== undefined ||
      baseConfig.gateway?.auth?.token !== undefined ||
      baseConfig.gateway?.auth?.password !== undefined ||
      baseConfig.gateway?.customBindHost !== undefined ||
      baseConfig.gateway?.tailscale?.mode !== undefined;

    // 解析绑定模式
    const bindRaw = baseConfig.gateway?.bind;
    const bind =
      bindRaw === "loopback" ||
      bindRaw === "lan" ||
      bindRaw === "auto" ||
      bindRaw === "custom" ||
      bindRaw === "tailnet"
        ? bindRaw
        : "loopback"; // 默认绑定到本地回环地址

    // 解析认证模式
    let authMode: GatewayAuthChoice = "token";
    if (
      baseConfig.gateway?.auth?.mode === "token" ||
      baseConfig.gateway?.auth?.mode === "password"
    ) {
      authMode = baseConfig.gateway.auth.mode;
    } else if (baseConfig.gateway?.auth?.token) {
      authMode = "token";
    } else if (baseConfig.gateway?.auth?.password) {
      authMode = "password";
    }

    // 解析 Tailscale 模式
    const tailscaleRaw = baseConfig.gateway?.tailscale?.mode;
    const tailscaleMode =
      tailscaleRaw === "off" || tailscaleRaw === "serve" || tailscaleRaw === "funnel"
        ? tailscaleRaw
        : "off"; // 默认关闭 Tailscale

    return {
      hasExisting,
      port: resolveGatewayPort(baseConfig),
      bind,
      authMode,
      tailscaleMode,
      token: baseConfig.gateway?.auth?.token,
      password: baseConfig.gateway?.auth?.password,
      customBindHost: baseConfig.gateway?.customBindHost,
      tailscaleResetOnExit: baseConfig.gateway?.tailscale?.resetOnExit ?? false,
    };
  })();

  // QuickStart 模式显示配置摘要
  if (flow === "quickstart") {
    // 格式化辅助函数
    const formatBind = (value: "loopback" | "lan" | "auto" | "custom" | "tailnet") => {
      if (value === "loopback") {
        return "Loopback (127.0.0.1)";
      }
      if (value === "lan") {
        return "LAN";
      }
      if (value === "custom") {
        return "Custom IP";
      }
      if (value === "tailnet") {
        return "Tailnet (Tailscale IP)";
      }
      return "Auto";
    };
    const formatAuth = (value: GatewayAuthChoice) => {
      if (value === "token") {
        return "Token (default)";
      }
      return "Password";
    };
    const formatTailscale = (value: "off" | "serve" | "funnel") => {
      if (value === "off") {
        return "Off";
      }
      if (value === "serve") {
        return "Serve";
      }
      return "Funnel";
    };

    // 根据是否有现有配置显示不同的摘要
    const quickstartLines = quickstartGateway.hasExisting
      ? [
          "Keeping your current gateway settings:",
          `Gateway port: ${quickstartGateway.port}`,
          `Gateway bind: ${formatBind(quickstartGateway.bind)}`,
          ...(quickstartGateway.bind === "custom" && quickstartGateway.customBindHost
            ? [`Gateway custom IP: ${quickstartGateway.customBindHost}`]
            : []),
          `Gateway auth: ${formatAuth(quickstartGateway.authMode)}`,
          `Tailscale exposure: ${formatTailscale(quickstartGateway.tailscaleMode)}`,
          "Direct to chat channels.",
        ]
      : [
          `Gateway port: ${DEFAULT_GATEWAY_PORT}`,
          "Gateway bind: Loopback (127.0.0.1)",
          "Gateway auth: Token (default)",
          "Tailscale exposure: Off",
          "Direct to chat channels.",
        ];
    await prompter.note(quickstartLines.join("\n"), "QuickStart");
  }

  // ========================================
  // 步骤 6: 探测 Gateway 可达性
  // ========================================
  const localPort = resolveGatewayPort(baseConfig);
  const localUrl = `ws://127.0.0.1:${localPort}`;

  // 探测本地 Gateway
  const localProbe = await probeGatewayReachable({
    url: localUrl,
    token: baseConfig.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN,
    password: baseConfig.gateway?.auth?.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD,
  });

  // 探测远程 Gateway（如果配置了）
  const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
  const remoteProbe = remoteUrl
    ? await probeGatewayReachable({
        url: remoteUrl,
        token: baseConfig.gateway?.remote?.token,
      })
    : null;

  // ========================================
  // 步骤 7: 选择本地或远程 Gateway
  // ========================================
  const mode =
    opts.mode ??
    (flow === "quickstart"
      ? "local" // QuickStart 默认本地模式
      : ((await prompter.select({
          message: "What do you want to set up?",
          options: [
            {
              value: "local",
              label: "Local gateway (this machine)",
              hint: localProbe.ok
                ? `Gateway reachable (${localUrl})`
                : `No gateway detected (${localUrl})`,
            },
            {
              value: "remote",
              label: "Remote gateway (info-only)",
              hint: !remoteUrl
                ? "No remote URL configured yet"
                : remoteProbe?.ok
                  ? `Gateway reachable (${remoteUrl})`
                  : `Configured but unreachable (${remoteUrl})`,
            },
          ],
        })) as OnboardMode));

  // 远程模式: 配置远程 Gateway 后退出
  if (mode === "remote") {
    let nextConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
    nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
    await prompter.outro("Remote gateway configured.");
    return;
  }

  // ========================================
  // 步骤 8: 配置工作区目录
  // ========================================
  const workspaceInput =
    opts.workspace ??
    (flow === "quickstart"
      ? (baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE)
      : await prompter.text({
          message: "Workspace directory",
          initialValue: baseConfig.agents?.defaults?.workspace ?? DEFAULT_WORKSPACE,
        }));

  const workspaceDir = resolveUserPath(workspaceInput.trim() || DEFAULT_WORKSPACE);

  // 初始化下一步的配置对象
  let nextConfig: OpenClawConfig = {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      defaults: {
        ...baseConfig.agents?.defaults,
        workspace: workspaceDir,
      },
    },
    gateway: {
      ...baseConfig.gateway,
      mode: "local",
    },
  };

  // ========================================
  // 步骤 9: 选择 AI Provider 和认证方式 ⭐ 关键步骤
  // ========================================
  const authStore = ensureAuthProfileStore(undefined, {
    allowKeychainPrompt: false,
  });

  const authChoiceFromPrompt = opts.authChoice === undefined;

  // 如果未通过命令行指定，则提示用户选择 AI Provider
  // 支持: OpenAI, Anthropic, MiniMax, Moonshot, Google, OpenRouter 等
  const authChoice =
    opts.authChoice ??
    (await promptAuthChoiceGrouped({
      prompter,
      store: authStore,
      includeSkip: true,
    }));

  // 应用认证配置
  const authResult = await applyAuthChoice({
    authChoice,
    config: nextConfig,
    prompter,
    runtime,
    setDefaultModel: true,
    opts: {
      tokenProvider: opts.tokenProvider,
      token: opts.authChoice === "apiKey" && opts.token ? opts.token : undefined,
    },
  });
  nextConfig = authResult.config;

  // ========================================
  // 步骤 10: 选择默认模型 ⭐ 关键步骤
  // ========================================
  if (authChoiceFromPrompt) {
    // 提示用户选择默认模型 (GPT-4, Claude, Kimi 等)
    const modelSelection = await promptDefaultModel({
      config: nextConfig,
      prompter,
      allowKeep: true,
      ignoreAllowlist: true,
      preferredProvider: resolvePreferredProviderForAuthChoice(authChoice),
    });

    // 应用选择的模型
    if (modelSelection.model) {
      nextConfig = applyPrimaryModel(nextConfig, modelSelection.model);
    }
  }

  // 检查模型配置是否合理
  await warnIfModelConfigLooksOff(nextConfig, prompter);

  // ========================================
  // 步骤 11: 配置 Gateway
  // ========================================
  const gateway = await configureGatewayForOnboarding({
    flow,
    baseConfig,
    nextConfig,
    localPort,
    quickstartGateway,
    prompter,
    runtime,
  });
  nextConfig = gateway.nextConfig;
  const settings = gateway.settings;

  // ========================================
  // 步骤 12: 设置消息通道 (Channels)
  // ========================================
  if (opts.skipChannels ?? opts.skipProviders) {
    await prompter.note("Skipping channel setup.", "Channels");
  } else {
    // 获取支持 QuickStart 自动允许的通道插件
    const quickstartAllowFromChannels =
      flow === "quickstart"
        ? listChannelPlugins()
            .filter((plugin) => plugin.meta.quickstartAllowFrom)
            .map((plugin) => plugin.id)
        : [];

    // 设置通道 (Telegram, Discord, Slack, Signal, iMessage 等)
    nextConfig = await setupChannels(nextConfig, runtime, prompter, {
      allowSignalInstall: true,
      forceAllowFromChannels: quickstartAllowFromChannels,
      skipDmPolicyPrompt: flow === "quickstart",
      skipConfirm: flow === "quickstart",
      quickstartDefaults: flow === "quickstart",
    });
  }

  // 保存配置
  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);

  // 确保工作区和会话目录存在
  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  // ========================================
  // 步骤 13: 设置技能 (Skills)
  // ========================================
  if (opts.skipSkills) {
    await prompter.note("Skipping skills setup.", "Skills");
  } else {
    nextConfig = await setupSkills(nextConfig, workspaceDir, runtime, prompter);
  }

  // ========================================
  // 步骤 14: 设置内部钩子 (Hooks)
  // ========================================
  // 例如: 新会话时的记忆功能 (/new 命令)
  nextConfig = await setupInternalHooks(nextConfig, runtime, prompter);

  // ========================================
  // 步骤 15: 保存最终配置并完成向导
  // ========================================
  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);

  // 完成向导，可能启动 TUI (终端用户界面)
  const { launchedTui } = await finalizeOnboardingWizard({
    flow,
    opts,
    baseConfig,
    nextConfig,
    workspaceDir,
    settings,
    prompter,
    runtime,
  });

  // 如果启动了 TUI，直接返回（TUI 会接管控制）
  if (launchedTui) {
    return;
  }
}
