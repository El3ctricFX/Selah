// src/imageAssets.ts
import { mkdir, writeFile, copyFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { moveToTrash } from "./trash";

const ASSETS_DIR = "assets";

export async function assetsDirForNote(notePath: string): Promise<string> {
  const lastSlash = Math.max(notePath.lastIndexOf("/"), notePath.lastIndexOf("\\"));
  const noteDir = notePath.substring(0, lastSlash);
  const fileName = notePath.substring(lastSlash + 1);
  const baseName = fileName.replace(/\.(note|md)$/i, "");
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
  const baseName = noteFileName.replace(/\.(note|md)$/i, "");

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

export function markdownImagesToAssetUrls(md: string, noteDir: string): string {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    if (/^(https?:|data:|blob:|asset:)/i.test(url)) return match;
    if (url.startsWith("http://asset.localhost/")) return match;

    const decoded = safeDecode(url.replace(/^<|>$/g, ""));
    const sep = noteDir.includes("\\") ? "\\" : "/";
    const abs = noteDir.replace(/[\\/]+$/, "") + sep + decoded;
    try {
      const assetUrl = convertFileSrc(abs);
      return `![${alt}](${assetUrl})`;
    } catch {
      return match;
    }
  });
}

export function markdownImagesToRelativePaths(md: string, noteDir: string): string {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    let absPath: string | null = null;

    let m = url.match(/^https?:\/\/asset\.localhost\/(.+)$/);
    if (m) absPath = safeDecode(m[1]);
    if (!absPath) {
      m = url.match(/^asset:\/\/localhost\/(.+)$/);
      if (m) absPath = safeDecode(m[1]);
    }
    if (!absPath) {
      m = url.match(/^asset:\/\/\/(.+)$/);
      if (m) absPath = safeDecode(m[1]);
    }
    if (!absPath) return match;

    const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const normAbs = absPath.replace(/\\/g, "/");
    if (!normAbs.startsWith(normNote + "/")) return match;

    const rel = normAbs.slice(normNote.length + 1);
    const encoded = rel.replace(/ /g, "%20");
    return `![${alt}](${encoded})`;
  });
}