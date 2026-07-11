import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "@/lib/tauri";

export type InstalledUpdate = {
  version: string;
};

/**
 * Silent auto-update: on launch, check the hosted manifest and, if a newer
 * version exists, download + install it in the background with no user action.
 * We do NOT relaunch here — the shell holds live product webview sessions, so
 * the update is applied on the next natural restart. Returns the installed
 * version (to offer an optional "restart to finish" nudge) or null.
 */
export async function silentUpdateOnLaunch(): Promise<InstalledUpdate | null> {
  if (!isTauri()) return null;

  try {
    const update = await check();
    if (!update) return null;

    await update.downloadAndInstall();
    return { version: update.version };
  } catch (err) {
    console.warn("[updater] silent update failed", err);
    return null;
  }
}

/** Relaunch the app to finish applying an already-installed update. */
export async function restartToApplyUpdate(): Promise<void> {
  if (!isTauri()) return;
  await relaunch();
}
