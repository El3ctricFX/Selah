// src/proxyFeature.ts
import { useEffect, useState } from "react";

// App-wide switch for the whole image-proxy feature. OFF by default.
const KEY = "proxies-feature-enabled";

export function proxyFeatureEnabled(): boolean {
    try { return localStorage.getItem(KEY) === "true"; } catch { return false; }
}

export function setProxyFeatureEnabled(on: boolean): void {
    try { localStorage.setItem(KEY, String(on)); } catch {}
    window.dispatchEvent(new Event("proxy-feature-changed"));
}

export function useProxyFeature(): boolean {
    const [on, setOn] = useState(proxyFeatureEnabled);
    useEffect(() => {
        const fn = () => setOn(proxyFeatureEnabled());
        window.addEventListener("proxy-feature-changed", fn);
        return () => window.removeEventListener("proxy-feature-changed", fn);
    }, []);
    return on;
}
