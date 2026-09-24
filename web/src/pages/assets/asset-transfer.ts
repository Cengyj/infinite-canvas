import { saveAs } from "file-saver";
import { nanoid } from "nanoid";

import { createZip, readZip } from "@/lib/zip";
import { deleteStoredMedia, getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { deleteStoredImages, getImageBlob, setImageBlob } from "@/services/image-storage";
import { retainMediaReferences } from "@/services/media-references";
import type { Asset } from "@/stores/use-asset-store";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[], filename: string) {
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind !== "image" && asset.kind !== "video") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey) return;
            const blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            if (!blob) return;
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    saveAs(zip, filename);
}

export async function readAssetPackage(file: File) {
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    const importedFiles = new Map<string, { storageKey: string; url: string }>();
    const release = retainMediaReferences(() => Array.from(importedFiles.values()));
    try {
        const writes = await Promise.allSettled(
            Array.from(new Map(data.files.map((item) => [item.storageKey, item])).values()).map(async (item) => {
                const blob = zip.get(item.path);
                if (!blob) throw new Error(`Missing asset file: ${item.path}`);
                const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                const prefix = item.storageKey.split(":", 1)[0] || (item.mimeType.startsWith("image/") ? "image" : "file");
                const imported = { storageKey: `${prefix}:${nanoid()}`, url: "" };
                importedFiles.set(item.storageKey, imported);
                imported.url = await (imported.storageKey.startsWith("image:") ? setImageBlob(imported.storageKey, typedBlob) : setMediaBlob(imported.storageKey, typedBlob));
            }),
        );
        const failed = writes.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        const assets = data.assets.map((asset) => {
            if (asset.kind !== "image" && asset.kind !== "video") return asset;
            const imported = asset.data.storageKey ? importedFiles.get(asset.data.storageKey) : undefined;
            if (!imported) return asset;
            if (asset.kind === "video") return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? "" : asset.coverUrl, data: { ...asset.data, storageKey: imported.storageKey, url: imported.url } };
            const previousUrl = asset.data.dataUrl;
            return {
                ...asset,
                coverUrl: !asset.coverUrl || asset.coverUrl === previousUrl || asset.coverUrl.startsWith("blob:") ? imported.url : asset.coverUrl,
                data: { ...asset.data, storageKey: imported.storageKey, dataUrl: imported.url },
            };
        });
        return { assets, release };
    } catch (error) {
        const written = Array.from(importedFiles.values()).filter((item) => item.url);
        await Promise.all([
            deleteStoredImages(written.filter((item) => item.storageKey.startsWith("image:")).map((item) => item.storageKey)),
            deleteStoredMedia(written.filter((item) => !item.storageKey.startsWith("image:")).map((item) => item.storageKey)),
        ]).catch(() => undefined);
        release();
        throw error;
    }
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return kind === "image" ? "png" : "bin";
}
