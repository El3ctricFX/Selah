// src/imageAssets.ts
import { mkdir, writeFile, readFile, copyFile, exists, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { moveToTrash } from "./trash";
import { parseNoteFile } from "./noteFormat";
import { proxyFeatureEnabled } from "./proxyFeature";

const ASSETS_DIR = "assets";

// Must match the SRC_SEP used in DmArchive.tsx. Duplicated here on purpose
// to avoid a circular import.
const DM_SRC_SEP = "\u001E";

export async function assetsDirForNote(notePath: string): Promise<string> {
  const lastSlash = Math.max(notePath.lastIndexOf("/"), notePath.lastIndexOf("\\"));
  const noteDir = notePath.substring(0, lastSlash);
  const fileName = notePath.substring(lastSlash + 1);
  const baseName = fileName.replace(/\.(selah|md)$/i, "");
  return await join(noteDir, ASSETS_DIR, baseName);
}

function sanitizeFileName(name: string): string {
  const idx = name.lastIndexOf(".");
  const base = idx > 0 ? name.slice(0, idx) : name;
  const ext = idx > 0 ? name.slice(idx + 1) : "";
  const safeBase =
    base.replace(/[\\/:*?"<>|]/g, "-").replace(/-+/g, "-").trim() || "image";
  const safeExt = (ext || "png").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "png";
  return `${safeBase}.${safeExt}`;
}

async function uniqueName(dir: string, baseName: string): Promise<string> {
  let candidate = baseName;
  let counter = 1;
  while (await exists(await join(dir, candidate))) {
    const idx = baseName.lastIndexOf(".");
    const base = idx > 0 ? baseName.slice(0, idx) : baseName;
    const ext = idx > 0 ? baseName.slice(idx) : "";
    candidate = `${base}-${counter}${ext}`;
    counter++;
    if (counter > 500) {
      candidate = `${base}-${Date.now()}${ext}`;
      break;
    }
  }
  return candidate;
}

// ── Save with proxy ─────────────────────────────────────────────────────
const PROXY_DIR = "proxy";

async function proxyDirForNote(notePath: string): Promise<string> {
  return await join(await assetsDirForNote(notePath), PROXY_DIR);
}

// ── Per-note "image proxies" switch (frontmatter `proxies: false` = off) ──
const proxyPref = new Map<string, boolean>();
export function setProxyPref(notePath: string, on: boolean): void {
  proxyPref.set(notePath, on);
}
export async function proxiesEnabledForNote(notePath: string): Promise<boolean> {
  if (!proxyFeatureEnabled()) return false;
  const cached = proxyPref.get(notePath);
  if (cached !== undefined) return cached;
  try {
    const { frontmatter } = parseNoteFile(await readTextFile(notePath));
    const on = frontmatter.proxies === true;
    proxyPref.set(notePath, on);
    return on;
  } catch {
    return false; // note not on disk yet: default is OFF
  }
}

export const THUMB_DIR = "thumb";   // lives inside proxy/
export const THUMB_MAX = 640;       // longest side, px
const PROXY_MAX = 1600;

/** Decode an image file, downscale so its longest side is <= maxDim, and
 *  re-encode as WebP. Used for both the 1600px proxy and the 640px thumb. */
export async function encodeImageToWebP(
  absPath: string,
  maxDim: number = PROXY_MAX,
  quality: number = 0.82
): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(absPath);
    const blob = new Blob([bytes as any]);
    const bitmap = await createImageBitmap(blob);
    try {
      const { width, height } = bitmap;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      const out = await canvas.convertToBlob({ type: "image/webp", quality });
      return new Uint8Array(await out.arrayBuffer());
    } finally { bitmap.close(); }
  } catch (e) {
    console.warn("[image] webp encode failed:", absPath, e);
    return null;
  }
}

/** Write `<assetsDir>/proxy/thumb/<name>.webp` (640px) from the original. */
export async function writeThumb(
  originalAbs: string,
  assetsDir: string,
  name: string
): Promise<boolean> {
  try {
    const thumbDir = await join(assetsDir, PROXY_DIR, THUMB_DIR);
    const dst = await join(thumbDir, `${name}.webp`);
    if (await exists(dst)) return true;
    const bytes = await encodeImageToWebP(originalAbs, THUMB_MAX, 0.78);
    if (!bytes) return false;
    await mkdir(thumbDir, { recursive: true });
    await writeFile(dst, bytes);
    return true;
  } catch (e) {
    console.warn("[image] thumb write failed:", originalAbs, e);
    return false;
  }
}

/**
 * Save an image into the note's assets folder. The source lands flat in
 * `<assetsDir>/photo.jpg`; a WebP proxy lands in `<assetsDir>/proxy/`.
 * The returned path is the proxy — that's what goes in the note.
 */
export async function saveImageToNoteAssets(
  notePath: string,
  sourcePath: string,
  preferredName?: string
): Promise<string> {
  const dir = await assetsDirForNote(notePath);
  const proxyDir = await proxyDirForNote(notePath);
  await mkdir(dir, { recursive: true });

  const rawName = preferredName || sourcePath.split(/[/\\]/).pop() || "image.png";
  const safeName = sanitizeFileName(rawName);
  const finalName = await uniqueName(dir, safeName);
  const destPath = await join(dir, finalName);
  await copyFile(sourcePath, destPath);

  const ext = (finalName.split(".").pop() || "").toLowerCase();
  if (ext === "gif" || ext === "svg" || ext === "webp") return destPath;
  if (!(await proxiesEnabledForNote(notePath))) return destPath;

  const bytes = await encodeImageToWebP(destPath);
  if (!bytes) return destPath;

  await mkdir(proxyDir, { recursive: true });
  const proxyPath = await join(proxyDir, `${finalName}.webp`);
  if (await exists(proxyPath)) return destPath;
  try {
    await writeFile(proxyPath, bytes);
    await writeThumb(destPath, dir, finalName);
    return proxyPath;
  } catch (e) {
    console.warn("[image] webp proxy write failed:", e);
    return destPath;
  }
}

export async function writeImageBytesToNoteAssets(
  notePath: string,
  bytes: Uint8Array,
  preferredName: string
): Promise<string> {
  const dir = await assetsDirForNote(notePath);
  const proxyDir = await proxyDirForNote(notePath);
  await mkdir(dir, { recursive: true });

  const safeName = sanitizeFileName(preferredName);
  const finalName = await uniqueName(dir, safeName);
  const destPath = await join(dir, finalName);
  await writeFile(destPath, bytes);

  const ext = (finalName.split(".").pop() || "").toLowerCase();
  if (ext === "gif" || ext === "svg" || ext === "webp") return destPath;
  if (!(await proxiesEnabledForNote(notePath))) return destPath;

  const webpBytes = await encodeImageToWebP(destPath);
  if (!webpBytes) return destPath;

  await mkdir(proxyDir, { recursive: true });
  const proxyPath = await join(proxyDir, `${finalName}.webp`);
  if (await exists(proxyPath)) return destPath;
  try {
    await writeFile(proxyPath, webpBytes);
    await writeThumb(destPath, dir, finalName);
    return proxyPath;
  } catch (e) {
    console.warn("[image] webp proxy write failed:", e);
    return destPath;
  }
}

/**
 * Raw copy, no conversion. Videos, audio, and anything that isn't an
 * image. Lives flat in the assets folder; the video block computes its
 * own proxy path in proxy/.
 */
export async function saveFileToNoteAssets(
  notePath: string,
  sourcePath: string,
  preferredName?: string
): Promise<string> {
  const dir = await assetsDirForNote(notePath);
  await mkdir(dir, { recursive: true });
  const rawName = preferredName || sourcePath.split(/[/\\]/).pop() || "file";
  const safeName = sanitizeFileName(rawName);
  const finalName = await uniqueName(dir, safeName);
  const destPath = await join(dir, finalName);
  await copyFile(sourcePath, destPath);
  return destPath;
}

// ── Path helpers (used by every transform below) ────────────────────────
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function encodeAssetPathSegment(seg: string): string {
  return seg
    .replace(/%/g, "%25")
    .replace(/ /g, "%20")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function encodeAssetPath(rel: string): string {
  return rel.split("/").map(encodeAssetPathSegment).join("/");
}

export function assetUrlToAbsolutePath(url: string): string | null {
  if (!url) return null;
  let m = url.match(/^https?:\/\/asset\.localhost\/(.+)$/);
  if (m) return safeDecode(m[1]);
  m = url.match(/^asset:\/\/localhost\/(.+)$/);
  if (m) return safeDecode(m[1]);
  m = url.match(/^asset:\/\/\/(.+)$/);
  if (m) return safeDecode(m[1]);
  return null;
}

export function isInsideNoteAssets(absolutePath: string, notePath: string): boolean {
  const noteSlash = Math.max(notePath.lastIndexOf("/"), notePath.lastIndexOf("\\"));
  const noteDir = notePath.substring(0, noteSlash);
  const noteFileName = notePath.substring(noteSlash + 1);
  const baseName = noteFileName.replace(/\.(selah|md)$/i, "");

  const prefix = `${noteDir}/${ASSETS_DIR}/${baseName}/`.replace(/\\/g, "/");
  const normalized = absolutePath.replace(/\\/g, "/");
  return normalized.startsWith(prefix);
}

export async function deleteImageFromNoteAssets(
  absolutePath: string,
  notePath: string
): Promise<boolean> {
  if (!isInsideNoteAssets(absolutePath, notePath)) return false;
  try {
    await moveToTrash(absolutePath);
    return true;
  } catch (e) {
    console.error("[image] move to trash failed:", e);
    return false;
  }
}

/**
 * Given any image src (asset URL, absolute path), return the asset URL of
 * its 640px thumbnail, or null if this image has no thumbnail convention
 * (gif/svg/remote/etc). The thumbnail may not exist yet; <ThumbImg> falls
 * back to the full image on load error.
 */
export function thumbUrlFor(src: string): string | null {
  if (!src) return null;
  let abs = assetUrlToAbsolutePath(src);
  if (!abs) {
    if (/^(https?:|data:|blob:|asset:)/i.test(src)) return null;
    if (!/^([a-zA-Z]:[\\/]|\/)/.test(src)) return null;
    abs = src;
  }
  const norm = abs.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  const dir = norm.slice(0, i);
  const name = norm.slice(i + 1);
  let thumbAbs: string;
  if (dir.endsWith(`/${PROXY_DIR}`) && /\.webp$/i.test(name)) {
    thumbAbs = `${dir}/${THUMB_DIR}/${name}`;
  } else if (dir.includes(`/${ASSETS_DIR}/`) && /\.(png|jpe?g|avif|bmp|tiff?)$/i.test(name)) {
    thumbAbs = `${dir}/${PROXY_DIR}/${THUMB_DIR}/${name}.webp`;
  } else {
    return null;
  }
  try { return convertFileSrc(thumbAbs); } catch { return null; }
}

/**
 * For a proxy image (…/proxy/photo.png.webp) return the asset URL of the
 * original (…/photo.png) if that file still exists, else null. Lets the
 * lightbox show the full-resolution file while tiles use the small copies.
 */
export async function originalUrlFor(src: string): Promise<string | null> {
  if (!src) return null;
  const abs = assetUrlToAbsolutePath(src);
  if (!abs) return null;
  const norm = abs.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  const dir = norm.slice(0, i);
  const name = norm.slice(i + 1);
  if (!dir.endsWith(`/${PROXY_DIR}`) || !/\.webp$/i.test(name)) return null;
  const origAbs = `${dir.slice(0, -(PROXY_DIR.length + 1))}/${name.slice(0, -5)}`;
  try {
    if (!(await exists(origAbs))) return null;
    return convertFileSrc(origAbs);
  } catch { return null; }
}

// ── Markdown <-> asset URL transforms ───────────────────────────────────
function splitImageWidthSuffix(url: string): [string, string] {
  const m = url.match(/[?&]w=\d+$/);
  if (!m) return [url, ""];
  return [url.slice(0, -m[0].length), m[0]];
}

export function markdownImagesToAssetUrls(md: string, noteDir: string): string {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    if (/^(https?:|data:|blob:|asset:)/i.test(url)) return match;
    if (url.startsWith("http://asset.localhost/")) return match;

    const [cleanUrl, widthSuffix] = splitImageWidthSuffix(url);
    const decoded = safeDecode(cleanUrl.replace(/^<|>$/g, ""));
    const sep = noteDir.includes("\\") ? "\\" : "/";
    const abs = noteDir.replace(/[\\/]+$/, "") + sep + decoded;
    try {
      const assetUrl = convertFileSrc(abs);
      return `![${alt}](${assetUrl}${widthSuffix})`;
    } catch {
      return match;
    }
  });
}

