import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { hydrateAssistantImages, hydrateCanvasImages, resetInterruptedGeneration } from "./canvas-generation-helpers";

export type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

export function startCanvasGenerationRequest(requests: Map<string, CanvasGenerationRequest>, request: CanvasGenerationRequest) {
    const previous = requests.get(request.targetNodeId);
    if (previous?.controller !== request.controller) previous?.controller.abort();
    requests.set(request.targetNodeId, request);
    return request.controller;
}

export function finishCanvasGenerationRequest(requests: Map<string, CanvasGenerationRequest>, nodeId: string, controller: AbortController) {
    if (requests.get(nodeId)?.controller !== controller) return false;
    return requests.delete(nodeId);
}

export async function hydrateCanvasProjectSnapshot(project: Pick<CanvasProject, "nodes" | "chatSessions">, signal: AbortSignal) {
    signal.throwIfAborted();
    const nodes = await hydrateCanvasImages(resetInterruptedGeneration(project.nodes));
    signal.throwIfAborted();
    const chatSessions = await hydrateAssistantImages(project.chatSessions || []);
    signal.throwIfAborted();
    return { nodes, chatSessions };
}

export function abortCanvasGenerationRequests(requests: Map<string, { controller: AbortController }>) {
    const pending = [...requests.values()];
    requests.clear();
    pending.forEach(({ controller }) => controller.abort());
}
