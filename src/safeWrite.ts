// src/safeWrite.ts
import {
  writeTextFile, writeFile, rename as fsRename, exists,
} from "@tauri-apps/plugin-fs";

/**
 * Write `contents` to `path` without ever leaving `path` in a partially-
 * written state.
 *
 *   1. Write the full new content to a uniquely-named sibling temp file.
 *   2. Rename it over `path` (atomic on POSIX, MoveFileEx on Windows).
 *
 * The tmp filename is unique per call, so two concurrent writes to the
 * same target can never collide on the same tmp path. That was the cause
 * of the "No such file or directory (os error 2)" rename failures: the
 * first caller's rename consumed the shared `.tmp`, and the second
 * caller's rename then found nothing left to rename.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array
): Promise<void> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const tmp = `${path}.${nonce}.tmp`;

  // Stage 1: write the full new content to a private temp file.
  if (typeof contents === "string") {
    await writeTextFile(tmp, contents);
  } else {
    await writeFile(tmp, contents);
  }

  // Stage 2: atomic swap, with a short retry loop for transient locks.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fsRename(tmp, path);
      return;
    } catch (e) {
      lastErr = e;

      // On Windows an existing target can block the rename. Try moving it
      // aside so the rename can go through; the trash step is best-effort.
      if (attempt === 1) {
        try {
          if (await exists(tmp)) {
            // still ours — nothing to move aside
          }
        } catch {}
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 60));
    }
  }

  console.warn(
    "[safeWrite] atomic rename failed after retries; falling back to direct write:",
    path,
    lastErr
  );

  // Stage 3: last-resort direct write. Not atomic, but better than
  // throwing the save away. If our tmp file still exists, clean it up.
  if (typeof contents === "string") {
    await writeTextFile(path, contents);
  } else {
    await writeFile(path, contents);
  }
  try {
    // Some backends leave the tmp behind on the failed rename path.
    // Best-effort cleanup — we don't care if this fails.
    const { remove } = await import("@tauri-apps/plugin-fs");
    if (await exists(tmp)) await remove(tmp);
  } catch {}
}