export function markdownImagesToRelativePaths(md: string, noteDir: string): string {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    const [cleanUrl, widthSuffix] = splitImageWidthSuffix(url);

    let absPath: string | null = null;

    let m = cleanUrl.match(/^https?:\/\/asset\.localhost\/(.+)$/);
    if (m) absPath = safeDecode(m[1]);
    if (!absPath) {
      m = cleanUrl.match(/^asset:\/\/localhost\/(.+)$/);
      if (m) absPath = safeDecode(m[1]);
    }
    if (!absPath) {
      m = cleanUrl.match(/^asset:\/\/\/(.+)$/);
      if (m) absPath = safeDecode(m[1]);
    }
    if (!absPath) return match;

    const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const normAbs = absPath.replace(/\\/g, "/");
    if (!normAbs.startsWith(normNote + "/")) return match;

    const rel = normAbs.slice(normNote.length + 1);
    const encoded = encodeAssetPath(rel);
    return `![${alt}](${encoded}${widthSuffix})`;
  });
}

// ── Video src transforms ────────────────────────────────────────────────
export function videoSrcsToAssetUrls(md: string, noteDir: string): string {
  return md.replace(/(::: video\b[^\n]*?\bsrc=")([^"]+)(")/g, (_m, pre, src, post) => {
    if (/^(https?:|data:|blob:|asset:)/i.test(src)) return pre + src + post;
    const decoded = safeDecode(src);
    const sep = noteDir.includes("\\") ? "\\" : "/";
    const abs = noteDir.replace(/[\\/]+$/, "") + sep + decoded;
    try {
      return pre + convertFileSrc(abs) + post;
    } catch {
      return pre + src + post;
    }
  });
}

