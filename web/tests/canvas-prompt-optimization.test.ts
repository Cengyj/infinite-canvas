import { expect, test } from "bun:test";
import type { CanvasConnection, CanvasNodeData, CanvasNodeMetadata } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const dependencies = await (async () => {
    try {
        return await Promise.all([import("../src/lib/canvas/canvas-prompt-optimization"), import("../src/components/canvas/canvas-node-generation"), import("../src/stores/use-config-store"), import("../src/types/canvas"), import("../src/lib/canvas/canvas-resource-references"), import("../src/lib/image-reference-prompt")]);
    } finally {
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();
const [{ buildCanvasPromptOptimizationInput }, { buildNodeGenerationContext }, { defaultConfig }, { CanvasNodeType }, { buildNodeMentionReferences }, { imageReferenceLabel }] = dependencies;

function node(id: string, type: CanvasNodeData["type"], metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 200, height: 200, metadata };
}

function connect(fromNodeId: string, toNodeId: string): CanvasConnection {
    return { id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId };
}

test("image optimization follows new-node and overwrite reference semantics without expanding the draft", () => {
    const source = node("result", CanvasNodeType.Image, { content: "blob:result", storageKey: "image:result", quality: "max", size: "1024x1536" });
    const image = node("reference", CanvasNodeType.Image, { content: "blob:reference", storageKey: "image:reference" });
    const text = node("brief", CanvasNodeType.Text, { content: "保留包装文字" });
    const nodes = [source, image, text];
    const edges = [connect(image.id, source.id), connect(text.id, source.id)];
    const initial = buildCanvasPromptOptimizationInput("project", source.id, "image", "改成暖光", nodes, edges, { ...defaultConfig, nodeRegenerateBehavior: "new-node" })!;
    expect(initial.references.map((item) => item.id)).toEqual([source.id, image.id]);
    expect(initial.prompt).toBe("改成暖光");
    expect(initial.context.upstreamText).toContain("保留包装文字");
    expect(initial.context).toMatchObject({ quality: "max", frameSize: "1024x1536" });
    const overwritten = buildCanvasPromptOptimizationInput("project", source.id, "image", initial.prompt, nodes, edges, { ...defaultConfig, nodeRegenerateBehavior: "overwrite" })!;
    expect(overwritten.references.map((item) => item.id)).toEqual([image.id]);
});

test.each(["new-node", "overwrite"] as const)("image mention labels follow the actual %s reference order", (behavior) => {
    const source = node("source", CanvasNodeType.Image, { content: "blob:source" });
    const image = node("reference", CanvasNodeType.Image, { content: "blob:reference" });
    const text = node("brief", CanvasNodeType.Text, { content: "保留包装文字" });
    const nodes = [source, image, text];
    const edges = [connect(image.id, source.id), connect(text.id, source.id)];
    const mentions = buildNodeMentionReferences(source, nodes, edges, behavior !== "overwrite");
    const imageMentions = mentions.filter((item) => item.kind === "image");
    const expectedIds = behavior === "new-node" ? [source.id, image.id] : [image.id];
    expect(imageMentions.map((item) => [item.nodeId, item.label])).toEqual(expectedIds.map((id, index) => [id, imageReferenceLabel(index)]));
    const prompt = "保留" + mentions.find((item) => item.nodeId === image.id)!.label + "的文字";
    const input = buildCanvasPromptOptimizationInput("project", source.id, "image", prompt, nodes, edges, { ...defaultConfig, nodeRegenerateBehavior: behavior })!;
    expect(input.references.map((item) => item.id)).toEqual(expectedIds);
    expect(input.prompt).toBe(prompt);
    expect(mentions.filter((item) => item.kind === "text").map((item) => item.nodeId)).toEqual([text.id]);
});

test.each(["new-node", "overwrite"] as const)("image mentions without external inputs follow %s source-image participation", (behavior) => {
    const source = node("source", CanvasNodeType.Image, { content: "blob:source" });
    const mentions = buildNodeMentionReferences(source, [source], [], behavior !== "overwrite");
    const input = buildCanvasPromptOptimizationInput("project", source.id, "image", "改成暖光", [source], [], { ...defaultConfig, nodeRegenerateBehavior: behavior })!;
    expect(mentions.map((item) => item.nodeId)).toEqual(behavior === "new-node" ? [source.id] : []);
    expect(mentions.map((item) => item.nodeId)).toEqual(input.references.map((item) => item.id));
    expect(buildNodeMentionReferences(node("empty", CanvasNodeType.Image), [], [], behavior !== "overwrite")).toEqual([]);
});

test.each(["new-node", "overwrite"] as const)("image mentions preserve group deduplication and connected-config priority in %s mode", (behavior) => {
    const source = node("source", CanvasNodeType.Image, { content: "blob:source" });
    const configNode = node("config", CanvasNodeType.Config);
    const group = node("group", CanvasNodeType.Group);
    const first = node("first", CanvasNodeType.Image, { content: "blob:first", groupId: group.id });
    const second = node("second", CanvasNodeType.Image, { content: "blob:second", groupId: group.id });
    const unused = node("unused", CanvasNodeType.Image, { content: "blob:unused" });
    const nodes = [source, configNode, group, first, second, unused];
    const expectedIds = behavior === "new-node" ? [source.id, first.id, second.id] : [first.id, second.id];
    for (const edges of [
        [connect(group.id, source.id), connect(first.id, source.id)],
        [connect(source.id, configNode.id), connect(group.id, configNode.id), connect(first.id, configNode.id), connect(unused.id, source.id)],
    ]) {
        const mentions = buildNodeMentionReferences(source, nodes, edges, behavior !== "overwrite");
        const input = buildCanvasPromptOptimizationInput("project", source.id, "image", "改成暖光", nodes, edges, { ...defaultConfig, nodeRegenerateBehavior: behavior })!;
        expect(mentions.map((item) => [item.nodeId, item.label])).toEqual(expectedIds.map((id, index) => [id, imageReferenceLabel(index)]));
        expect(input.references.map((item) => item.id)).toEqual(expectedIds);
    }
});

test("an explicit group source reference keeps its generation position when not automatically prepended", () => {
    const group = node("group", CanvasNodeType.Group);
    const image = node("reference", CanvasNodeType.Image, { content: "blob:reference", groupId: group.id });
    const source = node("source", CanvasNodeType.Image, { content: "blob:source", groupId: group.id });
    const nodes = [group, image, source];
    const edges = [connect(group.id, source.id), connect(image.id, source.id)];
    expect(buildNodeGenerationContext(source.id, nodes, edges, "").referenceImages.map((item) => item.id)).toEqual([image.id, source.id]);
    expect(buildNodeMentionReferences(source, nodes, edges, false).map((item) => item.nodeId)).toEqual([image.id, source.id]);
    expect(buildNodeMentionReferences(source, nodes, edges, true).map((item) => item.nodeId)).toEqual([source.id, image.id]);
});

test("config optimization preserves group tokens and the generation resource order", () => {
    const prompt = "以 @[node:group] 为参考，保留 @[node:image]";
    const configNode = node("config", CanvasNodeType.Config, { composerContent: prompt });
    const group = node("group", CanvasNodeType.Group);
    const image = node("image", CanvasNodeType.Image, { content: "blob:image", groupId: group.id });
    const text = node("text", CanvasNodeType.Text, { content: "晴山茶", groupId: group.id });
    const unused = node("unused", CanvasNodeType.Image, { content: "blob:unused" });
    const nodes = [configNode, group, image, text, unused];
    const edges = [connect(group.id, configNode.id), connect(image.id, configNode.id), connect(unused.id, configNode.id)];
    const input = buildCanvasPromptOptimizationInput("project", configNode.id, "image", prompt, nodes, edges, defaultConfig)!;
    expect(input.prompt).toBe(prompt);
    expect(input.references.map((item) => item.id)).toEqual([image.id]);
    expect(input.context.upstreamText).toContain("晴山茶");
    expect(input.context.referenceTokens?.map((item) => item.token)).toEqual(["@[node:group]", "@[node:image]"]);
    expect(input.context.referenceTokens?.[0].label).toContain(input.context.referenceTokens![1].label);
});

test("the first optimized config draft keeps every formerly implicit reference after application", () => {
    const configNode = node("config", CanvasNodeType.Config);
    const image = node("image", CanvasNodeType.Image, { content: "blob:image" });
    const text = node("text", CanvasNodeType.Text, { content: "复古海报" });
    const nodes = [configNode, image, text];
    const edges = [connect(image.id, configNode.id), connect(text.id, configNode.id)];
    const input = buildCanvasPromptOptimizationInput("project", configNode.id, "image", "", nodes, edges, defaultConfig)!;
    expect(configNode.metadata?.composerContent).toBeUndefined();
    expect(input.prompt).toBe("@[node:image] @[node:text]");
    const applied = { ...configNode, metadata: { ...configNode.metadata, composerContent: input.prompt } };
    const context = buildNodeGenerationContext(configNode.id, [applied, image, text], edges, input.prompt);
    expect(context.referenceImages.map((item) => item.id)).toEqual(input.references.map((item) => item.id));
    expect(context.prompt).toContain("复古海报");
});

test("canvas targets change when the project, externally saved draft, or reference media changes", () => {
    const configNode = node("config", CanvasNodeType.Config, { composerContent: "@[node:video]" });
    const video = node("video", CanvasNodeType.Video, { content: "blob:old", storageKey: "video:old" });
    const edges = [connect(video.id, configNode.id)];
    const read = (project: string, target = configNode, media = video) => buildCanvasPromptOptimizationInput(project, target.id, "video", "@[node:video]", [target, media], edges, defaultConfig)!;
    const original = read("project");
    expect(read("other").targetId).not.toBe(original.targetId);
    expect(read("project", { ...configNode, metadata: { composerContent: "外部修改 @[node:video]" } }).targetId).not.toBe(original.targetId);
    expect(read("project", configNode, { ...video, metadata: { content: "blob:new", storageKey: "video:new" } }).targetId).not.toBe(original.targetId);
});
