import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const handledConfigParams = useRef(false);
    const config = useConfigStore((state) => state.config);
    const replaceConfig = useConfigStore((state) => state.replaceConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);

    usePromptSourceScheduler();

    useEffect(() => {
        if (handledConfigParams.current) return;
        handledConfigParams.current = true;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        const firstChannel = config.channels[0];
        const channels = firstChannel
            ? config.channels.map((channel, index) =>
                  index === 0
                      ? {
                            ...channel,
                            ...(baseUrl ? { baseUrl } : {}),
                            ...(apiKey ? { apiKey } : {}),
                        }
                      : channel,
              )
            : [createModelChannel({ id: "default", name: t("config.channels.defaultName"), baseUrl: baseUrl || undefined, apiKey: apiKey || "" })];
        replaceConfig({ ...config, channels, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) });
        openConfigDialog(false);
        message.success(t("config.importedDirectConfig"));
    }, [config, message, openConfigDialog, replaceConfig, t]);

    return <>{children}</>;
}