export function videoSrcsToRelativePaths(md: string, noteDir: string): string {
  return md.replace(/(::: video\b[^\n]*?\bsrc=")([^"]+)(")/g, (_m, pre, url, post) => {
    const absPath = assetUrlToAbsolutePath(url);
    if (!absPath) return pre + url + post;
    const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const normAbs = absPath.replace(/\\/g, "/");
    if (!normAbs.startsWith(normNote + "/")) return pre + url + post;
    const rel = normAbs.slice(normNote.length + 1);
    return pre + encodeAssetPath(rel) + post;
  });
}

// ── DM archive src transforms ───────────────────────────────────────────
function convertSrcs(
  srcsRaw: string,
  noteDir: string,
  direction: "toAsset" | "toRelative"
): string {
  const parts = srcsRaw.split(DM_SRC_SEP);
  const mapped = parts.map((src) => {
    if (!src) return src;

    if (direction === "toAsset") {
      if (/^(https?:|data:|blob:|asset:)/i.test(src)) return src;
      const decoded = safeDecode(src);
      const sep = noteDir.includes("\\") ? "\\" : "/";
      const abs = noteDir.replace(/[\\/]+$/, "") + sep + decoded;
      try {
        return convertFileSrc(abs);
      } catch {
        return src;
      }
    }

    const absPath = assetUrlToAbsolutePath(src);
    if (!absPath) return src;
    const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const normAbs = absPath.replace(/\\/g, "/");
    if (!normAbs.startsWith(normNote + "/")) return src;
    const rel = normAbs.slice(normNote.length + 1);
    return encodeAssetPath(rel);
  });
  return mapped.join(DM_SRC_SEP);
}

