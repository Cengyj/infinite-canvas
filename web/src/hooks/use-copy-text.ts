import { App } from "antd";
import copy from "copy-to-clipboard";
import { useTranslation } from "react-i18next";

export function useCopyText() {
    const { message } = App.useApp();
    const { t } = useTranslation();

    return (value: string, successText = t("common.copied")) => {
        try {
            if (copy(value)) {
                message.success(successText);
                return true;
            }
        } catch {
            // Fall through to the shared failure message.
        }
        message.error(t("common.copyFailed"));
        return false;
    };
}
