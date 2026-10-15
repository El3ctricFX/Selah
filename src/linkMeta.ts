// src/linkMeta.ts
// Turns a pasted URL into a rich bookmark card. Canonicalizes tracking
// params away, detects the platform, and — for social links that don't
// serve useful OG tags — fetches author + thumbnail from a platform
// endpoint so the card looks like a YouTube embed instead of a bare link.

import { invoke } from "@tauri-apps/api/core";

export type PlatformInfo = {
  id: string;
  label: string;
  accent: string;
};

const PLATFORMS: Array<PlatformInfo & { test: RegExp }> = [
  { id: "x",         label: "X",         accent: "#0f1419", test: /(?:^|\.)(?:x\.com|twitter\.com)$/i },
  { id: "instagram", label: "Instagram", accent: "#e1306c", test: /(?:^|\.)instagram\.com$/i },
  { id: "tiktok",    label: "TikTok",    accent: "#ff0050", test: /(?:^|\.)tiktok\.com$/i },
  { id: "youtube",   label: "YouTube",   accent: "#ff0000", test: /(?:^|\.)(?:youtube\.com|youtu\.be)$/i },
  { id: "facebook",  label: "Facebook",  accent: "#1877f2", test: /(?:^|\.)facebook\.com$/i },
  { id: "reddit",    label: "Reddit",    accent: "#ff4500", test: /(?:^|\.)reddit\.com$/i },
  { id: "linkedin",  label: "LinkedIn",  accent: "#0a66c2", test: /(?:^|\.)linkedin\.com$/i },
  { id: "pinterest", label: "Pinterest", accent: "#e60023", test: /(?:^|\.)pinterest\.com$/i },
  { id: "twitch",    label: "Twitch",    accent: "#9146ff", test: /(?:^|\.)twitch\.tv$/i },
  { id: "spotify",   label: "Spotify",   accent: "#1db954", test: /(?:^|\.)spotify\.com$/i },
  { id: "github",    label: "GitHub",    accent: "#8b949e", test: /(?:^|\.)github\.com$/i },
];

export function detectPlatform(url: string): PlatformInfo | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    for (const p of PLATFORMS) {
      if (p.test.test(hostname)) {
        return { id: p.id, label: p.label, accent: p.accent };
      }
    }
  } catch {}
  return null;
}

const TRACKING_PARAMS = new Set([
  "s", "t", "ref", "ref_src", "ref_url", "igsh", "igshid",
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "si", "feature", "share",
  "_ga", "_gl", "mc_cid", "mc_eid",
]);

