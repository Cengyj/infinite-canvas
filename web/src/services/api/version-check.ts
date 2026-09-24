import i18n from "@/i18n";
import { isBrowserNetworkError, isOriginNotAllowedFetchResponse, networkFailureMessage } from "@/lib/network-errors";
import { withLocalProxy } from "@/stores/use-config-store";

const releaseBaseUrl = "https://raw.githubusercontent.com/basketikun/infinite-canvas/main";

async function readReleaseFile(file: string, errorKey: string) {
    const requestUrl = withLocalProxy(`${releaseBaseUrl}/${file}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(requestUrl, { signal: controller.signal });
        if (await isOriginNotAllowedFetchResponse(response, requestUrl)) throw new Error(i18n.t("config.proxy.originNotAllowed"));
        if (!response.ok) throw new Error(i18n.t(errorKey));
        return await response.text();
    } catch (error) {
        if (controller.signal.aborted) throw new Error(i18n.t(errorKey));
        if (isBrowserNetworkError(error)) {
            throw new Error(networkFailureMessage(error, requestUrl, {
                cors: i18n.t("apiErrors.corsRequired"),
                proxy: i18n.t("config.proxy.unreachable"),
                fallback: i18n.t(errorKey),
            }));
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export function fetchLatestVersion() {
    return readReleaseFile("VERSION", "version.readFailed");
}

export async function fetchLatestRelease() {
    const [version, changelog] = await Promise.all([fetchLatestVersion(), readReleaseFile("CHANGELOG.md", "version.changelogFailed")]);
    return { version, changelog };
}
