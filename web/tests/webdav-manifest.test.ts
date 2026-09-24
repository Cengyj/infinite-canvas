import "./setup";
import { afterAll, expect, mock, test } from "bun:test";
import * as webdav from "../src/services/webdav-sync";
import { useAssetStore } from "../src/stores/use-asset-store";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import type { WebdavSyncConfig } from "../src/stores/use-config-store";

const originalWebdav = { ...webdav };
let invalidFields: Record<string, unknown> = {};
let uploads = 0;
mock.module("../src/services/webdav-sync", () => ({
    ...originalWebdav,
    downloadWebdavFile: async (_config: unknown, path: string) => {
        const domain = path.split("/")[0];
        const items = domain === "canvas" ? "projects" : domain === "assets" ? "assets" : "logs";
        return new Blob([JSON.stringify({ app: "infinite-canvas", version: 1, domain, data: { [items]: [], deleted: [] }, files: [], ...invalidFields })]);
    },
    uploadWebdavFile: async () => { uploads += 1; },
}));
const { syncAppDataToWebdav } = await import("../src/services/app-sync");
afterAll(() => mock.module("../src/services/webdav-sync", () => originalWebdav));

test("refuses unsupported or malformed remote manifests before overwriting them", async () => {
    useCanvasStore.setState({ hydrated: true });
    useAssetStore.setState({ hydrated: true });
    const config = { url: "https://webdav.example", directory: "canvas", username: "", password: "" } as WebdavSyncConfig;
    for (const invalid of [{ version: 2 }, { data: null }, { data: {} }, { files: null }]) {
        invalidFields = invalid;
        uploads = 0;
        await expect(syncAppDataToWebdav(config)).rejects.toThrow();
        expect(uploads).toBe(0);
    }
});