export function dmarchiveSrcsToAssetUrls(md: string, noteDir: string): string {
  return md.replace(
    /(::: dmarchive\b[^\n]*?\bsrcs=")([^"]*)(")/g,
    (_m, pre, srcsRaw, post) =>
      pre + convertSrcs(String(srcsRaw), noteDir, "toAsset") + post
  );
}

export function dmarchiveSrcsToRelativePaths(md: string, noteDir: string): string {
  return md.replace(
    /(::: dmarchive\b[^\n]*?\bsrcs=")([^"]*)(")/g,
    (_m, pre, srcsRaw, post) =>
      pre + convertSrcs(String(srcsRaw), noteDir, "toRelative") + post
  );
}

// ── Image gallery grid transforms ───────────────────────────────────────
function unescapeGridAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

function escapeGridAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;");
}

function convertGrid(
  gridRaw: string,
  noteDir: string,
  direction: "toAsset" | "toRelative"
): string {
  let grid: any;
  try {
    grid = JSON.parse(gridRaw);
  } catch {
    return escapeGridAttr(gridRaw);
  }
  if (!Array.isArray(grid)) return escapeGridAttr(gridRaw);

  const mapped = grid.map((row: any) => {
    if (!Array.isArray(row)) return row;
    return row.map((cell: any) => {
      if (!cell || typeof cell.src !== "string" || !cell.src) return cell;
      const src: string = cell.src;

      if (direction === "toAsset") {
        if (/^(https?:|data:|blob:|asset:)/i.test(src)) return cell;
        const decoded = safeDecode(src);
        const sep = noteDir.includes("\\") ? "\\" : "/";
        const abs = noteDir.replace(/[\\/]+$/, "") + sep + decoded;
        try {
          return { ...cell, src: convertFileSrc(abs) };
        } catch {
          return cell;
        }
      }

      const absPath = assetUrlToAbsolutePath(src);
      if (!absPath) return cell;
      const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
      const normAbs = absPath.replace(/\\/g, "/");
      if (!normAbs.startsWith(normNote + "/")) return cell;
      const rel = normAbs.slice(normNote.length + 1);
      return { ...cell, src: encodeAssetPath(rel) };
    });
  });

  return escapeGridAttr(JSON.stringify(mapped));
}

