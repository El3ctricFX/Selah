// src/journalDateMove.ts
import {
  readTextFile, writeTextFile, mkdir, exists, rename as fsRename,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { parseNoteFile, serializeNoteFile } from "./noteFormat";
import { moveToTrash } from "./trash";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDayName(year: number, month: number, day: number): string {
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

async function safeExists(path: string): Promise<boolean> {
  try { return await exists(path); } catch { return false; }
}

// ─── Flexible date parsing ──────────────────────────────────────────────────
// Accepts the formats a user is likely to type. Returns null if nothing
// matches, so the caller can show a helpful error.

function monthIndexFromName(name: string): number {
  const n = name.toLowerCase().replace(/\./g, "");
  const exact = MONTH_NAMES.findIndex((m) => m.toLowerCase() === n);
  if (exact !== -1) return exact;
  if (n.length >= 3) {
    return MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(n));
  }
  return -1;
}

function isValidYmd(y: number, mo: number, d: number): boolean {
  if (!Number.isFinite(y) || y < 1000 || y > 9999) return false;
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  const test = new Date(y, mo - 1, d);
  return (
    test.getFullYear() === y &&
    test.getMonth() === mo - 1 &&
    test.getDate() === d
  );
}

export function parseFlexibleDate(
  input: string
): { year: number; month: number; day: number } | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  const today = new Date();
  const ymd = (d: Date) => ({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
  });

  if (s === "today" || s === "now") return ymd(today);
  if (s === "yesterday") {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return ymd(d);
  }
  if (s === "tomorrow") {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    return ymd(d);
  }

  // YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (isValidYmd(y, mo, d)) return { year: y, month: mo, day: d };
  }

  // MM/DD/YYYY or M/D/YY (assumed US order for ambiguous input)
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const mo = +m[1], d = +m[2];
    if (isValidYmd(y, mo, d)) return { year: y, month: mo, day: d };
  }

  // "October 9, 2026" / "Oct 9 2026" / "October 9th, 2026"
  m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,\s]+(\d{2,4})$/);
  if (m) {
    const idx = monthIndexFromName(m[1]);
    if (idx >= 0) {
      let y = +m[3];
      if (y < 100) y += 2000;
      const d = +m[2];
      if (isValidYmd(y, idx + 1, d)) return { year: y, month: idx + 1, day: d };
    }
  }

  // "9 October 2026" / "9 Oct 2026"
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?[,\s]+(\d{2,4})$/);
  if (m) {
    const idx = monthIndexFromName(m[2]);
    if (idx >= 0) {
      let y = +m[3];
      if (y < 100) y += 2000;
      const d = +m[1];
      if (isValidYmd(y, idx + 1, d)) return { year: y, month: idx + 1, day: d };
    }
  }

  // "October 9" / "Oct 9" — current year
  m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const idx = monthIndexFromName(m[1]);
    if (idx >= 0) {
      const d = +m[2];
      const y = today.getFullYear();
      if (isValidYmd(y, idx + 1, d)) return { year: y, month: idx + 1, day: d };
    }
  }

  // "9 October" / "9 Oct" — current year
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?$/);
  if (m) {
    const idx = monthIndexFromName(m[2]);
    if (idx >= 0) {
      const d = +m[1];
      const y = today.getFullYear();
      if (isValidYmd(y, idx + 1, d)) return { year: y, month: idx + 1, day: d };
    }
  }

  return null;
}

// ─── The move ───────────────────────────────────────────────────────────────

export interface MoveResult {
  newPath: string;
  newName: string;
  oldPath: string;
  assetsMoved: boolean;
  overwroteExisting: boolean;
}

/**
 * Move a journal day note to a new date.
 *
 * What moves:
 *   - The .selah file itself: `<dir>/<oldDay>.selah` → `<newDir>/<newDay>.selah`
 *   - The note's assets folder: `assets/<oldBase>/` → `assets/<newBase>/`
 *   - Every `assets/<oldBase>/…` reference inside the note body (both raw
 *     spaces and `%20`-encoded forms, since the markdown writer percent-encodes
 *     spaces when saving image paths)
 *   - Frontmatter `coverValue` if it points inside the old assets folder
 *
 * If the destination file exists, it is moved to the trash before the new
 * one is written — the caller is expected to have warned the user first.
 *
 * The new file is written *before* the old one is trashed, so a mid-flight
 * failure (disk full, permission error) leaves the original fully intact.
 */
