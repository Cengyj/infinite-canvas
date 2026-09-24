import "./storage-setup";

// Browser configuration stays in memory during service tests.
if (typeof globalThis.localStorage === "undefined") {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            get length() { return values.size; },
            clear: () => values.clear(),
            getItem: (key: string) => values.get(String(key)) ?? null,
            key: (index: number) => [...values.keys()][index] ?? null,
            removeItem: (key: string) => values.delete(String(key)),
            setItem: (key: string, value: string) => values.set(String(key), String(value)),
        } satisfies Storage,
    });
}
