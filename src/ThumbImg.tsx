// src/ThumbImg.tsx
import { useEffect, useMemo, useState, type ImgHTMLAttributes } from "react";
import { exists } from "@tauri-apps/plugin-fs";
import { thumbUrlFor, assetUrlToAbsolutePath } from "./imageAssets";

// Remembers whether each thumbnail exists on disk. Cleared whenever
// cleanup creates, removes or rewrites images so it never goes stale.
const thumbExistsCache = new Map<string, boolean>();
const listeners = new Set<() => void>();

export function clearThumbCache() {
  thumbExistsCache.clear();
  listeners.forEach((fn) => fn());
}
if (typeof window !== "undefined") {
  window.addEventListener("note-rewritten", clearThumbCache);
  window.addEventListener("thumbs-changed", clearThumbCache);
}

async function thumbExistsOnDisk(thumbUrl: string): Promise<boolean> {
  const cached = thumbExistsCache.get(thumbUrl);
  if (cached !== undefined) return cached;
  const abs = assetUrlToAbsolutePath(thumbUrl);
  if (!abs) {
    thumbExistsCache.set(thumbUrl, false);
    return false;
  }
  try {
    const ok = await exists(abs);
    thumbExistsCache.set(thumbUrl, ok);
    return ok;
  } catch {
    thumbExistsCache.set(thumbUrl, false);
    return false;
  }
}

interface Props extends ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  /** Set false for big displays (lightbox, hero) that need the full image. */
  allowThumb?: boolean;
}

type State = "unknown" | "thumb" | "full";

export default function ThumbImg({ src, allowThumb = true, onError, ...rest }: Props) {
  const thumb = useMemo(() => (allowThumb ? thumbUrlFor(src) : null), [src, allowThumb]);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<State>(() => {
    if (!thumb) return "full";
    const c = thumbExistsCache.get(thumb);
    return c === undefined ? "unknown" : c ? "thumb" : "full";
  });

  // Re-check when the cache is cleared.
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  useEffect(() => {
    if (!thumb) { setState("full"); return; }
    let cancelled = false;
    thumbExistsOnDisk(thumb).then((ok) => {
      if (!cancelled) setState(ok ? "thumb" : "full");
    });
      return () => { cancelled = true; };
  }, [thumb, tick]);

  // Don't start downloading the big image while we're still checking.
  if (state === "unknown") {
    return <img {...rest} alt={rest.alt ?? ""} style={{ ...rest.style, visibility: "hidden" }} />;
  }

  const shown = thumb && state === "thumb" ? thumb : src;
  return (
    <img
    {...rest}
    src={shown}
    loading="lazy"
    decoding="async"
    onError={(e) => {
      if (thumb && state === "thumb") {
        thumbExistsCache.set(thumb, false);
        setState("full");
        return;
      }
      onError?.(e);
    }}
    />
  );
}
