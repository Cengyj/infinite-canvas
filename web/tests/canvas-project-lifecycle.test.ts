import { expect, mock, spyOn, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { CanvasGenerationRequest } from "../src/lib/canvas/canvas-project-lifecycle";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
if (!originalStorage) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const [helpers, { abortCanvasGenerationRequests, finishCanvasGenerationRequest, hydrateCanvasProjectSnapshot, startCanvasGenerationRequest }] = await (async () => {
    try {
        return await Promise.all([import("../src/lib/canvas/canvas-generation-helpers"), import("../src/lib/canvas/canvas-project-lifecycle")]);
    } finally {
        if (!originalStorage) Reflect.deleteProperty(globalThis, "localStorage");
    }
})();

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const video: CanvasNodeData = { id: "video", type: CanvasNodeType.Video, title: "Video", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status: "loading", videoTaskId: "pending-task", videoTaskProvider: "openai", model: "grok-imagine-video-1.5" } };

test("project restoration preserves resumable video tasks and existing interruption rules", async () => {
    const image = { ...video, id: "image", type: CanvasNodeType.Image, metadata: { status: "loading" as const } };
    const hydrateNodes = spyOn(helpers, "hydrateCanvasImages").mockImplementation(async nodes => nodes);
    const hydrateChat = spyOn(helpers, "hydrateAssistantImages").mockImplementation(async sessions => sessions);
    try {
        const snapshot = await hydrateCanvasProjectSnapshot({ nodes: [video, image], chatSessions: [] }, new AbortController().signal);
        expect(snapshot.nodes[0]).toBe(video);
        expect(snapshot.nodes[0].metadata?.videoTaskId).toBe("pending-task");
        expect(snapshot.nodes[0].metadata?.status).toBe("loading");
        expect(snapshot.nodes[1].metadata?.status).toBe("error");
        expect(image.metadata.status).toBe("loading");
        expect(snapshot.chatSessions).toEqual([]);
    } finally { hydrateNodes.mockRestore(); hydrateChat.mockRestore(); }
});

