import { useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2, Square, WandSparkles } from "lucide-react";
import { App, Button, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { PromptOptimizeDialog } from "@/components/prompt-optimize-dialog";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { buildCanvasPromptOptimizationContext, createCanvasPromptOptimizationBinding, type CanvasPromptOptimizationBinding } from "@/lib/canvas/canvas-prompt-optimization";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { PromptOptimizationContext, PromptOptimizationScenario } from "@/services/api/prompt-optimization";
import type { ReferenceImage } from "@/types/image";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    getOptimizationReferences?: (nodeId: string, mode: PromptOptimizationScenario) => ReferenceImage[];
    onOptimizationApplied?: (nodeId: string, binding: CanvasPromptOptimizationBinding) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

type PromptOptimizationSession = {
    prompt: string;
    references: ReferenceImage[];
    context: PromptOptimizationContext;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], getOptimizationReferences, onOptimizationApplied, onImageSettingsOpenChange, modeOverride }: CanvasNodePromptPanelProps) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildGenerationConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [expanded, setExpanded] = useState(false);
    const [promptOptimizationSession, setPromptOptimizationSession] = useState<PromptOptimizationSession | null>(null);
    const pendingPromptOptimizationRef = useRef<PromptOptimizationSession | null>(null);
    const optimizationMode: PromptOptimizationScenario | null = node.type === CanvasNodeType.Image && mode === "image" ? "image" : node.type === CanvasNodeType.Video && mode === "video" ? "video" : null;

    // Restore prompts only when switching nodes; preserve the current input after generation on the same node.
    useEffect(() => {
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
        pendingPromptOptimizationRef.current = null;
        setPromptOptimizationSession(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const submit = () => {
        const text = prompt.trim();
        if (!text || isRunning) return;
        onGenerate(node.id, mode, text);
    };

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    const openPromptOptimization = () => {
        if (!optimizationMode || isRunning) return;
        const references = (getOptimizationReferences?.(node.id, optimizationMode) || []).map((reference) => ({ ...reference }));
        const session = { prompt, references, context: buildCanvasPromptOptimizationContext(optimizationMode, config, references) };
        if (expanded) {
            pendingPromptOptimizationRef.current = session;
            setExpanded(false);
            return;
        }
        setPromptOptimizationSession(session);
    };

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasPromptChipInput
                value={prompt}
                references={mentionReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip>
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {optimizationMode ? (
                        <Tooltip title={t(`${optimizationMode}Workbench.promptOptimization.action`)}>
                            <span className="inline-flex shrink-0">
                                <Button
                                    type="text"
                                    className="!h-8 !w-8 !min-w-8 !rounded-full !bg-transparent !p-0 hover:!bg-black/5 dark:hover:!bg-white/10"
                                    style={{ color: theme.node.text }}
                                    icon={<WandSparkles className="size-3.5" />}
                                    disabled={isRunning}
                                    onClick={openPromptOptimization}
                                    aria-label={t(`${optimizationMode}Workbench.promptOptimization.action`)}
                                />
                            </span>
                        </Tooltip>
                    ) : null}
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasVideoSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                        </>
                    )}
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={isRunning}
                    disabled={!isRunning && !prompt.trim()}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={t(isRunning ? "canvas.promptPanel.stopGeneration" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">{t("canvas.promptPanel.stop")}</span>
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
            <Modal
                title={
                    <div className="flex items-center justify-between gap-3 pr-7">
                        <span>{t("canvas.promptPanel.editorTitle")}</span>
                        {optimizationMode ? (
                            <Button type="text" size="small" icon={<WandSparkles className="size-3.5" />} disabled={isRunning} onClick={openPromptOptimization}>
                                {t(`${optimizationMode}Workbench.promptOptimization.action`)}
                            </Button>
                        ) : null}
                    </div>
                }
                open={expanded}
                centered
                width={760}
                footer={null}
                onCancel={() => setExpanded(false)}
                afterOpenChange={(open) => {
                    if (open || !pendingPromptOptimizationRef.current) return;
                    const session = pendingPromptOptimizationRef.current;
                    pendingPromptOptimizationRef.current = null;
                    setPromptOptimizationSession(session);
                }}
                destroyOnHidden
            >
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasPromptChipInput
                        value={prompt}
                        references={mentionReferences}
                        onChange={updatePrompt}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full cursor-text overflow-y-auto rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`)}
                    />
                </div>
            </Modal>
            {promptOptimizationSession && optimizationMode ? (
                <PromptOptimizeDialog
                    scenario={optimizationMode}
                    prompt={promptOptimizationSession.prompt}
                    references={promptOptimizationSession.references}
                    context={promptOptimizationSession.context}
                    appearance="canvas"
                    disabled={isRunning}
                    onApply={(value) => {
                        const optimizedPrompt = value.trim();
                        updatePrompt(optimizedPrompt);
                        onOptimizationApplied?.(
                            node.id,
                            createCanvasPromptOptimizationBinding(optimizedPrompt, optimizationMode, promptOptimizationSession.context, promptOptimizationSession.references),
                        );
                        setPromptOptimizationSession(null);
                        message.success(t(`${optimizationMode}Workbench.promptOptimization.applied`));
                    }}
                    onClose={() => setPromptOptimizationSession(null)}
                />
            ) : null}
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}