export function canonicalizeUrl(raw: string): string {
  if (!raw) return raw;
  try {
    const u = new URL(raw.trim());
    const platform = detectPlatform(raw);
    if (platform) {
      const params = new URLSearchParams(u.search);
      let changed = false;
      for (const key of Array.from(params.keys())) {
        if (TRACKING_PARAMS.has(key.toLowerCase())) {
          params.delete(key);
          changed = true;
        }
      }
      if (changed) {
        const next = params.toString();
        u.search = next ? `?${next}` : "";
      }
      if (platform.id === "x" && u.pathname.length > 1) {
        u.pathname = u.pathname.replace(/\/+$/, "");
      }
    }
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export function normalizeUrlInput(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(t)) return `https://${t}`;
  return t;
}

/**
 * Extract the numeric status ID from an X/Twitter URL. Returns null if
 * the URL isn't a status link (e.g. just a profile).
 */
function xStatusId(url: string): string | null {
  const m = url.match(/\/status(?:es)?\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * Extract the shortcode from an Instagram post/reel/tv URL.
 */
function igShortcode(url: string): string | null {
  const m = url.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * Extract @handle and media type from an Instagram URL as a last resort.
 */
function igHandleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    // /{handle}/p/{code}/  →  parts = [handle, "p", code]
    if (parts.length >= 3 && /^(p|reel|reels|tv)$/.test(parts[1])) {
      return parts[0];
    }
  } catch {}
  return null;
}

export interface EnrichedMetadata {
  title: string;
  description: string;
  icon: string;
  image: string;
  meta: string;
}

/**
 * Fetch metadata for a tweet via the same JSON endpoint X's own embed
 * widget uses. Unauthenticated, CORS-friendly, and returns the full
 * author + media payload we need for a rich card.
 *
 * If your Tauri CSP blocks it, add `https://cdn.syndication.twimg.com`
 * to `connect-src` in tauri.conf.json.
 */
async function fetchXMetadata(
  canonicalUrl: string,
  platform: PlatformInfo
): Promise<EnrichedMetadata | null> {
  const id = xStatusId(canonicalUrl);
  if (!id) return null;

  try {
    const token = Math.random().toString(36).slice(2, 10);
    const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`;
    const resp = await fetch(endpoint, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      console.warn("[linkMeta] X syndication non-OK:", resp.status);
      return null;
    }
    const data: any = await resp.json();

    const userName: string = data?.user?.name || "";
    const screenName: string = data?.user?.screen_name || "";
    let avatar: string = data?.user?.profile_image_url_https || "";
    // Bump the avatar to 400×400 (the default is _normal = 48×48).
    if (avatar.includes("_normal.")) {
      avatar = avatar.replace("_normal.", "_400x400.");
    }

    const text: string = data?.text || "";

    // Media resolution, in preference order:
    //   1. photo attached to the tweet (best — it IS the tweet)
    //   2. video poster frame (mp4 preview)
    //   3. mediaDetails array (fallback for mixed-media tweets)
    let image = "";
    if (Array.isArray(data?.photos) && data.photos.length > 0) {
      image = data.photos[0]?.url || "";
    } else if (data?.video?.poster) {
      image = data.video.poster;
    } else if (Array.isArray(data?.mediaDetails) && data.mediaDetails.length > 0) {
      image = data.mediaDetails[0]?.media_url_https || "";
    }
    // If the tweet had no media, use the avatar as the card thumbnail so
    // the card never renders as a blank rectangle.
    if (!image && avatar) image = avatar;

    const title = userName || (screenName ? `@${screenName}` : "Post on X");
    const meta = screenName ? `@${screenName} · ${platform.label}` : platform.label;

    return {
      title,
      description: text,
      icon: avatar,
      image,
      meta,
    };
  } catch (e) {
    console.warn("[linkMeta] X syndication fetch failed:", e);
    return null;
  }
}

/**
 * Ask the Rust `fetch_link_metadata` command for a URL. Returns null on
 * failure so callers can fall back to a URL-derived title.
 */
async function fetchViaRust(url: string): Promise<Partial<EnrichedMetadata> | null> {
  try {
    const meta: any = await invoke("fetch_link_metadata", { url });
    if (!meta) return null;
    return {
      title: meta.title || "",
      description: meta.description || "",
      icon: meta.favicon || "",
      image: meta.image || "",
      meta: meta.meta || "",
    };
  } catch (e) {
    console.warn("[linkMeta] rust fetch_link_metadata failed:", e);
    return null;
  }
}

/**
 * Instagram fallback when nothing else worked. We can't reliably scrape
 * IG from the frontend — no CORS, and the public oEmbed now requires
 * auth. Build the nicest card we can from the URL alone.
 */
function igFallback(canonicalUrl: string, platform: PlatformInfo): EnrichedMetadata {
  const handle = igHandleFromUrl(canonicalUrl);
  const isReel = /\/(reel|reels)\//.test(canonicalUrl);
  const isTV = /\/tv\//.test(canonicalUrl);
  const kind = isReel ? "Reel" : isTV ? "IGTV video" : "Post";

  return {
    title: handle ? `@${handle}` : `Instagram ${kind.toLowerCase()}`,
    description: "",
    icon: "",
    image: "",
    meta: `${platform.label} · ${kind}`,
  };
}

/**
 * Fetch metadata for an Instagram URL. Instagram serves a stripped-down
 * "embed/captioned" page to browser user agents that has clean markup
 * for the author handle and post image. Rust does the fetch (CORS).
 *
 * If your Rust fetch returns an empty `image`, we fall back to a
 * URL-derived card that still names the author when we can.
 */
async function fetchInstagramMetadata(
  canonicalUrl: string,
  platform: PlatformInfo
): Promise<EnrichedMetadata | null> {
  const shortcode = igShortcode(canonicalUrl);
  if (!shortcode) return null;

  // Give Rust a hint that this is an Instagram URL so it can route to
  // its IG-specific scraper. If your Rust command ignores the hint,
  // that's fine — it just falls back to generic OG scraping.
  const rust = await fetchViaRust(canonicalUrl);

  const handle = igHandleFromUrl(canonicalUrl);

  // Only trust the Rust response if it actually returned something
  // beyond the URL itself.
  const rustTitle = rust?.title?.trim() || "";
  const rustUsefulTitle =
    rustTitle && rustTitle !== canonicalUrl && !rustTitle.startsWith("http");

  const rustHasImage = !!rust?.image;
  const rustHasIcon = !!rust?.icon;

  if (rustUsefulTitle || rustHasImage || rustHasIcon) {
    return {
      title: rustUsefulTitle ? rustTitle : (handle ? `@${handle}` : "Instagram post"),
      description: rust?.description || "",
      icon: rust?.icon || "",
      image: rust?.image || "",
      meta: handle ? `@${handle} · ${platform.label}` : platform.label,
    };
  }

  // Nothing useful from Rust — build a branded fallback.
  return igFallback(canonicalUrl, platform);
}

/**
 * The single entry point. Detects the platform, tries the right fetcher,
 * and always returns a usable card payload.
 */
export async function fetchEnrichedMetadata(
  rawUrl: string
): Promise<EnrichedMetadata> {
  const canonical = canonicalizeUrl(rawUrl);
  const platform = detectPlatform(canonical);

  // ── X / Twitter ─────────────────────────────────────────────────────
  // The syndication endpoint gives us a full rich card without any Rust
  // round-trip.
  if (platform?.id === "x") {
    const xMeta = await fetchXMetadata(canonical, platform);
    if (xMeta) return xMeta;
    // Fall through to Rust if the syndication endpoint fails.
  }

  // ── Instagram ───────────────────────────────────────────────────────
  if (platform?.id === "instagram") {
    const igMeta = await fetchInstagramMetadata(canonical, platform);
    if (igMeta) return igMeta;
  }

  // ── Everything else ─────────────────────────────────────────────────
  const rust = await fetchViaRust(canonical);
  const rustTitle = rust?.title?.trim() || "";
  const rustUseful =
    rustTitle &&
    rustTitle !== canonical &&
    !rustTitle.startsWith("http");

  if (rustUseful || rust?.image) {
    return {
      title: rustUseful ? rustTitle : humanizeUrlTitle(canonical),
      description: rust?.description || "",
      icon: rust?.icon || "",
      image: rust?.image || "",
      meta: rust?.meta || platform?.label || "",
    };
  }

  // Nothing from anywhere — URL-derived title so the card doesn't just
  // show the raw link.
  return {
    title: humanizeUrlTitle(canonical),
    description: "",
    icon: "",
    image: "",
    meta: platform?.label || "",
  };
}

export function humanizeUrlTitle(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const platform = detectPlatform(url);

    if (platform?.id === "x") {
      const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
      if (m) return `Post by @${m[1]} on X`;
    }

    if (platform?.id === "instagram") {
      const m = u.pathname.match(/^\/([^/]+)\/(p|reel|tv)\//);
      if (m && !["p", "reel", "tv"].includes(m[1])) {
        return `Post by @${m[1]} on Instagram`;
      }
      if (/^\/(p|reel|tv)\//.test(u.pathname)) {
        return `Post on Instagram`;
      }
    }

    if (platform?.id === "youtube") {
      if (u.searchParams.get("v") || /^\/(shorts|live|embed)\//.test(u.pathname)) {
        return `Video on YouTube`;
      }
    }

    if (platform?.id === "reddit") {
      const m = u.pathname.match(/^\/r\/([^/]+)\/comments\//);
      if (m) return `Post in r/${m[1]}`;
    }

    const host = u.hostname.replace(/^www\./, "");
    const path = u.pathname.replace(/^\/+|\/+$/g, "");
    if (path) {
      const short = path.length > 40 ? path.slice(0, 40) + "…" : path;
      return `${host} — ${short}`;
    }
    return host;
  } catch {
    return url;
  }
}

export function isMetadataUseful(meta: any, url: string): boolean {
  if (!meta) return false;
  const title = String(meta.title || "").trim();
  if (!title) return false;
  if (title === url) return false;
  const urlNoProto = url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const titleNoProto = title.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (titleNoProto === urlNoProto) return false;
  return true;
}