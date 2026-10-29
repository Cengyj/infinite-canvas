import localforage from "localforage";
import { create } from "zustand";

type Scenario = "image" | "video";
type Requirement = { scenario: Scenario; text: string };
type Requirements = Record<Scenario, string[]>;

type PromptOptimizationStore = {
    items: Requirements;
    loaded: boolean;
    loading: boolean;
    error: string | null;
    load: () => Promise<void>;
    save: (scenario: Scenario, text: string) => Promise<void>;
    remove: (scenario: Scenario, text: string) => Promise<void>;
};

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "prompt_optimization_requirements" });
const keyFor = (scenario: Scenario, text: string) => JSON.stringify([scenario, text]);

function readRequirement(value: unknown, key: string): Requirement {
    const item = value as Partial<Requirement> | null;
    if (!item || (item.scenario !== "image" && item.scenario !== "video") || typeof item.text !== "string" || !item.text || item.text !== item.text.trim() || key !== keyFor(item.scenario, item.text)) {
        throw new Error("收藏的补充要求数据损坏，未覆盖原数据");
    }
    return { scenario: item.scenario, text: item.text };
}

export const usePromptOptimizationStore = create<PromptOptimizationStore>((set, get) => {
    let queue = Promise.resolve();
    const run = (operation: () => Promise<void>) => {
        const pending = queue.then(async () => {
            set({ error: null });
            try {
                await operation();
            } catch (cause) {
                set({ error: cause instanceof Error ? cause.message : "补充要求存储操作失败" });
                throw cause;
            }
        });
        queue = pending.catch(() => {});
        return pending;
    };

    const load = async () => {
        set({ loading: true });
        try {
            const items: Requirements = { image: [], video: [] };
            await storage.iterate((value, key) => {
                const item = readRequirement(value, key);
                items[item.scenario].push(item.text);
            });
            items.image.sort();
            items.video.sort();
            set({ items, loaded: true });
        } catch (cause) {
            set({ loaded: false });
            throw cause;
        } finally {
            set({ loading: false });
        }
    };

    const change = (scenario: Scenario, value: string, remove: boolean) => run(async () => {
        const text = value.trim();
        if (!text) throw new Error("请先填写补充要求");
        if (!get().loaded) await load();
        const key = keyFor(scenario, text);
        let existing: unknown;
        try {
            existing = await storage.getItem(key);
            if (existing !== null) readRequirement(existing, key);
        } catch (cause) {
            set({ loaded: false });
            throw cause;
        }
        if (remove) {
            if (existing !== null) await storage.removeItem(key);
        } else if (existing === null) {
            await storage.setItem(key, { scenario, text });
        }
        set((state) => ({
            items: {
                ...state.items,
                [scenario]: remove
                    ? state.items[scenario].filter((item) => item !== text)
                    : [...new Set([...state.items[scenario], text])].sort(),
            },
        }));
    });

    return {
        items: { image: [], video: [] },
        loaded: false,
        loading: false,
        error: null,
        load: () => run(load),
        save: (scenario, text) => change(scenario, text, false),
        remove: (scenario, text) => change(scenario, text, true),
    };
});
