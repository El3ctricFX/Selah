// src/pluginFeature.ts
import { useEffect, useState } from "react";

const KEY = "plugins-feature-enabled";

export function pluginFeatureEnabled(): boolean {
    try { return localStorage.getItem(KEY) === "true"; } catch { return false; }
}

export function setPluginFeatureEnabled(on: boolean): void {
    try { localStorage.setItem(KEY, String(on)); } catch {}
    window.dispatchEvent(new Event("plugins-feature-changed"));
}

export function usePluginFeature(): boolean {
    const [on, setOn] = useState(pluginFeatureEnabled);
    useEffect(() => {
        const fn = () => setOn(pluginFeatureEnabled());
        window.addEventListener("plugins-feature-changed", fn);
        return () => window.removeEventListener("plugins-feature-changed", fn);
    }, []);
    return on;
}
