import { storeGeneratedVideo, type VideoGenerationResult } from "@/services/api/video";
import { claimStoredMedia, deleteStoredMedia, type UploadedFile } from "@/services/file-storage";

export async function storeCanvasVideoResult(result: VideoGenerationResult, signal: AbortSignal, isCurrent: () => boolean, publication: { publish: (video: UploadedFile) => void; isPublished: (video: UploadedFile) => boolean }) {
    const active = () => !signal.aborted && isCurrent();
    if (!active()) throw new DOMException("Aborted", "AbortError");
    let video: UploadedFile;
    try {
        video = await storeGeneratedVideo(result);
    } catch (error) {
        if (!active()) throw new DOMException("Aborted", "AbortError");
        throw error;
    }
    try {
        if (!active()) throw new DOMException("Aborted", "AbortError");
        // Keep the ownership check and final node publication in one synchronous phase.
        publication.publish(video);
        if (!publication.isPublished(video)) throw new DOMException("Aborted", "AbortError");
        claimStoredMedia(video.storageKey);
        return video;
    } catch (error) {
        // A renderer may throw after committing. Never delete a key already received by its node.
        if (publication.isPublished(video)) claimStoredMedia(video.storageKey);
        else if (video.storageKey) await deleteStoredMedia([video.storageKey]).catch(() => undefined);
        if (!active()) throw new DOMException("Aborted", "AbortError");
        throw error;
    }
}