export function imageGalleryToAssetUrls(md: string, noteDir: string): string {
  return md.replace(
    /(::: imagegallery\b[^\n]*?\bgrid=")([^"]*)(")/g,
    (_m, pre, gridRaw, post) =>
      pre + convertGrid(unescapeGridAttr(String(gridRaw)), noteDir, "toAsset") + post
  );
}

export function imageGalleryToRelativePaths(md: string, noteDir: string): string {
  return md.replace(
    /(::: imagegallery\b[^\n]*?\bgrid=")([^"]*)(")/g,
    (_m, pre, gridRaw, post) =>
      pre + convertGrid(unescapeGridAttr(String(gridRaw)), noteDir, "toRelative") + post
  );
}

// ── Cover path portability ──────────────────────────────────────────────
const URL_LIKE = /^(https?:|data:|blob:|asset:)/i;
const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\/)/;

export function coverValueToRelative(
  coverValue: string,
  noteDir: string
): string {
  if (!coverValue) return coverValue;
  if (URL_LIKE.test(coverValue)) return coverValue;
  if (!ABSOLUTE_PATH.test(coverValue)) return coverValue;

  const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const normCv = coverValue.replace(/\\/g, "/");
  if (!normCv.startsWith(normNote + "/")) return coverValue;
  return normCv.slice(normNote.length + 1);
}

export function coverValueToAbsolute(
  coverValue: string,
  noteDir: string
): string {
  if (!coverValue) return coverValue;
  if (URL_LIKE.test(coverValue)) return coverValue;
  if (ABSOLUTE_PATH.test(coverValue)) return coverValue;
  const sep = noteDir.includes("\\") ? "\\" : "/";
  return noteDir.replace(/[\\/]+$/, "") + sep + coverValue.replace(/^[\\/]+/, "");
}
