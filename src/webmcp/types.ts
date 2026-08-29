/** Minimal WebMCP typings until browser libs ship. */

export type ToolAnnotations = {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
};

export type ToolExecuteCallbackOptions = {
  signal: AbortSignal;
};

export type ModelContextTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  annotations?: ToolAnnotations;
  execute: (
    inputObject: Record<string, unknown>,
    options: ToolExecuteCallbackOptions,
  ) => Promise<unknown>;
};

export type ModelContextRegisterToolOptions = {
  exposedTo?: string[];
  signal?: AbortSignal;
};

export type RegisteredTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  window: Window;
  origin: string;
  annotations?: ToolAnnotations;
};

export type ModelContext = EventTarget & {
  registerTool: (
    tool: ModelContextTool,
    options?: ModelContextRegisterToolOptions,
  ) => Promise<undefined>;
  getTools: (options?: { fromOrigins?: string[] }) => Promise<RegisteredTool[]>;
  executeTool: (
    tool: RegisteredTool,
    inputObject?: object,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
  ontoolchange: ((this: ModelContext, ev: Event) => unknown) | null;
};

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
}

export function isWebmcpAvailable(): boolean {
  return typeof document.modelContext?.registerTool === "function";
}
