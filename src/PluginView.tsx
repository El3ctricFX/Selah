// src/PluginView.tsx
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Puzzle } from "lucide-react";
import { usePlugins, scopedFs } from "./plugins";
import { mkdir } from "@tauri-apps/plugin-fs";

export default function PluginView({
    vaultPath, dir, name, icon, mode,
}: {
    vaultPath: string; dir: string; name: string; icon: string; mode: string;
}) {
    const { categoryTypes, ready } = usePlugins();
    const type = categoryTypes.find((t) => t.mode === mode);
    const hostRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const el = hostRef.current;
        if (!type || !el) return;
        setError(null);
        el.innerHTML = "";
        let disposed = false;
        let cleanup: (() => void) | undefined;

        (async () => {
            try { await mkdir(dir, { recursive: true }); } catch {}
            // Find the custom sidebar container in Selah's DOM
            const sidebarEl = document.getElementById("plugin-sidebar-target") || undefined;

            return type.render(el, {
                vaultPath, dir, name, icon, fs: scopedFs(dir),
                sidebarContainer: sidebarEl,
                               // Pass consistent theme classes
                               theme: {
                                   bg: "bg-[var(--c-bg)]",
                               surface: "bg-[var(--c-surface)]",
                               border: "border-[var(--c-border)]",
                               text: "text-[var(--c-text)]",
                               accent: "text-[var(--c-accent)]"
                               }
            });
        })()
        .then((r) => {
            if (typeof r !== "function") return;
            if (disposed) { try { r(); } catch {} } else cleanup = r;
        })
        .catch((e) => {
            console.error("[plugins] render failed:", e);
            if (!disposed) setError(e?.message ?? String(e));
        });

            return () => {
                disposed = true;
                try { cleanup?.(); } catch {}
                el.innerHTML = "";
            };
    }, [type, dir]);

    if (!type) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 bg-[var(--c-bg)] gap-2 px-6 text-center">
            <Puzzle size={28} className="opacity-50" />
            <p className="text-sm">
            {ready ? `The plugin for "${name}" isn't installed or is disabled.` : "Loading plugins…"}
            </p>
            {ready && (
                <p className="text-xs text-gray-600">
                Your files in this category are safe. Re-enable or reinstall the plugin in Settings → Plugins.
                </p>
            )}
            </div>
        );
    }

    return (
        <div className="w-full h-full overflow-y-auto bg-[var(--c-bg)] text-[var(--c-text)]">
        {error && (
            <div className="m-4 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <span className="break-words">Plugin error: {error}</span>
            </div>
        )}
        <div ref={hostRef} className="min-h-full" />
        </div>
    );
}
