import "./setup";
import { expect, test } from "bun:test";
import { iterateBarriers } from "./storage-setup";
import { retainMediaReferences } from "../src/services/media-references";

if (typeof globalThis.window === "undefined") Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });

class ControlledImage {
    static mode: "load" | "error" | "hold" = "load";
    static pending: ControlledImage[] = [];
    naturalWidth = 640;
    naturalHeight = 480;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
        if (ControlledImage.mode === "hold") ControlledImage.pending.push(this);
        else queueMicrotask(() => (ControlledImage.mode === "error" ? this.onerror?.() : this.onload?.()));
    }
    finish(ok = true) {
        if (ok) this.onload?.(); else this.onerror?.();
    }
}
Object.defineProperty(globalThis, "Image", { configurable: true, value: ControlledImage });

const { cleanupUnusedImages, collectImageStorageKeys, getImageBlob, resolveImageUrl, setImageBlob } = await import("../src/services/image-storage");
const { cleanupUnusedMedia, collectMediaStorageKeys, deleteStoredMedia, getMediaBlob, resolveMediaUrl, setMediaBlob, uploadMediaFile } = await import("../src/services/file-storage");

test("rejects a corrupt image without replacing an existing valid image", async () => {
    const valid = new Blob(["valid image"]);
    await setImageBlob("image:decode", valid);
    ControlledImage.mode = "error";
    await expect(setImageBlob("image:decode", new Blob(["broken image"]))).rejects.toThrow();
    ControlledImage.mode = "load";
    expect(await getImageBlob("image:decode")).toBe(valid);
});

