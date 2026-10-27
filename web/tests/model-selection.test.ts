import { afterAll, expect, test } from "bun:test";
import type { AiConfig, ModelCapability } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";

// Config and i18n use browser storage during module initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const configModulePath = require.resolve("../src/stores/use-config-store");
const originalConfigModule = require.cache[configModulePath];
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: globalThis.localStorage } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalConfigModule) require.cache[configModulePath] = originalConfigModule;
    else delete require.cache[configModulePath];
});

// Other suites may have initialized the shared module before browser storage existed.
delete require.cache[configModulePath];
const { createModelChannel, defaultBaseUrlForApiFormat, defaultConfig, resolveModelForCapability, useConfigStore, withChannels } = await import(configModulePath) as typeof import("../src/stores/use-config-store");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");

const config: AiConfig = {
    ...defaultConfig,
    videoModel: "replacement::video-b",
    channels: [
        {
            id: "replacement",
            name: "Replacement",
            baseUrl: "https://example.com",
            apiKey: "test-key",
            apiFormat: "openai",
            models: [
                { name: "video-b", capability: "video" },
                { name: "video-a", capability: "video" },
                { name: "image-a", capability: "image" },
            ],
        },
    ],
};
const ready = useConfigStore.getState().isAiConfigReady;
const videoNode = (model: string): CanvasNodeData => ({
    id: "saved-video",
    type: CanvasNodeType.Video,
    title: "Saved video",
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata: { model, videoTaskId: "original-task", videoTaskProvider: "openai", seconds: "4" },
});

test("a saved video on a removed provider is not replaced by the default video model", () => {
    const selected = buildGenerationConfig(config, videoNode("removed::video-a"), "video");
    expect(selected.model).toBe("removed::video-a");
    expect(ready(selected, selected.model)).toBe(false);
});

test("removing a model from an existing provider prevents retry even with valid credentials", () => {
    const selected = buildGenerationConfig(config, videoNode("replacement::deleted-video"), "video");
    expect(selected.model).toBe("replacement::deleted-video");
    expect(ready(selected, selected.model)).toBe(false);
});

test("task recovery rejects a missing provider instead of querying the first provider", () => {
    expect(ready(config, "removed::video-a")).toBe(false);
    expect(ready(config, "unknown-video")).toBe(false);
});

test("an explicitly selected unavailable default is not replaced by the built-in default", () => {
    const selected = buildGenerationConfig({ ...config, videoModel: "removed::video-a" }, undefined, "video");
    expect(selected.model).toBe("removed::video-a");
    expect(ready(selected, selected.model)).toBe(false);
});

test("a new node without a selection still uses its configured default", () => {
    const selected = buildGenerationConfig(config, undefined, "video");
    expect(selected.model).toBe("replacement::video-b");
    expect(ready(selected, selected.model)).toBe(true);
});

test("switching generation capability still selects a model of the new capability", () => {
    expect(resolveModelForCapability(config, "replacement::image-a", "video")).toBe("replacement::video-b");
});

test("changing only the key on the same provider preserves the saved model and task", () => {
    const node = videoNode("replacement::video-a");
    const selected = buildGenerationConfig({ ...config, channels: [{ ...config.channels[0], apiKey: "rotated-key" }] }, node, "video");
    expect(selected.model).toBe("replacement::video-a");
    expect(ready(selected, selected.model)).toBe(true);
    expect(node.metadata?.videoTaskId).toBe("original-task");
    expect(ready({ ...selected, channels: [{ ...config.channels[0], apiKey: "" }] }, selected.model)).toBe(false);
});

test("unavailable explicit selections are preserved for every generation capability", () => {
    for (const capability of ["image", "video", "text", "audio"] as ModelCapability[]) {
        expect(resolveModelForCapability(config, `removed::${capability}`, capability)).toBe(`removed::${capability}`);
    }
});

const defaultSelections = [["imageModel", "image"], ["videoModel", "video"], ["textModel", "text"], ["audioModel", "audio"]] as const;
const selectionConfig: AiConfig = {
    ...config,
    imageModel: "selected::image",
    videoModel: "selected::video",
    textModel: "selected::text",
    audioModel: "selected::audio",
    channels: [{
        ...config.channels[0],
        id: "selected",
        models: defaultSelections.flatMap(([, capability]) => [
            { name: capability, capability },
            { name: capability + "-replacement", capability },
        ]),
    }],
};
const hydrateConfig = (saved: AiConfig) => useConfigStore.persist.getOptions().merge!({ config: saved }, useConfigStore.getState()).config;

test("saving a removed model preserves its explicit default through hydration", () => {
    for (const [field, capability] of defaultSelections) {
        const channels = [{ ...selectionConfig.channels[0], models: selectionConfig.channels[0].models.filter((model) => model.name !== capability) }];
        const saved = withChannels(selectionConfig, channels);
        const hydrated = hydrateConfig(saved);
        expect(saved[field]).toBe(selectionConfig[field]);
        expect(hydrated[field]).toBe(selectionConfig[field]);
        expect(ready(saved, saved[field])).toBe(false);
        expect(ready(hydrated, hydrated[field])).toBe(false);
    }
});

