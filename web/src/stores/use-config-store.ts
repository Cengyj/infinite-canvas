import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";

export type ApiCallFormat = "openai" | "gemini";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoMode: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    background: string;
    count: string;
    canvasImageCount: string;
    proxyEnabled: boolean;
    proxyUrl: string;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "local-proxy" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export type ChannelCredentialsImportResult = {
    status: "created" | "updated" | "missing-base-url" | "invalid-base-url";
    channelName?: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CONFIG_STORE_VERSION = 1;
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://direct.foropencode.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
export const LOCAL_PROXY_PACKAGE = "@basketikun/canvas-proxy";
export const DEFAULT_LOCAL_PROXY_URL = "http://127.0.0.1:23210";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: OPENAI_BASE_URL,
    apiKey: "",
    apiFormat: "openai",
    channels: [
        {
            id: "default",
            name: "OpenAI",
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "openai",
            models: [
                { name: "gpt-image-2", capability: "image" },
                { name: "grok-imagine-video", capability: "video" },
                { name: "gpt-6-sol", capability: "text" },
                { name: "gpt-4o-mini-tts", capability: "audio" },
            ],
        },
        {
            id: "google",
            name: "Google",
            baseUrl: OPENAI_BASE_URL,
            apiKey: "",
            apiFormat: "gemini",
            models: [
                { name: "gemini-2.5-flash-image-preview", capability: "image" },
                { name: "gemini-3-pro-image-preview", capability: "image" },
                { name: "gemini-3.1-flash-image-preview", capability: "image" },
            ],
        },
    ],
    model: "default::gpt-image-2",
    imageModel: "default::gpt-image-2",
    videoModel: "default::grok-imagine-video",
    textModel: "default::gpt-6-sol",
    audioModel: "default::gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoMode: "frames",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: [
        "default::gpt-image-2",
        "default::grok-imagine-video",
        "default::gpt-6-sol",
        "default::gpt-4o-mini-tts",
        "google::gemini-2.5-flash-image-preview",
        "google::gemini-3-pro-image-preview",
        "google::gemini-3.1-flash-image-preview",
    ],
    quality: "auto",
    size: "1:1",
    background: "",
    count: "1",
    canvasImageCount: "3",
    proxyEnabled: false,
    proxyUrl: DEFAULT_LOCAL_PROXY_URL,
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    importChannelCredentials: (input: { baseUrl?: string | null; apiKey?: string | null }) => ChannelCredentialsImportResult;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    replaceConfig: (config: Partial<AiConfig>, webdav?: Partial<WebdavSyncConfig>) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo"];

export function boolConfig(value: string, fallback: boolean) {
    return value ? value === "true" : fallback;
}
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name));
    const model = channel?.models.find((item) => item.name === name);
    return channel && model ? { channel, model } : null;
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    if (currentModel && modelMatchesCapability(config, currentModel, capability)) return currentModel;
    if (defaultModel && modelMatchesCapability(config, defaultModel, capability)) return defaultModel;
    if (fallbackModel && modelMatchesCapability(config, fallbackModel, capability)) return fallbackModel;
    return selectableModelsByCapability(config, capability)[0] || "";
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && channel.apiKey.trim());
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            importChannelCredentials: (input) => {
                const currentConfig = get().config;
                const result = upsertChannelCredentials(currentConfig, input);
                if (result.config !== currentConfig) set({ config: result.config });
                return { status: result.status, channelName: result.channelName };
            },
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            replaceConfig: (config, webdav) =>
                set((state) => ({
                    config: normalizeAiConfig(config),
                    webdav: webdav ? normalizeWebdavSyncConfig(webdav) : state.webdav,
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            version: CONFIG_STORE_VERSION,
            migrate: (persisted, version) => {
                if (version !== 0) throw new Error(`Unsupported config store version: ${version}`);
                return persisted as Pick<ConfigStore, "config" | "webdav">;
            },
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                return {
                    ...current,
                    config: normalizeAiConfig(persistedState.config),
                    webdav: normalizeWebdavSyncConfig(persistedState.webdav),
                };
            },
        },
    ),
);