test("the newest completed decode wins when image writes overlap", async () => {
    ControlledImage.mode = "hold";
    const first = setImageBlob("image:race", new Blob(["old"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = setImageBlob("image:race", new Blob(["new"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [firstImage, secondImage] = ControlledImage.pending.splice(0, 2);
    firstImage.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondImage.finish();
    ControlledImage.mode = "load";
    await Promise.all([first, second]);
    expect(await (await getImageBlob("image:race"))?.text()).toBe("new");
});

test("explicit deletion cancels an image still waiting for decode", async () => {
    ControlledImage.mode = "hold";
    const writing = setImageBlob("image:cancel-decode", new Blob(["pending"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [pending] = ControlledImage.pending.splice(0, 1);
    const deletion = (await import("../src/services/image-storage")).deleteStoredImages(["image:cancel-decode"]);
    pending.finish();
    ControlledImage.mode = "load";
    await Promise.all([writing, deletion]);
    expect(await getImageBlob("image:cancel-decode")).toBeNull();
});

function pauseHistoryRead() {
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    iterateBarriers.set("video_generation_logs", barrier);
    return () => { iterateBarriers.delete("video_generation_logs"); resume(); };
}

test("retains stored generation references after their source nodes are gone", async () => {
    const image = new Blob(["reference image"]);
    const video = new Blob(["reference video"]);
    await setImageBlob("image:source", image);
    await setMediaBlob("video:source", video);
    await setImageBlob("image:orphan", new Blob(["unused"]));
    await setMediaBlob("video:orphan", new Blob(["unused"]));
    const project = { nodes: [{ metadata: { references: ["image:source", "video:source", "audio-reference:source"] } }] };

    expect([...collectImageStorageKeys(project)]).toEqual(["image:source"]);
    expect([...collectMediaStorageKeys(project)]).toEqual(["video:source", "audio-reference:source"]);
    await Promise.all([cleanupUnusedImages(project), cleanupUnusedMedia(project)]);

    expect(await getImageBlob("image:source")).toBe(image);
    expect(await getMediaBlob("video:source")).toBe(video);
    expect(await getImageBlob("image:orphan")).toBeNull();
    expect(await getMediaBlob("video:orphan")).toBeNull();
});

test("does not delete uploads completed while an older cleanup snapshot reads history", async () => {
    const resume = pauseHistoryRead();
    const cleanup = Promise.all([cleanupUnusedImages({}), cleanupUnusedMedia({})]);
    const image = new Blob(["new image"]);
    await setImageBlob("image:concurrent", image);
    const media = await uploadMediaFile(new Blob(["new media"]));
    resume();
    await cleanup;

    expect(await getImageBlob("image:concurrent")).toBe(image);
    expect(await getMediaBlob(media.storageKey)).not.toBeNull();
    await Promise.all([cleanupUnusedImages({}), cleanupUnusedMedia({})]);
    expect(await getImageBlob("image:concurrent")).toBeNull();
    expect(await getMediaBlob(media.storageKey)).toBeNull();
});

test("protects writes already in progress when cleanup starts", async () => {
    const image = new Blob(["pending image"]);
    const video = new Blob(["pending video"]);
    const writing = Promise.all([setImageBlob("image:pending", image), setMediaBlob("video:pending", video)]);
    const resume = pauseHistoryRead();
    const cleanup = Promise.all([cleanupUnusedImages({}), cleanupUnusedMedia({})]);
    await writing;
    resume();
    await cleanup;
    expect(await getImageBlob("image:pending")).toBe(image);
    expect(await getMediaBlob("video:pending")).toBe(video);
});

test("global cleanup retains mounted canvas undo history and unsaved workbench references", async () => {
    const image = new Blob(["undo image"]);
    const video = new Blob(["undo video"]);
    await setImageBlob("image:undo", image);
    await setMediaBlob("video:undo", video);
    await setImageBlob("image:workbench", image);
    const release = retainMediaReferences(() => ({
        history: { past: [{ nodes: [{ metadata: { storageKey: "image:undo" } }, { metadata: { storageKey: "video:undo" } }] }] },
        references: [{ storageKey: "image:workbench" }],
    }));
    try {
        await Promise.all([cleanupUnusedImages({ projects: [], assets: [] }), cleanupUnusedMedia({ projects: [], assets: [] })]);
        expect(await getImageBlob("image:undo")).toBe(image);
        expect(await getMediaBlob("video:undo")).toBe(video);
        expect(await getImageBlob("image:workbench")).toBe(image);
    } finally {
        release();
    }
    await Promise.all([cleanupUnusedImages({}), cleanupUnusedMedia({})]);
    expect(await getImageBlob("image:undo")).toBeNull();
    expect(await getMediaBlob("video:undo")).toBeNull();
    expect(await getImageBlob("image:workbench")).toBeNull();
});

test("rereads mounted references before deleting files after an asynchronous scan", async () => {
    const image = new Blob(["selected image"]);
    await setImageBlob("image:selected", image);
    let references: unknown = [];
    const release = retainMediaReferences(() => references);
    const resume = pauseHistoryRead();
    const cleanup = cleanupUnusedImages({});
    references = [{ storageKey: "image:selected" }];
    resume();
    try {
        await cleanup;
        expect(await getImageBlob("image:selected")).toBe(image);
    } finally {
        release();
    }
});

test("queued image cleanup keeps both blob and URL when a reference appears behind thumbnail work", async () => {
    const image = new Blob(["queued image"]);
    const url = await setImageBlob("image:queued", image);
    const originalCreateBitmap = globalThis.createImageBitmap;
    let unblock!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    globalThis.createImageBitmap = (async () => {
        markStarted();
        await blocked;
        return { width: 1, height: 1, close() {} };
    }) as typeof createImageBitmap;
    const writing = setImageBlob("image:blocking-thumbnail", new Blob(["thumbnail"]));
    await started;
    const cleanup = cleanupUnusedImages({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    const release = retainMediaReferences(() => [{ storageKey: "image:queued" }]);
    try {
        unblock();
        await Promise.all([writing, cleanup]);
        expect(await getImageBlob("image:queued")).toBe(image);
        expect(await resolveImageUrl("image:queued")).toBe(url);
        expect(await (await fetch(url)).text()).toBe("queued image");
    } finally {
        unblock();
        release();
        globalThis.createImageBitmap = originalCreateBitmap;
    }
});

test("automatic media deletion checks live references inside the mutation lock", async () => {
    const video = new Blob(["queued video"]);
    const url = await setMediaBlob("video:queued", video);
    const cleanup = deleteStoredMedia(["video:queued"], true);
    const release = retainMediaReferences(() => [{ storageKey: "video:queued" }]);
    try {
        await cleanup;
        expect(await getMediaBlob("video:queued")).toBe(video);
        expect(await resolveMediaUrl("video:queued")).toBe(url);
        expect(await (await fetch(url)).text()).toBe("queued video");
    } finally {
        release();
    }
});
