import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

const unreliableReads = new Set<string>();

export function isLocalForageStorageReadReliable(name: string) {
    return !unreliableReads.has(name);
}

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            const value = (await localforage.getItem<string>(name)) || null;
            unreliableReads.delete(name);
            return value;
        } catch {
            unreliableReads.add(name);
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};