test("an abandoned project does not begin hydration", async () => {
    const controller = new AbortController();
    controller.abort();
    const hydrateNodes = spyOn(helpers, "hydrateCanvasImages").mockResolvedValue([]);
    const hydrateChat = spyOn(helpers, "hydrateAssistantImages").mockResolvedValue([]);
    try {
        await expect(hydrateCanvasProjectSnapshot({ nodes: [], chatSessions: [] }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
        expect(hydrateNodes).not.toHaveBeenCalled();
        expect(hydrateChat).not.toHaveBeenCalled();
    } finally { hydrateNodes.mockRestore(); hydrateChat.mockRestore(); }
});

test("a slow previous project cannot publish after the next project is restored", async () => {
    const previousController = new AbortController();
    const previousNodes = deferred<CanvasNodeData[]>();
    const nextNode = { ...video, id: "next-project-video" };
    const hydrateNodes = spyOn(helpers, "hydrateCanvasImages").mockImplementation(nodes => nodes[0]?.id === video.id ? previousNodes.promise : Promise.resolve(nodes));
    const hydrateChat = spyOn(helpers, "hydrateAssistantImages").mockResolvedValue([]);
    const publishPrevious = mock(() => undefined);
    try {
        const previous = hydrateCanvasProjectSnapshot({ nodes: [video], chatSessions: [] }, previousController.signal).then(publishPrevious);
        previousController.abort();
        const next = await hydrateCanvasProjectSnapshot({ nodes: [nextNode], chatSessions: [] }, new AbortController().signal);
        previousNodes.resolve([video]);
        await expect(previous).rejects.toMatchObject({ name: "AbortError" });
        expect(publishPrevious).not.toHaveBeenCalled();
        expect(next.nodes[0]).toBe(nextNode);
        expect(hydrateChat).toHaveBeenCalledTimes(1);
    } finally { hydrateNodes.mockRestore(); hydrateChat.mockRestore(); }
});

test("leaving during assistant hydration prevents the restored snapshot from being published", async () => {
    const controller = new AbortController();
    const sessions = deferred<[]>();
    const hydrateNodes = spyOn(helpers, "hydrateCanvasImages").mockResolvedValue([video]);
    const hydrateChat = spyOn(helpers, "hydrateAssistantImages").mockReturnValue(sessions.promise);
    const publish = mock(() => undefined);
    try {
        const operation = hydrateCanvasProjectSnapshot({ nodes: [video], chatSessions: [] }, controller.signal).then(publish);
        await Promise.resolve();
        expect(hydrateChat).toHaveBeenCalledTimes(1);
        controller.abort();
        sessions.resolve([]);
        await expect(operation).rejects.toMatchObject({ name: "AbortError" });
        expect(publish).not.toHaveBeenCalled();
    } finally { hydrateNodes.mockRestore(); hydrateChat.mockRestore(); }
});

test("active restoration failures remain visible to the caller", async () => {
    const error = new Error("local media unavailable");
    const hydrateNodes = spyOn(helpers, "hydrateCanvasImages").mockRejectedValue(error);
    const hydrateChat = spyOn(helpers, "hydrateAssistantImages").mockResolvedValue([]);
    try {
        await expect(hydrateCanvasProjectSnapshot({ nodes: [video], chatSessions: [] }, new AbortController().signal)).rejects.toBe(error);
        expect(hydrateChat).not.toHaveBeenCalled();
    } finally { hydrateNodes.mockRestore(); hydrateChat.mockRestore(); }
});

test("project disposal clears ownership before aborting all shared request controllers", () => {
    const first = new AbortController();
    const second = new AbortController();
    const requests = new Map([["origin", { controller: first }], ["video-result", { controller: first }], ["other-task", { controller: second }]]);
    const aborted = mock(() => expect(requests.size).toBe(0));
    first.signal.addEventListener("abort", aborted);
    second.signal.addEventListener("abort", aborted);
    abortCanvasGenerationRequests(requests);
    abortCanvasGenerationRequests(requests);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(2);
    expect(requests.size).toBe(0);
});

test("a stopped poll can resume immediately and its old finally cannot release the new owner", async () => {
    const requests = new Map<string, CanvasGenerationRequest>();
    const request = (controller: AbortController): CanvasGenerationRequest => ({ targetNodeId: "video", originNodeId: "video", runningNodeId: "video", controller });
    const old = startCanvasGenerationRequest(requests, request(new AbortController()));
    const completion = deferred<void>();
    let running: string | null = "video";
    const finishOld = completion.promise.then(() => {
        if (finishCanvasGenerationRequest(requests, "video", old)) running = null;
    });
    expect(requests.has("video")).toBe(true);
    abortCanvasGenerationRequests(requests);
    expect(old.signal.aborted).toBe(true);
    expect(requests.has("video")).toBe(false);
    const current = startCanvasGenerationRequest(requests, request(new AbortController()));
    completion.resolve();
    await finishOld;
    expect(requests.get("video")?.controller).toBe(current);
    expect(current.signal.aborted).toBe(false);
    expect(running).toBe("video");
    expect(finishCanvasGenerationRequest(requests, "video", current)).toBe(true);
    expect(requests.has("video")).toBe(false);
});

test("replacing a node request aborts only its previous controller and ignores the old finalizer", () => {
    const requests = new Map<string, CanvasGenerationRequest>();
    const first = new AbortController();
    const second = new AbortController();
    const request = { targetNodeId: "video", originNodeId: "config", runningNodeId: "config" };
    startCanvasGenerationRequest(requests, { ...request, controller: first });
    startCanvasGenerationRequest(requests, { ...request, controller: second });
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(finishCanvasGenerationRequest(requests, "video", first)).toBe(false);
    expect(requests.get("video")?.controller).toBe(second);
    expect(finishCanvasGenerationRequest(requests, "video", second)).toBe(true);
});

test("registering source and output with the same controller preserves their shared cancellation", () => {
    const requests = new Map<string, CanvasGenerationRequest>();
    const controller = new AbortController();
    const request = { targetNodeId: "source", originNodeId: "source", runningNodeId: "source", controller };
    startCanvasGenerationRequest(requests, request);
    startCanvasGenerationRequest(requests, request);
    startCanvasGenerationRequest(requests, { ...request, targetNodeId: "video" });
    expect(controller.signal.aborted).toBe(false);
    expect(requests.size).toBe(2);
    expect(finishCanvasGenerationRequest(requests, "video", controller)).toBe(true);
    expect(requests.get("source")?.controller).toBe(controller);
    expect(finishCanvasGenerationRequest(requests, "source", controller)).toBe(true);
});
