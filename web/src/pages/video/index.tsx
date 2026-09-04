import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, Plus, SlidersHorizontal, Sparkles, Trash2, Upload, VideoIcon, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { App, Button, Checkbox, Drawer, Empty, Input, Modal, Tag, Typography } from "antd";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { PromptOptimizeDialog } from "@/components/prompt-optimize-dialog";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { normalizeVideoFrameSize, normalizeVideoResolution, normalizeVideoSeconds } from "@/lib/video-config";
import { deleteStoredMedia, resolveMediaUrl } from "@/services/file-storage";
import { createImageStorageLease, deleteStoredImages, registerActiveImageStorageKeys, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { createVideoGenerationTask, MAX_VIDEO_REFERENCE_IMAGES, storeGeneratedVideo, waitForVideoGenerationTask, type VideoGenerationTask } from "@/services/api/video";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import { boolConfig, modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey: string;
    durationMs: number;
    width: number;
    height: number;
    aspectRatio?: string;
    bytes: number;
    mimeType: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    elapsedMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "pending" | "success" | "failed";
    task?: VideoGenerationTask;
    video?: GeneratedVideo;
    error?: string;
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark">;

type PromptOptimizationSession = {
    id: string;
    prompt: string;
    references: ReferenceImage[];
    generationMode: "text-to-video" | "image-to-video";
    durationSeconds: string;
    frameSize: string;
    audioEnabled: boolean;
};

type PromptOptimizationBinding = {
    prompt: string;
    referenceIds: string[];
    contextKey: string;
};

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

export default function VideoPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const activeLogIdsRef = useRef<Set<string>>(new Set());
    const deletedLogIdsRef = useRef<Set<string>>(new Set());
    const createControllerRef = useRef<AbortController | null>(null);
    const pollControllersRef = useRef(new Map<string, AbortController>());
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [promptOptimizationSession, setPromptOptimizationSession] = useState<PromptOptimizationSession | null>(null);
    const [promptOptimizationBinding, setPromptOptimizationBinding] = useState<PromptOptimizationBinding | null>(null);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [referenceDragTarget, setReferenceDragTarget] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const videoCommand = useWorkbenchAgentStore((state) => state.videoCommand);
    const clearVideoCommand = useWorkbenchAgentStore((state) => state.clearVideoCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const referencesRef = useRef<ReferenceImage[]>([]);
    const referenceEpochRef = useRef(0);
    const pendingReferenceSlotsRef = useRef(new Map<number, number>());
    const activeReferencesDisposeRef = useRef<(() => void) | null>(null);

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    useEffect(
        () => () => {
            referenceEpochRef.current += 1;
            createControllerRef.current?.abort();
            pollControllersRef.current.forEach((controller) => controller.abort());
            pollControllersRef.current.clear();
            activeReferencesDisposeRef.current?.();
            cleanupImages();
        },
        [cleanupImages],
    );

    const updateReferences = (update: ReferenceImage[] | ((value: ReferenceImage[]) => ReferenceImage[]), cleanupRemoved = false) => {
        const nextReferences = typeof update === "function" ? update(referencesRef.current) : update;
        referencesRef.current = nextReferences;
        activeReferencesDisposeRef.current?.();
        activeReferencesDisposeRef.current = registerActiveImageStorageKeys("video-workbench", nextReferences.flatMap((reference) => (reference.storageKey ? [reference.storageKey] : [])));
        setReferences(nextReferences);
        if (cleanupRemoved) cleanupImages({ references: nextReferences });
    };

    const replaceReferences = (nextReferences: ReferenceImage[]) => {
        referenceEpochRef.current += 1;
        updateReferences(nextReferences, true);
    };

    const addReferenceInputs = async (inputs: Array<{ input: string | Blob; name: string }>) => {
        const epoch = referenceEpochRef.current;
        const pending = pendingReferenceSlotsRef.current.get(epoch) || 0;
        const available = Math.max(0, MAX_VIDEO_REFERENCE_IMAGES - referencesRef.current.length - pending);
        const selected = inputs.slice(0, available);
        if (selected.length < inputs.length) message.warning(t("apiErrors.videoReferenceLimit", { count: MAX_VIDEO_REFERENCE_IMAGES }));
        if (!selected.length) return 0;

        pendingReferenceSlotsRef.current.set(epoch, pending + selected.length);
        const lease = createImageStorageLease();
        try {
            const results = await Promise.allSettled(
                selected.map(async ({ input, name }) => {
                    const image = await uploadImage(input, lease);
                    return { id: nanoid(), name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            const uploaded = results.filter((result): result is PromiseFulfilledResult<ReferenceImage> => result.status === "fulfilled").map((result) => result.value);
            if (referenceEpochRef.current !== epoch) {
                await deleteStoredImages(uploaded.flatMap((reference) => (reference.storageKey ? [reference.storageKey] : []))).catch(() => undefined);
                return 0;
            }

            const accepted = uploaded.slice(0, Math.max(0, MAX_VIDEO_REFERENCE_IMAGES - referencesRef.current.length));
            const discarded = uploaded.slice(accepted.length);
            if (accepted.length) updateReferences([...referencesRef.current, ...accepted]);
            if (discarded.length) await deleteStoredImages(discarded.flatMap((reference) => (reference.storageKey ? [reference.storageKey] : []))).catch(() => undefined);
            if (results.some((result) => result.status === "rejected")) message.error(t("common.imageReadFailed"));
            return accepted.length;
        } finally {
            const remainingPending = (pendingReferenceSlotsRef.current.get(epoch) || selected.length) - selected.length;
            if (remainingPending > 0) pendingReferenceSlotsRef.current.set(epoch, remainingPending);
            else pendingReferenceSlotsRef.current.delete(epoch);
            lease.release();
        }
    };

    const addReferences = async (files?: FileList | null) => {
        const selectedFiles = Array.from(files || []);
        const unsupported = selectedFiles.filter((file) => !file.type.startsWith("image/"));
        if (unsupported.length) message.warning(t("videoWorkbench.unsupportedFiles"));
        const imageFiles = selectedFiles.filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        await addReferenceInputs(imageFiles.map((file) => ({ input: file, name: file.name })));
    };

    const handleReferenceDragEnter = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes("Files")) setReferenceDragTarget(true);
    };

    const handleReferenceDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (!dragDepthRef.current) setReferenceDragTarget(false);
    };

    const handleReferenceDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepthRef.current = 0;
        setReferenceDragTarget(false);
        void addReferences(event.dataTransfer.files);
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("videoWorkbench.clipboardEmpty"));
                return;
            }
            const added = await addReferenceInputs(blobs.map((blob, index) => ({ input: blob, name: `clipboard-${index + 1}.png` })));
            if (added) message.success(t("videoWorkbench.clipboardAdded", { count: added }));
        } catch {
            message.error(t("videoWorkbench.clipboardEmpty"));
        }
    };
    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("videoWorkbench.invalidParams") });
            return;
        }
        const lease = createImageStorageLease(snapshot.references.flatMap((reference) => (reference.storageKey ? [reference.storageKey] : [])));
        const controller = new AbortController();
        createControllerRef.current = controller;
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults([{ id: nanoid(), status: "pending" }]);
        const createdAt = Date.now();
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);
        try {
            const task = await createVideoGenerationTask(snapshot.config, snapshot.text, snapshot.references, { signal: controller.signal });
            const log = buildLog({ prompt: snapshot.text, model: snapshot.config.model, config: snapshot.config, references: snapshot.references, createdAt, elapsedMs: 0, status: "pending", task });
            await saveLog(log, false);
            if (controller.signal.aborted) return;
            void pollGenerationLog(log, snapshot.config, agentTaskId);
        } catch (error) {
            if (controller.signal.aborted) return;
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            setResults([{ id: nanoid(), status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            setRunning(false);
            await saveLog(buildLog({ prompt: snapshot.text, model: snapshot.config.model, config: snapshot.config, references: snapshot.references, createdAt, elapsedMs: performance.now() - batchStartedAt, status: "failed", error: errorMessage }));
            message.error(errorMessage);
        } finally {
            if (createControllerRef.current === controller) createControllerRef.current = null;
            lease.release();
        }
    };

    // Handle video-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!videoCommand || videoCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = videoCommand.nonce;
        clearVideoCommand();
        if (typeof videoCommand.prompt === "string" || videoCommand.run) setPromptOptimizationSession(null);
        if (typeof videoCommand.prompt === "string") {
            setPrompt(videoCommand.prompt);
            setPromptOptimizationBinding(null);
        }
        if (videoCommand.run && running) {
            if (videoCommand.taskId) updateAgentTask(videoCommand.taskId, { status: "failed", error: t("videoWorkbench.busy") });
            return;
        }
        if (videoCommand.run) {
            agentTaskIdRef.current = videoCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [videoCommand, clearVideoCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        const currentReferences = referencesRef.current;
        if (!text) {
            message.error(t("videoWorkbench.promptRequired"));
            return null;
        }
        const optimizedPrompt = promptOptimizationBinding?.prompt === text;
        const referencesChanged = Boolean(
            optimizedPrompt
            && (promptOptimizationBinding.referenceIds.length !== currentReferences.length || promptOptimizationBinding.referenceIds.some((id, index) => id !== currentReferences[index]?.id)),
        );
        const contextChanged = Boolean(optimizedPrompt && promptOptimizationBinding.contextKey !== videoOptimizationContextKey(effectiveConfig));
        if (referencesChanged || contextChanged) {
            setPromptOptimizationBinding(null);
            message.warning(t(`videoWorkbench.promptOptimization.${referencesChanged && contextChanged ? "referenceAndContextChanged" : referencesChanged ? "referenceChanged" : "contextChanged"}`));
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: buildVideoConfig(effectiveConfig, model), references: [...currentReferences] };
    };

    const retryResult = () => {
        void generate();
    };

    const downloadVideo = (video: GeneratedVideo) => {
        saveAs(video.url, "video.mp4");
    };

    const saveResultToAssets = (video: GeneratedVideo) => {
        addAsset({
            kind: "video",
            title: t("videoWorkbench.resultTitle"),
            coverUrl: "",
            tags: [],
            source: t("videoWorkbench.source"),
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, aspectRatio: video.aspectRatio, durationMs: video.durationMs, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
            setPromptOptimizationBinding(null);
        } else if (payload.kind === "image") {
            await addReferenceInputs([{ input: payload.dataUrl, name: payload.title }]);
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        setPrompt("");
        replaceReferences([]);
        setPromptOptimizationSession(null);
        setPromptOptimizationBinding(null);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = () => {
        selectedLogIds.forEach((id) => deletedLogIdsRef.current.add(id));
        selectedLogIds.forEach((id) => pollControllersRef.current.get(id)?.abort());
        const mediaKeys = logs
            .filter((log) => selectedLogIds.includes(log.id))
            .map((log) => log.video?.storageKey)
            .filter((key): key is string => Boolean(key));
        void Promise.all([deleteStoredMedia(mediaKeys), ...selectedLogIds.map((id) => logStore.removeItem(id))]).then(() => {
            cleanupImages({ references: referencesRef.current });
            return refreshLogs();
        });
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog, resumePending = true) => {
        if (deletedLogIdsRef.current.has(log.id)) return;
        await logStore.setItem(log.id, serializeLog(log));
        if (deletedLogIdsRef.current.has(log.id)) {
            await logStore.removeItem(log.id);
            return;
        }
        await refreshLogs(resumePending);
    };

    const refreshLogs = async (resumePending = true) => {
        const nextLogs = await readStoredLogs();
        setLogs(nextLogs);
        if (resumePending) resumePendingLogs(nextLogs);
        return nextLogs;
    };

    const resumePendingLogs = (items: GenerationLog[]) => {
        for (const log of items) {
            if (log.status === "pending" && log.task) void pollGenerationLog(log);
        }
    };

    const pollGenerationLog = async (log: GenerationLog, configOverride?: AiConfig, agentTaskId?: string) => {
        if (!log.task || activeLogIdsRef.current.has(log.id)) return;
        activeLogIdsRef.current.add(log.id);
        const controller = new AbortController();
        pollControllersRef.current.set(log.id, controller);
        setRunning(true);
        setStartedAt((value) => value || performance.now());
        setResults((value) => (value.length ? value : [{ id: log.id, status: "pending" }]));
        const taskConfig = buildVideoConfig({ ...effectiveConfig, ...log.config }, log.task.model || log.model);
        try {
            const result = await waitForVideoGenerationTask(configOverride || taskConfig, log.task, { signal: controller.signal });
            const stored = await storeGeneratedVideo(result);
            if (controller.signal.aborted || deletedLogIdsRef.current.has(log.id)) {
                if (stored.storageKey) await deleteStoredMedia([stored.storageKey]);
                return;
            }
            const nextVideo: GeneratedVideo = {
                id: nanoid(),
                url: stored.url,
                storageKey: stored.storageKey,
                durationMs: stored.durationMs || 0,
                width: stored.width || 0,
                height: stored.height || 0,
                aspectRatio: stored.aspectRatio,
                bytes: stored.bytes,
                mimeType: stored.mimeType,
            };
            setResults([{ id: nextVideo.id, status: "success", video: nextVideo }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "succeeded", successCount: 1, failCount: 0, error: undefined });
            await saveLog({ ...log, status: "success", elapsedMs: Date.now() - log.createdAt, video: nextVideo, error: undefined });
            message.success(t("videoWorkbench.generated"));
        } catch (error) {
            if (controller.signal.aborted) return;
            const errorMessage = error instanceof Error ? error.message : t("workbench.generationFailed");
            setResults([{ id: log.id, status: "failed", error: errorMessage }]);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", successCount: 0, failCount: 1, error: errorMessage });
            await saveLog({ ...log, status: "failed", elapsedMs: Date.now() - log.createdAt, error: errorMessage });
            message.error(errorMessage);
        } finally {
            activeLogIdsRef.current.delete(log.id);
            if (pollControllersRef.current.get(log.id) === controller) pollControllersRef.current.delete(log.id);
            if (!activeLogIdsRef.current.size) {
                setRunning(false);
                setStartedAt(0);
            }
        }
    };

    const previewGenerationLog = (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        replaceReferences(log.references || []);
        setPromptOptimizationSession(null);
        setPromptOptimizationBinding(null);
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoGenerateAudio) updateConfig("videoGenerateAudio", log.config.videoGenerateAudio);
        if (log.config.videoWatermark) updateConfig("videoWatermark", log.config.videoWatermark);
        setResults(log.status === "pending" ? [{ id: log.id, status: "pending" }] : log.video ? [{ id: log.video.id, status: "success", video: log.video }] : [{ id: log.id, status: "failed", error: log.error || t("workbench.generationFailed") }]);
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} />
                </aside>

                <section className="grid gap-3 lg:min-h-0 lg:overflow-hidden xl:grid-cols-[420px_minmax(0,1fr)]">
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div className="flex items-start justify-between gap-3">
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("videoWorkbench.title")}</h1>
                            <div className="flex shrink-0 gap-2 lg:hidden">
                                <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                    {t("workbench.logs")}
                                </Button>
                                <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.settings")}
                                </Button>
                            </div>
                        </div>

                        <div className="mt-6 space-y-5">
                            <div>
                                <div className="mb-2 flex w-full items-center gap-1.5 whitespace-nowrap">
                                    <span className="shrink-0 text-sm font-semibold">{t("workbench.prompt")}</span>
                                    <div className="grid min-w-0 flex-1 grid-cols-3 gap-1">
                                        <Button
                                            size="small"
                                            className="!h-7 !w-full !min-w-0 !gap-1 !px-2 !text-xs max-[389px]:!px-1 max-[389px]:!text-[11px] max-[389px]:[&_.ant-btn-icon]:hidden"
                                            icon={<BookOpen className="size-3.5" />}
                                            title={t("workbench.viewPrompts")}
                                            aria-label={t("workbench.viewPrompts")}
                                            onClick={() => setPromptDialogOpen(true)}
                                        >
                                            {t("videoWorkbench.promptActions.prompts")}
                                        </Button>
                                        <Button
                                            size="small"
                                            className="!h-7 !w-full !min-w-0 !gap-1 !px-2 !text-xs max-[389px]:!px-1 max-[389px]:!text-[11px] max-[389px]:[&_.ant-btn-icon]:hidden"
                                            icon={<FolderPlus className="size-3.5" />}
                                            title={t("workbench.viewAssets")}
                                            aria-label={t("workbench.viewAssets")}
                                            onClick={() => setAssetPickerOpen(true)}
                                        >
                                            {t("videoWorkbench.promptActions.assets")}
                                        </Button>
                                        <Button
                                            size="small"
                                            className="!h-7 !w-full !min-w-0 !gap-1 !px-2 !text-xs max-[389px]:!px-1 max-[389px]:!text-[11px] max-[389px]:[&_.ant-btn-icon]:hidden"
                                            icon={<WandSparkles className="size-3.5" />}
                                            title={t("videoWorkbench.promptOptimization.action")}
                                            aria-label={t("videoWorkbench.promptOptimization.action")}
                                            disabled={running}
                                            onClick={() =>
                                                setPromptOptimizationSession({
                                                    id: nanoid(),
                                                    prompt,
                                                    references: references.map((reference) => ({ ...reference })),
                                                    generationMode: references.length ? "image-to-video" : "text-to-video",
                                                    durationSeconds: normalizeVideoSeconds(effectiveConfig.videoSeconds),
                                                    frameSize: normalizeVideoFrameSize(effectiveConfig.size),
                                                    audioEnabled: boolConfig(effectiveConfig.videoGenerateAudio, true),
                                                })
                                            }
                                        >
                                            {t("videoWorkbench.promptActions.optimize")}
                                        </Button>
                                    </div>
                                </div>
                                <Input.TextArea value={prompt} onChange={(event) => { setPrompt(event.target.value); setPromptOptimizationBinding(null); }} rows={7} placeholder={t("videoWorkbench.promptPlaceholder")} />
                            </div>

                            <div className="min-w-0">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <span className="text-base font-semibold">{t("videoWorkbench.references")}</span>
                                    <div className="flex gap-2">
                                        <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={() => void addReferencesFromClipboard()}>
                                            {t("workbench.clipboard")}
                                        </Button>
                                        <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => fileInputRef.current?.click()}>
                                            {t("workbench.upload")}
                                        </Button>
                                    </div>
                                </div>
                                <div
                                    className={`hover-scrollbar hover-scrollbar-hint flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${referenceDragTarget ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                    onDragEnter={handleReferenceDragEnter}
                                    onDragOver={(event) => {
                                        event.preventDefault();
                                        event.dataTransfer.dropEffect = "copy";
                                    }}
                                    onDragLeave={handleReferenceDragLeave}
                                    onDrop={handleReferenceDrop}
                                >
                                    {references.map((item, index) => (
                                        <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                            <img src={item.dataUrl} alt={item.name} className="size-full object-cover" />
                                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                            <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => updateReferences((value) => moveListItem(value, index, offset))} />
                                            <button type="button" className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => updateReferences((value) => value.filter((ref) => ref.id !== item.id), true)} aria-label={t("videoWorkbench.removeImage")}>
                                                <Trash2 className="size-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{referenceDragTarget ? t("videoWorkbench.dropReferences") : t("videoWorkbench.noImages", { count: MAX_VIDEO_REFERENCE_IMAGES })}</div> : null}
                                </div>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {normalizeVideoResolution(effectiveConfig.vquality)}p · {videoSizeLabel(effectiveConfig.size)} · {normalizeVideoSeconds(effectiveConfig.videoSeconds)}s
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} loading={running} disabled={!canGenerate || running} onClick={() => void generate()}>
                                {t("workbench.generate")}
                            </Button>
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h2 className="text-xl font-semibold">{t("workbench.results")}</h2>
                            {running ? <Tag className="m-0 px-2 py-1">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag> : null}
                        </div>
                        {results.length ? (
                            <div className="grid gap-4">
                                {results.map((result) => (result.status === "success" && result.video ? <ResultVideoCard key={result.id} video={result.video} onDownload={downloadVideo} onSaveAsset={saveResultToAssets} /> : result.status === "failed" ? <FailedVideoCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={retryResult} /> : <PendingVideoCard key={result.id} />))}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <VideoIcon className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("videoWorkbench.empty")} />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel logs={logs} selectedLogIds={selectedLogIds} activeLogId={previewLog?.id} onSelectedLogIdsChange={setSelectedLogIds} onCreateSession={createSession} onDeleteSelected={() => setDeleteConfirmOpen(true)} onPreviewLog={previewGenerationLog} />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" height="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog
                open={promptDialogOpen}
                onOpenChange={setPromptDialogOpen}
                onSelect={(value) => {
                    setPrompt(value);
                    setPromptOptimizationBinding(null);
                }}
            />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            {promptOptimizationSession ? (
                <PromptOptimizeDialog
                    key={promptOptimizationSession.id}
                    scenario="video"
                    prompt={promptOptimizationSession.prompt}
                    references={promptOptimizationSession.references}
                    context={{
                        generationMode: promptOptimizationSession.generationMode,
                        durationSeconds: promptOptimizationSession.durationSeconds,
                        frameSize: promptOptimizationSession.frameSize,
                        audioEnabled: promptOptimizationSession.audioEnabled,
                    }}
                    disabled={running}
                    onApply={(value) => {
                        setPrompt(value);
                        setPromptOptimizationBinding({
                            prompt: value.trim(),
                            referenceIds: promptOptimizationSession.references.map((reference) => reference.id),
                            contextKey: [
                                promptOptimizationSession.durationSeconds,
                                promptOptimizationSession.frameSize,
                                promptOptimizationSession.audioEnabled,
                            ].join("|"),
                        });
                        setPreviewLog(null);
                        setPromptOptimizationSession(null);
                        message.success(t("videoWorkbench.promptOptimization.applied"));
                    }}
                    onClose={() => setPromptOptimizationSession(null)}
                />
            ) : null}
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("videoModel", value)} capability="video" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <VideoSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" />
            </div>
        </>
    );
}

function ResultVideoCard({ video, onDownload, onSaveAsset }: { video: GeneratedVideo; onDownload: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo) => void }) {
    const { t } = useTranslation();
    const aspectRatio = video.width && video.height ? `${video.width} / ${video.height}` : (video.aspectRatio || "16:9").replace(":", " / ");
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <div className="flex justify-center bg-black">
                <video src={video.url} controls className="w-full max-h-[70vh] max-w-full object-contain" style={{ aspectRatio }} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    {video.width && video.height ? <span>{video.width}x{video.height}</span> : video.aspectRatio ? <span>{video.aspectRatio}</span> : null}
                    <span>{formatBytes(video.bytes)}</span>
                    <span>{formatDuration(video.durationMs)}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video)}>
                        {t("common.addToAssets")}
                    </Button>
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video)}>
                        {t("common.download")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function PendingVideoCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-video overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedVideoCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    {t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard key={log.id} log={log} selected={selectedLogIds.includes(log.id)} active={activeLogId === log.id} onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))} onClick={() => onPreviewLog(log)} />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    return (
        <button type="button" className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`} onClick={onClick}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
                <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                <div className="min-w-0">
                    <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.size}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.resolution}p</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.seconds}s</Tag>
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color={log.status === "success" ? "blue" : log.status === "pending" ? "processing" : "red"}>
                        {t(`workbench.${log.status === "success" ? "success" : log.status === "pending" ? "generating" : "failed"}`)}
                    </Tag>
                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                        {formatDuration(log.elapsedMs)}
                    </Tag>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const logs: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            logs.push(value);
        });
        return (await Promise.all(logs.map(normalizeLog))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, url: await resolveMediaUrl(log.video.storageKey, log.video.url) } : log.video;
    const references = await Promise.all(
        (log.references || []).map(async (item) => ({
            ...item,
            dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl),
        })),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        elapsedMs: log.elapsedMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeVideoResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "success",
        task: log.task,
        video,
        error: log.error,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        video: log.video?.storageKey ? { ...log.video, url: "" } : log.video,
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeVideoResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoGenerateAudio: log.config?.videoGenerateAudio || "true",
        videoWatermark: log.config?.videoWatermark || "false",
    };
}