export function normalizeAiConfig(persistedConfig?: Partial<AiConfig>): AiConfig {
    const hasPersistedConfig = Boolean(persistedConfig && typeof persistedConfig === "object" && !Array.isArray(persistedConfig));
    const raw = hasPersistedConfig ? (persistedConfig as Record<string, unknown>) : {};
    const config = { ...defaultConfig, ...raw } as AiConfig;
    const hasPersistedChannels = Object.prototype.hasOwnProperty.call(raw, "channels");
    const hasValidPersistedChannels = Array.isArray(raw.channels);
    if (hasPersistedChannels) config.channels = hasValidPersistedChannels ? (raw.channels as ModelChannel[]) : [];
    else if (hasPersistedConfig) config.channels = [];
    if (Object.prototype.hasOwnProperty.call(raw, "models")) config.models = Array.isArray(raw.models) ? raw.models.filter((model): model is string => typeof model === "string") : [];
    else if (hasPersistedConfig && !hasPersistedChannels) config.models = [];
    const stringDefaults: Array<[keyof AiConfig, string]> = [
        ["baseUrl", defaultConfig.baseUrl],
        ["apiKey", defaultConfig.apiKey],
        ["model", defaultConfig.model],
        ["imageModel", defaultConfig.imageModel],
        ["videoModel", defaultConfig.videoModel],
        ["textModel", defaultConfig.textModel],
        ["audioModel", defaultConfig.audioModel],
        ["audioVoice", defaultConfig.audioVoice],
        ["audioFormat", defaultConfig.audioFormat],
        ["audioSpeed", defaultConfig.audioSpeed],
        ["audioInstructions", defaultConfig.audioInstructions],
        ["videoSeconds", defaultConfig.videoSeconds],
        ["vquality", defaultConfig.vquality],
        ["videoGenerateAudio", defaultConfig.videoGenerateAudio],
        ["videoWatermark", defaultConfig.videoWatermark],
        ["videoMode", defaultConfig.videoMode],
        ["systemPrompt", defaultConfig.systemPrompt],
        ["quality", defaultConfig.quality],
        ["size", defaultConfig.size],
        ["background", defaultConfig.background],
        ["count", defaultConfig.count],
        ["canvasImageCount", defaultConfig.canvasImageCount],
        ["proxyUrl", defaultConfig.proxyUrl],
    ];
    for (const [key, fallback] of stringDefaults) {
        if (typeof config[key] !== "string") (config[key] as unknown as string) = fallback;
    }
    if (hasPersistedConfig && !hasPersistedChannels) {
        for (const key of ["model", "imageModel", "videoModel", "textModel", "audioModel"] as const) {
            if (typeof raw[key] !== "string") config[key] = "";
        }
    }
    config.proxyEnabled = typeof config.proxyEnabled === "boolean" ? config.proxyEnabled : defaultConfig.proxyEnabled;
    config.reasoningEffort = ["auto", "low", "medium", "high", "xhigh"].includes(config.reasoningEffort as string) ? config.reasoningEffort : defaultConfig.reasoningEffort;
    const channels = normalizeChannels(config, hasPersistedConfig && !hasPersistedChannels);
    const imageModel = normalizeDefaultModel(config.imageModel || config.model, channels, "image");
    return {
        ...config,
        channelMode: "local",
        apiFormat: normalizeApiFormat(config.apiFormat),
        channels,
        models: modelOptionsFromChannels(channels),
        model: imageModel,
        imageModel,
        videoModel: normalizeDefaultModel(config.videoModel, channels, "video"),
        textModel: normalizeDefaultModel(config.textModel || config.model, channels, "text"),
        audioModel: normalizeDefaultModel(config.audioModel || defaultConfig.audioModel, channels, "audio"),
        audioVoice: config.audioVoice || defaultConfig.audioVoice,
        audioFormat: config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: config.audioInstructions || "",
        reasoningEffort: config.reasoningEffort || "auto",
        videoSeconds: config.videoSeconds || "6",
        vquality: config.vquality || "720",
        videoGenerateAudio: config.videoGenerateAudio || "true",
        videoWatermark: config.videoWatermark || "false",
        videoMode: config.videoMode === "reference" ? "reference" : "frames",
        canvasImageCount: config.canvasImageCount || "3",
        proxyEnabled: Boolean(config.proxyEnabled),
        proxyUrl: config.proxyUrl || DEFAULT_LOCAL_PROXY_URL,
    };
}

