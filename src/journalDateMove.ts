// src/journalDateMove.ts
import {
  readTextFile, mkdir, exists, readDir, copyFile,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { parseNoteFile, serializeNoteFile } from "./noteFormat";
import { moveToTrash } from "./trash";
import { writeFileAtomic } from "./safeWrite";

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

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readDir(src);
  for (const e of entries) {
    if (!e.name) continue;
    const s = await join(src, e.name);
    const d = await join(dst, e.name);
    if (e.isDirectory) {
      await copyDirRecursive(s, d);
    } else {
      await copyFile(s, d);
    }
  }
}

// ─── Flexible date parsing ──────────────────────────────────────────────────

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

  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (isValidYmd(y, mo, d)) return { year: y, month: mo, day: d };
  }

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    const mo = +m[1], d = +m[2];
    if (isValidYmd(y, mo, d)) return { year: y, month: mo, day: d };
  }

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

  m = s.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const idx = monthIndexFromName(m[1]);
    if (idx >= 0) {
      const d = +m[2];
      const y = today.getFullYear();
      if (isValidYmd(y, idx + 1, d)) return { year: y, month: idx + 1, day: d };
    }
  }

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

  const raw = await readTextFile(oldPath);
  const { frontmatter, body } = parseNoteFile(raw);

  // ── Compute the updated body and frontmatter IN MEMORY first ─────────
  const oldBaseEnc = oldBase.replace(/ /g, "%20");
  const newBaseEnc = newBase.replace(/ /g, "%20");

  let updatedBody = body;
  if (oldBase !== newBase) {
    updatedBody = updatedBody
      .split(`assets/${oldBase}/`).join(`assets/${newBase}/`)
      .split(`assets/${oldBaseEnc}/`).join(`assets/${newBaseEnc}/`);
  }

  const oldAssetsRoot = await join(oldDir, "assets");
  const newAssetsRoot = await join(newDir, "assets");
  const oldAssetsDir = await join(oldAssetsRoot, oldBase);
  const newAssetsDir = await join(newAssetsRoot, newBase);

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

  // ── Handle a pre-existing destination file ───────────────────────────
  let overwroteExisting = false;
  if (await safeExists(newPath)) {
    try {
      await moveToTrash(newPath);
      overwroteExisting = true;
    } catch (e) {
      console.warn("[journal-move] could not trash existing dest note:", e);
    }
  }

  // ── 1. COPY the assets folder into place ─────────────────────────────
  // Copy, not move: the source note must remain fully functional until
  // every subsequent step has succeeded.
  let assetsMoved = false;
  const oldAssetsExists = await safeExists(oldAssetsDir);
  if (oldAssetsExists) {
    try {
      await mkdir(newAssetsRoot, { recursive: true });
      if (await safeExists(newAssetsDir)) {
        try { await moveToTrash(newAssetsDir); } catch (e) {
          console.warn("[journal-move] could not clear dest assets dir:", e);
        }
      }
      await copyDirRecursive(oldAssetsDir, newAssetsDir);
      assetsMoved = true;
    } catch (e) {
      console.error("[journal-move] assets copy failed:", e);
    }
  }

  // ── 2. Write the new note file (atomic) ──────────────────────────────
  await writeFileAtomic(newPath, serializeNoteFile(updatedFm, updatedBody));

  // ── 3. Trash the old note file ───────────────────────────────────────
  try {
    await moveToTrash(oldPath);
  } catch (e) {
    console.warn("[journal-move] could not trash old note:", e);
  }

  // ── 4. Trash the old assets folder, now that the new note is safe ────
  if (oldAssetsExists) {
    try {
      await moveToTrash(oldAssetsDir);
    } catch (e) {
      console.warn("[journal-move] could not trash old assets dir:", e);
    }
  }

  return {
    newPath, newName, oldPath,
    assetsMoved,
    overwroteExisting,
  };
}