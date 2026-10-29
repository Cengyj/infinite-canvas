import { useEffect, useRef, useState, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { getGrokVideoModel, VIDEO_REFERENCE_IMAGE_LIMIT } from "@/lib/video-generation-config";
import { deleteStoredImages, uploadImage } from "@/services/image-storage";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type ReferenceSource = { source: Blob | string; name: string };
type ReferenceInput = ReferenceSource[] | (() => Promise<ReferenceSource[]>);
type ImportResult = { count: number; warning?: "importLimit" | "importChanged"; values?: Record<string, number> } | null;

const createSession = () => ({ pending: 0, imageCount: 0, commit: Promise.resolve(), commits: new Set<() => void>(), controller: new AbortController() });
const videoConfig = (config: AiConfig) => ({ ...config, model: config.videoModel || config.model });

export function createVideoReferenceImporter(getReferences: () => ReferenceImage[], appendReferences: (images: ReferenceImage[]) => void) {
    let active = false;
    let session = createSession();
    const reset = () => {
        session.controller.abort();
        // Clipboard permissions cannot be aborted; release batches waiting behind them.
        session.commits.forEach((finish) => finish());
        session.commits.clear();
        session = createSession();
    };

    return {
        reset,
        isImporting: () => session.pending > 0,
        connect() {
            active = true;
            const unsubscribe = useConfigStore.subscribe((next, previous) => {
                const before = videoConfig(previous.config);
                const after = videoConfig(next.config);
                const beforeGrok = getGrokVideoModel(before);
                const afterGrok = getGrokVideoModel(after);
                if ((beforeGrok || afterGrok) && (before.model !== after.model || beforeGrok !== afterGrok)) reset();
            });
            return () => {
                active = false;
                unsubscribe();
                reset();
            };
        },
        async import(input: ReferenceInput): Promise<ImportResult> {
            if (!active) return null;
            const current = session;
            const isCurrent = () => active && current === session;
            const grok = getGrokVideoModel(videoConfig(useConfigStore.getState().config));
            const previousCommit = grok ? current.commit : undefined;
            let finishCommit: (() => void) | undefined;
            if (previousCommit) {
                const committed = new Promise<void>((resolve) => { finishCommit = resolve; current.commits.add(resolve); });
                current.commit = previousCommit.then(() => committed);
            }
            const unclaimedKeys = new Set<string>();
            let reserved = 0;
            current.pending += 1;
            const runImport = async (): Promise<ImportResult> => {
                try {
                    const items = typeof input === "function" ? await input() : input;
                    if (!isCurrent()) return null;
                    const count = getReferences().length + current.imageCount;
                    if (grok && count + items.length > VIDEO_REFERENCE_IMAGE_LIMIT) {
                        return { count: 0, warning: "importLimit", values: { max: VIDEO_REFERENCE_IMAGE_LIMIT, count, added: items.length } };
                    }
                    const selected = grok ? items : items.slice(0, Math.max(0, VIDEO_REFERENCE_IMAGE_LIMIT - getReferences().length));
                    if (!selected.length) return { count: 0 };
                    reserved = selected.length;
                    current.imageCount += reserved;
                    const uploaded = await Promise.allSettled(selected.map(async ({ source, name }) => {
                        const image = await uploadImage(source, { signal: current.controller.signal });
                        if (image.storageKey) unclaimedKeys.add(image.storageKey);
                        return { id: nanoid(), name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                    }));
                    // Upload concurrently, but commit Grok batches in the order they were requested.
                    if (previousCommit) await previousCommit;
                    if (!isCurrent()) return null;
                    const images = uploaded.map((result) => {
                        if (result.status === "rejected") throw result.reason;
                        return result.value;
                    });
                    if (grok && getReferences().length + images.length > VIDEO_REFERENCE_IMAGE_LIMIT) {
                        return { count: 0, warning: "importChanged" };
                    }
                    const accepted = grok ? images : images.slice(0, Math.max(0, VIDEO_REFERENCE_IMAGE_LIMIT - getReferences().length));
                    appendReferences(accepted);
                    accepted.forEach((image) => { if (image.storageKey) unclaimedKeys.delete(image.storageKey); });
                    return { count: accepted.length };
                } finally {
                    current.pending -= 1;
                    current.imageCount -= reserved;
                    if (finishCommit) {
                        current.commits.delete(finishCommit);
                        finishCommit();
                    }
                    if (unclaimedKeys.size) await deleteStoredImages(unclaimedKeys).catch(() => undefined);
                }
            };
            try {
                const result = await runImport();
                return isCurrent() ? result : null;
            } catch (error) {
                if (isCurrent()) throw error;
                return null;
            }
        },
    };
}

export function useVideoReferences() {
    const { message } = App.useApp();
    const [references, setReferenceState] = useState<ReferenceImage[]>([]);
    const referencesRef = useRef(references);
    const setReferences = (next: SetStateAction<ReferenceImage[]>) => {
        referencesRef.current = typeof next === "function" ? next(referencesRef.current) : next;
        setReferenceState(referencesRef.current);
    };
    const [imports] = useState(() => createVideoReferenceImporter(() => referencesRef.current, (images) => setReferences((value) => [...value, ...images])));
    useEffect(() => imports.connect(), [imports]);

    return {
        references,
        setReferences,
        getReferences: () => referencesRef.current,
        isImporting: imports.isImporting,
        resetReferences(value: ReferenceImage[] = []) {
            imports.reset();
            setReferences(value);
        },
        async importReferences(input: ReferenceInput, failureMessage?: string) {
            try {
                const result = await imports.import(input);
                if (result?.warning) message.warning(i18n.t(`videoCapabilities.${result.warning}`, result.values));
                return result && !result.warning ? result.count : null;
            } catch (error) {
                message.error(failureMessage || (error instanceof Error ? error.message : i18n.t("videoCapabilities.importFailed")));
                return null;
            }
        },
    };
}
