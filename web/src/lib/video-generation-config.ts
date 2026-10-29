import i18n from "@/i18n";
import { clampVideoSeconds, computeVideoSize, normalizeVideoRequestResolution, normalizeVideoRequestSize, resolveVideoMode, videoRatioOptions, videoRequestAspectRatio, VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX } from "@/lib/media-size";
import { modelCapabilityOf, modelOptionName, resolveModelChannel, resolveModelScript, type AiConfig } from "@/stores/use-config-store";

export const VIDEO_REFERENCE_IMAGE_LIMIT = 7;

export type VideoGenerationMedia = { imageCount: number; videoCount?: number; audioCount?: number };
export type VideoGenerationIssue = { field: "images" | "videos" | "audios" | "seconds" | "resolution" | "size"; key: string; values?: Record<string, string | number> };

/** Callers supply the effective generation model, not the workbench's global image selection. */
export function getGrokVideoModel(config: AiConfig): "classic" | "1.5" | null {
    const model = config.model || config.videoModel;
    const name = modelOptionName(model);
    if (name !== "grok-imagine-video" && name !== "grok-imagine-video-1.5") return null;
    if (modelCapabilityOf(config, model) !== "video" || resolveModelScript(config, model) || resolveModelChannel(config, model).apiFormat !== "openai") return null;
    return name === "grok-imagine-video" ? "classic" : "1.5";
}

/** Missing media means counts are unknown (for example Agent get_config), not zero. */
export function resolveVideoGenerationConfig(config: AiConfig, media?: VideoGenerationMedia) {
    const grok = getGrokVideoModel(config);
    const mode = grok ? "reference" : resolveVideoMode(config.videoMode, media?.imageCount || 0);
    const hasImages = Boolean(media?.imageCount);
    const resolutions = grok === "classic" || (grok && (media?.imageCount || 0) > 1) ? ["480", "720"] : ["480", "720", "1080"];
    const limits = {
        minSeconds: grok ? 1 : VIDEO_SECONDS_MIN,
        maxSeconds: grok ? grok === "classic" && hasImages ? 10 : 15 : VIDEO_SECONDS_MAX,
        minImages: 0,
        maxImages: VIDEO_REFERENCE_IMAGE_LIMIT,
        resolutions,
    };
    const seconds = grok ? String(config.videoSeconds).trim() : clampVideoSeconds(config.videoSeconds);
    const resolution = grok ? String(config.vquality).trim().toLowerCase().replace(/p$/, "") : normalizeVideoRequestResolution(config.vquality).replace(/p$/, "");
    const size = normalizeVideoRequestSize(config.size, config.vquality);
    const issues: VideoGenerationIssue[] = [];
    if (grok) {
        if (media && (media.imageCount < limits.minImages || media.imageCount > limits.maxImages)) {
            issues.push({ field: "images", key: "invalidImageCount", values: { count: media.imageCount, min: limits.minImages, max: limits.maxImages } });
        }
        if (media?.videoCount) issues.push({ field: "videos", key: "unsupportedVideos" });
        if (media?.audioCount) issues.push({ field: "audios", key: "unsupportedAudios" });
        if (!seconds || !Number.isInteger(Number(seconds)) || Number(seconds) < limits.minSeconds || Number(seconds) > limits.maxSeconds) {
            issues.push({ field: "seconds", key: "invalidSeconds", values: { value: seconds, min: limits.minSeconds, max: limits.maxSeconds } });
        }
        if (!resolutions.includes(resolution)) issues.push({ field: "resolution", key: "invalidResolution", values: { value: config.vquality, allowed: resolutions.map((value) => `${value}p`).join(" / ") } });
        const fixedRatio = videoRatioOptions.some((item) => item.value !== "auto" && item.value === config.size);
        const presetSize = videoRatioOptions.some((item) => item.value !== "auto" && computeVideoSize(resolution, item.value) === config.size);
        if (!fixedRatio && !presetSize) issues.push({ field: "size", key: "invalidSize", values: { value: config.size } });
    }
    return { grok, mode, seconds: grok && !issues.some((issue) => issue.field === "seconds") ? String(Number(seconds)) : seconds, resolution, size, aspectRatio: videoRequestAspectRatio(config.size), limits, issues };
}

export function videoGenerationIssueText(issue: VideoGenerationIssue) {
    return i18n.t(`videoCapabilities.${issue.key}`, issue.values);
}

export function assertVideoGenerationConfig(config: AiConfig, media?: VideoGenerationMedia) {
    const resolved = resolveVideoGenerationConfig(config, media);
    const issue = resolved.issues[0];
    if (issue) throw new Error(videoGenerationIssueText(issue));
    return resolved;
}
