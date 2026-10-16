// src/emojiTheme.ts
import { Theme } from "emoji-picker-react";

/**
 * Which palette to hand `emoji-picker-react`. That library has no way to
 * know about our custom theme system, so we peek at the `data-theme`
 * attribute we set on `<html>` and decide. For "custom" themes we sample
 * the current `--c-bg` and judge by luminance.
 */
export function currentEmojiTheme(): Theme {
  if (typeof document === "undefined") return Theme.DARK;
  const root = document.documentElement;
  const mode = root.getAttribute("data-theme");
  if (mode === "light") return Theme.LIGHT;
  if (mode === "custom") {
    const bg = getComputedStyle(root).getPropertyValue("--c-bg").trim();
    return isLightColor(bg) ? Theme.LIGHT : Theme.DARK;
  }
  return Theme.DARK;
}

function isLightColor(hex: string): boolean {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Perceptual luminance (Rec. 601). > 140 reads as "light enough that
  // dark text works better than light text."
  return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}