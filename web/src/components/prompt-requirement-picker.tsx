import { useEffect, useState } from "react";
import { Alert, App, Button, Popover, theme } from "antd";
import { Bookmark, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { appendPromptOptimizationRequirement, type PromptOptimizationScenario } from "@/lib/prompt-optimization";
import { usePromptOptimizationStore } from "@/stores/use-prompt-optimization-store";

export function PromptRequirementPicker({ scenario, value, onChange, disabled }: {
    scenario: PromptOptimizationScenario;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const items = usePromptOptimizationStore((state) => state.items[scenario]);
    const loaded = usePromptOptimizationStore((state) => state.loaded);
    const loading = usePromptOptimizationStore((state) => state.loading);
    const error = usePromptOptimizationStore((state) => state.error);
    const load = usePromptOptimizationStore((state) => state.load);
    const save = usePromptOptimizationStore((state) => state.save);
    const remove = usePromptOptimizationStore((state) => state.remove);
    const text = (key: string) => t(`promptOptimization.savedRequirements.${key}`);
    const presets = ["concise", "wording", ...(scenario === "image" ? ["identity", "composition"] : ["continuity", "pacing"])];

    useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

    const select = (requirement: string) => {
        if (disabled) return;
        onChange(appendPromptOptimizationRequirement(value, requirement));
        setOpen(false);
    };
    const persist = async (requirement: string, deleting = false) => {
        if (disabled || saving || loading || !loaded || !requirement.trim()) return;
        setSaving(true);
        try {
            await (deleting ? remove(scenario, requirement) : save(scenario, requirement));
            message.success(text(deleting ? "removed" : "saved"));
        } catch {
            message.error(text(deleting ? "removeFailed" : "saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    return <Popover trigger="click" placement="bottomRight" open={open && !disabled} onOpenChange={(next) => {
        if (disabled) return;
        setOpen(next);
        if (next) void load().catch(() => undefined);
    }} content={<div className="w-80 max-w-[calc(100vw-64px)] space-y-3" data-canvas-no-zoom data-canvas-shortcuts-ignore>
        <p className="m-0 text-xs" style={{ color: token.colorTextSecondary }}>{text("hint")}</p>
        <div className="thin-scrollbar max-h-72 space-y-2 overflow-y-auto">
            <div className="text-xs" style={{ color: token.colorTextSecondary }}>{text("suggested")}</div>
            {presets.map((preset) => <Button key={preset} type="text" block className="!justify-start !text-left" disabled={disabled} onClick={() => select(text(`presets.${preset}.value`))}>{text(`presets.${preset}.label`)}</Button>)}
            <div className="pt-2 text-xs" style={{ color: token.colorTextSecondary }}>{text(scenario === "image" ? "imageSaved" : "videoSaved")}</div>
            {error ? <Alert type="error" showIcon title={text("loadFailed")} action={<Button size="small" type="text" loading={loading} onClick={() => void load().catch(() => undefined)}>{text("reload")}</Button>} /> : loading ? <p className="m-0 text-xs" style={{ color: token.colorTextSecondary }}>{text("loading")}</p> : null}
            {!loading && !error && !items.length ? <p className="m-0 py-1 text-xs" style={{ color: token.colorTextSecondary }}>{text("empty")}</p> : null}
            {items.map((requirement) => <div key={requirement} className="flex items-start gap-1">
                <Button type="text" className="!h-auto min-h-8 min-w-0 flex-1 !justify-start !py-1.5 !text-left !whitespace-normal" disabled={disabled || !loaded || loading} title={requirement} onClick={() => select(requirement)}><span className="line-clamp-2 break-words">{requirement}</span></Button>
                <Button type="text" size="small" icon={<Trash2 className="size-3.5" />} disabled={disabled || saving || !loaded || loading} aria-label={t("promptOptimization.savedRequirements.remove", { value: requirement })} onClick={() => void persist(requirement, true)} />
            </div>)}
        </div>
        <Button type="text" block icon={<Plus className="size-3.5" />} loading={saving} disabled={disabled || !loaded || loading || !value.trim() || items.includes(value.trim())} onClick={() => void persist(value)}>{text("saveCurrent")}</Button>
    </div>}>
        <Button type="text" size="small" className="!h-6 !px-1.5" disabled={disabled} icon={<Bookmark className="size-3.5" />}>{text("title")}</Button>
    </Popover>;
}
