import "./setup";
import { expect, test } from "bun:test";

import { buildCanvasPromptOptimizationContext, canvasPromptOptimizationChanges, createCanvasPromptOptimizationBinding } from "../src/lib/canvas/canvas-prompt-optimization";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-generation-helpers";
import { defaultConfig, type AiConfig } from "../src/stores/use-config-store";
import { CanvasNodeType } from "../src/types/canvas";
import type { ReferenceImage } from "../src/types/image";

const reference = (id: string, source = "https://images.example/reference.png"): ReferenceImage => ({ id, name: `${id}.png`, type: "image/png", dataUrl: source, storageKey: `image:${id}` });
const config = { ...defaultConfig, model: "default::grok-imagine-video", size: "3:4", vquality: "720", videoSeconds: "2", videoGenerateAudio: "false" } as AiConfig;

test("video optimization preserves portrait framing, Grok short duration and disabled audio", () => {
    expect(buildCanvasPromptOptimizationContext("video", config, [reference("source")])).toEqual({ generationMode: "image-to-video", referenceMode: "frames", frameSize: "720x960", durationSeconds: "2", audioEnabled: false });
    expect(buildCanvasPromptOptimizationContext("video", config, []).generationMode).toBe("text-to-video");
});

test("optimized prompt bindings detect replaced, removed and reordered references", () => {
    const references = [reference("source"), reference("style")];
    const binding = createCanvasPromptOptimizationBinding("优化结果", "image", buildCanvasPromptOptimizationContext("image", config, references), references);
    expect(canvasPromptOptimizationChanges(binding, " 优化结果 ", "image", config, references)).toEqual({ referencesChanged: false, contextChanged: false });
    expect(canvasPromptOptimizationChanges(binding, "优化结果", "image", config, [...references].reverse())?.referencesChanged).toBe(true);
    expect(canvasPromptOptimizationChanges(binding, "优化结果", "image", config, references.slice(0, 1))?.referencesChanged).toBe(true);
    expect(canvasPromptOptimizationChanges(binding, "优化结果", "image", config, [reference("source", "https://images.example/replaced.png"), references[1]])?.referencesChanged).toBe(true);
});

test("bindings detect relevant parameter changes without blocking a manually rewritten prompt", () => {
    const binding = createCanvasPromptOptimizationBinding("优化结果", "video", buildCanvasPromptOptimizationContext("video", config, []), []);
    for (const patch of [{ videoSeconds: "3" }, { size: "16:9" }, { videoGenerateAudio: "true" }, { videoMode: "reference" }]) {
        expect(canvasPromptOptimizationChanges(binding, "优化结果", "video", { ...config, ...patch }, [])?.contextChanged).toBe(true);
    }
    expect(canvasPromptOptimizationChanges(binding, "手动修改后的提示词", "video", config, [])).toBeNull();
    expect(canvasPromptOptimizationChanges(binding, "优化结果", "image", config, [])).toBeNull();
});

test("shared canvas generation settings retain node overrides and upstream video mode", () => {
    const node = { id: "video-node", type: CanvasNodeType.Video, title: "视频", width: 320, height: 240, position: { x: 0, y: 0 }, metadata: { seconds: "2", size: "9:16", videoMode: "omni", generateAudio: "false", watermark: "false" } };
    const result = buildGenerationConfig(config, node, "video");
    expect(result.videoSeconds).toBe("2");
    expect(result.size).toBe("9:16");
    expect(result.videoMode).toBe("omni");
    expect(result.videoGenerateAudio).toBe("false");
    expect(result.videoWatermark).toBe("false");
});
