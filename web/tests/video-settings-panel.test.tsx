import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { AiConfig, ApiCallFormat } from "../src/stores/use-config-store";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const dependencies = await (async () => {
    try {
        return await Promise.all([import("../src/components/video-settings-panel"), import("../src/stores/use-config-store"), import("../src/lib/canvas-theme"), import("../src/i18n/locales/zh-CN")]);
    } finally {
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();
const [{ VideoSettingsPanel }, { defaultConfig }, { canvasThemes }, { default: zhCN }] = dependencies;
const locale = createInstance();
await locale.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, initAsync: false });

function config(model = "custom-video", apiFormat: ApiCallFormat = "openai", script?: string): AiConfig {
    return {
        ...defaultConfig, model: `test::${model}`, videoModel: `test::${model}`, size: "16:9", vquality: "720", videoSeconds: "6",
        channels: [{ id: "test", name: "Render fixture", baseUrl: "https://generation.example", apiKey: "test-only", apiFormat, models: [{ name: model, capability: "video", script }] }],
    };
}

type Control = { kind: "button" | "input" | "slider"; label: string; disabled: boolean; min: string | null; max: string | null };

async function renderPanel(initial: AiConfig, imageCount = 0, theme: keyof typeof canvasThemes = "light") {
    const controls: Control[] = [];
    const groups: string[] = [];
    const labels: string[] = [];
    let activeButton: Control | undefined;
    const before = structuredClone(initial);
    const markup = renderToStaticMarkup(
        <I18nextProvider i18n={locale}>
            <VideoSettingsPanel config={initial} media={{ imageCount }} theme={canvasThemes[theme]} onConfigChange={() => { throw new Error("Rendering must not rewrite configuration"); }} />
        </I18nextProvider>,
    );
    // Parse the real React/Ant Design output with Bun's built-in HTML parser.
    await new HTMLRewriter()
        .on('div[class="space-y-2.5"] > div:first-child', {
            element() { groups.push(""); },
            text(chunk) { groups[groups.length - 1] += chunk.text; },
        })
        .on("label", {
            element() { labels.push(""); },
            text(chunk) { labels[labels.length - 1] += chunk.text; },
        })
        .on("button", {
            element(element) {
                activeButton = { kind: "button", label: "", disabled: element.hasAttribute("disabled"), min: null, max: null };
                controls.push(activeButton);
            },
            text(chunk) { if (activeButton) activeButton.label += chunk.text; },
        })
        .on("input", {
            element(element) { controls.push({ kind: "input", label: element.getAttribute("type") || "text", disabled: element.hasAttribute("disabled"), min: element.getAttribute("min"), max: element.getAttribute("max") }); },
        })
        .on('[role="slider"]', {
            element(element) { controls.push({ kind: "slider", label: "", disabled: element.getAttribute("aria-disabled") === "true", min: element.getAttribute("aria-valuemin"), max: element.getAttribute("aria-valuemax") }); },
        })
        .transform(new Response(markup)).text();
    controls.forEach((control) => { control.label = control.label.trim(); });
    expect(initial).toEqual(before);
    return { groups: groups.map((value) => value.trim()), labels: labels.map((value) => value.trim()).filter(Boolean), controls, buttons: controls.filter((control) => control.kind === "button"), inputs: controls.filter((control) => control.kind === "input"), slider: controls.find((control) => control.kind === "slider") };
}

// Fixed visible order from the original 0.20.0 ZIP, independent of capability code.
const originalControls = [
    "button:480p", "button:720p", "button:1080p", "input:number", "input:number", "input:number",
    "button:1:1", "button:3:4", "button:4:3", "button:16:9", "button:9:16", "button:21:9", "button:自动",
    "slider:", "input:number", "button:首尾帧模式", "button:全能参考模式",
];

test.each(["light", "dark"] as const)("video settings preserve the original control order and Chinese labels in %s theme", async (theme) => {
    for (const model of ["custom-video", "grok-imagine-video", "grok-imagine-video-1.5"]) {
        const panel = await renderPanel(config(model), 1, theme);
        expect(panel.groups).toEqual(["清晰度", "尺寸", "比例", "秒数", "模式"]);
        expect(panel.labels).toEqual(["p", "W", "H"]);
        expect(panel.controls.map(({ kind, label }) => `${kind}:${label}`)).toEqual(originalControls);
    }
});

test.each([0, 1, 7])("classic Grok disables 1080p and renders its duration limits with %s images", async (count) => {
    const panel = await renderPanel(config("grok-imagine-video"), count);
    expect(panel.buttons.slice(0, 3).map(({ disabled }) => disabled)).toEqual([false, false, true]);
    expect(panel.slider).toMatchObject({ min: "1", max: count ? "10" : "15" });
    expect(panel.inputs[3]).toMatchObject({ min: "1", max: count ? "10" : "15" });
});

test.each([0, 1, 2, 7])("Grok 1.5 enables 1080p only for zero or one image (%s images)", async (count) => {
    const panel = await renderPanel(config("grok-imagine-video-1.5"), count);
    expect(panel.buttons.slice(0, 3).map(({ disabled }) => disabled)).toEqual([false, false, count > 1]);
    expect(panel.slider).toMatchObject({ min: "1", max: "15" });
});

test.each(["grok-imagine-video", "grok-imagine-video-1.5"])("%s keeps unsupported controls visible and disabled", async (model) => {
    const panel = await renderPanel(config(model), 1);
    expect(panel.inputs.map(({ disabled }) => disabled)).toEqual([true, true, true, false]);
    expect(panel.buttons.filter(({ disabled }) => disabled).map(({ label }) => label)).toEqual([...(model === "grok-imagine-video" ? ["1080p"] : []), "自动", "首尾帧模式", "全能参考模式"]);
});

test.each([
    ["custom-video", "openai", undefined],
    ["grok-imagine-video", "openai", "return 'custom';"],
    ["grok-imagine-video-1.5", "openai", "return 'custom';"],
    ["grok-imagine-video", "gemini", undefined],
    ["grok-imagine-video-1.5", "gemini", undefined],
] as const)("%s on %s with script %s keeps generic controls enabled", async (model, format, script) => {
    const panel = await renderPanel(config(model, format, script), 7);
    expect(panel.controls.map(({ kind, label }) => `${kind}:${label}`)).toEqual(originalControls);
    expect(panel.buttons.every(({ disabled }) => !disabled)).toBe(true);
    expect(panel.inputs.every(({ disabled }) => !disabled)).toBe(true);
    expect(panel.slider).toMatchObject({ min: "4", max: "30" });
    expect(panel.inputs[3]).toMatchObject({ min: "4", max: "30" });
});

test("generic automatic ratio retains its original dimension-input behavior", async () => {
    const panel = await renderPanel({ ...config(), size: "auto" }, 0);
    expect(panel.inputs.map(({ disabled }) => disabled)).toEqual([false, true, true, false]);
    expect(panel.buttons.every(({ disabled }) => !disabled)).toBe(true);
});
