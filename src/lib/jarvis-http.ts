import { isTauri } from "./tauri";

export const JARVIS_API_BASE =
  import.meta.env?.VITE_JARVIS_URL ?? "http://127.0.0.1:8788";

/** WebKit reports blocked/CORS localhost fetches as a bare "Load failed". */
export function mapJarvisFetchError(
  err: unknown,
  baseUrl = JARVIS_API_BASE,
): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message === "Load failed" ||
    message === "Failed to fetch" ||
    message.includes("error sending request for url")
  ) {
    return new Error(`Cannot reach Jarvis at ${baseUrl}`);
  }
  return err instanceof Error ? err : new Error(message);
}

export async function jarvisFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    if (isTauri()) {
      const { fetch } = await import("@tauri-apps/plugin-http");
      return await fetch(input, init);
    }
    return await fetch(input, init);
  } catch (err) {
    throw mapJarvisFetchError(err);
  }
}
