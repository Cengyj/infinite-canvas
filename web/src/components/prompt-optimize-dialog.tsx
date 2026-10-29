import { type ClipboardEvent, useEffect, useId, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Switch, Tooltip, theme } from "antd";
import { ArrowRight, Check, Copy, Image as ImageIcon, LoaderCircle, RefreshCw, Square, WandSparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { useCopyText } from "@/hooks/use-copy-text";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { promptOptimizationTokens, type PromptOptimizationInput } from "@/lib/prompt-optimization";
import { requestPromptOptimization } from "@/services/api/prompt-optimization";
import { modelCapabilityOf, resolveModelRequestConfig, resolveModelScript, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";

type Props = {
    input: PromptOptimizationInput;
    stale: boolean;
    onRefresh: () => void;
    onApply: (value: string) => void;
    onClose: () => void;
};

export function PromptOptimizeDialog({ input, stale, onRefresh, onApply, onClose }: Props) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const copyText = useCopyText();
    const config = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const ready = useConfigStore((state) => state.isAiConfigReady);
    const textModel = config.textModel;
    const configReady = modelCapabilityOf(config, textModel) === "text" && ready(config, textModel);
    const [source, setSource] = useState(input.prompt);
    const [requirements, setRequirements] = useState("");
    const [analyzeReferences, setAnalyzeReferences] = useState(false);
    const [result, setResult] = useState<{ text: string; signature: string } | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    const [error, setError] = useState("");
    const controllerRef = useRef<AbortController | null>(null);
    const previousSource = useRef<string | null>(null);
    const busy = preview !== null;
    const requestConfig = resolveModelRequestConfig(config, textModel);
    // This key stays in memory and also detects a changed key, protocol, or saved call script.
    const modelKey = JSON.stringify([textModel, requestConfig.baseUrl, requestConfig.apiKey, requestConfig.apiFormat, resolveModelScript(config, textModel), config.reasoningEffort, config.proxyEnabled, config.proxyUrl]);
    const latestRequestState = useRef({ modelKey, stale, configReady });
    latestRequestState.current = { modelKey, stale, configReady };
    const signature = JSON.stringify([source, requirements, analyzeReferences, modelKey]);
    const draft = preview ?? result?.text ?? "";
    const originalTokens = JSON.stringify(promptOptimizationTokens(input.prompt));
    const sourceTokensValid = JSON.stringify(promptOptimizationTokens(source)) === originalTokens;
    const tokensValid = JSON.stringify(promptOptimizationTokens(draft)) === originalTokens;
    const resultStale = Boolean(result && result.signature !== signature);
    const canContinue = Boolean(result?.text.trim() && !busy && !stale && configReady && sourceTokensValid && tokensValid);
    const canApply = canContinue && !resultStale;
    const text = (key: string) => t(`promptOptimization.${key}`);

    const stop = () => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        if (previousSource.current !== null) setSource(previousSource.current);
        previousSource.current = null;
        setPreview(null);
    };

    useEffect(() => () => controllerRef.current?.abort(), []);
    useEffect(() => {
        if (stale || !configReady) stop();
    }, [stale, configReady]);
    useEffect(() => {
        stop();
    }, [modelKey]);

    const optimize = async (nextSource = source) => {
        if (controllerRef.current || stale || !nextSource.trim() || JSON.stringify(promptOptimizationTokens(nextSource)) !== originalTokens) return;
        if (!configReady) {
            message.warning(text("errors.modelUnavailable"));
            return;
        }
        const controller = new AbortController();
        controllerRef.current = controller;
        previousSource.current = source;
        setSource(nextSource);
        setError("");
        setPreview("");
        const requestSignature = JSON.stringify([nextSource, requirements, analyzeReferences, modelKey]);
        const isActive = () => controllerRef.current === controller && !controller.signal.aborted && !latestRequestState.current.stale && latestRequestState.current.configReady && latestRequestState.current.modelKey === modelKey;
        try {
            const value = await requestPromptOptimization(config, textModel, { ...input, prompt: nextSource, requirements, analyzeReferences }, (value) => {
                if (isActive()) setPreview(value);
            }, controller.signal);
            if (!isActive()) return;
            setResult({ text: value, signature: requestSignature });
            previousSource.current = null;
        } catch (cause) {
            if (isActive()) {
                if (previousSource.current !== null) setSource(previousSource.current);
                previousSource.current = null;
                setError(cause instanceof Error ? cause.message : text("failed"));
            }
        } finally {
            if (controllerRef.current === controller) {
                controllerRef.current = null;
                setPreview(null);
            }
        }
    };

    const close = () => { stop(); onClose(); };
    const status = busy ? "running" : stale || resultStale ? "outdated" : result ? "ready" : "waiting";
    const refs = input.context.referenceTokens || [];

    return (
        <Modal open centered width={960} zIndex={1000} onCancel={close} mask={{ closable: !busy }}
            style={{ maxWidth: "calc(100vw - 24px)" }}
            styles={{ body: { maxHeight: "calc(100dvh - 190px)", overflowY: "auto", paddingTop: 12 }, footer: { borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 14 } }}
            title={<div className="flex items-center gap-2.5"><WandSparkles className="size-4" /><span>{text("title")}</span><span className="ml-1 text-xs font-normal" style={{ color: token.colorTextSecondary }}>{text(input.scenario === "image" ? "image" : "video")}</span></div>}
            footer={<div className="space-y-2.5">
                <p className="m-0 text-left text-xs" style={{ color: token.colorTextSecondary }}>{text("applyHint")}</p>
                <div className="thin-scrollbar flex items-center justify-between gap-3 overflow-x-auto">
                    <div className="flex shrink-0 items-center gap-1.5">
                        {busy ? <Button type="text" danger icon={<Square className="size-3.5" />} onClick={stop}>{text("stop")}</Button> : <Button type="text" icon={<WandSparkles className="size-4" />} disabled={stale || !configReady || !sourceTokensValid || !source.trim()} onClick={() => void optimize()}>{text(result ? "retry" : "start")}</Button>}
                        {result ? <Button type="text" icon={<ArrowRight className="size-3.5" />} disabled={!canContinue} onClick={() => void optimize(result.text)}>{text("continue")}</Button> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <Button type="text" onClick={close}>{t("common.cancel")}</Button>
                        <Button type="primary" icon={<Check className="size-4" />} disabled={!canApply} onClick={() => canApply && result && onApply(result.text.trim())}>{text("apply")}</Button>
                    </div>
                </div>
            </div>}
        >
            <div className="space-y-5" data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="min-w-0 flex-1 sm:max-w-80">
                        <div className="mb-2 text-xs font-medium" style={{ color: token.colorTextSecondary }}>{text("model")}</div>
                        <ModelPicker config={config} value={textModel} capability="text" fullWidth disabled={busy} className="!h-9 !rounded-lg !shadow-none" onChange={(value) => updateConfig("textModel", value)} onMissingConfig={() => openConfigDialog(false, "channels")} />
                    </div>
                    <span className="inline-flex items-center gap-1.5 pb-2 text-xs" role="status" aria-live="polite" style={{ color: token.colorTextSecondary }}>
                        {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : result && !resultStale && !stale ? <Check className="size-3.5" /> : <span className="size-1.5 rounded-full" style={{ background: token.colorTextQuaternary }} />}
                        {text(`status.${status}`)}
                    </span>
                </div>

                {!configReady ? <Alert type="warning" showIcon title={text("errors.modelUnavailable")} action={<Button size="small" type="text" onClick={() => openConfigDialog(false, "channels")}>{text("configure")}</Button>} /> : null}
                {stale ? <Alert type="warning" showIcon title={text("sourceChanged")} action={<Button size="small" type="text" icon={<RefreshCw className="size-3.5" />} onClick={onRefresh}>{text("refresh")}</Button>} /> : null}
                {error ? <Alert type="error" showIcon title={error} closable onClose={() => setError("")} /> : null}
                {!sourceTokensValid ? <Alert type="warning" showIcon title={text("errors.tokensChanged")} /> : null}

                <div className="grid gap-5 md:grid-cols-2">
                    <div className="min-w-0 space-y-4">
                        <div>
                            <div className="mb-2 flex items-baseline gap-2"><span className="text-sm font-medium">{text("source")}</span><span className="text-xs" style={{ color: token.colorTextSecondary }}>{text("sourceHint")}</span></div>
                            <PromptEditor label={text("source")} value={source} references={refs} onChange={setSource} readOnly={busy || stale} placeholder={text("sourcePlaceholder")} />
                        </div>
                        <label className="block">
                            <span className="mb-2 block text-sm font-medium">{text("requirements")} <span className="text-xs font-normal" style={{ color: token.colorTextSecondary }}>{text("optional")}</span></span>
                            <Input.TextArea aria-label={text("requirements")} value={requirements} onChange={(event) => setRequirements(event.target.value)} disabled={busy || stale} autoSize={{ minRows: 2, maxRows: 4 }} placeholder={text(input.scenario === "image" ? "imageRequirements" : "videoRequirements")} />
                        </label>
                    </div>
                    <div className="flex min-w-0 flex-col">
                        <div className="mb-2 flex min-h-5 items-center justify-between gap-2"><span className="text-sm font-medium">{text("result")}</span><Tooltip title={t("common.copy")}><Button type="text" size="small" className="!h-5 !p-0" aria-label={text("copyResult")} disabled={busy || !result?.text.trim()} icon={<Copy className="size-3.5" />} onClick={() => result && copyText(result.text)} /></Tooltip></div>
                        <PromptEditor label={text("result")} value={draft} references={refs} readOnly={busy || !result} placeholder={busy ? text("streaming") : text("resultPlaceholder")} onChange={(value) => setResult((current) => current ? { ...current, text: value } : current)} tall />
                        <div className="mt-2 min-h-5 text-xs leading-5" style={{ color: resultStale || !tokensValid && result ? token.colorWarningText : token.colorTextSecondary }}>
                            {resultStale ? text("inputsChanged") : result && !tokensValid ? text("errors.tokensChanged") : text("resultHint")}
                        </div>
                    </div>
                </div>

                {input.references.length ? <div className="border-t pt-4" style={{ borderColor: token.colorBorderSecondary }}>
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0"><div className="flex items-center gap-1.5 text-sm font-medium"><ImageIcon className="size-3.5" />{text("analyzeReferences")}<span className="text-xs font-normal" style={{ color: token.colorTextSecondary }}>{input.references.length}</span></div><p className="mt-1 mb-0 text-xs leading-5" style={{ color: token.colorTextSecondary }}>{text(analyzeReferences ? "analysisOn" : "analysisOff")}</p></div>
                        <Switch aria-label={text("analyzeReferences")} checked={analyzeReferences} disabled={busy || stale} onChange={setAnalyzeReferences} />
                    </div>
                    <div className="mt-3 flex gap-2.5 overflow-x-auto pb-1">{input.references.map((reference, index) => <Tooltip key={`${reference.id}-${index}`} title={reference.name}><div className="w-14 shrink-0"><img src={reference.dataUrl || reference.url} alt={reference.name} className="size-14 rounded-lg object-cover" /><div className="mt-1 truncate text-center text-[11px]" style={{ color: token.colorTextSecondary }}>{imageReferenceLabel(index)}</div></div></Tooltip>)}</div>
                </div> : null}
                {input.context.upstreamText || input.context.videoReferences?.length || input.context.audioReferences?.length ? <p className="m-0 text-xs leading-5" style={{ color: token.colorTextSecondary }}>{text("contextHint")}</p> : null}
            </div>
        </Modal>
    );
}

// Preserve canvas reference tokens as non-editable chips while keeping the surrounding prose editable.
function PromptEditor({ value, onChange, references, label, placeholder, readOnly, tall = false }: {
    value: string; onChange: (value: string) => void; references: NonNullable<PromptOptimizationInput["context"]["referenceTokens"]>;
    label: string; placeholder: string; readOnly?: boolean; tall?: boolean;
}) {
    const { token } = theme.useToken();
    const editorRef = useRef<HTMLDivElement>(null);
    const lastEmitted = useRef<string | null>(null);
    const composing = useRef(false);
    const id = useId();
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor || document.activeElement === editor && value === lastEmitted.current) return;
        editor.replaceChildren();
        for (const part of value.split(/(@\[node:[^\]]+\])/g)) {
            const reference = references.find((item) => item.token === part);
            if (!reference) { editor.append(document.createTextNode(part)); continue; }
            const chip = document.createElement("span");
            chip.contentEditable = "false";
            chip.dataset.promptToken = reference.token;
            chip.textContent = `@${reference.label}`;
            chip.title = reference.description || reference.label;
            chip.className = "mx-0.5 inline-block rounded px-1.5 text-xs align-baseline";
            Object.assign(chip.style, { background: token.colorFillSecondary, color: token.colorText });
            editor.append(chip);
        }
    }, [value, references, token.colorFillSecondary, token.colorText]);
    const emit = () => {
        if (!editorRef.current) return;
        lastEmitted.current = readEditor(editorRef.current);
        onChange(lastEmitted.current);
    };
    const copySelection = (event: ClipboardEvent<HTMLDivElement>, cut = false) => {
        const selection = window.getSelection();
        if (!selection?.rangeCount || selection.isCollapsed) return;
        const range = selection.getRangeAt(0);
        if (!editorRef.current?.contains(range.commonAncestorContainer)) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", readEditor(range.cloneContents()));
        if (cut && !readOnly) { range.deleteContents(); emit(); }
    };
    return <div className={`relative rounded-xl border ${tall ? "flex-1" : ""}`} style={{ borderColor: token.colorBorder, background: token.colorFillQuaternary }}>
        {!value ? <span id={`${id}-placeholder`} className="pointer-events-none absolute top-3 left-3 right-3 text-sm leading-7" style={{ color: token.colorTextPlaceholder }}>{placeholder}</span> : null}
        <div ref={editorRef} role="textbox" aria-label={label} aria-multiline="true" aria-readonly={Boolean(readOnly)} contentEditable={!readOnly} suppressContentEditableWarning
            className={`thin-scrollbar max-h-80 overflow-y-auto whitespace-pre-wrap break-words p-3 text-sm leading-7 outline-none focus-visible:ring-1 ${tall ? "min-h-60 md:min-h-80" : "min-h-48"}`} style={{ color: token.colorText, borderRadius: "inherit" }}
            onInput={() => { if (!composing.current) emit(); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; emit(); }}
            onCopy={copySelection} onCut={(event) => copySelection(event, true)}
            onPaste={(event) => {
                event.preventDefault();
                if (readOnly) return;
                const selection = window.getSelection();
                if (!selection?.rangeCount) return;
                const range = selection.getRangeAt(0);
                if (!editorRef.current?.contains(range.commonAncestorContainer)) return;
                range.deleteContents();
                const node = document.createTextNode(event.clipboardData.getData("text/plain"));
                range.insertNode(node); range.setStartAfter(node); range.collapse(true);
                selection.removeAllRanges(); selection.addRange(range); emit();
            }} />
    </div>;
}

function readEditor(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node instanceof HTMLElement && node.dataset.promptToken) return node.dataset.promptToken;
    if (node.nodeName === "BR") return "\n";
    // Browsers use a lone BR as the caret placeholder inside an empty line.
    if (node instanceof HTMLElement && node.childNodes.length === 1 && node.firstChild?.nodeName === "BR") return "";
    return Array.from(node.childNodes, (child, index) => `${index && child.nodeName === "DIV" ? "\n" : ""}${readEditor(child)}`).join("");
}
