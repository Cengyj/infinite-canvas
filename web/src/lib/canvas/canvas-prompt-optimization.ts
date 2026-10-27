import i18n from "@/i18n";
import { buildNodeGenerationContext, buildNodeGenerationInputs, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { buildGenerationConfig, sourceNodeReferenceImages } from "@/lib/canvas/canvas-generation-helpers";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { buildPromptOptimizationContext, buildPromptOptimizationGenerationIdentity, type PromptOptimizationInput } from "@/lib/prompt-optimization";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";

export function buildCanvasPromptOptimizationInput(projectId: string, nodeId: string, mode: CanvasGenerationMode, prompt: string, nodes: CanvasNodeData[], connections: CanvasConnection[], config: AiConfig): PromptOptimizationInput | null {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || (mode !== "image" && mode !== "video")) return null;
    const generation = buildNodeGenerationContext(nodeId, nodes, connections, prompt);
    const ownImages = mode === "image" && config.nodeRegenerateBehavior !== "overwrite" ? sourceNodeReferenceImages(node) : [];
    const references = [...new Map([...ownImages, ...generation.referenceImages].map((image) => [image.id, image])).values()];
    const generationConfig = buildGenerationConfig(config, node, mode);
    const context = buildPromptOptimizationContext(mode, generationConfig, references, {
        sourceImageId: ownImages[0]?.id,
        videoReferences: generation.referenceVideos.map((video) => video.name),
        audioReferences: generation.referenceAudios.map((audio) => audio.name),
    });
    let optimizationPrompt = prompt;

    if (node.type === CanvasNodeType.Config) {
        const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
        const inputById = new Map(inputs.map((input) => [input.nodeId, input]));
        const explicitComposer = Boolean(node.metadata?.composerContent?.trim());
        const tokens = explicitComposer ? [...prompt.matchAll(/@\[node:([^\]]+)\]/g)].map((match) => match[1]) : inputs.map((input) => input.nodeId);
        // A first composer draft must make the existing implicit inputs explicit before optimization.
        if (!explicitComposer) optimizationPrompt = [tokens.map((id) => `@[node:${id}]`).join(" "), prompt].filter(Boolean).join("\n\n");
        const counts = { image: 0, video: 0, audio: 0, text: 0 };
        const labels = new Map<string, string>();
        const texts: string[] = [];
        context.referenceTokens = [...new Set(tokens)].flatMap((id) => {
            const input = inputById.get(id);
            if (!input) return [];
            const resources = input.type === "group" ? input.children : [input];
            const resourceLabels = resources.map((resource) => {
                let label = labels.get(resource.nodeId);
                if (!label) {
                    label = resourceLabel(resource.type, counts[resource.type]++);
                    labels.set(resource.nodeId, label);
                    if (resource.type === "text") texts.push(`【${label}】\n${resource.text || ""}`);
                }
                return label;
            });
            return [{ token: `@[node:${id}]`, label: resourceLabels.join("、"), description: input.title }];
        });
        context.upstreamText = texts.join("\n\n");
    } else {
        context.upstreamText = generation.prompt.slice(prompt.length).trim();
    }

    const mediaIdentity = [...generation.referenceVideos, ...generation.referenceAudios].map((media) => [media.id, media.storageKey, media.url]);
    return { targetId: JSON.stringify(["canvas", projectId, nodeId, node.metadata?.composerContent ?? node.metadata?.prompt ?? "", mediaIdentity]), generationIdentity: buildPromptOptimizationGenerationIdentity(mode, generationConfig), scenario: mode, prompt: optimizationPrompt, references, context };
}

function resourceLabel(type: Exclude<NodeGenerationInput["type"], "group">, index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return `${i18n.t("canvas.configNode.videoReferences")} ${index + 1}`;
    if (type === "audio") return `${i18n.t("canvas.configNode.audioReferences")} ${index + 1}`;
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}
