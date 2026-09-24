import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 17371;
export const CONFIG_DIR = path.join(os.homedir(), ".infinite-canvas");
export const CONFIG_FILE = path.join(CONFIG_DIR, "canvas-agent.json");
export const CONFIG_VERSION = 1 as const;
export const VERSION = readPackageVersion();
export const AGENT_PROMPT = fs.readFileSync(new URL("../agent-instructions.md", import.meta.url), "utf8");
const initializedWorkspaces = new Set<string>();

export type SiteWorkspaceConfig = { workspacePath: string; activeThreadId?: string; pinnedThreadIds?: string[] };
export type CanvasAgentConfig = { version: typeof CONFIG_VERSION; url: string; token: string; origins?: string[]; workspace?: SiteWorkspaceConfig };

/** 读取本地 Canvas Agent 配置，不存在时生成默认配置。 */
export function loadConfig(create = false): CanvasAgentConfig {
    assertNoSymlinkComponents(CONFIG_DIR, "configuration directory");
    let raw: string;
    try {
        assertNotSymlink(CONFIG_FILE, "configuration file");
        raw = fs.readFileSync(CONFIG_FILE, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw configError("Unable to read configuration", error);
        const config = defaultConfig();
        if (create) saveConfig(config);
        return config;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        throw configError("Configuration contains invalid JSON", error);
    }
    return validateConfig(value);
}

/** 将 Canvas Agent 配置写入用户配置目录。 */
export function saveConfig(config: CanvasAgentConfig) {
    writeConfigFile(CONFIG_DIR, CONFIG_FILE, config);
}

/** 以私有权限原子写入配置；供测试验证崩溃和权限场景。 */
export function writeConfigFile(dir: string, file: string, config: CanvasAgentConfig) {
    const resolvedDir = path.resolve(dir);
    const resolvedFile = path.resolve(file);
    if (path.dirname(resolvedFile) !== resolvedDir) throw new Error("Configuration file must be directly inside its directory");
    const normalized = validateConfig(config);
    assertNoSymlinkComponents(resolvedDir, "configuration directory");
    fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(resolvedDir, "configuration directory");
    if (!fs.statSync(resolvedDir).isDirectory()) throw new Error("Configuration path is not a directory");
    setPrivateMode(resolvedDir, 0o700);
    atomicWrite(resolvedFile, JSON.stringify(normalized, null, 2), 0o600);
}

/** 确保站点级 Codex 工作空间存在并已初始化。 */
export function ensureSiteWorkspace(config: CanvasAgentConfig) {
    const current = config.workspace;
    if (current?.workspacePath) {
        const workspacePath = resolveWorkspacePath(current.workspacePath);
        initializeWorkspace(workspacePath);
        return { ...current, workspacePath };
    }
    const workspacePath = path.join(CONFIG_DIR, "codex-workspaces", "site");
    config.workspace = { workspacePath };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return { workspacePath };
}

/** 更新站点级 Codex 工作空间配置。 */
export function updateSiteWorkspace(config: CanvasAgentConfig, patch: Partial<SiteWorkspaceConfig>) {
    const current = ensureSiteWorkspace(config);
    const workspacePath = patch.workspacePath ? resolveWorkspacePath(patch.workspacePath) : current.workspacePath;
    const next = { ...current, ...patch, workspacePath };
    config.workspace = { workspacePath: next.workspacePath, activeThreadId: next.activeThreadId, pinnedThreadIds: next.pinnedThreadIds };
    initializeWorkspace(workspacePath);
    saveConfig(config);
    return config.workspace;
}

/** 创建工作空间目录并写入默认 AGENTS.md。 */
function initializeWorkspace(workspacePath: string) {
    const resolvedPath = path.resolve(workspacePath);
    if (initializedWorkspaces.has(resolvedPath)) return;
    assertNoSymlinkComponents(resolvedPath, "workspace directory");
    fs.mkdirSync(resolvedPath, { recursive: true });
    assertNoSymlinkComponents(resolvedPath, "workspace directory");
    if (!fs.statSync(resolvedPath).isDirectory()) throw new Error("Workspace path is not a directory");
    const instructionsFile = path.join(resolvedPath, "AGENTS.md");
    assertNotSymlink(instructionsFile, "workspace instructions file");
    const current = fs.existsSync(instructionsFile) ? fs.readFileSync(instructionsFile, "utf8") : "";
    if (!current || current.startsWith("# Infinite Canvas Agent")) atomicWrite(instructionsFile, AGENT_PROMPT, 0o644);
    initializedWorkspaces.add(resolvedPath);
}

/** 将用户输入的工作空间路径解析为绝对路径。 */
function resolveWorkspacePath(value: string) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("Workspace path is invalid");
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return path.resolve(value);
}

