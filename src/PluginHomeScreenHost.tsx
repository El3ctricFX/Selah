// src/PluginHomeScreenHost.tsx
import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { usePlugins } from "./plugins";

export function PluginHomeScreenHost({
    pluginKey,
    vaultPath,
}: {
    pluginKey: string;
    vaultPath: string;
}) {
    const { homeScreens } = usePlugins();
    const screen = homeScreens.find((s) => s.key === pluginKey);
    const hostRef = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const el = hostRef.current;
        if (!screen || !el) return;
        setError(null);
        el.innerHTML = "";
        let disposed = false;
        let cleanup: (() => void) | undefined;

        Promise.resolve()
        .then(() => screen.render(el, { vaultPath }))
        .then((r) => {
            if (typeof r !== "function") return;
            if (disposed) { try { r(); } catch {} } else cleanup = r;
        })
        .catch((e) => {
            console.error("[plugin home] render failed:", pluginKey, e);
            if (!disposed) setError(e?.message ?? String(e));
        });

            return () => {
                disposed = true;
                try { cleanup?.(); } catch {}
                el.innerHTML = "";
            };
    }, [screen, vaultPath, pluginKey]);

    if (!screen) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-500 gap-2">
            <p className="text-sm">This custom home screen is not available.</p>
            <p className="text-xs">The plugin providing it may have been disabled.</p>
            </div>
        );
    }

    return (
        <div className="w-full h-full relative overflow-y-auto">
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
