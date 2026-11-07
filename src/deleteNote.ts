// src/deleteNote.ts
import { exists } from "@tauri-apps/plugin-fs";
import { assetsDirForNote } from "./imageAssets";
import { moveToTrash } from "./trash";

/**
 * Trash a note file *and* its per-note assets folder in one shot.
 *
 * Notes store their images, audio, video, and attachments inside
 * `<noteDir>/assets/<noteBase>/` (see `assetsDirForNote`). Trashing only
 * the `.selah` file leaves that folder behind as garbage — the cleanup
 * audit later reports it as "unused files", but it's better to remove it
 * at the same time so the vault stays tidy.
 *
 * Both operations are best-effort and independent:
 *  - If the note file is already gone, we still try the assets folder.
 *  - If the assets folder is missing or the trash call fails, we still
 *    return and let the caller decide whether to warn.
 *
 * The note file is trashed *first*. If the assets folder trash fails
 * afterwards we leave garbage (recoverable via Cleanup) rather than a
 * live note whose assets have vanished.
 */
export async function trashNoteWithAssets(notePath: string): Promise<{
    noteTrashed: boolean;
    assetsTrashed: boolean;
}> {
    let assetsDir: string | null = null;
    try {
        assetsDir = await assetsDirForNote(notePath);
    } catch (e) {
        console.warn("[delete] could not resolve assets folder:", notePath, e);
    }

    let noteTrashed = false;
    try {
        await moveToTrash(notePath);
        noteTrashed = true;
    } catch (e) {
        console.error("[delete] could not trash note:", notePath, e);
    }

    let assetsTrashed = false;
    if (assetsDir) {
        try {
            if (await exists(assetsDir)) {
                await moveToTrash(assetsDir);
                assetsTrashed = true;
            }
        } catch (e) {
            console.warn("[delete] could not trash note assets folder:", assetsDir, e);
        }
    }

    return { noteTrashed, assetsTrashed };
}
