import * as Sentry from "@sentry/react";
import type { Breadcrumb, ErrorEvent, EventHint } from "@sentry/react";
import { invoke } from "@tauri-apps/api/core";

type SentryTransport = ReturnType<typeof Sentry.createTransport>;

// The Rust process (tauri-plugin-sentry) owns the real DSN and transport. The
// browser SDK forwards every envelope/breadcrumb to Rust over IPC, so the
// webview never talks to Sentry directly and never embeds a real DSN. The IPC
// command names are the plugin's stable contract. We reproduce the plugin's own
// `defaultOptions` (rather than adding `tauri-plugin-sentry-api`, which pins an
// incompatible beta `@tauri-apps/api`) and layer PII scrubbing on top.

let ipcFailed = false;

/** Keys / query params that carry an auth secret we must never ship. */
const SENSITIVE = /authorization|_atid|token|redirect_url|cookie/i;

/** Redact sensitive query-string values from a URL, keeping the path for triage. */
function scrubUrl(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;
  const base = url.slice(0, queryStart);
  const scrubbed = url
    .slice(queryStart + 1)
    .split("&")
    .map((pair) => {
      const key = pair.split("=")[0] ?? "";
      return SENSITIVE.test(key) ? `${key}=[Filtered]` : pair;
    })
    .join("&");
  return `${base}?${scrubbed}`;
}

/** Recursively redact sensitive keys and secret-bearing URLs from any value. */
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes("://") && value.includes("?") ? scrubUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE.test(key) ? "[Filtered]" : scrubDeep(val);
    }
    return out;
  }
  return value;
}

/** Transport that hands each envelope to the Rust process via Tauri invoke. */
function makeRendererTransport(
  options: Parameters<typeof Sentry.createTransport>[0],
): SentryTransport {
  return Sentry.createTransport(options, async (request) => {
    const ok = { statusCode: 200 };
    if (ipcFailed) return ok;
    try {
      await invoke("plugin:sentry|envelope", { envelope: request.body });
    } catch (error) {
      // Usually a missing capability; stop retrying so we don't spam the console.
      console.error("[sentry] failed to forward envelope to Rust:", error);
      ipcFailed = true;
    }
    return ok;
  });
}

/** `beforeBreadcrumb`: scrub, then forward the breadcrumb to Rust (which owns them). */
function beforeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (ipcFailed) return null;
  const url = breadcrumb.data?.url;
  // Ignore IPC breadcrumbs or we'd create an infinite loop.
  if (
    typeof url === "string" &&
    (url.startsWith("ipc://") || /^https?:\/\/ipc\.localhost/.test(url))
  ) {
    return null;
  }
  const scrubbed = { ...breadcrumb, data: scrubDeep(breadcrumb.data) as Breadcrumb["data"] };
  invoke("plugin:sentry|breadcrumb", { breadcrumb: scrubbed }).catch((error) => {
    console.error("[sentry] failed to forward breadcrumb to Rust:", error);
    ipcFailed = true;
  });
  // Breadcrumbs are collected in Rust, not the renderer.
  return null;
}

/** `beforeSend`: last-line PII scrub for events that reach the transport. */
function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  if (event.request?.url) event.request.url = scrubUrl(event.request.url);
  if (event.request?.query_string && typeof event.request.query_string === "string") {
    event.request.query_string = scrubUrl(`?${event.request.query_string}`).replace(/^\?/, "");
  }
  if (event.request?.headers) {
    for (const key of Object.keys(event.request.headers)) {
      if (SENSITIVE.test(key)) event.request.headers[key] = "[Filtered]";
    }
  }
  if (event.request?.cookies) delete event.request.cookies;
  if (event.request?.data) event.request.data = scrubDeep(event.request.data);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
      ...crumb,
      data: scrubDeep(crumb.data) as Breadcrumb["data"],
    }));
  }
  if (event.extra) event.extra = scrubDeep(event.extra) as ErrorEvent["extra"];
  return event;
}

/**
 * Initialise the shell's Sentry SDK. A dummy DSN is required for the SDK to
 * start; nothing is ever sent from the browser — the transport routes envelopes
 * to Rust, which holds the real DSN. Safe to call when Rust Sentry is disabled:
 * the transport silently no-ops after the first failed IPC call.
 */
export function initSentry(): void {
  Sentry.init({
    dsn: "https://[email protected]/0",
    environment: import.meta.env.PROD ? "production" : "development",
    // Tracing is disabled; this is error/crash reporting only.
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // App sessions are tracked in Rust; drop the browser session integration.
    integrations: (integrations) =>
      integrations.filter((integration) => integration.name !== "BrowserSession"),
    transport: makeRendererTransport,
    beforeBreadcrumb,
    beforeSend,
  });
}
