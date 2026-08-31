import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { defaultConfig, defaultWebdavSyncConfig, useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { normalizePromptSourceState, usePromptSourceStore, type PromptSourceState } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceState["schedule"];
    };
};

type ImportedAppConfigFile = Omit<AppConfigFile, "config" | "webdav" | "promptSources"> & {
    config: Partial<AiConfig>;
    webdav: Partial<WebdavSyncConfig>;
    promptSources: Partial<PromptSourceState>;
};

export function exportAppConfig() {
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav, promptSources: { sources, schedule } };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
}

export async function importAppConfig(file: File) {
    let data: unknown;
    try {
        data = JSON.parse(await file.text());
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (!isAppConfigFile(data)) throw new Error(i18n.t("config.invalidFile"));
    let promptSources: PromptSourceState;
    try {
        promptSources = normalizePromptSourceState(data.promptSources);
        useConfigStore.getState().replaceConfig(data.config, data.webdav);
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    usePromptSourceStore.setState(promptSources);
}

function isAppConfigFile(value: unknown): value is ImportedAppConfigFile {
    if (!isRecord(value) || value.app !== "infinite-canvas" || value.version !== 1 || typeof value.exportedAt !== "string" || !isRecord(value.config) || !isRecord(value.webdav) || !isRecord(value.promptSources)) return false;
    const scalarConfigKeys = Object.keys(defaultConfig).filter((key) => key !== "channels" && key !== "models");
    if (!scalarConfigKeys.every((key) => value.config[key] === undefined || typeof value.config[key] === "string")) return false;
    if (value.config.models !== undefined && (!Array.isArray(value.config.models) || !value.config.models.every((model) => typeof model === "string"))) return false;
    if (value.config.channels !== undefined && (!Array.isArray(value.config.channels) || !value.config.channels.every(isChannel))) return false;
    if (!Object.keys(defaultWebdavSyncConfig).every((key) => value.webdav[key] === undefined || typeof value.webdav[key] === "string")) return false;
    const sources = value.promptSources.sources;
    const schedule = value.promptSources.schedule;
    return Array.isArray(sources) && sources.every(isPromptSource) && isRecord(schedule) && (schedule.intervalMinutes === undefined || (typeof schedule.intervalMinutes === "number" && Number.isFinite(schedule.intervalMinutes))) && (schedule.lastFetchedAt === undefined || typeof schedule.lastFetchedAt === "string");
}

function isChannel(value: unknown) {
    if (!isRecord(value) || !["id", "name", "baseUrl", "apiKey"].every((key) => value[key] === undefined || typeof value[key] === "string")) return false;
    if (value.apiFormat !== undefined && value.apiFormat !== "openai" && value.apiFormat !== "gemini") return false;
    return value.models === undefined || (Array.isArray(value.models) && value.models.every((model) => typeof model === "string" || (isRecord(model) && typeof model.name === "string" && (model.capability === undefined || ["image", "video", "text", "audio"].includes(String(model.capability))) && (model.script === undefined || typeof model.script === "string"))));
}

function isPromptSource(value: unknown) {
    return isRecord(value) && ["id", "name", "url", "homepage"].every((key) => value[key] === undefined || typeof value[key] === "string") && ["enabled", "builtIn"].every((key) => value[key] === undefined || typeof value[key] === "boolean");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
