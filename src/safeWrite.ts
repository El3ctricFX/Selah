// src/safeWrite.ts
import {
  writeTextFile, writeFile, rename as fsRename,
} from "@tauri-apps/plugin-fs";

/**
 * Write `contents` to `path` without ever leaving `path` in a partially-
 * written state.
 *
 *   1. Write the full new content to `<path>.tmp`.
 *   2. Rename `<path>.tmp` over `<path>`. On POSIX this is one atomic
 *      syscall; on Windows it's MoveFileEx(REPLACE_EXISTING), which is
 *      equivalent for our purposes.
 *
 * If the process is killed at any point, `path` holds either the complete
 * old content or the complete new content — never a mixture. A crashed
 * write may leave `<path>.tmp` behind; the next save overwrites it in
 * place, so at most one temp file per note ever exists.
 *
 * If the rename fails repeatedly (rare; usually a Windows antivirus lock),
 * we fall back to a direct write so the save isn't lost. The `.tmp` file
 * still holds the full new content as a manual recovery path.
 */
export async function writeFileAtomic(
  path: string,
  contents: string | Uint8Array
): Promise<void> {
  const tmp = `${path}.tmp`;

  // Stage 1: write the full new content to a sibling temp file.
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
      if (attempt < 2) await new Promise((r) => setTimeout(r, 60));
    }
  }

  console.warn(
    "[safeWrite] atomic rename failed after retries; falling back to direct write:",
    path,
    lastErr
  );

  // Stage 3: last-resort direct write. Not atomic, but better than
  // throwing away the save. `.tmp` is still on disk with the full content.
  if (typeof contents === "string") {
    await writeTextFile(path, contents);
  } else {
    await writeFile(path, contents);
  }
}