import { ArrowRight, Copy, Square, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Switch, Tag, Tooltip, type ModalProps } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { useCopyText } from "@/hooks/use-copy-text";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { MAX_PROMPT_OPTIMIZATION_REFERENCES, requestPromptOptimization, type PromptOptimizationContext, type PromptOptimizationScenario } from "@/services/api/prompt-optimization";
import { resolveModelForCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ReferenceImage } from "@/types/image";

type PromptOptimizeDialogProps = {
    scenario: PromptOptimizationScenario;
    prompt: string;
    references: ReferenceImage[];
    context?: PromptOptimizationContext;
    appearance?: "workbench" | "canvas";
    disabled?: boolean;
    onApply: (prompt: string) => void;
    onClose: () => void;
};

type PromptOptimizeSnapshot = {
    sourcePrompt: string;
    requirements: string;
    draft: string;
    draftComplete: boolean;
    draftStale: boolean;
    analyzeReferences: boolean;
};

const MODAL_STYLES: ModalProps["styles"] = {
    body: { maxHeight: "calc(100vh - 190px)", overflowY: "auto" },
};

export function PromptOptimizeDialog({ scenario, prompt, references, context, appearance = "workbench", disabled = false, onApply, onClose }: PromptOptimizeDialogProps) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const canvasThemeName = useThemeStore((state) => state.theme);
    const canvasTheme = canvasThemes[canvasThemeName];
    const config = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const textModel = resolveModelForCapability(config, config.textModel, "text");
    const referencesWithinLimit = references.length <= MAX_PROMPT_OPTIMIZATION_REFERENCES;
    const [sourcePrompt, setSourcePrompt] = useState(prompt);
    const [requirements, setRequirements] = useState("");
    const [draft, setDraft] = useState("");
    const [draftComplete, setDraftComplete] = useState(false);
    const [draftStale, setDraftStale] = useState(false);
    const [analyzeReferences, setAnalyzeReferences] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const requestRef = useRef<AbortController | null>(null);
    const requestSnapshotRef = useRef<PromptOptimizeSnapshot | null>(null);
    const textModelRef = useRef<string | null>(null);
    const configReady = Boolean(textModel && isAiConfigReady(config, textModel));
    const canvasAppearance = appearance === "canvas";
    const namespace = scenario === "image" ? "imageWorkbench" : "videoWorkbench";
    const text = (key: string, options?: Record<string, unknown>) => t(`${namespace}.promptOptimization.${key}`, options);
    const mutedTextClass = canvasAppearance ? "" : "text-stone-500 dark:text-stone-400";
    const mutedTextStyle = canvasAppearance ? { color: canvasTheme.node.muted } : undefined;
    const inputStyle = canvasAppearance ? { background: "transparent" } : undefined;
    const modalStyles: ModalProps["styles"] = canvasAppearance
        ? {
              content: {
                  background: canvasTheme.toolbar.panel,
                  border: `1px solid ${canvasTheme.toolbar.border}`,
                  borderRadius: 20,
                  boxShadow: canvasThemeName === "dark" ? "0 22px 70px rgba(0,0,0,.46)" : "0 22px 70px rgba(28,25,23,.14)",
                  color: canvasTheme.node.text,
              },
              header: { background: "transparent", color: canvasTheme.node.text },
              body: { maxHeight: "calc(100dvh - 176px)", overflowY: "auto" },
              footer: { background: "transparent", borderTop: `1px solid ${canvasTheme.toolbar.border}`, paddingTop: 12 },
          }
        : MODAL_STYLES;

    useEffect(
        () => () => {
            const request = requestRef.current;
            requestRef.current = null;
            requestSnapshotRef.current = null;
            request?.abort();
        },
        [],
    );

    useEffect(() => {
        if (textModelRef.current === null) {
            textModelRef.current = textModel;
            return;
        }
        if (textModelRef.current === textModel) return;
        textModelRef.current = textModel;
        requestRef.current?.abort();
        requestRef.current = null;
        requestSnapshotRef.current = null;
        setOptimizing(false);
        clearDraft();
    }, [textModel]);

    useEffect(() => {
        if (!disabled || !requestRef.current) return;
        requestRef.current.abort();
        requestRef.current = null;
        restoreSnapshot();
    }, [disabled]);

    function clearDraft() {
        setDraft("");
        setDraftComplete(false);
        setDraftStale(false);
    }

    function restoreSnapshot() {
        const snapshot = requestSnapshotRef.current;
        requestSnapshotRef.current = null;
        setOptimizing(false);
        if (!snapshot) return;
        setSourcePrompt(snapshot.sourcePrompt);
        setRequirements(snapshot.requirements);
        setDraft(snapshot.draft);
        setDraftComplete(snapshot.draftComplete);
        setDraftStale(snapshot.draftStale);
        setAnalyzeReferences(snapshot.analyzeReferences);
    }

    const close = () => {
        requestRef.current?.abort();
        requestRef.current = null;
        requestSnapshotRef.current = null;
        onClose();
    };

    const stop = () => {
        requestRef.current?.abort();
        requestRef.current = null;
        restoreSnapshot();
    };

    const optimize = async (nextSource = sourcePrompt) => {
        const source = nextSource.trim();
        if (!source) {
            message.warning(t(`${namespace}.promptRequired`));
            return;
        }
        if (!configReady) {
            message.warning(text("configRequired"));
            openConfigDialog(false);
            return;
        }
        if (requestRef.current) return;

        const controller = new AbortController();
        requestRef.current = controller;
        requestSnapshotRef.current = { sourcePrompt, requirements, draft, draftComplete, draftStale, analyzeReferences };
        setSourcePrompt(source);
        clearDraft();
        setOptimizing(true);
        try {
            const result = await requestPromptOptimization(
                config,
                textModel,
                { scenario, prompt: source, requirements, references, analyzeReferences, context },
                (value) => {
                    if (requestRef.current === controller) setDraft(value);
                },
                controller.signal,
            );
            if (requestRef.current !== controller) return;
            setDraft(result);
            setDraftComplete(true);
            setDraftStale(false);
            requestSnapshotRef.current = null;
        } catch (error) {
            if (requestRef.current !== controller) return;
            const canceled = controller.signal.aborted;
            if (!canceled) controller.abort();
            restoreSnapshot();
            if (!canceled) message.error(error instanceof Error ? error.message : text("failed"));
        } finally {
            if (requestRef.current === controller) {
                requestRef.current = null;
                setOptimizing(false);
            }
        }
    };

    const hasDraft = Boolean(draft.trim());
    const hasCompleteDraft = draftComplete && hasDraft;
    const resultStatus = optimizing ? "running" : draftStale ? "stale" : hasCompleteDraft ? "ready" : "waiting";
    const referenceHint = !referencesWithinLimit
        ? text("referenceLimit", { count: MAX_PROMPT_OPTIMIZATION_REFERENCES })
        : analyzeReferences
          ? text("analyzeReferencesHint", { count: MAX_PROMPT_OPTIMIZATION_REFERENCES })
          : text("referencesTextOnly", { count: references.length });

    return (
        <Modal
            centered
            open
            width={canvasAppearance ? 860 : 880}
            zIndex={canvasAppearance ? 1120 : 1050}
            keyboard={!optimizing}
            maskClosable={!optimizing}
            closable={!optimizing}
            style={canvasAppearance ? { maxWidth: "calc(100vw - 24px)" } : undefined}
            styles={modalStyles}
            title={
                <span className="flex items-center gap-2" style={canvasAppearance ? { color: canvasTheme.node.text } : undefined}>
                    <WandSparkles className="size-4" />
                    {text("title")}
                </span>
            }
            onCancel={close}
            footer={
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-wrap gap-2">
                        {optimizing ? (
                            <Button type={canvasAppearance ? "text" : undefined} danger icon={<Square className="size-3.5 fill-current" />} onClick={stop}>
                                {text("stop")}
                            </Button>
                        ) : (
                            <Button type={canvasAppearance ? "text" : undefined} icon={<WandSparkles className="size-4" />} disabled={disabled || !sourcePrompt.trim()} onClick={() => void optimize()}>
                                {hasDraft ? text("reoptimize") : text("optimize")}
                            </Button>
                        )}
                        {hasCompleteDraft ? (
                            <Button type={canvasAppearance ? "text" : undefined} icon={<ArrowRight className="size-4" />} disabled={disabled || optimizing} onClick={() => void optimize(draft)}>
                                {text("continue")}
                            </Button>
                        ) : null}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button type={canvasAppearance ? "text" : undefined} disabled={optimizing} onClick={close}>{t("common.cancel")}</Button>
                        <Button type="primary" disabled={disabled || optimizing || draftStale || !hasCompleteDraft} onClick={() => onApply(draft.trim())}>
                            {text("apply")}
                        </Button>
                    </div>
                </div>
            }
        >
            <div className="space-y-4 pt-1">
                <p className={`m-0 text-sm ${mutedTextClass}`} style={mutedTextStyle}>{text("description")}</p>
                <div
                    className={canvasAppearance ? "rounded-xl border p-3" : "rounded-lg border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900"}
                    style={canvasAppearance ? { background: "transparent", borderColor: canvasTheme.toolbar.border } : undefined}
                >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{text("model")}</div>
                            <div className={`mt-1 text-xs ${mutedTextClass}`} style={mutedTextStyle}>
                                {references.length ? text("referenceCount", { count: references.length }) : text("noReferences")}
                            </div>
                        </div>
                        <div className="w-full sm:w-72">
                            <ModelPicker
                                config={config}
                                value={textModel}
                                capability="text"
                                fullWidth
                                disabled={disabled || optimizing}
                                onChange={(value) => {
                                    updateConfig("textModel", value);
                                    clearDraft();
                                }}
                                onMissingConfig={() => openConfigDialog(false)}
                            />
                        </div>
                    </div>
                    {references.length ? (
                        <div className={canvasAppearance ? "mt-3 border-t pt-3" : "mt-3 border-t border-stone-200 pt-3 dark:border-stone-800"} style={canvasAppearance ? { borderColor: canvasTheme.toolbar.border } : undefined}>
                            <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                    <div className="text-sm font-medium">{text("analyzeReferences")}</div>
                                    <div className={`mt-1 text-xs leading-5 ${mutedTextClass}`} style={mutedTextStyle}>
                                        {referenceHint}
                                    </div>
                                </div>
                                <Switch
                                    className="mt-0.5 shrink-0"
                                    checked={analyzeReferences}
                                    disabled={disabled || optimizing || !referencesWithinLimit}
                                    aria-label={text("analyzeReferences")}
                                    onChange={(checked) => {
                                        setAnalyzeReferences(checked);
                                        clearDraft();
                                    }}
                                />
                            </div>
                            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                                {references.map((reference, index) => (
                                    <Tooltip key={reference.id} title={reference.name}>
                                        <div
                                            className={canvasAppearance ? "relative size-12 shrink-0 overflow-hidden rounded-md border" : "relative size-12 shrink-0 overflow-hidden rounded-md border border-stone-200 bg-background dark:border-stone-700"}
                                            style={canvasAppearance ? { background: canvasTheme.node.panel, borderColor: canvasTheme.node.stroke } : undefined}
                                        >
                                            <img src={reference.dataUrl || reference.url} alt={reference.name} className="size-full object-cover" />
                                            <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 py-0.5 text-center text-[9px] leading-none text-white">
                                                {imageReferenceLabel(index)}
                                            </span>
                                        </div>
                                    </Tooltip>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-4">
                        <label className="block">
                            <span className="text-sm font-medium">{text("source")}</span>
                            <span className={`ml-2 text-xs ${mutedTextClass}`} style={mutedTextStyle}>{text("sourceHint")}</span>
                            <Input.TextArea
                                className="mt-2"
                                style={inputStyle}
                                rows={8}
                                value={sourcePrompt}
                                disabled={disabled || optimizing}
                                placeholder={text("sourcePlaceholder")}
                                onChange={(event) => {
                                    setSourcePrompt(event.target.value);
                                    clearDraft();
                                }}
                            />
                        </label>
                        <label className="block">
                            <span className="text-sm font-medium">{text("requirements")}</span>
                            <span className={`ml-2 text-xs ${mutedTextClass}`} style={mutedTextStyle}>{text("requirementsHint")}</span>
                            <Input.TextArea
                                className="mt-2"
                                style={inputStyle}
                                rows={3}
                                value={requirements}
                                disabled={disabled || optimizing}
                                placeholder={text(references.length ? "requirementsReferencePlaceholder" : "requirementsPlaceholder")}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    setRequirements(value);
                                    setDraftStale(Boolean(draftComplete && draft.trim()));
                                }}
                            />
                        </label>
                    </div>

                    <div className="block">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span>
                                <span className="text-sm font-medium">{text("result")}</span>
                                <span className={`ml-2 text-xs ${mutedTextClass}`} style={mutedTextStyle}>{text("resultHint")}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                                {canvasAppearance ? (
                                    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 px-1 text-xs" style={{ color: canvasTheme.node.muted }}>
                                        <span className={`size-1.5 rounded-full ${resultStatus === "running" ? "animate-pulse" : ""}`} style={{ background: resultStatus === "ready" ? canvasTheme.node.text : canvasTheme.node.faint }} />
                                        {text(`status.${resultStatus}`)}
                                    </span>
                                ) : (
                                    <Tag role="status" aria-live="polite" className="m-0" color={resultStatus === "ready" ? "green" : resultStatus === "stale" ? "gold" : resultStatus === "running" ? "processing" : undefined}>
                                        {text(`status.${resultStatus}`)}
                                    </Tag>
                                )}
                                <Tooltip title={t("common.copy")}>
                                    <span>
                                        <Button
                                            type="text"
                                            size="small"
                                            shape="circle"
                                            icon={<Copy className="size-3.5" />}
                                            disabled={optimizing || draftStale || !hasCompleteDraft}
                                            aria-label={t("common.copy")}
                                            onClick={() => copyText(draft.trim(), t("common.promptCopied"))}
                                        />
                                    </span>
                                </Tooltip>
                            </span>
                        </div>
                        <Input.TextArea
                            className="mt-2"
                            style={inputStyle}
                            rows={15}
                            value={draft}
                            aria-label={text("result")}
                            disabled={disabled}
                            readOnly={optimizing}
                            placeholder={optimizing ? text("optimizing") : text("resultPlaceholder")}
                            onChange={(event) => {
                                const value = event.target.value;
                                setDraft(value);
                                setDraftComplete(Boolean(value.trim()));
                                setDraftStale(false);
                            }}
                        />
                    </div>
                </div>
            </div>
        </Modal>
    );
}
