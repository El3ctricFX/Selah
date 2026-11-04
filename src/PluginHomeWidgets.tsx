// src/PluginHomeWidgets.tsx
import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { usePlugins, type HomeWidgetSlot, type RegisteredHomeWidget } from "./plugins";

/** Enabled widgets for one slot, in the order the user arranged them. */
export function useSlotWidgets(
    slot: HomeWidgetSlot,
    enabledKeys: string[] | undefined
): RegisteredHomeWidget[] {
    const { homeWidgets } = usePlugins();
    const out: RegisteredHomeWidget[] = [];
    for (const key of enabledKeys || []) {
        const w = homeWidgets.find((x) => x.key === key);
        if (w && w.slot === slot) out.push(w);
    }
    return out;
}

function WidgetHost({
    widget,
    vaultPath,
}: {
    widget: RegisteredHomeWidget;
    vaultPath: string;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const el = hostRef.current;
        if (!el) return;
        setError(null);
        el.innerHTML = "";
        let disposed = false;
        let cleanup: (() => void) | undefined;

        Promise.resolve()
        .then(() =>
        widget.render(el, {
            vaultPath,
            fs: widget.fs,
            name: widget.label,
            slot: widget.slot,
            theme: {
                bg: "bg-[var(--c-bg)]",
                      surface: "bg-[var(--c-surface)]",
                      border: "border-[var(--c-border)]",
                      text: "text-[var(--c-text)]",
                      accent: "text-[var(--c-accent)]",
            },
        })
        )
        .then((r) => {
            if (typeof r !== "function") return;
            if (disposed) { try { r(); } catch {} } else cleanup = r;
        })
        .catch((e) => {
            console.error("[plugins] home widget failed:", widget.key, e);
            if (!disposed) setError(e?.message ?? String(e));
        });

            return () => {
                disposed = true;
                try { cleanup?.(); } catch {}
                el.innerHTML = "";
            };
    }, [widget, vaultPath]);

    return (
        <div>
        {error && (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-300">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            <span className="break-words">{widget.label}: {error}</span>
            </div>
        )}
        <div ref={hostRef} />
        </div>
    );
}

export function WidgetSlot({
    widgets,
    vaultPath,
    className,
}: {
    widgets: RegisteredHomeWidget[];
    vaultPath: string;
    className?: string;
}) {
    if (widgets.length === 0) return null;
    return (
        <div className={className}>
        {widgets.map((w) => (
            <div key={w.key} className="mb-3 last:mb-0">
            <WidgetHost widget={w} vaultPath={vaultPath} />
            </div>
        ))}
        </div>
    );
}