export function normalizeWebdavSyncConfig(config?: Partial<WebdavSyncConfig>): WebdavSyncConfig {
    return {
        url: typeof config?.url === "string" ? config.url : defaultWebdavSyncConfig.url,
        username: typeof config?.username === "string" ? config.username : defaultWebdavSyncConfig.username,
        password: typeof config?.password === "string" ? config.password : defaultWebdavSyncConfig.password,
        directory: typeof config?.directory === "string" ? config.directory : defaultWebdavSyncConfig.directory,
        lastSyncedAt: typeof config?.lastSyncedAt === "string" ? config.lastSyncedAt : defaultWebdavSyncConfig.lastSyncedAt,
    };
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of Array.isArray(models) ? models : []) {
        const raw = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : undefined;
        const rawName = typeof item === "string" ? item : raw?.name;
        const name = typeof rawName === "string" ? rawName.trim() : "";
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const rawCapability = raw?.capability;
        const capability = rawCapability === "image" || rawCapability === "video" || rawCapability === "text" || rawCapability === "audio" ? rawCapability : guessCapability(name);
        const script = typeof raw?.script === "string" ? raw.script.trim() || undefined : undefined;
        result.push({ name, capability, script });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    const id = typeof channel?.id === "string" ? channel.id.trim() : "";
    const name = typeof channel?.name === "string" ? channel.name.trim() : "";
    const baseUrl = typeof channel?.baseUrl === "string" ? channel.baseUrl.trim() : "";
    const apiKey = typeof channel?.apiKey === "string" ? channel.apiKey : "";
    return {
        id: id || nanoid(),
        name: name || i18n.t("config.channels.newName"),
        baseUrl: baseUrl || defaultBaseUrlForApiFormat(apiFormat),
        apiKey,
        apiFormat,
        models: normalizeChannelModels(Array.isArray(channel?.models) ? channel.models : []),
    };
}

export function upsertChannelCredentials(
    config: AiConfig,
    input: { baseUrl?: string | null; apiKey?: string | null },
): ChannelCredentialsImportResult & { config: AiConfig } {
    const rawBaseUrl = input.baseUrl?.trim() || "";
    if (!rawBaseUrl) return { status: "missing-base-url", config };
    if (!isHttpBaseUrl(rawBaseUrl)) return { status: "invalid-base-url", config };

    const baseUrl = normalizeImportedBaseUrl(rawBaseUrl);
    const apiKey = input.apiKey?.trim() || "";
    const matchingIndex = config.channels.findIndex((channel) => normalizedBaseUrlKey(channel.baseUrl) === normalizedBaseUrlKey(baseUrl));

    if (matchingIndex >= 0) {
        const existing = config.channels[matchingIndex];
        if (existing.baseUrl === baseUrl && (!apiKey || existing.apiKey === apiKey)) {
            return { status: "updated", channelName: existing.name, config };
        }
        const updated = { ...existing, baseUrl, ...(apiKey ? { apiKey } : {}) };
        const channels = config.channels.map((channel, index) => (index === matchingIndex ? updated : channel));
        return { status: "updated", channelName: existing.name, config: { ...config, channels } };
    }

    const channel = createModelChannel({
        name: importedChannelName(baseUrl),
        baseUrl,
        apiKey,
        apiFormat: "openai",
        models: [],
    });
    return { status: "created", channelName: channel.name, config: { ...config, channels: [...config.channels, channel] } };
}

function isHttpBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
    } catch {
        return false;
    }
}

function normalizedBaseUrlKey(baseUrl: string) {
    try {
        const url = new URL(normalizeImportedBaseUrl(baseUrl));
        url.pathname = url.pathname.replace(/\/v1$/i, "");
        return url.toString();
    } catch {
        return baseUrl.trim();
    }
}

function normalizeImportedBaseUrl(baseUrl: string) {
    const url = new URL(baseUrl.trim());
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.hash = "";
    return url.toString();
}

function importedChannelName(baseUrl: string) {
    const hostname = new URL(baseUrl).hostname;
    return hostname.replace(/^(?:www|api)\./i, "") || i18n.t("config.channels.newName");
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    return channel ? `${decoded.model}（${channel.name}）` : decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        return channel && channel.models.some((item) => item.name === decoded.model) ? model : "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return matched || config.channels[0] || createModelChannel({ id: "default", name: i18n.t("config.channels.defaultName"), baseUrl: config.baseUrl, apiKey: config.apiKey, apiFormat: config.apiFormat, models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })) });
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
    };
}