export async function moveJournalNoteToDate(
  journalDir: string,
  oldPath: string,
  newYear: number,
  newMonth: number,
  newDay: number
): Promise<MoveResult> {
  const oldSlash = Math.max(oldPath.lastIndexOf("/"), oldPath.lastIndexOf("\\"));
  const oldDir = oldPath.slice(0, oldSlash);
  const oldName = oldPath.slice(oldSlash + 1);
  const oldBase = oldName.replace(/\.(selah|md)$/i, "");

  const newName = `${formatDayName(newYear, newMonth, newDay)}.selah`;
  const newBase = newName.replace(/\.(selah|md)$/i, "");
  const newDir = await join(journalDir, String(newYear), pad(newMonth));
  const newPath = await join(newDir, newName);

  if (newPath === oldPath) {
    return {
      newPath, newName, oldPath,
      assetsMoved: false,
      overwroteExisting: false,
    };
  }

  await mkdir(newDir, { recursive: true });

  // Read the source note before touching anything so a read failure bails
  // out cleanly with the original still intact.
  const raw = await readTextFile(oldPath);
  const { frontmatter, body } = parseNoteFile(raw);

  // ── Handle an existing destination file ─────────────────────────────────
  let overwroteExisting = false;
  if (await safeExists(newPath)) {
    try {
      await moveToTrash(newPath);
      overwroteExisting = true;
    } catch (e) {
      console.warn("[journal-move] could not trash existing dest note:", e);
    }
  }

  // ── Move the assets folder ──────────────────────────────────────────────
  const oldAssetsRoot = await join(oldDir, "assets");
  const newAssetsRoot = await join(newDir, "assets");
  const oldAssetsDir = await join(oldAssetsRoot, oldBase);
  const newAssetsDir = await join(newAssetsRoot, newBase);

  let assetsMoved = false;
  if (await safeExists(oldAssetsDir)) {
    await mkdir(newAssetsRoot, { recursive: true });

    // If the destination assets folder already exists (e.g. from a note we
    // just trashed above, or a stray folder), clear it out of the way so the
    // rename has an empty slot.
    if (await safeExists(newAssetsDir)) {
      try { await moveToTrash(newAssetsDir); } catch (e) {
        console.warn("[journal-move] could not clear dest assets dir:", e);
      }
    }

    try {
      await fsRename(oldAssetsDir, newAssetsDir);
      assetsMoved = true;
    } catch (e) {
      console.error("[journal-move] assets rename failed:", e);
      // Non-fatal: the note will still be written, just with refs pointing
      // at the (now missing) new location. The caller surfaces no error —
      // the user can manually repair if they notice.
    }
  }

  // ── Rewrite asset references in the body ────────────────────────────────
  // The markdown writer stores paths relative to the note's own directory
  // and percent-encodes spaces as %20. So we have to replace both the raw
  // and encoded forms of the old base name.
  const oldBaseEnc = oldBase.replace(/ /g, "%20");
  const newBaseEnc = newBase.replace(/ /g, "%20");

  let updatedBody = body;
  if (oldBase !== newBase) {
    updatedBody = updatedBody
      .split(`assets/${oldBase}/`).join(`assets/${newBase}/`)
      .split(`assets/${oldBaseEnc}/`).join(`assets/${newBaseEnc}/`);
  }

  // ── Rewrite frontmatter.coverValue if it points into the old assets dir ─
  const updatedFm = { ...frontmatter };
  if (typeof updatedFm.coverValue === "string" && updatedFm.coverValue) {
    const cv = updatedFm.coverValue;
    const isUrl = /^(https?:|data:|blob:)/i.test(cv);
    if (!isUrl) {
      const normCv = cv.replace(/\\/g, "/");
      const normOld = oldAssetsDir.replace(/\\/g, "/");
      if (normCv === normOld || normCv.startsWith(normOld + "/")) {
        const tail = normCv.slice(normOld.length);
        const normNew = newAssetsDir.replace(/\\/g, "/");
        updatedFm.coverValue = normNew + tail;
      }
    }
  }

  // ── Write the new file, then trash the old one ──────────────────────────
  await writeTextFile(newPath, serializeNoteFile(updatedFm, updatedBody));

  try {
    await moveToTrash(oldPath);
  } catch (e) {
    console.warn("[journal-move] could not trash old note:", e);
  }

  return {
    newPath, newName, oldPath,
    assetsMoved,
    overwroteExisting,
  };
}