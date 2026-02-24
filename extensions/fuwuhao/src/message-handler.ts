import type { FuwuhaoMessage, CallbackPayload, StreamCallback, AgentEventPayload } from "./types.js";
import { getWecomRuntime } from "./runtime.js";
import { buildMessageContext } from "./message-context.js";

// ============================================
// 消息处理器
// ============================================

/**
 * 处理消息并转发给 Agent
 */
export const handleMessage = async (message: FuwuhaoMessage): Promise<string | null> => {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  
  const content = message.Content || message.text?.content || "";
  const userId = message.FromUserName || message.userid || "unknown";
  const messageId = String(message.MsgId || message.msgid || Date.now());
  const messageType = message.msgtype || "text";
  const timestamp = message.CreateTime || Date.now();
  
  console.log("[fuwuhao] 收到消息:", {
    类型: messageType,
    消息ID: messageId,
    内容: content,
    用户ID: userId,
    时间戳: timestamp
  });

  // 构建消息上下文
  const { ctx, route, storePath } = buildMessageContext(message);
  
  console.log("[fuwuhao] 路由信息:", {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    accountId: route.accountId,
  });
  
  // 记录会话元数据
  void runtime.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctx.SessionKey as string ?? route.sessionKey,
    ctx,
  }).catch((err: unknown) => {
    console.log(`[fuwuhao] 记录会话元数据失败: ${String(err)}`);
  });
  
  // 记录频道活动
  runtime.channel.activity.record({
    channel: "fuwuhao",
    accountId: "default",
    direction: "inbound",
  });
  
  // 调用 OpenClaw 的消息分发系统
  try {
    let responseText: string | null = null;
    
    // 获取响应前缀配置
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);
    
    console.log("[fuwuhao] 开始调用 Agent...");
    
    const { queuedFinal } = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (
          payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean; channelData?: unknown },
          info: { kind: string }
        ) => {
          console.log(`[fuwuhao] Agent ${info.kind} 回复:`, payload, info);

          if (info.kind === "tool") {
            // 工具调用结果（如 write、read_file 等），仅记录日志
            console.log("[fuwuhao] 工具调用结果:", payload);
          } else if (info.kind === "block") {
            // 流式分块回复，累积文本
            if (payload.text) {
              responseText = payload.text;
            }
          } else if (info.kind === "final") {
            // 最终完整回复
            if (payload.text) {
              responseText = payload.text;
            }
            console.log("[fuwuhao] 最终回复:", payload);
          }

          // 记录出站活动
          runtime.channel.activity.record({
            channel: "fuwuhao",
            accountId: "default",
            direction: "outbound",
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[fuwuhao] ${info.kind} 回复失败:`, err);
        },
      },
      replyOptions: {},
    });
    
    if (!queuedFinal) {
      console.log("[fuwuhao] Agent 没有生成回复");
    }
    
    // ============================================
    // 后置处理：将结果发送到回调服务
    // ============================================
    const callbackPayload: CallbackPayload = {
      userId,
      messageId,
      messageType,
      userMessage: content,
      aiReply: responseText,
      timestamp,
      sessionKey: route.sessionKey,
      success: true,
    };
    
    // 异步发送，不阻塞返回
    // void sendToCallbackService(callbackPayload);
    
    return responseText;
  } catch (err) {
    console.error("[fuwuhao] 消息分发失败:", err);
    
    // 即使失败也发送回调（带错误信息）
    const callbackPayload: CallbackPayload = {
      userId,
      messageId,
      messageType,
      userMessage: content,
      aiReply: null,
      timestamp,
      sessionKey: route.sessionKey,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
    
    // void sendToCallbackService(callbackPayload);
    
    return null;
  }
};

/**
 * 处理消息并流式返回结果
 */
export const handleMessageStream = async (
  message: FuwuhaoMessage,
  onChunk: StreamCallback
): Promise<void> => {
  const runtime = getWecomRuntime();
  const cfg = runtime.config.loadConfig();
  
  const content = message.Content || message.text?.content || "";
  const userId = message.FromUserName || message.userid || "unknown";
  const messageId = String(message.MsgId || message.msgid || Date.now());
  const messageType = message.msgtype || "text";

  console.log("[fuwuhao] 流式处理消息:", {
    类型: messageType,
    消息ID: messageId,
    内容: content,
    用户ID: userId,
  });

  // 构建消息上下文
  const { ctx, route, storePath } = buildMessageContext(message);
  
  // 记录会话元数据
  void runtime.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctx.SessionKey as string ?? route.sessionKey,
    ctx,
  }).catch((err: unknown) => {
    console.log(`[fuwuhao] 记录会话元数据失败: ${String(err)}`);
  });
  
  // 记录频道活动
  runtime.channel.activity.record({
    channel: "fuwuhao",
    accountId: "default",
    direction: "inbound",
  });
  
  // 订阅全局 Agent 事件，捕获流式文本和工具调用信息
  console.log("[fuwuhao] 注册 onAgentEvent 监听器...");
  let lastEmittedText = ""; // 用于去重，只发送增量文本
  
  const unsubscribeAgentEvents = runtime.events.onAgentEvent((evt: AgentEventPayload) => {
    // 记录所有事件（调试用）
    console.log(`[fuwuhao] 收到 AgentEvent: stream=${evt.stream}, runId=${evt.runId}`);
    
    const data = evt.data as Record<string, unknown>;
    
    // ============================================
    // 处理流式文本（assistant 流）
    // ============================================
    if (evt.stream === "assistant") {
      const delta = data.delta as string | undefined;
      const text = data.text as string | undefined;
      
      // 优先使用 delta（增量文本），如果没有则计算增量
      let textToSend = delta;
      if (!textToSend && text && text !== lastEmittedText) {
        textToSend = text.slice(lastEmittedText.length);
        lastEmittedText = text;
      } else if (delta) {
        lastEmittedText += delta;
      }
      
      if (textToSend) {
        console.log(`[fuwuhao] 流式文本:`, textToSend.slice(0, 50) + (textToSend.length > 50 ? "..." : ""));
        onChunk({
          type: "block",
          text: textToSend,
          timestamp: evt.ts,
        });
      }
      return;
    }
    
    // ============================================
    // 处理工具调用事件（tool 流）
    // ============================================
    if (evt.stream === "tool") {
      const phase = data.phase as string | undefined;
      const toolName = data.name as string | undefined;
      const toolCallId = data.toolCallId as string | undefined;
      
      console.log(`[fuwuhao] 工具事件 [${phase}]:`, toolName, toolCallId);
      
      if (phase === "start") {
        // 工具开始执行
        onChunk({
          type: "tool_start",
          toolName,
          toolCallId,
          toolArgs: data.args as Record<string, unknown> | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      } else if (phase === "update") {
        // 工具执行中间状态更新
        onChunk({
          type: "tool_update",
          toolName,
          toolCallId,
          text: data.text as string | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      } else if (phase === "result") {
        // 工具执行完成
        onChunk({
          type: "tool_result",
          toolName,
          toolCallId,
          text: data.result as string | undefined,
          isError: data.isError as boolean | undefined,
          toolMeta: data.meta as Record<string, unknown> | undefined,
          timestamp: evt.ts,
        });
      }
      return;
    }
    
    // ============================================
    // 处理生命周期事件（lifecycle 流）
    // ============================================
    if (evt.stream === "lifecycle") {
      const phase = data.phase as string | undefined;
      console.log(`[fuwuhao] 生命周期事件 [${phase}]`);
      // 可以在这里处理 start/end/error 事件，例如：
      // if (phase === "error") { onChunk({ type: "error", text: data.error as string, timestamp: evt.ts }); }
    }
  });
  
  try {
    // 获取响应前缀配置
    const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);
    
    console.log("[fuwuhao] 开始流式调用 Agent...");
    console.log("[fuwuhao] ctx:", JSON.stringify(ctx));
    
    const dispatchResult = await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx,
      cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (
          payload: { text?: string; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean; channelData?: unknown },
          info: { kind: string }
        ) => {
          console.log(`[fuwuhao] 流式 ${info.kind} 回复:`, payload, info);

          if (info.kind === "tool") {
            // 工具调用结果
            onChunk({
              type: "tool",
              text: payload.text,
              isError: payload.isError,
              timestamp: Date.now(),
            });
          } else if (info.kind === "block") {
            // 流式分块回复
            onChunk({
              type: "block",
              text: payload.text,
              timestamp: Date.now(),
            });
          } else if (info.kind === "final") {
            // 最终完整回复
            onChunk({
              type: "final",
              text: payload.text,
              timestamp: Date.now(),
            });
          }

          // 记录出站活动
          runtime.channel.activity.record({
            channel: "fuwuhao",
            accountId: "default",
            direction: "outbound",
          });
        },
        onError: (err: unknown, info: { kind: string }) => {
          console.error(`[fuwuhao] 流式 ${info.kind} 回复失败:`, err);
          onChunk({
            type: "error",
            text: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
        },
      },
      replyOptions: {},
    });
    
    console.log("[fuwuhao] dispatchReplyWithBufferedBlockDispatcher 完成, 结果:", dispatchResult);
    
    // 取消订阅 Agent 事件
    unsubscribeAgentEvents();
    
    // 发送完成信号
    onChunk({
      type: "done",
      timestamp: Date.now(),
    });
    
  } catch (err) {
    // 确保在异常时也取消订阅
    unsubscribeAgentEvents();
    console.error("[fuwuhao] 流式消息分发失败:", err);
    onChunk({
      type: "error",
      text: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    });
  }
};
