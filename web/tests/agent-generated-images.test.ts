import { expect, test } from "bun:test";

import { GENERATED_IMAGE_MAX_BYTES, generatedImageFileName, generatedImageSources, importGeneratedImageSources, isSuccessfulImageGeneration } from "../src/components/agent/agent-generated-images";

test("only successful image events may import saved paths or inline images", () => {
    expect(isSuccessfulImageGeneration({})).toBe(true);
    expect(isSuccessfulImageGeneration({ status: "completed", success: true })).toBe(true);
    for (const item of [{ status: "failed" }, { status: "cancelled" }, { success: false }, { status: "completed", error: { message: "failed" } }]) {
        expect(isSuccessfulImageGeneration(item)).toBe(false);
    }
});

test("finds generated images from POSIX and Windows absolute paths", () => {
    const windowsPath = String.raw`C:\Users\Ceng\output\render.PNG`;
    const sources = generatedImageSources({
        posix: "/tmp/render.webp",
        windows: [windowsPath, "D:/output/render.jpg", String.raw`\\server\share\render.avif`, windowsPath],
        dataUrl: "data:image/png;base64,AAAA",
    });

    expect(Array.from(sources)).toEqual([
        "/tmp/render.webp",
        windowsPath,
        "D:/output/render.jpg",
        String.raw`\\server\share\render.avif`,
        "data:image/png;base64,AAAA",
    ]);
});

test("ignores relative, unsupported, and multiline image paths", () => {
    expect(Array.from(generatedImageSources([
        "output/render.png",
        String.raw`output\render.png`,
        String.raw`C:\output\render.svg`,
        "C:\\output\\render.png\nmore text",
        "/tmp/render.png\rmore text",
    ]))).toEqual([]);
});

test("extracts generated image names with either path separator", () => {
    expect(generatedImageFileName("/tmp/render.webp")).toBe("render.webp");
    expect(generatedImageFileName(String.raw`/tmp/render\final.webp`)).toBe(String.raw`render\final.webp`);
    expect(generatedImageFileName(String.raw`C:\output\render.png`)).toBe("render.png");
    expect(generatedImageFileName("data:image/png;base64,AAAA")).toBeUndefined();
});

test("stops safely when generated-image metadata is cyclic", () => {
    const cyclic: { image: string; self?: unknown } = { image: "/tmp/render.png" };
    cyclic.self = cyclic;
    expect(Array.from(generatedImageSources(cyclic))).toEqual(["/tmp/render.png"]);
});

test("imports at most eight images sequentially and counts truncated results", async () => {
    const sources = Array.from({ length: 10 }, (_, index) => `/tmp/render-${index}.png`);
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const result = await importGeneratedImageSources(
        sources,
        async (source) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await Promise.resolve();
            order.push(source);
            active -= 1;
            return { size: 1 };
        },
        async (_blob, source) => source,
    );

    expect(result.items).toEqual(sources.slice(0, 8));
    expect(result.failed).toBe(2);
    expect(order).toEqual(sources.slice(0, 8));
    expect(maxActive).toBe(1);
});

test("keeps valid images when a read fails or the total exceeds 30 MB", async () => {
    const sources = ["/tmp/first.png", "/tmp/read-fails.png", "/tmp/too-large.png", "/tmp/last.png"];
    const sizes = new Map([
        [sources[0], 20 * 1024 * 1024],
        [sources[2], 11 * 1024 * 1024],
        [sources[3], 10 * 1024 * 1024],
    ]);
    const result = await importGeneratedImageSources(
        sources,
        async (source) => {
            if (source === sources[1]) throw new Error("read failed");
            return { size: sizes.get(source) || 0 };
        },
        async (_blob, source) => source,
    );

    expect(result.items).toEqual([sources[0], sources[3]]);
    expect(result.failed).toBe(2);
    expect(result.items.reduce((total, source) => total + (sizes.get(source) || 0), 0)).toBe(GENERATED_IMAGE_MAX_BYTES);
});
