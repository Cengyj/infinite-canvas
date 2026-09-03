import { normalizeVideoFrameSize, normalizeVideoSeconds } from "@/lib/video-config";
import type { PromptOptimizationContext, PromptOptimizationScenario } from "@/services/api/prompt-optimization";
import { boolConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type ReferenceVersion = {
    id: string;
    storageKey?: string;
    source: string;
};

export type CanvasPromptOptimizationBinding = {
    prompt: string;
    mode: PromptOptimizationScenario;
    references: ReferenceVersion[];
    contextKey: string;
};

export function buildCanvasPromptOptimizationContext(mode: PromptOptimizationScenario, config: AiConfig, references: ReferenceImage[]): PromptOptimizationContext {
    if (mode === "image") return { frameSize: config.size, transparentBackground: config.background === "transparent" };
    return {
        generationMode: references.length ? "image-to-video" : "text-to-video",
        durationSeconds: normalizeVideoSeconds(config.videoSeconds),
        frameSize: normalizeVideoFrameSize(config.size),
        audioEnabled: boolConfig(config.videoGenerateAudio, true),
    };
}

export function createCanvasPromptOptimizationBinding(prompt: string, mode: PromptOptimizationScenario, context: PromptOptimizationContext, references: ReferenceImage[]): CanvasPromptOptimizationBinding {
    return {
        prompt: prompt.trim(),
        mode,
        references: references.map((reference) => ({ id: reference.id, storageKey: reference.storageKey, source: reference.dataUrl || reference.url || "" })),
        contextKey: mode === "image" ? `${context.frameSize}|${context.transparentBackground}` : `${context.durationSeconds}|${context.frameSize}|${context.audioEnabled}`,
    };
}

export function canvasPromptOptimizationChanges(binding: CanvasPromptOptimizationBinding, prompt: string, mode: PromptOptimizationScenario, config: AiConfig, references: ReferenceImage[]) {
    if (binding.prompt !== prompt.trim() || binding.mode !== mode) return null;
    const current = createCanvasPromptOptimizationBinding(prompt, mode, buildCanvasPromptOptimizationContext(mode, config, references), references);
    return {
        referencesChanged:
            binding.references.length !== current.references.length
            || binding.references.some((reference, index) => {
                const next = current.references[index];
                return !next || reference.id !== next.id || reference.storageKey !== next.storageKey || reference.source !== next.source;
            }),
        contextChanged: binding.contextKey !== current.contextKey,
    };
}
