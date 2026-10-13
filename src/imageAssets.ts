// src/imageAssets.ts
import { mkdir, writeFile, copyFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { moveToTrash } from "./trash";

const ASSETS_DIR = "assets";

// Must match the SRC_SEP used in DmArchive.tsx. Duplicated here on purpose
// to avoid a circular import (DmArchive imports from this file, so this
// file can't import from DmArchive).
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

export async function saveImageToNoteAssets(
  notePath: string,
  sourcePath: string,
  preferredName?: string
): Promise<string> {
  const dir = await assetsDirForNote(notePath);
  await mkdir(dir, { recursive: true });

  const rawName = preferredName || sourcePath.split(/[/\\]/).pop() || "image.png";
  const safeName = sanitizeFileName(rawName);
  const finalName = await uniqueName(dir, safeName);
  const destPath = await join(dir, finalName);
  await copyFile(sourcePath, destPath);
  return destPath;
}

export async function writeImageBytesToNoteAssets(
  notePath: string,
  bytes: Uint8Array,
  preferredName: string
): Promise<string> {
  const dir = await assetsDirForNote(notePath);
  await mkdir(dir, { recursive: true });

  const safeName = sanitizeFileName(preferredName);
  const finalName = await uniqueName(dir, safeName);
  const destPath = await join(dir, finalName);
  await writeFile(destPath, bytes);
  return destPath;
}

// ---- URL <-> path helpers ----

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Percent-encode the characters that break a markdown `(...)` link.
 *  We deliberately don't use `encodeURIComponent`, because that would
 *  also encode characters like `~` and `-` that are safe in links and
 *  common in filenames — making paths unreadable. This targets exactly
 *  the characters the markdown parser cares about. */
function encodeAssetPathSegment(seg: string): string {
  return seg
    .replace(/%/g, "%25")   // must run first
    .replace(/ /g, "%20")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

function encodeAssetPath(rel: string): string {
  return rel.split("/").map(encodeAssetPathSegment).join("/");
}

// Turn an asset:// URL back into the absolute filesystem path it points at.
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

// True if the given absolute path lives inside the per-note assets folder
// that belongs to `notePath`. Used to guard deletion so we never trash files
// that just happen to be referenced from the note but live elsewhere.
export function isInsideNoteAssets(absolutePath: string, notePath: string): boolean {
  const noteSlash = Math.max(notePath.lastIndexOf("/"), notePath.lastIndexOf("\\"));
  const noteDir = notePath.substring(0, noteSlash);
  const noteFileName = notePath.substring(noteSlash + 1);
  const baseName = noteFileName.replace(/\.(selah|md)$/i, "");

  const prefix = `${noteDir}/${ASSETS_DIR}/${baseName}/`.replace(/\\/g, "/");
  const normalized = absolutePath.replace(/\\/g, "/");
  return normalized.startsWith(prefix);
}

// Move the image file to the system trash, but only if it belongs to this
// note's assets folder. Returns true on success.
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

// ---- markdown <-> asset URL transforms ----
//
// Note: these functions also carry through a `?w=NNN` (or `&w=NNN`) suffix
// that blocknote.ts appends to image URLs when the user has resized an
// image. It must survive both directions of the transform, since it's what
// preserves the image's custom width across a save/load cycle.

// Split a URL into [baseUrl, widthSuffix]. The width suffix is "" if absent.
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

// ─── Generic file save (video, audio, anything) ─────────────────────────────
// saveImageToNoteAssets doesn't actually check extensions — it just copies
// a file into the note's assets folder. This alias exists so the call sites
// read correctly for non-image files.
export const saveFileToNoteAssets = saveImageToNoteAssets;

// ─── Video src transforms ───────────────────────────────────────────────────
// The video block stores an asset:// URL while in memory. When we save, we
// rewrite the src to a relative path so the note is portable. On load, we
// do the reverse.

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

// ─── DM archive src transforms ──────────────────────────────────────────────
// The `srcs` attribute on a dmarchive block is a Unit-Separator-joined list
// of paths. Same idea as the video transforms, but per-element within the
// attribute value.

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


// ─── Image gallery grid transforms ──────────────────────────────────────────
// The `grid` attribute on an imagegallery block is a JSON-encoded 2D
// array of cells. Each cell may hold { src, caption }. We rewrite the
// src fields the same way dmarchive rewrites its srcs attribute.
//
// The JSON is HTML-entity-escaped when written into the `:::` line (see
// escAttr in noteFormat.ts), so we unescape on the way in and re-escape
// on the way out.

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
                    pre +
                    convertGrid(unescapeGridAttr(String(gridRaw)), noteDir, "toAsset") +
                    post
  );
}

export function imageGalleryToRelativePaths(md: string, noteDir: string): string {
  return md.replace(
    /(::: imagegallery\b[^\n]*?\bgrid=")([^"]*)(")/g,
                    (_m, pre, gridRaw, post) =>
                    pre +
                    convertGrid(unescapeGridAttr(String(gridRaw)), noteDir, "toRelative") +
                    post
  );
}

// ── Cover path portability ──────────────────────────────────────────────
// Covers are stored in frontmatter (or gallery.meta.json) and must
// survive a vault move. We store them *relative to the note's directory*
// so the reference travels with the vault, then resolve them at read time.

const URL_LIKE = /^(https?:|data:|blob:|asset:)/i;
const ABSOLUTE_PATH = /^([a-zA-Z]:[\\/]|\/)/;

/** Convert a stored coverValue into a vault-relative form, if it's inside
 *  the note's directory. Anything external (URL, different drive, an
 *  absolute path outside the note dir) is returned unchanged. */
export function coverValueToRelative(
  coverValue: string,
  noteDir: string
): string {
  if (!coverValue) return coverValue;
  if (URL_LIKE.test(coverValue)) return coverValue;
  if (!ABSOLUTE_PATH.test(coverValue)) return coverValue; // already relative

  const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const normCv = coverValue.replace(/\\/g, "/");
  if (!normCv.startsWith(normNote + "/")) return coverValue;
  return normCv.slice(normNote.length + 1);
}

/** Resolve a stored coverValue to an absolute path we can hand to
 *  convertFileSrc or readFile. URLs and absolute paths pass through. */
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
