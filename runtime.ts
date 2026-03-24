import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setOdooRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getOdooRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Odoo runtime not initialized");
  }
  return runtime;
}
