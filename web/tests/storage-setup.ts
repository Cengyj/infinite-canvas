import { mock } from "bun:test";

export const storageValues = new Map<string, Map<string, unknown>>();
export const iterateBarriers = new Map<string, Promise<void>>();

function createMemoryStore({ storeName }: { storeName: string }) {
    const values = storageValues.get(storeName) || new Map<string, unknown>();
    storageValues.set(storeName, values);
    return {
        getItem: async (key: string) => values.get(key) ?? null,
        setItem: async (key: string, value: unknown) => { values.set(key, value); return value; },
        removeItem: async (key: string) => { values.delete(key); },
        clear: async () => values.clear(),
        keys: async () => [...values.keys()],
        length: async () => values.size,
        key: async (index: number) => [...values.keys()][index] ?? null,
        iterate: async (visit: (value: unknown, key: string) => unknown) => {
            await iterateBarriers.get(storeName);
            for (const [key, value] of values) {
                const result = visit(value, key);
                if (result !== undefined) return result;
            }
        },
    };
}

// Install before any application module creates its localforage instances.
mock.module("localforage", () => ({
    default: {
        ...createMemoryStore({ storeName: "app_state" }),
        config: () => undefined,
        createInstance: createMemoryStore,
    },
}));
