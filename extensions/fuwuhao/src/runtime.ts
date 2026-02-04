import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export const setWecomRuntime = (next: PluginRuntime): void => {
  runtime = next;
};

export const getWecomRuntime = (): PluginRuntime => {
  if (!runtime) {
    throw new Error("WeCom runtime not initialized");
  }
  return runtime;
};