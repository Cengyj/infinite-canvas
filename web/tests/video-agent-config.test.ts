import { expect, mock, spyOn, test } from "bun:test";
import type { AiConfig } from "../src/stores/use-config-store";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const dependencies = await (async () => {
    try {
        return await Promise.all([import("../src/lib/agent/agent-site-tools"), import("../src/stores/use-config-store"), import("../src/stores/use-workbench-agent-store")]);
    } finally {
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();
const [{ runSiteTool }, { defaultConfig, useConfigStore }, { useWorkbenchAgentStore }] = dependencies;

function config(model = "custom-video", script?: string): AiConfig {
    return {
        ...defaultConfig, videoModel: `test::${model}`, size: "16:9",
        channels: [{ id: "test", name: "Mock", baseUrl: "https://generation.example", apiKey: "test-only", apiFormat: "openai", models: [
            { name: "custom-video", capability: "video" },
            { name: "grok-imagine-video", capability: "video", script: model === "grok-imagine-video" ? script : undefined },
            { name: "grok-imagine-video-1.5", capability: "video", script: model === "grok-imagine-video-1.5" ? script : undefined },
        ] }],
    };
}

async function withAgent(initial: AiConfig, action: (controls: { readConfig: () => AiConfig; writes: AiConfig[]; dispatch: ReturnType<typeof mock>; navigate: ReturnType<typeof mock>; dispatchedConfigs: AiConfig[] }) => Promise<void>) {
    let state = { ...useConfigStore.getState(), config: initial };
    const writes: AiConfig[] = [];
    const dispatchedConfigs: AiConfig[] = [];
    const navigate = mock(() => undefined);
    const dispatch = mock(() => { dispatchedConfigs.push(structuredClone(state.config)); return "mock-task"; });
    state.updateConfig = (key, value) => { state = { ...state, config: { ...state.config, [key]: value } }; writes.push(state.config); };
    const configRead = spyOn(useConfigStore, "getState").mockImplementation(() => state);
    const configWrite = spyOn(useConfigStore, "setState").mockImplementation((patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; writes.push(state.config); });
    const workbenchState = { ...useWorkbenchAgentStore.getState(), dispatchVideo: dispatch };
    const workbenchRead = spyOn(useWorkbenchAgentStore, "getState").mockReturnValue(workbenchState);
    try {
        await action({ readConfig: () => state.config, writes, dispatch, navigate, dispatchedConfigs });
    } finally {
        configRead.mockRestore();
        configWrite.mockRestore();
        workbenchRead.mockRestore();
    }
}

test("Agent applies a model switch and short duration together before dispatch", async () => {
    const initial = { ...config(), videoSeconds: "30", vquality: "1080" };
    await withAgent(initial, async ({ readConfig, writes, dispatch, navigate, dispatchedConfigs }) => {
        const result = await runSiteTool("workbench_video_generate", { model: "grok-imagine-video", seconds: 3, resolution: "720", prompt: "小球缓慢滚动" }, navigate);
        expect(writes).toHaveLength(1);
        expect(readConfig()).toMatchObject({ model: initial.model, videoModel: "test::grok-imagine-video", videoSeconds: "3", vquality: "720" });
        expect(dispatchedConfigs).toHaveLength(1);
        expect(dispatchedConfigs[0]).toMatchObject({ videoModel: "test::grok-imagine-video", videoSeconds: "3", vquality: "720" });
        expect(dispatch).toHaveBeenCalledWith({ prompt: "小球缓慢滚动", run: true });
        expect(navigate).toHaveBeenCalledWith("/video");
        expect(result).toMatchObject({ ok: true, applied: { model: "test::grok-imagine-video", seconds: "3", resolution: "720" } });
        expect(initial.videoSeconds).toBe("30");
    });
});

test.each([
    { model: "grok-imagine-video", seconds: 3, resolution: "1080" },
    { model: "grok-imagine-video-1.5", seconds: 16 },
    { model: "grok-imagine-video", size: "auto" },
    { model: "grok-imagine-video", seconds: "" },
    { model: "grok-imagine-video", seconds: " " },
    { model: "grok-imagine-video", size: "" },
    { model: "grok-imagine-video", size: " " },
    { model: "grok-imagine-video", resolution: "" },
    { model: "grok-imagine-video", resolution: " " },
])("Agent invalid combined configuration leaves settings and dispatch untouched (%#)", async (input) => {
    const initial = config();
    await withAgent(initial, async ({ readConfig, writes, dispatch, navigate }) => {
        await expect(runSiteTool("workbench_video_generate", { ...input, prompt: "不应提交" }, navigate)).rejects.toThrow();
        expect(readConfig()).toBe(initial);
        expect(writes).toHaveLength(0);
        expect(dispatch).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });
});

test.each([
    ["grok-imagine-video", ["480", "720"], 10],
    ["grok-imagine-video-1.5", ["480", "720", "1080"], 15],
] as const)("Agent reports %s JSON fields and conditional image limits without inventing counts", async (model, textResolutions, imageMaxSeconds) => {
    await withAgent({ ...config(model), videoMode: "invalid" }, async ({ writes, dispatch, navigate }) => {
        const result = await runSiteTool("workbench_video_get_config", {}, navigate) as { current: { model: string }; referenceCountsKnown: boolean; requestFields: string[]; unsupportedParameters: string[]; modeOptions: unknown[]; mediaConstraints: Array<{ minImages: number; maxImages: number; secondsRange: { min: number; max: number }; resolutions: string[] }>; sizeOptions: Array<{ value: string }>; issues: string[] };
        expect(result.current.model).toBe(`test::${model}`);
        for (const field of ["mode", "generateAudio", "watermark"]) expect(result.current).not.toHaveProperty(field);
        expect(result.requestFields).toEqual(["model", "prompt", "seconds", "aspect_ratio", "resolution", "reference_images"]);
        expect(result.unsupportedParameters).toEqual(["mode", "generateAudio", "watermark"]);
        expect(result.modeOptions).toEqual([]);
        expect(result.referenceCountsKnown).toBe(false);
        expect(result).not.toHaveProperty("imageCount");
        expect(result.mediaConstraints).toHaveLength(model === "grok-imagine-video-1.5" ? 3 : 2);
        expect(result.mediaConstraints).toMatchObject([
            { minImages: 0, maxImages: 0, secondsRange: { min: 1, max: 15 }, resolutions: textResolutions },
            ...(model === "grok-imagine-video-1.5" ? [
                { minImages: 1, maxImages: 1, secondsRange: { min: 1, max: 15 }, resolutions: ["480", "720", "1080"] },
                { minImages: 2, maxImages: 7, secondsRange: { min: 1, max: 15 }, resolutions: ["480", "720"] },
            ] : [{ minImages: 1, maxImages: 7, secondsRange: { min: 1, max: imageMaxSeconds }, resolutions: ["480", "720"] }]),
        ]);
        for (const constraint of result.mediaConstraints) expect(constraint).not.toHaveProperty("mode");
        expect(result.sizeOptions.map((option) => option.value)).not.toContain("auto");
        expect(result.issues).toEqual([]);
        expect(writes).toHaveLength(0);
        expect(dispatch).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });
});

test.each(["frames", "reference", "invalid", ""])("Agent ignores stored Grok mode %s and defers image-dependent checks to the workbench", async (videoMode) => {
    await withAgent({ ...config("grok-imagine-video"), videoMode }, async ({ readConfig, writes, dispatch, navigate }) => {
        expect(await runSiteTool("workbench_video_generate", { seconds: 15, run: false }, navigate)).toMatchObject({ ok: true, run: false, applied: { seconds: "15" } });
        expect(readConfig()).toMatchObject({ videoMode, videoSeconds: "15" });
        expect(writes).toHaveLength(1);
        expect(dispatch).toHaveBeenCalledWith({ prompt: undefined, run: false });
    });
});

test.each([
    { mode: "frames" }, { mode: "reference" }, { mode: "invalid" }, { mode: "" },
    { generateAudio: true }, { generateAudio: false }, { watermark: true }, { watermark: false },
])("Agent rejects explicit unsupported Grok controls before any partial update (%#)", async (input) => {
    for (const model of ["grok-imagine-video", "grok-imagine-video-1.5"]) {
        const initial = config();
        await withAgent(initial, async ({ readConfig, writes, dispatch, navigate }) => {
            await expect(runSiteTool("workbench_video_generate", { model, seconds: 3, resolution: "720", prompt: "不应提交", ...input }, navigate)).rejects.toThrow();
            expect(readConfig()).toBe(initial);
            expect(writes).toHaveLength(0);
            expect(dispatch).not.toHaveBeenCalled();
            expect(navigate).not.toHaveBeenCalled();
        });
    }
});

test.each(["grok-imagine-video", "grok-imagine-video-1.5"])("Agent rejects every advertised unsupported %s parameter without exposing mutable rules", async (model) => {
    const initial = config(model);
    await withAgent(initial, async ({ readConfig, writes, dispatch, navigate }) => {
        const advertised = await runSiteTool("workbench_video_get_config", {}, navigate) as { unsupportedParameters: string[] };
        const parameters = [...advertised.unsupportedParameters];
        expect(parameters).toHaveLength(3);
        advertised.unsupportedParameters.length = 0;
        expect(await runSiteTool("workbench_video_get_config", {}, navigate)).toMatchObject({ unsupportedParameters: parameters });
        for (const parameter of parameters) {
            await expect(runSiteTool("workbench_video_generate", { seconds: 3, prompt: "不应提交", [parameter]: parameter === "mode" ? "reference" : false }, navigate)).rejects.toThrow(parameter);
        }
        expect(readConfig()).toBe(initial);
        expect(writes).toHaveLength(0);
        expect(dispatch).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });
});

test("Agent keeps saved-script and non-Grok duration behavior and generic choices", async () => {
    const script = "return 'custom-result';";
    for (const initial of [config(), config("grok-imagine-video", script)]) {
        await withAgent(initial, async ({ readConfig, dispatch, navigate }) => {
            expect(await runSiteTool("workbench_video_generate", { seconds: 3, resolution: "1080", size: "auto", mode: "reference", generateAudio: false, watermark: true, run: false }, navigate)).toMatchObject({ ok: true, applied: { seconds: "4", resolution: "1080", size: "auto", mode: "reference", generateAudio: false, watermark: true } });
            expect(readConfig()).toMatchObject({ videoModel: initial.videoModel, videoSeconds: "4", size: "auto", videoMode: "reference", videoGenerateAudio: "false", videoWatermark: "true" });
            expect(readConfig().channels).toEqual(initial.channels);
            const capabilities = await runSiteTool("workbench_video_get_config", {}, navigate);
            expect(capabilities).toMatchObject({ secondsRange: { min: 4, max: 30 }, current: { mode: "reference", generateAudio: false, watermark: true }, modeOptions: [{ value: "frames" }, { value: "reference" }] });
            expect(capabilities).not.toHaveProperty("mediaConstraints");
            expect(dispatch).toHaveBeenCalledTimes(1);
            const previous = structuredClone(readConfig());
            await runSiteTool("workbench_video_generate", { seconds: "", size: "", resolution: "", mode: "invalid", run: false }, navigate);
            expect(readConfig()).toEqual(previous);
            expect(dispatch).toHaveBeenCalledTimes(2);
        });
    }
});
