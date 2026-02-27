import type { onAgentEvent as OnAgentEventType } from "openclaw/plugin-sdk";

export type AgentEventStream = "lifecycle" | "tool" | "assistant" | "error" | (string & {});

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

// 动态导入，兼容 openclaw 未导出该函数的情况
let _onAgentEvent: typeof OnAgentEventType | undefined;

async function loadOnAgentEvent() {
  if (_onAgentEvent) return _onAgentEvent;
  try {
    const sdk = await import("openclaw/plugin-sdk");
    if (typeof sdk.onAgentEvent === "function") {
      _onAgentEvent = sdk.onAgentEvent;
    }
  } catch {
    // ignore
  }
  return _onAgentEvent;
}

export const onAgentEvent: typeof OnAgentEventType = (listener) => {
  let unsubscribe: (() => boolean) | undefined;
  loadOnAgentEvent().then((fn) => {
    if (fn) {
      unsubscribe = fn(listener);
    }
  });
  return () => unsubscribe?.() ?? false;
};