import type { PostHog } from "posthog-js";

const UTM_STORAGE_KEY = "bananalabs:utm_source";

let client: PostHog | null = null;

function envKey(): string {
  return (import.meta.env.VITE_POSTHOG_KEY ?? "").trim();
}

function envHost(): string {
  return (import.meta.env.VITE_POSTHOG_HOST ?? "").trim();
}

export function analyticsEnabled(): boolean {
  return Boolean(envKey() && envHost());
}

function automationSkip(): boolean {
  try {
    return Boolean(navigator.webdriver);
  } catch {
    return false;
  }
}

function firstUtmSource(): string | undefined {
  try {
    const fromUrl = new URLSearchParams(location.search).get("utm_source")?.trim();
    if (fromUrl) {
      const clipped = fromUrl.slice(0, 64);
      localStorage.setItem(UTM_STORAGE_KEY, clipped);
      return clipped;
    }
    return localStorage.getItem(UTM_STORAGE_KEY)?.slice(0, 64) || undefined;
  } catch {
    return undefined;
  }
}

/** No-op when env is unset (open-source clones, local eval, CI). */
export async function initAnalytics(): Promise<void> {
  if (client || !analyticsEnabled() || automationSkip()) return;

  const { default: posthog } = await import("posthog-js");
  const utm = firstUtmSource();

  posthog.init(envKey(), {
    api_host: envHost(),
    defaults: "2026-05-30",
    person_profiles: "identified_only",
    capture_pageview: true,
    autocapture: false,
    persistence: "localStorage",
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: ".ph-mask",
    },
  });

  if (utm) posthog.register({ utm_source: utm });
  client = posthog;
}

export function registerContext(props: Record<string, string | number | boolean>): void {
  client?.register(props);
}

type CaptureValue = string | number | boolean | string[];

export function capture(
  event: string,
  properties?: Record<string, CaptureValue | null | undefined>,
): void {
  if (!client || automationSkip()) return;
  const cleaned: Record<string, CaptureValue> = {};
  if (properties) {
    for (const [k, v] of Object.entries(properties)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      cleaned[k] = v;
    }
  }
  client.capture(event, cleaned);
}
