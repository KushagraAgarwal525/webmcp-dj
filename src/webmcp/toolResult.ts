const MAX_OUTPUT = 1500;

/** Serialize a tool payload. `max: null` skips the size cap (playbook, etc.). */
export function toolResult(value: unknown, max: number | null = MAX_OUTPUT): string {
  const json = JSON.stringify(value);
  if (max == null || json.length <= max) return json;
  const budget = Math.max(120, max - 80);
  return JSON.stringify({
    truncated: true,
    cursor: 0,
    preview: json.slice(0, budget),
    message: `Output truncated to ${max} chars. Call a more specific getter.`,
  });
}

export function toolOk(payload: Record<string, unknown> = {}, max?: number | null) {
  return toolResult({ ok: true, ...payload }, max === undefined ? MAX_OUTPUT : max);
}

export function toolOkFull(payload: Record<string, unknown> = {}) {
  return toolResult({ ok: true, ...payload }, null);
}

export function toolErr(error: string) {
  return toolResult({ ok: false, error });
}