function buildLog({ prompt, model, config, references, createdAt = Date.now(), elapsedMs, status, task, video, error }: { prompt: string; model: string; config: AiConfig; references: ReferenceImage[]; createdAt?: number; elapsedMs: number; status: GenerationLog["status"]; task?: VideoGenerationTask; video?: GeneratedVideo; error?: string }): GenerationLog {
    const logConfig = {
        model: config.model,
        videoModel: config.videoModel,
        size: config.size,
        vquality: normalizeVideoResolution(config.vquality),
        videoSeconds: config.videoSeconds,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
    };
    return {
        id: nanoid(),
        createdAt,
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date(createdAt).toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        elapsedMs,
        size: logConfig.size,
        resolution: logConfig.vquality,
        seconds: logConfig.videoSeconds,
        status,
        task,
        video,
        error,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    return {
        ...config,
        model,
        videoModel: model,
        videoSeconds: normalizeVideoSeconds(config.videoSeconds),
        vquality: normalizeVideoResolution(config.vquality),
        videoGenerateAudio: String(boolConfig(config.videoGenerateAudio, true)),
        videoWatermark: String(boolConfig(config.videoWatermark, false)),
    };
}

function videoOptimizationContextKey(config: AiConfig) {
    return [normalizeVideoSeconds(config.videoSeconds), normalizeVideoFrameSize(config.size), boolConfig(config.videoGenerateAudio, true)].join("|");
}
