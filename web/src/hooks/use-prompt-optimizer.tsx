import { useRef, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";

import { PromptOptimizeDialog } from "@/components/prompt-optimize-dialog";
import { samePromptOptimizationInput, type PromptOptimizationInput } from "@/lib/prompt-optimization";

type Options = {
    getInput: () => PromptOptimizationInput | null;
    onApply: (value: string) => void;
    disabled?: boolean;
};

// Each editor owns its optimization session; unmounting the editor cancels its dialog's request.
export function usePromptOptimizer(options: Options) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const latest = useRef(options);
    latest.current = options;
    const [session, setSession] = useState<{ input: PromptOptimizationInput; id: number } | null>(null);
    const sequence = useRef(0);

    const openOptimizer = () => {
        if (latest.current.disabled) return;
        const input = latest.current.getInput();
        if (!input) return;
        setSession({ input, id: ++sequence.current });
    };

    const isCurrent = () => {
        const current = latest.current.getInput();
        return Boolean(session && current && !latest.current.disabled && samePromptOptimizationInput(session.input, current));
    };

    return {
        openOptimizer,
        optimizerDialog: session ? (
            <PromptOptimizeDialog
                key={session.id}
                input={session.input}
                stale={!isCurrent()}
                onRefresh={openOptimizer}
                onClose={() => setSession(null)}
                onApply={(value) => {
                    // Check again at the write boundary, including changes made by Agent tools.
                    if (!isCurrent()) {
                        message.warning(t("promptOptimization.sourceChanged"));
                        return;
                    }
                    latest.current.onApply(value);
                    setSession(null);
                    message.success(t("promptOptimization.applied"));
                }}
            />
        ) : null,
    };
}
