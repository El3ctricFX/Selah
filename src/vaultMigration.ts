// src/vaultMigration.ts
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { parseNoteFile, serializeNoteFile } from "./noteFormat";
import { writeFileAtomic } from "./safeWrite";
import { coverValueToRelative } from "./imageAssets";

const MIGRATION_FLAG = "portabilityMigratedV1";

// Walk the vault. For every .selah and gallery.meta.json, rewrite any
// absolute coverValue that points inside the vault so it becomes a
// relative reference. Idempotent — running it twice is a no-op.
async function walk(
  dir: string,
  vaultPath: string,
  depth = 0,
): Promise<void> {
  if (depth > 8) return;
  let entries: any[] = [];
  try { entries = await readDir(dir); } catch { return; }

  for (const e of entries) {
    if (!e.name) continue;
    if (e.name.startsWith(".")) continue;
    if (e.name === "assets" || e.name === "_attachments") continue;

    const full = await join(dir, e.name);
    if (e.isDirectory) {
      await walk(full, vaultPath, depth + 1);
      continue;
    }

    // ── Note files ─────────────────────────────────────────────────
    if (e.name.endsWith(".selah")) {
      try {
        const raw = await readTextFile(full);
        const { frontmatter, body } = parseNoteFile(raw);
        const cv = frontmatter.coverValue;
        if (typeof cv !== "string" || !cv) continue;

        const noteDir = full.substring(
          0,
          Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\")),
        );
        const next = coverValueToRelative(cv, noteDir);
        if (next === cv) continue;

        frontmatter.coverValue = next;
        await writeFileAtomic(full, serializeNoteFile(frontmatter, body));
        console.log("[migration] note cover:", cv, "→", next);
      } catch (err) {
        console.warn("[migration] note failed:", full, err);
      }
      continue;
    }

    // ── Gallery section metadata ───────────────────────────────────
    if (e.name === "gallery.meta.json") {
      try {
        const raw = await readTextFile(full);
        const meta = JSON.parse(raw);
        const cv = meta?.coverValue;
        if (typeof cv !== "string" || !cv) continue;

        const next = coverValueToRelative(cv, dir);
        if (next === cv) continue;

        meta.coverValue = next;
        await writeFileAtomic(full, JSON.stringify(meta, null, 2));
        console.log("[migration] gallery cover:", cv, "→", next);
      } catch (err) {
        console.warn("[migration] gallery meta failed:", full, err);
      }
      continue;
    }
  }
}

async function migrateHomeBackground(vaultPath: string): Promise<void> {
  const metaPath = await join(vaultPath, ".vault_metadata.json");
  try {
    const raw = await readTextFile(metaPath);
    const meta = JSON.parse(raw);
    const bg = meta?.homeSettings?.backgroundImage;
    if (typeof bg !== "string" || !bg) return;

    const next = coverValueToRelative(bg, vaultPath);
    if (next === bg) return;

    meta.homeSettings.backgroundImage = next;
    await writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));
    console.log("[migration] home background:", bg, "→", next);
  } catch {
    // No metadata — nothing to do.
  }
}

export async function migrateVaultPaths(vaultPath: string): Promise<void> {
  // Only run once per vault. The flag lives in .vault_metadata.json.
  let meta: any = {};
  try {
    const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
    meta = JSON.parse(raw);
  } catch {}
  if (meta[MIGRATION_FLAG]) return;

  console.log("[migration] running vault portability migration…");

  await walk(vaultPath, vaultPath);
  await migrateHomeBackground(vaultPath);

  // Mark done.
  try {
    const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
    const fresh = JSON.parse(raw);
    fresh[MIGRATION_FLAG] = true;
    await writeFileAtomic(
      await join(vaultPath, ".vault_metadata.json"),
      JSON.stringify(fresh, null, 2),
    );
  } catch (e) {
    console.warn("[migration] could not write flag:", e);
  }

  console.log("[migration] done.");
}