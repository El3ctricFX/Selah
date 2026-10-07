// src/trash.ts
import { invoke } from "@tauri-apps/api/core";

/**
 * Move a file or folder to the system trash / recycle bin.
 * Works cross-platform (Windows, macOS, Linux).
 *
 * Any delete action in the app should route through this rather than
 * `remove()` from @tauri-apps/plugin-fs, which permanently deletes.
 */
export async function moveToTrash(path: string): Promise<void> {
  await invoke("move_to_trash", { path });
}