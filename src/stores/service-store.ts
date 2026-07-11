import { create } from "zustand";
import { getDefaultService, type ServiceDefinition } from "@/config/services";
import {
  loadBookmarks,
  saveBookmarks,
  loadLastPath,
  saveLastPath,
  type Bookmark,
} from "@/lib/token-store";

// Stable reference so the getBookmarksForService selector doesn't return a new
// array each render (React 19 + Zustand 5 treat that as a changing snapshot).
const EMPTY_BOOKMARKS: Bookmark[] = [];

const MENU_COLLAPSED_KEY = "tendencys.menuCollapsed";

function loadMenuCollapsed(): boolean {
  try {
    return localStorage.getItem(MENU_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

type ServiceState = {
  activeService: ServiceDefinition;
  bookmarks: Record<string, Bookmark[]>;
  lastPaths: Record<string, string>;
  /** Per-service flag: login-sites / server SSO already opened this shell session. */
  ssoInitiated: Record<string, boolean>;
  /** Single collapsible service menu: icon rail (collapsed) or icon+label list (expanded). */
  menuCollapsed: boolean;
  setActiveService: (service: ServiceDefinition) => void;
  toggleMenuCollapsed: () => void;
  loadServiceData: (serviceId: string) => Promise<void>;
  addBookmark: (serviceId: string, bookmark: Bookmark) => Promise<void>;
  removeBookmark: (serviceId: string, bookmarkId: string) => Promise<void>;
  setLastPath: (serviceId: string, path: string) => Promise<void>;
  markSsoInitiated: (serviceId: string) => void;
  clearSsoInitiatedFor: (serviceId: string) => void;
  clearSsoInitiated: () => void;
  getBookmarksForService: (serviceId: string) => Bookmark[];
  getLastPathForService: (serviceId: string) => string | undefined;
};

export const useServiceStore = create<ServiceState>((set, get) => ({
  activeService: getDefaultService(),
  bookmarks: {},
  lastPaths: {},
  ssoInitiated: {},
  menuCollapsed: loadMenuCollapsed(),

  setActiveService: (service) => {
    set({ activeService: service });
  },

  toggleMenuCollapsed: () => {
    const next = !get().menuCollapsed;
    try {
      localStorage.setItem(MENU_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // ignore storage failures (e.g. private mode)
    }
    set({ menuCollapsed: next });
  },

  loadServiceData: async (serviceId) => {
    const [bookmarks, lastPath] = await Promise.all([
      loadBookmarks(serviceId),
      loadLastPath(serviceId),
    ]);

    set((state) => ({
      bookmarks: { ...state.bookmarks, [serviceId]: bookmarks },
      lastPaths: lastPath
        ? { ...state.lastPaths, [serviceId]: lastPath }
        : state.lastPaths,
    }));
  },

  addBookmark: async (serviceId, bookmark) => {
    const current = get().bookmarks[serviceId] ?? [];
    const updated = [...current, bookmark];
    await saveBookmarks(serviceId, updated);
    set((state) => ({
      bookmarks: { ...state.bookmarks, [serviceId]: updated },
    }));
  },

  removeBookmark: async (serviceId, bookmarkId) => {
    const current = get().bookmarks[serviceId] ?? [];
    const updated = current.filter((b) => b.id !== bookmarkId);
    await saveBookmarks(serviceId, updated);
    set((state) => ({
      bookmarks: { ...state.bookmarks, [serviceId]: updated },
    }));
  },

  setLastPath: async (serviceId, path) => {
    await saveLastPath(serviceId, path);
    set((state) => ({
      lastPaths: { ...state.lastPaths, [serviceId]: path },
    }));
  },

  markSsoInitiated: (serviceId) => {
    set((state) => ({
      ssoInitiated: { ...state.ssoInitiated, [serviceId]: true },
    }));
  },

  clearSsoInitiatedFor: (serviceId) => {
    set((state) => {
      if (!state.ssoInitiated[serviceId]) {
        return state;
      }
      const next = { ...state.ssoInitiated };
      delete next[serviceId];
      return { ssoInitiated: next };
    });
  },

  clearSsoInitiated: () => {
    set({ ssoInitiated: {} });
  },

  getBookmarksForService: (serviceId) =>
    get().bookmarks[serviceId] ?? EMPTY_BOOKMARKS,

  getLastPathForService: (serviceId) => get().lastPaths[serviceId],
}));