test("saving a removed channel does not reroute defaults to matching models on another channel", () => {
    const saved = withChannels(selectionConfig, [{ ...selectionConfig.channels[0], id: "other" }]);
    const hydrated = hydrateConfig(saved);
    for (const [field] of defaultSelections) {
        expect(saved[field]).toBe(selectionConfig[field]);
        expect(hydrated[field]).toBe(selectionConfig[field]);
        expect(ready(hydrated, hydrated[field])).toBe(false);
    }
});

test("an explicit capability change still chooses a model of the required capability", () => {
    const channels = [{ ...selectionConfig.channels[0], models: selectionConfig.channels[0].models.map((model) => model.name === "image" ? { ...model, capability: "text" as const } : model) }];
    const saved = withChannels(selectionConfig, channels);
    expect(saved.imageModel).toBe("selected::image-replacement");
    expect(hydrateConfig(saved).imageModel).toBe("selected::image-replacement");
    expect(saved.textModel).toBe(selectionConfig.textModel);
});

test("saving channels still selects an available model when no default was selected", () => {
    const saved = withChannels({ ...selectionConfig, imageModel: "", videoModel: "", textModel: "", audioModel: "" }, selectionConfig.channels);
    for (const [field] of defaultSelections) expect(saved[field]).toBe(selectionConfig[field]);
});

test("an explicitly cleared channel URL stays empty and unusable after save and hydration", () => {
    const saved = withChannels(selectionConfig, [{ ...selectionConfig.channels[0], baseUrl: "" }]);
    const hydrated = hydrateConfig(saved);
    expect(saved.channels[0].baseUrl).toBe("");
    expect(hydrated.channels[0].baseUrl).toBe("");
    expect(hydrated.channels[0].apiKey).toBe(selectionConfig.channels[0].apiKey);
    expect(ready(saved, saved.videoModel)).toBe(false);
    expect(ready(hydrated, hydrated.videoModel)).toBe(false);
});

test("channel creation defaults only an omitted URL and preserves explicit blank or custom URLs", () => {
    for (const apiFormat of ["openai", "gemini"] as const) {
        expect(createModelChannel({ apiFormat }).baseUrl).toBe(defaultBaseUrlForApiFormat(apiFormat));
        expect(createModelChannel({ apiFormat, baseUrl: "" }).baseUrl).toBe("");
        expect(createModelChannel({ apiFormat, baseUrl: "  " }).baseUrl).toBe("");
        expect(createModelChannel({ apiFormat, baseUrl: " https://custom.example/v1 " }).baseUrl).toBe("https://custom.example/v1");
    }
});

test("hydration preserves saved channel models, script, and custom URL without injecting presets", () => {
    const channel = { ...selectionConfig.channels[0], baseUrl: "https://custom.example/v1", models: [{ name: "custom", capability: "text" as const, script: "return 'custom';" }] };
    const hydrated = hydrateConfig({ ...selectionConfig, channels: [channel], textModel: "selected::custom" });
    expect(hydrated.channels.map((item) => item.id)).toEqual([channel.id]);
    expect(hydrated.channels[0].baseUrl).toBe(channel.baseUrl);
    expect(hydrated.channels[0].apiKey).toBe(channel.apiKey);
    expect(hydrated.channels[0].models).toEqual(channel.models);
    expect(hydrated.textModel).toBe("selected::custom");
});

test("an explicitly empty channel list stays empty despite retained legacy credentials", () => {
    const saved = withChannels({ ...defaultConfig, baseUrl: "https://legacy.example", apiKey: "old-test-key" }, []);
    const hydrated = hydrateConfig(saved);
    expect(saved.channels).toEqual([]);
    expect(hydrated.channels).toEqual([]);
    expect(hydrated.models).toEqual([]);
    expect(hydrated.imageModel).toBe(defaultConfig.imageModel);
    expect(ready(hydrated, hydrated.imageModel)).toBe(false);
    expect(ready(hydrated, hydrated.videoModel)).toBe(false);
});

test("without persisted configuration hydration retains both built-in channels and presets", () => {
    const hydrated = useConfigStore.persist.getOptions().merge!(undefined, useConfigStore.getState()).config;
    expect(hydrated.channels.map((channel) => channel.id)).toEqual(defaultConfig.channels.map((channel) => channel.id));
    expect(hydrated.models).toEqual(defaultConfig.models);
    expect(hydrated.imageModel).toBe(defaultConfig.imageModel);
    expect(hydrated.videoModel).toBe(defaultConfig.videoModel);
    expect(hydrated.textModel).toBe(defaultConfig.textModel);
    expect(hydrated.audioModel).toBe(defaultConfig.audioModel);
});