function defaultConfig(): CanvasAgentConfig {
    const port = Number(process.env.PORT);
    const defaultPort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
    return { version: CONFIG_VERSION, url: `http://127.0.0.1:${defaultPort}`, token: crypto.randomBytes(18).toString("hex") };
}

function validateConfig(value: unknown): CanvasAgentConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object");
    const source = value as Record<string, unknown>;
    if (source.version !== CONFIG_VERSION) throw new Error(`Unsupported configuration version: ${String(source.version ?? "missing")}`);
    const url = source.url;
    const token = source.token;
    if (typeof url !== "string" || !url.trim()) throw new Error("Configuration url must be a non-empty string");
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch (error) {
        throw configError("Configuration url is invalid", error);
    }
    if (typeof token !== "string" || !token.trim()) throw new Error("Configuration token must be a non-empty string");
    const origins = source.origins;
    if (origins !== undefined && (!Array.isArray(origins) || origins.some((origin) => typeof origin !== "string" || !origin.trim()))) {
        throw new Error("Configuration origins must be an array of non-empty strings");
    }
    let workspace: SiteWorkspaceConfig | undefined;
    if (source.workspace !== undefined) workspace = validateWorkspace(source.workspace);
    return {
        version: CONFIG_VERSION,
        url,
        token,
        ...(origins === undefined ? {} : { origins: [...origins] as string[] }),
        ...(workspace ? { workspace } : {}),
    };
}

function validateWorkspace(value: unknown): SiteWorkspaceConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration workspace must be an object");
    const source = value as Record<string, unknown>;
    if (typeof source.workspacePath !== "string" || !source.workspacePath.trim()) throw new Error("Workspace path must be a non-empty string");
    const workspacePath = resolveWorkspacePath(source.workspacePath);
    const activeThreadId = source.activeThreadId;
    if (activeThreadId !== undefined && typeof activeThreadId !== "string") throw new Error("Active thread id must be a string");
    const pinnedThreadIds = source.pinnedThreadIds;
    if (pinnedThreadIds !== undefined && (!Array.isArray(pinnedThreadIds) || pinnedThreadIds.some((id) => typeof id !== "string"))) {
        throw new Error("Pinned thread ids must be an array of strings");
    }
    return {
        workspacePath,
        ...(activeThreadId === undefined ? {} : { activeThreadId }),
        ...(pinnedThreadIds === undefined ? {} : { pinnedThreadIds: [...pinnedThreadIds] as string[] }),
    };
}

function assertNotSymlink(target: string, label: string) {
    try {
        if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
    }
}

function assertNoSymlinkComponents(target: string, label: string) {
    const resolved = path.resolve(target);
    const root = path.parse(resolved).root;
    const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
        current = path.join(current, part);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${label} must not contain symbolic links: ${current}`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
        }
    }
}

function setPrivateMode(target: string, mode: number) {
    fs.chmodSync(target, mode);
}

function atomicWrite(file: string, content: string, mode: number) {
    const directory = path.dirname(file);
    const temporaryFile = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
        assertNotSymlink(file, "target file");
        descriptor = fs.openSync(temporaryFile, "wx", mode);
        fs.writeFileSync(descriptor, content, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        assertNotSymlink(file, "target file");
        fs.renameSync(temporaryFile, file);
        setPrivateMode(file, mode);
        try {
            if (process.platform === "win32") return;
            const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
            try {
                fs.fsyncSync(directoryDescriptor);
            } finally {
                fs.closeSync(directoryDescriptor);
            }
        } catch (error) {
            if (!(["EINVAL", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code || ""))) throw error;
        }
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try {
            fs.unlinkSync(temporaryFile);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}

function configError(message: string, cause: unknown) {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
    return new Error(`${message}${detail}`, { cause: cause instanceof Error ? cause : undefined });
}

/** 从当前包信息中读取 Canvas Agent 版本号。 */
function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}
