import { create } from "zustand";
import type { OpsNodeId } from "@/config/ops-scene";
import type { OpsVehicleKind } from "@/config/ops-world";
import type { OpsSourceMode } from "@/lib/ops-sim/types";

export type OpsSpeed = 1 | 2 | 5;

export type OpsSelection =
  | { type: "building"; nodeId: OpsNodeId }
  | { type: "vehicle"; vehicleId: string; kind: OpsVehicleKind }
  | null;

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

type OpsWorldState = {
  paused: boolean;
  speed: OpsSpeed;
  /** `sim` is live now; `live`/`replay` are scaffolded for the future feed. */
  mode: OpsSourceMode;
  selection: OpsSelection;
  setPaused: (paused: boolean) => void;
  togglePaused: () => void;
  setSpeed: (speed: OpsSpeed) => void;
  setMode: (mode: OpsSourceMode) => void;
  select: (selection: OpsSelection) => void;
  clearSelection: () => void;
};

export const useOpsWorldStore = create<OpsWorldState>((set, get) => ({
  paused: prefersReducedMotion(),
  speed: 1,
  mode: "sim",
  selection: null,
  setPaused: (paused) => set({ paused }),
  togglePaused: () => set({ paused: !get().paused }),
  setSpeed: (speed) => set({ speed }),
  setMode: (mode) => set({ mode }),
  select: (selection) => set({ selection }),
  clearSelection: () => set({ selection: null }),
}));
