// src/abbaAssets.ts
import { mkdir, copyFile, exists, readFile, stat } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";
import { moveToTrash } from "./trash";

const ASSETS_DIR = "assets";

export async function abbaAssetsDir(abbaDir: string): Promise<string> {
  return await join(abbaDir, ASSETS_DIR);
}

export async function abbaSectionAssetsDir(
  abbaDir: string,
  section: string
): Promise<string> {
  return await join(abbaDir, ASSETS_DIR, section);
}

export async function abbaNoteAssetsDir(
  abbaDir: string,
  section: string,
  noteId: string
): Promise<string> {
  return await join(abbaDir, ASSETS_DIR, section, noteId);
}

function sanitizeFileName(name: string): string {
  const idx = name.lastIndexOf(".");
  const base = idx > 0 ? name.slice(0, idx) : name;
  const ext = idx > 0 ? name.slice(idx + 1) : "";
  const safeBase =
    base.replace(/[\\/:*?"<>|]/g, "-").replace(/-+/g, "-").trim() || "file";
  const safeExt =
    (ext || "bin").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
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

/** Save a file into <abbaDir>/assets/<section>/<noteId>/ */
export async function saveFileToAbbaNote(
  abbaDir: string,
  section: string,
  noteId: string,
  sourcePath: string,
  preferredName?: string
): Promise<{ fileName: string; displayName: string }> {
  const dir = await abbaNoteAssetsDir(abbaDir, section, noteId);
  await mkdir(dir, { recursive: true });

  const rawName = preferredName || sourcePath.split(/[/\\]/).pop() || "file";
  const safeName = sanitizeFileName(rawName);
  const finalName = await uniqueName(dir, safeName);
  const destPath = await join(dir, finalName);
  await copyFile(sourcePath, destPath);
  return { fileName: finalName, displayName: rawName };
}

/** Absolute path for an asset inside a specific note's folder. */
export function abbaNoteAssetPath(
  abbaDir: string,
  section: string,
  noteId: string,
  fileName: string
): string {
  const base = abbaDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/${ASSETS_DIR}/${section}/${noteId}/${fileName}`;
}

/** Legacy flat-path helper, still used for opening files externally. */
export function abbaAssetUrl(
  abbaDir: string,
  section: string,
  noteId: string,
  fileName: string
): string {
  if (!abbaDir || !fileName) return "";
  try {
    return convertFileSrc(abbaNoteAssetPath(abbaDir, section, noteId, fileName));
  } catch (e) {
    console.error("[abba] abbaAssetUrl failed:", e);
    return "";
  }
}

export const MAX_BLOB_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export async function abbaNoteAssetSize(
  abbaDir: string,
  section: string,
  noteId: string,
  fileName: string
): Promise<number | null> {
  try {
    const info = await stat(abbaNoteAssetPath(abbaDir, section, noteId, fileName));
    return info.size;
  } catch {
    return null;
  }
}

export function mimeFromFileName(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg": return "audio/ogg";
    case "opus": return "audio/ogg";
    case "m4a": return "audio/mp4";
    case "aac": return "audio/aac";
    case "flac": return "audio/flac";
    case "webm": return "audio/webm";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    case "avif": return "image/avif";
    case "bmp": return "image/bmp";
    default: return "application/octet-stream";
  }
}

// ---- Blob URL cache -------------------------------------------------------
const blobCache = new Map<string, string>();
const blobPending = new Map<string, Promise<string | null>>();

export async function loadAbbaNoteAssetBlob(
  abbaDir: string,
  section: string,
  noteId: string,
  fileName: string
): Promise<string | null> {
  if (!abbaDir || !fileName) return null;
  const key = `${abbaDir}::${section}::${noteId}::${fileName}`;
  const cached = blobCache.get(key);
  if (cached) return cached;
  const pending = blobPending.get(key);
  if (pending) return pending;

  const p = (async () => {
    try {
      const full = abbaNoteAssetPath(abbaDir, section, noteId, fileName);
      const size = await abbaNoteAssetSize(abbaDir, section, noteId, fileName);
      if (size !== null && size > MAX_BLOB_BYTES) {
        console.warn("[abba] asset too large for blob, skipping:", key, size);
        return null;
      }
      const bytes = await readFile(full);
      const blob = new Blob([bytes], { type: mimeFromFileName(fileName) });
      const url = URL.createObjectURL(blob);
      blobCache.set(key, url);
      return url;
    } catch (e) {
      console.error("[abba] could not read asset:", key, e);
      return null;
    } finally {
      blobPending.delete(key);
    }
  })();

  blobPending.set(key, p);
  return p;
}

export function clearAbbaBlobCache(): void {
  for (const url of blobCache.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
  blobCache.clear();
}

export async function deleteAbbaNoteAsset(
  abbaDir: string,
  section: string,
  noteId: string,
  fileName: string
): Promise<void> {
  const path = abbaNoteAssetPath(abbaDir, section, noteId, fileName);
  try {
    if (await exists(path)) await moveToTrash(path);
  } catch (e) {
    console.error("[abba] could not trash asset:", e);
  }
  const key = `${abbaDir}::${section}::${noteId}::${fileName}`;
  const cached = blobCache.get(key);
  if (cached) {
    try {
      URL.revokeObjectURL(cached);
    } catch {}
    blobCache.delete(key);
  }
}

/** Trash an entire per-note asset folder. */
export async function deleteAbbaNoteAssetsFolder(
  abbaDir: string,
  section: string,
  noteId: string
): Promise<void> {
  const dir = await abbaNoteAssetsDir(abbaDir, section, noteId);
  try {
    if (await exists(dir)) await moveToTrash(dir);
  } catch (e) {
    console.error("[abba] could not trash note assets folder:", e);
  }
  // Purge any cached blob URLs under this note
  const prefix = `${abbaDir}::${section}::${noteId}::`;
  for (const key of Array.from(blobCache.keys())) {
    if (key.startsWith(prefix)) {
      const url = blobCache.get(key);
      if (url) {
        try { URL.revokeObjectURL(url); } catch {}
      }
      blobCache.delete(key);
    }
  }
}

/** Copy a legacy flat asset (<abbaDir>/assets/<fileName>) into a per-note
 *  folder. Returns true if the asset exists in the destination afterwards. */
export async function migrateLegacyAssetToNote(
  abbaDir: string,
  section: string,
  noteId: string,
  fileName: string
): Promise<boolean> {
  try {
    const src = await join(abbaDir, ASSETS_DIR, fileName);
    if (!(await exists(src))) return false;
    const destDir = await abbaNoteAssetsDir(abbaDir, section, noteId);
    await mkdir(destDir, { recursive: true });
    const dest = await join(destDir, fileName);
    if (await exists(dest)) return true;
    await copyFile(src, dest);
    return true;
  } catch (e) {
    console.error("[abba] legacy asset copy failed:", fileName, e);
    return false;
  }
}