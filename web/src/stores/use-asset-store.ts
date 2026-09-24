import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { isLocalForageStorageReadReliable, localForageStorage } from "@/lib/localforage-storage";
import type { SyncDeletedItem } from "@/lib/sync-merge";
import { cleanupUnusedImages, ensureImagePreview, previewUrlFor, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; aspectRatio?: string; durationMs?: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    storageReady: boolean;
    assets: Asset[];
    deletedAssets: SyncDeletedItem[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[], deletedAssets?: SyncDeletedItem[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

// 卡片用缩略图渲染，自定义封面（远程地址或单独上传的封面）保持原样。
export function assetCoverUrl(asset: Asset) {
    const own = asset.kind === "image" ? asset.data.dataUrl : "";
    const cover = asset.coverUrl || own;
    return asset.kind === "image" && cover === own ? previewUrlFor(asset.data.storageKey) || cover : cover;
}

const ASSET_STORE_KEY = "infinite-canvas:asset_store";
let storageReadReliable = false;

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        storageReadReliable = false;
        const value = await localForageStorage.getItem(name);
        if (!value) {
            storageReadReliable = isLocalForageStorageReadReliable(name);
            return null;
        }
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(
            parsed.state.assets.map(async (asset) => {
                if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey) {
                    void ensureImagePreview(asset.data.storageKey);
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                }
                if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
                const image = await uploadImage(asset.data.dataUrl);
                return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
            }),
        );
        storageReadReliable = isLocalForageStorageReadReliable(name);
        return parsed;
    },
    setItem: (name, value) => { if (storageReadReliable) return localForageStorage.setItem(name, JSON.stringify(value)); },
    removeItem: (name) => { if (storageReadReliable) return localForageStorage.removeItem(name); },
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            storageReady: false,
            assets: [],
            deletedAssets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) => {
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                }));
                if (patch.data || patch.kind) get().cleanupImages();
            },
            removeAsset: (id) => {
                const assets = get().assets.filter((asset) => asset.id !== id);
                const deletedAt = new Date().toISOString();
                set((state) => ({ assets, deletedAssets: [...(state.deletedAssets || []).filter((item) => item.id !== id), { id, deletedAt }] }));
                get().cleanupImages({ assets });
            },
            replaceAssets: (assets, deletedAssets = []) => set({ assets, deletedAssets }),
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    try {
                        const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                        if (!get().storageReady || !useCanvasStore.getState().storageReady) return;
                        const data = { assets: get().assets, projects: useCanvasStore.getState().projects, extra };
                        await Promise.all([cleanupUnusedImages(data), cleanupUnusedMedia(data)]);
                    } catch { /* 读取失败时保留文件，等下次清理。 */ }
                }, 0);
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets, deletedAssets: state.deletedAssets }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => (_state, error) => {
                useAssetStore.setState({ hydrated: true, storageReady: !error && storageReadReliable });
            },
        },
    ),
);
