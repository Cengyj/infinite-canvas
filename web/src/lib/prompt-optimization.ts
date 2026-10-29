import { resolveGeminiImageConfig } from "@/lib/image-generation-size";
import { getGrokVideoModel, resolveVideoGenerationConfig, videoGenerationIssueText } from "@/lib/video-generation-config";
import { boolConfig, modelOptionName, resolveModelChannel, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type PromptOptimizationScenario = "image" | "video";
export type PromptOptimizationContext = {
    generationModel?: { id: string; name: string; transport: "openai" | "gemini" | "script" };
    generationIssues?: string[];
    imageIntent?: "create" | "reference" | "edit";
    imageRoles?: Array<"source-image" | "reference-image" | "first-frame" | "last-frame">;
    frameSize?: string;
    resolution?: string;
    generationSystemPrompt?: string;
    quality?: string;
    transparentBackground?: boolean;
    durationSeconds?: string;
    referenceMode?: string;
    audioEnabled?: boolean;
    upstreamText?: string;
    videoReferences?: string[];
    audioReferences?: string[];
    referenceTokens?: Array<{ token: string; label: string; description?: string }>;
};

export type PromptOptimizationInput = {
    targetId: string;
    generationIdentity?: string;
    scenario: PromptOptimizationScenario;
    prompt: string;
    references: ReferenceImage[];
    context: PromptOptimizationContext;
};

export function buildPromptOptimizationContext(scenario: PromptOptimizationScenario, config: AiConfig, references: ReferenceImage[], options?: { sourceImageId?: string; videoReferences?: string[]; audioReferences?: string[] }): PromptOptimizationContext {
    const id = config.model || (scenario === "image" ? config.imageModel : config.videoModel);
    const transport = resolveModelScript(config, id) ? "script" : resolveModelChannel(config, id).apiFormat;
    const generationModel: NonNullable<PromptOptimizationContext["generationModel"]> = { id, name: modelOptionName(id), transport };
    let imageConfig: { aspectRatio?: string; imageSize?: string } | undefined;
    if (scenario === "image" && transport === "gemini") {
        // Incomplete size edits must not throw while the editor reads an optimization snapshot.
        try { imageConfig = resolveGeminiImageConfig(config).imageConfig; } catch {}
    }
    if (scenario === "image") return {
        generationModel,
        generationSystemPrompt: config.systemPrompt.trim() || undefined,
        imageIntent: references.some((image) => image.id === options?.sourceImageId) ? "edit" : references.length ? "reference" : "create",
        imageRoles: references.map((image) => image.id === options?.sourceImageId ? "source-image" : "reference-image"),
        frameSize: transport === "gemini" ? imageConfig?.aspectRatio : config.size,
        resolution: imageConfig?.imageSize,
        quality: config.quality,
        transparentBackground: config.background === "transparent",
    };
    const video = resolveVideoGenerationConfig({ ...config, model: id }, { imageCount: references.length, videoCount: options?.videoReferences?.length, audioCount: options?.audioReferences?.length });
    const invalid = new Set(video.issues.map((issue) => issue.field));
    const validRoles = !invalid.has("images");
    return {
        generationModel,
        generationIssues: video.issues.length ? video.issues.map(videoGenerationIssueText) : undefined,
        imageRoles: validRoles ? references.map((_, index) => video.mode === "reference" ? "reference-image" : index === 0 ? "first-frame" : "last-frame") : undefined,
        frameSize: invalid.has("size") || invalid.has("resolution") ? undefined : video.grok || transport === "gemini" ? video.aspectRatio : video.size || (transport === "openai" ? "1280x720" : "auto"),
        quality: invalid.has("resolution") ? undefined : `${video.resolution}p`,
        durationSeconds: invalid.has("seconds") ? undefined : video.seconds,
        referenceMode: validRoles ? video.grok ? references.length ? "reference" : undefined : video.mode : undefined,
        audioEnabled: video.grok ? undefined : boolConfig(config.videoGenerateAudio, true),
        videoReferences: video.grok ? undefined : transport === "gemini" ? options?.videoReferences?.slice(0, 1) : options?.videoReferences,
        audioReferences: video.grok ? undefined : transport === "gemini" ? options?.audioReferences?.slice(0, 1) : options?.audioReferences,
    };
}

export function buildPromptOptimizationGenerationIdentity(scenario: PromptOptimizationScenario, config: AiConfig) {
    const model = config.model || (scenario === "image" ? config.imageModel : config.videoModel);
    const channel = resolveModelChannel(config, model);
    const videoIdentity = scenario === "video" ? [config.videoSeconds, config.vquality, ...(getGrokVideoModel({ ...config, model }) ? [] : [config.videoMode, config.videoGenerateAudio, config.videoWatermark])] : [];
    // This local snapshot value is never sent to the optimizer.
    return JSON.stringify([model, channel.id, channel.apiFormat, channel.baseUrl, resolveModelScript(config, model), config.size, ...videoIdentity]);
}

export function samePromptOptimizationInput(left: PromptOptimizationInput, right: PromptOptimizationInput) {
    return left.targetId === right.targetId && left.generationIdentity === right.generationIdentity && left.scenario === right.scenario && left.prompt === right.prompt
        && left.references.length === right.references.length
        && left.references.every((reference, index) => {
            const next = right.references[index];
            return reference.id === next.id && reference.name === next.name && reference.storageKey === next.storageKey && reference.dataUrl === next.dataUrl && reference.url === next.url;
        })
        && JSON.stringify(contextValues(left.context)) === JSON.stringify(contextValues(right.context));
}

function contextValues(context: PromptOptimizationContext) {
    return [context.generationModel && [context.generationModel.id, context.generationModel.name, context.generationModel.transport], context.generationIssues || [], context.imageIntent, context.imageRoles || [],
        context.frameSize, context.resolution, context.generationSystemPrompt, context.quality, context.transparentBackground, context.durationSeconds, context.referenceMode, context.audioEnabled, context.upstreamText,
        context.videoReferences || [], context.audioReferences || [], context.referenceTokens?.map(({ token, label, description }) => [token, label, description]) || []];
}

export function promptOptimizationTokens(prompt: string) {
    // Composer reference numbers follow the first appearance of each token.
    return [...new Set(prompt.match(/@\[node:[^\]]*\]/g) || [])];
}
