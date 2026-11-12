// src/tabsFeature.ts
import { useEffect, useState } from "react";

const KEY = "tabs-feature-enabled";

export function tabsFeatureEnabled(): boolean {
    try { return localStorage.getItem(KEY) === "true"; } catch { return false; }
}

export function setTabsFeatureEnabled(on: boolean): void {
    try { localStorage.setItem(KEY, String(on)); } catch {}
    window.dispatchEvent(new Event("tabs-feature-changed"));
}

export function useTabsFeature(): boolean {
    const [on, setOn] = useState(tabsFeatureEnabled);
    useEffect(() => {
        const fn = () => setOn(tabsFeatureEnabled());
        window.addEventListener("tabs-feature-changed", fn);
        return () => window.removeEventListener("tabs-feature-changed", fn);
    }, []);
    return on;
}