function normalizeChannels(config: AiConfig, allowLegacyFallback = true) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.flatMap((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const channel = value as Partial<ModelChannel>;
        return [
            createModelChannel({
                ...channel,
                id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
                name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
                models: normalizeChannelModels(channel.models),
            }),
        ];
    });
    if (!channels.length && allowLegacyFallback) {
        channels.push(
            createModelChannel({
                id: "default",
                name: i18n.t("config.channels.defaultName"),
                baseUrl: config.baseUrl || defaultConfig.baseUrl,
                apiKey: config.apiKey || "",
                apiFormat: config.apiFormat || defaultConfig.apiFormat,
                models: normalizeChannelModels([...config.models, config.model, config.imageModel, config.videoModel, config.textModel, config.audioModel].map(modelOptionName)),
            }),
        );
    }
    return channels;
}

function normalizeDefaultModel(value: string | undefined, channels: ModelChannel[], capability: ModelCapability) {
    const options = channels.flatMap((channel) => channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name)));
    const normalized = normalizeModelOptionValue(value, channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" ? apiFormat : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

/** Join an API path before query/hash components instead of appending after them. */
export function appendUrlPath(baseUrl: string, path: string) {
    const base = new URL(baseUrl);
    const suffix = new URL(path, base.origin);
    const basePath = base.pathname.replace(/\/+$/, "");
    const suffixPath = suffix.pathname.replace(/^\/+/, "");
    base.pathname = `${basePath}/${suffixPath}` || "/";
    if (suffix.search) {
        const params = new URLSearchParams(base.search);
        suffix.searchParams.forEach((value, key) => params.append(key, value));
        base.search = params.toString();
    }
    // A fragment is client-side state and must never be sent as part of an API URL.
    base.hash = "";
    return base.toString();
}

export function buildApiUrl(baseUrl: string, path: string, apiVersion: "v1" | "v1beta" = "v1") {
    const rawBaseUrl = typeof baseUrl === "string" ? baseUrl.trim() : "";
    try {
        const base = new URL(rawBaseUrl);
        base.hash = "";
        const pathname = base.pathname.replace(/\/+$/, "");
        if (!/\/v1(?:beta)?$/i.test(pathname)) base.pathname = `${pathname}/${apiVersion}` || `/${apiVersion}`;
        return withLocalProxy(appendUrlPath(base.toString(), path));
    } catch {
        // Keep the previous behavior for an invalid/incomplete URL; validation will report it upstream.
        const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, "");
        const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
        const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/${apiVersion}`;
        return withLocalProxy(`${apiBaseUrl}${path}`);
    }
}

export function normalizeLocalProxyUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/** Accept absolute and protocol-relative HTTP URLs without treating data/blob URLs as proxy targets. */
export function isHttpUrl(value: string) {
    return /^https?:\/\//i.test(value) || /^\/\/[^/]/.test(value);
}

/** Resolve a protocol-relative target only when a browser page can provide its protocol. */
export function normalizeProxyTargetUrl(value: string) {
    if (!/^\/\/[^/]/.test(value)) return value;
    const protocol = typeof window !== "undefined" ? window.location?.protocol || "" : "";
    return /^https?:$/i.test(protocol) ? `${protocol}${value}` : value;
}

/** Prefix an outgoing request with the local forwarding proxy so the browser is not blocked by CORS. */
export function withLocalProxy(url: string) {
    const { proxyEnabled, proxyUrl } = useConfigStore.getState().config;
    const targetUrl = normalizeProxyTargetUrl(url);
    if (!proxyEnabled || !/^https?:\/\//i.test(targetUrl)) return url;
    const base = normalizeLocalProxyUrl(proxyUrl);
    if (!base || targetUrl === base || targetUrl.startsWith(`${base}/`)) return targetUrl;
    return `${base}/${targetUrl}`;
}

/** Whether a request URL is already addressed to the configured local proxy. */
export function isLocalProxyUrl(url: string) {
    const { proxyEnabled, proxyUrl } = useConfigStore.getState().config;
    const targetUrl = normalizeProxyTargetUrl(url);
    if (!proxyEnabled || !/^https?:\/\//i.test(targetUrl)) return false;
    const base = normalizeLocalProxyUrl(proxyUrl);
    return Boolean(base && (targetUrl === base || targetUrl.startsWith(`${base}/`)));
}
