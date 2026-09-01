/**
 * Output budgets. The old behavior (every WebMCP result sliced to 1500 chars
 * mid-JSON) made the library unreadable to agents — they saw a broken preview
 * and guessed the rest. Now: per-tool budgets, and truncation that drops whole
 * list items and reports what was dropped instead of cutting mid-JSON.
 */
const DEFAULT_MAX = 6000;

export function toolResult(value: unknown, max: number | null = DEFAULT_MAX): string {
  const json = JSON.stringify(value);
  if (max == null || json.length <= max) return json;
  const trimmed = trimToFit(value, max);
  if (trimmed) return trimmed;
  // Absolute last resort for non-trimmable payloads: valid JSON, clearly marked.
  return JSON.stringify({
    truncated: true,
    preview: json.slice(0, Math.max(200, max - 300)),
    message: `Output over ${max} chars and not list-trimmable — narrow the request.`,
  });
}

type ArrayRef = { array: unknown[]; path: string };

function collectArrays(node: unknown, path: string, out: ArrayRef[], depth: number) {
  if (depth > 4 || node == null) return;
  if (Array.isArray(node)) {
    out.push({ array: node, path });
    if (node.length && depth < 4) {
      collectArrays(node[0], `${path}[0]`, out, depth + 1);
    }
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      collectArrays(v, path ? `${path}.${k}` : k, out, depth + 1);
    }
  }
}

/**
 * Trim arrays (whole items only, largest first, halving) until the payload
 * fits. Returns null when it can't fit without cutting mid-item.
 */
function trimToFit(value: unknown, max: number): string | null {
  let working: unknown;
  try {
    working = JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
  const dropped: Record<string, { returned: number; total: number }> = {};
  let arrays: ArrayRef[] = [];
  collectArrays(working, "", arrays, 0);
  arrays = arrays.filter((a) => a.array.length > 2);
  arrays.sort((a, b) => b.array.length - a.array.length);

  for (const ref of arrays) {
    if (JSON.stringify(working).length <= max) break;
    const total = ref.array.length;
    while (ref.array.length > 2 && JSON.stringify(working).length > max) {
      ref.array.length = Math.max(2, Math.floor(ref.array.length / 2));
    }
    if (ref.array.length < total) {
      dropped[ref.path || "items"] = { returned: ref.array.length, total };
    }
  }
  if (JSON.stringify(working).length > max) return null;

  const root =
    typeof working === "object" && working != null && !Array.isArray(working)
      ? (working as Record<string, unknown>)
      : ({ items: working } as Record<string, unknown>);
  root.truncated = true;
  if (Object.keys(dropped).length) root.dropped = dropped;
  root.message =
    "Some list items were dropped to fit the output budget — narrow the request (filters, pagination) to see them all.";
  const out = JSON.stringify(root);
  return out.length <= max + 400 ? out : null;
}

export function toolOk(payload: Record<string, unknown> = {}, max?: number | null) {
  return toolResult({ ok: true, ...payload }, max === undefined ? DEFAULT_MAX : max);
}

export function toolOkFull(payload: Record<string, unknown> = {}) {
  return toolResult({ ok: true, ...payload }, null);
}

export function toolErr(error: string) {
  return toolResult({ ok: false, error });
}
