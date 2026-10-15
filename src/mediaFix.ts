// src/mediaFix.ts
import {
  readDir, readTextFile, exists, mkdir, rename, writeFile, readFile, remove,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { parseNoteFile, serializeNoteFile, type Frontmatter } from "./noteFormat";
import { writeFileAtomic } from "./safeWrite";
import { moveToTrash } from "./trash";
import { flushAll } from "./flushRegistry";
import {
  PROXY_DIR, dirname, basename,
  type BrokenRef, type UnusedFile, type OldLayoutFolder,
  type MissingProxiesForNote, type MissingThumbForNote, type ProxiesOffNote,
} from "./mediaVault";
import { assetUrlToAbsolutePath, encodeImageToWebP, writeThumb } from "./imageAssets";
import { convertFileSrc } from "@tauri-apps/api/core";

/** Tell any open editor showing this note that its file was rewritten on
 *  disk, so it reloads instead of holding (and re-saving) stale URLs. */
function notifyRewritten(path: string) {
  try {
    window.dispatchEvent(new CustomEvent("note-rewritten", { detail: { path } }));
    window.dispatchEvent(new CustomEvent("file-changed", { detail: { path } }));
  } catch {}
}

async function ensureDir(p: string) {
  try { await mkdir(p, { recursive: true }); } catch {}
}

/** Rewrite one asset path inside a note body (and frontmatter cover). */
async function replaceRefInNote(
  notePath: string,
  oldRef: string,
  newRef: string,
): Promise<boolean> {
  if (oldRef === newRef) return false;
  let raw: string;
  try { raw = await readTextFile(notePath); } catch { return false; }
  const { frontmatter, body } = parseNoteFile(raw);

  const escaped = oldRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + `(?![a-zA-Z0-9._-])`, "g");
  const next = body.replace(re, newRef);

  let fmChanged = false;
  if (frontmatter.coverValue === oldRef) {
    frontmatter.coverValue = newRef;
    fmChanged = true;
  }

  if (next === body && !fmChanged) return false;
  await writeFileAtomic(notePath, serializeNoteFile(frontmatter, next));
  notifyRewritten(notePath);
  return true;
}

export async function fixBrokenRef(item: BrokenRef): Promise<boolean> {
  const { notePath, raw, absPath, fix } = item;
  if (fix.kind === "unfixable") return false;

  // Downgrade: no file operation at all — just rewrite the note's
  // reference back to the original. This is what we do when the proxy
  // is gone and the original survives: the note starts working again
  // immediately with the full-size file.
  if (fix.kind === "downgrade") {
    const noteDir = dirname(notePath);
    const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
    const normOrig = fix.original.replace(/\\/g, "/");
    const rel = normOrig.startsWith(normNote + "/")
      ? normOrig.slice(normNote.length + 1)
      : normOrig;
    await replaceRefInNote(notePath, raw, rel);
    return true;
  }

  if (fix.kind === "move") {
    await ensureDir(dirname(fix.to));
    try {
      if (!(await exists(fix.to))) await rename(fix.from, fix.to);
    } catch (e) {
      console.warn("[mediaFix] move failed:", fix.from, "→", fix.to, e);
      return false;
    }
  } else {
    // regenerate: from fix.source, encode a .webp (or .webm stays put —
    // we don't re-encode video proxies here; only images).
    if (basename(absPath).endsWith(".webp")) {
      const bytes = await encodeImageToWebP(fix.source);
      if (!bytes) return false;
      await ensureDir(dirname(absPath));
      try { await writeFile(absPath, bytes); }
      catch (e) { console.warn("[mediaFix] regenerate failed:", e); return false; }
    } else {
      return false;
    }
  }

  // If the note's ref raw form doesn't equal the on-disk path we just
  // created, rewrite it. Compute the canonical relative path.
  const noteDir = dirname(notePath);
  const relSep = noteDir.includes("\\") ? "\\" : "/";
  const canonicalAbs = fix.kind === "move" ? fix.to : absPath;
  const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const normAbs = canonicalAbs.replace(/\\/g, "/");
  const canonicalRel = normAbs.startsWith(normNote + "/")
    ? normAbs.slice(normNote.length + 1)
    : normAbs;

  await replaceRefInNote(notePath, raw, canonicalRel);
  return true;
}

/**
 * Batch-repair every broken ref in one note in a single read-modify-write
 * cycle.
 *
 * Doing them one at a time was fine until the note was open in the editor:
 * each write fires `note-rewritten`, the editor remounts, its unmount
 * flush lands in the middle of our next read, and we write back a body
 * that doesn't contain the fix we just applied. Batching removes the
 * window — one write per note, one remount, one flush, no lost edits.
 */
export async function fixAllBrokenRefsForNote(
  notePath: string,
  refs: BrokenRef[],
): Promise<{ applied: number; skipped: number }> {
  const encSeg = (seg: string) =>
  seg
  .replace(/%/g, "%25")
  .replace(/ /g, "%20")
  .replace(/#/g, "%23")
  .replace(/\?/g, "%3F")
  .replace(/\(/g, "%28")
  .replace(/\)/g, "%29");
  const encRel = (rel: string) => rel.split("/").map(encSeg).join("/");

  const noteDir = dirname(notePath);
  const normNote = noteDir.replace(/\\/g, "/").replace(/\/+$/, "");

  const rewrites: Array<{ from: string; to: string }> = [];
  let skipped = 0;

  // ── Phase 1: filesystem work + compute the new ref strings ─────────
  for (const ref of refs) {
    const fix = ref.fix;
    if (fix.kind === "unfixable") { skipped++; continue; }

    if (fix.kind === "move") {
      await ensureDir(dirname(fix.to));
      try {
        if (!(await exists(fix.to))) await rename(fix.from, fix.to);
      } catch (e) {
        console.warn("[mediaFix] move failed:", fix.from, "→", fix.to, e);
        skipped++;
        continue;
      }
      // The ref itself doesn't need rewriting — the file moved to where
      // the ref already said it should be.
      continue;
    }

    if (fix.kind === "regenerate") {
      if (!basename(ref.absPath).endsWith(".webp")) { skipped++; continue; }
      const bytes = await encodeImageToWebP(fix.source);
      if (!bytes) { skipped++; continue; }
      await ensureDir(dirname(ref.absPath));
      try { await writeFile(ref.absPath, bytes); }
      catch (e) {
        console.warn("[mediaFix] regenerate failed:", e);
        skipped++;
        continue;
      }
      // Ref stays where it is.
      continue;
    }

    // Downgrade: no filesystem change, just rewrite the ref back to
    // the surviving original.
    const normNew = fix.original.replace(/\\/g, "/");
    const rel = normNew.startsWith(normNote + "/")
    ? normNew.slice(normNote.length + 1)
    : normNew;
    rewrites.push({ from: ref.raw, to: encRel(rel) });
  }

  if (rewrites.length === 0) return { applied: 0, skipped };

  // ── Phase 2: ONE read, all replacements in memory, ONE write ────────

  // Silence any NoteBody currently mounted for this note. Its unmount
  // flush runs on the `note-rewritten` we fire at the bottom of this
  // function, and without this the flush races our write and rewrites
  // the pre-fix body straight back to disk. `note-deleted` sets the
  // NoteBody's `disposedRef`, which makes its flush a no-op.
  try {
    window.dispatchEvent(
      new CustomEvent("note-deleted", { detail: { path: notePath } }),
    );
  } catch {}

  let raw: string;
  try { raw = await readTextFile(notePath); }
  catch { notifyRewritten(notePath); return { applied: 0, skipped }; }
  const { frontmatter, body } = parseNoteFile(raw);

  let next = body;
  let applied = 0;
  for (const r of rewrites) {
    if (r.from === r.to) { skipped++; continue; }

    // Try the exact raw form first (what the audit captured).
    const esc = r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(esc + `(?![a-zA-Z0-9._-])`, "g");
    const before = next;
    next = next.replace(re, r.to);
    if (next !== before) { applied++; continue; }

    // Fallback: the note may have been rewritten in a different encoding
    // pass (decoded vs. encoded). Try the decoded form too.
    let decoded: string;
    try { decoded = decodeURIComponent(r.from); } catch { decoded = r.from; }
    if (decoded === r.from) {
      console.warn("[mediaFix] ref not found in body:", r.from.slice(0, 120));
      skipped++;
      continue;
    }
    const escD = decoded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reD = new RegExp(escD + `(?![a-zA-Z0-9._-])`, "g");
    const beforeD = next;
    next = next.replace(reD, r.to);
    if (next !== beforeD) applied++;
    else {
      console.warn("[mediaFix] ref not found in body:", r.from.slice(0, 120));
      skipped++;
    }
  }

  // Cover value — single ref, check once.
  let fmChanged = false;
  if (typeof frontmatter.coverValue === "string" && frontmatter.coverValue) {
    for (const r of rewrites) {
      if (frontmatter.coverValue === r.from) {
        frontmatter.coverValue = r.to;
        fmChanged = true;
        break;
      }
    }
  }

  if (next === body && !fmChanged) { notifyRewritten(notePath); return { applied: 0, skipped }; }

  await writeFileAtomic(notePath, serializeNoteFile(frontmatter, next));
  notifyRewritten(notePath);
  return { applied, skipped };
}

/** Regenerate the missing 640px thumbnails for a note's images. */
export async function buildThumbsForNote(
  item: MissingThumbForNote,
): Promise<{ generated: number; failed: number }> {
  let generated = 0;
  let failed = 0;
  for (const src of item.sources) {
    // `writeThumb` returns false on encode failure (e.g. undecodable
    // source), true if the file was written or already existed.
    const ok = await writeThumb(src.sourceAbs, item.assetsDir, src.name);
    if (ok) generated++;
    else failed++;
  }
  window.dispatchEvent(new Event("thumbs-changed"));
  return { generated, failed };
}

export async function deleteUnusedFile(item: UnusedFile): Promise<boolean> {
  try {
    if (await exists(item.absPath)) await moveToTrash(item.absPath);
    return true;
  } catch (e) {
    console.warn("[mediaFix] trash failed:", item.absPath, e);
    return false;
  }
}

export async function keepUnusedFile(item: UnusedFile): Promise<boolean> {
  const assetsDir = dirname(item.absPath);
  const baseDir = item.inProxy ? dirname(assetsDir) : assetsDir;
  const keepPath = await join(baseDir, "keep.json");
  const name = basename(item.absPath);

  let list: string[] = [];
  try {
    const raw = await readTextFile(keepPath);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed.filter((x) => typeof x === "string");
  } catch {}
  if (!list.includes(name)) list.push(name);
  try {
    await writeFile(keepPath, JSON.stringify(list, null, 2));
    return true;
  } catch (e) {
    console.warn("[mediaFix] keep failed:", e);
    return false;
  }
}

/** Move every file out of an old-layout subfolder into the flat/proxy
 *  layout, then rewrite the note's refs to match. */
export async function fixOldLayout(folder: OldLayoutFolder): Promise<number> {
  const { absPath: assetsDir, notePath, noteBase, subfolders } = folder;
  const proxyDir = await join(assetsDir, PROXY_DIR);
  await ensureDir(proxyDir);
  let moved = 0;

  for (const sub of subfolders) {
    const subDir = await join(assetsDir, sub);
    let entries: any[] = [];
    try { entries = await readDir(subDir); } catch { continue; }
    for (const e of entries) {
      if (!e.name || e.isDirectory) continue;
      const src = await join(subDir, e.name);
      const isProxyFile = e.name.endsWith(".webp") || e.name.endsWith(".webm");
      const target = isProxyFile
        ? await join(proxyDir, e.name)
        : await join(assetsDir, e.name);
      try {
        if (await exists(target)) {
          await moveToTrash(src);
        } else {
          await rename(src, target);
        }
        moved++;
      } catch (err) {
        console.warn("[mediaFix] move failed:", src, "→", target, err);
      }
    }
    try { await remove(subDir); } catch {}
  }

  // Rewrite refs in the note: strip old prefixes and redirect proxies.
  let raw: string;
  try { raw = await readTextFile(notePath); } catch { return moved; }
  const { frontmatter, body } = parseNoteFile(raw);

  const baseEsc = noteBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const baseEncEsc = noteBase.replace(/ /g, "%20")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const re = new RegExp(
    `assets/(${baseEsc}|${baseEncEsc})/(originals|previews|proxy videos)/([^"'&\\s)\\\\]+)`,
    "g",
  );
  const next = body.replace(re, (_m, base, sub, file) => {
    const isProxyFile =
      sub === "previews" || file.endsWith(".webp") || file.endsWith(".webm");
    return isProxyFile
      ? `assets/${base}/${PROXY_DIR}/${file}`
      : `assets/${base}/${file}`;
  });

  if (typeof frontmatter.coverValue === "string") {
    const cv = frontmatter.coverValue;
    const cvRe = new RegExp(
      `^assets/(${baseEsc}|${baseEncEsc})/(originals|previews|proxy videos)/(.+)$`,
    );
    frontmatter.coverValue = cv.replace(cvRe, (_m, base, sub, file) => {
      const isProxyFile =
        sub === "previews" || file.endsWith(".webp") || file.endsWith(".webm");
      return isProxyFile
        ? `assets/${base}/${PROXY_DIR}/${file}`
        : `assets/${base}/${file}`;
    });
  }

  if (next !== body || frontmatter.coverValue !== parseNoteFile(raw).frontmatter.coverValue) {
    await writeFileAtomic(notePath, serializeNoteFile(frontmatter, next));
  notifyRewritten(notePath);
  }
  return moved;
}

// ── Proxy generation ────────────────────────────────────────────────────

const SRC_SEP = "\u001E"; // must match DmArchive

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
function splitWidthSuffix(url: string): [string, string] {
  const m = url.match(/[?&]w=\d+$/);
  if (!m) return [url, ""];
  return [url.slice(0, -m[0].length), m[0]];
}

/** Generate proxies for a note's images and rewrite the note to point at them. */
export async function buildProxiesForNote(
  item: MissingProxiesForNote,
  onLog?: (msg: string) => void,
): Promise<{ generated: number; rewritten: boolean }> {
  const { notePath, noteBase, assetsDir, sources } = item;
  await flushAll();

  // 1. Generate proxies
  const proxyDir = await join(assetsDir, PROXY_DIR);
  await ensureDir(proxyDir);

  const generatedNames: string[] = [];  // newly encoded proxies
  const rewriteNames: string[] = [];    // originals the note should stop loading
  for (const src of sources) {
    const srcPath = await join(assetsDir, src.name);
    onLog?.(`Generating proxies… ${sources.indexOf(src) + 1} of ${sources.length}`);
    let proxyOk = src.hasProxy;

    if (!proxyOk) {
      const bytes = await encodeImageToWebP(srcPath);
      if (bytes) {
        try {
          await writeFile(await join(proxyDir, `${src.name}.webp`), bytes);
          generatedNames.push(src.name);
          proxyOk = true;
        } catch (e) {
          console.warn("[mediaFix] proxy write failed:", src.name, e);
        }
      }
    }

    // Small thumbnail for gallery / timeline cells.
    if (!src.hasThumb) {
      const thumbSrc = src.originalMissing
        ? await join(proxyDir, `${src.name}.webp`)
        : srcPath;
      await writeThumb(thumbSrc, assetsDir, src.name);
    }

    if (proxyOk && src.refsOriginal) rewriteNames.push(src.name);
  }

  if (rewriteNames.length === 0) {
    return { generated: generatedNames.length, rewritten: false };
  }

  // 2. Rewrite references in the note
  onLog?.("Replacing references in the note…");
  // Tell the open editor to stand down so it can't write its old copy back.
  try { window.dispatchEvent(new CustomEvent("note-deleted", { detail: { path: notePath } })); } catch {}
  const rewritten = await rewriteNoteRefsToProxy(
    notePath,
    noteBase,
    rewriteNames,
  );

  // Always reload the editor afterward so it picks the new file up and can save again.
  notifyRewritten(notePath);
  return { generated: generatedNames.length, rewritten };
}

/** Apply `rewriteUrl` to every image reference form a note can contain. */
function applyUrlRewrite(
  body: string,
  frontmatter: Frontmatter,
  rewriteUrl: (u: string) => string,
): { next: string; changed: boolean } {
  // Unwrap the attribute escaping so callers see the URL the way the
  // user typed it, and re-wrap on the way out so the written body still
  // matches what the on-disk file format expects.
  const unescapeBody = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
  const escapeBody = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
  let next = body;
  let changed = false;

  // Markdown images: ![alt](url). Balanced-paren body, because convertFileSrc
  // leaves literal "(" ")" in URLs (e.g. a vault folder `thólos (copy)`).
  next = next.replace(/!\[([^\]]*)\]\(((?:[^()]|\([^)]*\))+)\)/g, (match, alt, url) => {
    const [cleanUrl, suffix] = splitWidthSuffix(url);
    const r = rewriteUrl(unescapeBody(cleanUrl));
    if (r === unescapeBody(cleanUrl)) return match;
    changed = true;
    return `![${alt}](${escapeBody(r)}${suffix})`;
  });

  // HTML images: <img src="…">
  next = next.replace(/<img\b([^>]*?)\bsrc="([^"]+)"/g, (_m, pre, url) => {
    const r = rewriteUrl(unescapeBody(url));
    if (r === unescapeBody(url)) return _m;
    changed = true;
    return `<img${pre}src="${escapeBody(r)}"`;
  });

  // imagegallery grids
  next = next.replace(
    /(::: imagegallery\b[^\n]*?\bgrid=")([^"]*)(")/g,
                      (_m, pre, gridRaw, post) => {
                        let grid: any;
                        try { grid = JSON.parse(unescapeGridAttr(gridRaw)); } catch { return pre + gridRaw + post; }
                        if (!Array.isArray(grid)) return pre + gridRaw + post;
                        let local = false;
                        const mapped = grid.map((row: any) =>
                        Array.isArray(row)
                        ? row.map((cell: any) => {
                          if (!cell || typeof cell.src !== "string") return cell;
                          const r = rewriteUrl(cell.src);
                          if (r === cell.src) return cell;
                          local = true;
                          return { ...cell, src: r };
                        })
                        : row
                        );
                        if (!local) return pre + gridRaw + post;
                        changed = true;
                        return pre + escapeGridAttr(JSON.stringify(mapped)) + post;
                      }
  );

  // dmarchive srcs — Unit-Separator-joined list
  next = next.replace(
    /(::: dmarchive\b[^\n]*?\bsrcs=")([^"]*)(")/g,
                      (_m, pre, srcsRaw, post) => {
                        const parts = srcsRaw.split(SRC_SEP);
                        let local = false;
                        const mapped = parts.map((s: string) => {
                          if (!s) return s;
                          const r = rewriteUrl(s);
                          if (r === s) return s;
                          local = true;
                          return r;
                        });
                        if (!local) return pre + srcsRaw + post;
                        changed = true;
                        return pre + mapped.join(SRC_SEP) + post;
                      }
  );

  // frontmatter cover
  if (typeof frontmatter.coverValue === "string" && frontmatter.coverValue) {
    const r = rewriteUrl(frontmatter.coverValue);
    if (r !== frontmatter.coverValue) {
      frontmatter.coverValue = r;
      changed = true;
    }
  }
  return { next, changed };
}

async function rewriteNoteRefsToProxy(
  notePath: string,
  noteBase: string,
  sourceNames: string[],
): Promise<boolean> {
  let raw: string;
  try { raw = await readTextFile(notePath); } catch { return false; }
  const { frontmatter, body } = parseNoteFile(raw);

  const baseForms = new Set([
    noteBase,
    noteBase.replace(/ /g, "%20"),
  ]);

  let matchCount = 0;
  const rewriteUrl = (url: string): string => {
    if (!url) return url;

    // asset:// URL — decode, check suffix, rebuild.
    const abs = assetUrlToAbsolutePath(url);
    if (abs) {
      for (const sourceName of sourceNames) {
        const sep = abs.includes("\\") ? "\\" : "/";
        if (abs.endsWith(`${sep}${sourceName}`)) {
          const parent = abs.slice(0, abs.length - sourceName.length - 1);
          const newAbs = `${parent}${sep}${PROXY_DIR}${sep}${sourceName}.webp`;
          try { return convertFileSrc(newAbs); } catch { return url; }
        }
      }
      return url;
    }

    // Relative path — must exactly match `assets/<base>/<source>`.
    for (const sourceName of sourceNames) {
      for (const base of baseForms) {
        const sourceEnc = sourceName.replace(/ /g, "%20");
        const prefix = `assets/${base}/`;
        if (url === `${prefix}${sourceName}` || url === `${prefix}${sourceEnc}`) {
          matchCount++;
          const suffix = url.slice(prefix.length);
          return `${prefix}proxy/${suffix}.webp`;
        }
      }
    }
    return url;
  };

  const { next, changed } = applyUrlRewrite(body, frontmatter, rewriteUrl);

  console.log("[mediaFix] rewrite end", {
    notePath,
    changed,
    matchCount,
    bodyLengthBefore: body.length,
    bodyLengthAfter: next.length,
  });

  if (!changed) return false;
  await writeFileAtomic(notePath, serializeNoteFile(frontmatter, next));
  notifyRewritten(notePath);
  console.log("[mediaFix] rewrite written", notePath);
  return true;
}

// ── Turn proxies OFF for a note: point refs back at originals, drop copies ─

function safeDecodeLocal(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

async function rewriteNoteRefsToOriginals(
  notePath: string,
  originals: Set<string>,
): Promise<boolean> {
  let raw: string;
  try { raw = await readTextFile(notePath); } catch { return false; }
  const { frontmatter, body } = parseNoteFile(raw);

  const rewriteUrl = (url: string): string => {
    if (!url) return url;
    const abs = assetUrlToAbsolutePath(url);
    if (abs) {
      const norm = abs.replace(/\\/g, "/");
      const m = norm.match(/^(.*)\/proxy\/([^/]+)\.webp$/);
      if (m && originals.has(m[2])) {
        try { return convertFileSrc(`${m[1]}/${m[2]}`); } catch { return url; }
      }
      return url;
    }
    const m = url.match(/^(assets\/[^/]+\/)proxy\/(.+)\.webp$/);
    if (m && originals.has(safeDecodeLocal(m[2]))) return `${m[1]}${m[2]}`;
    return url;
  };

  const { next, changed } = applyUrlRewrite(body, frontmatter, rewriteUrl);
  if (!changed) return false;
  await writeFileAtomic(notePath, serializeNoteFile(frontmatter, next));
  notifyRewritten(notePath);
  return true;
}

/** Re-point the note at its original photos, then trash its WebP proxies and
 *  thumbnails (only ones whose original exists and that nothing references). */
export async function removeProxiesForNote(
  item: ProxiesOffNote,
  onLog?: (msg: string) => void,
): Promise<{ removed: number; rewritten: boolean }> {
  const { notePath, assetsDir } = item;
  await flushAll();

  const originals = new Set<string>();
  try {
    for (const e of await readDir(assetsDir)) {
      if (!e.isDirectory && e.name) originals.add(e.name);
    }
  } catch {}

  onLog?.("Pointing the note back at your original photos…");
  try { window.dispatchEvent(new CustomEvent("note-deleted", { detail: { path: notePath } })); } catch {}
  const rewritten = await rewriteNoteRefsToOriginals(notePath, originals);

  // Safety: never trash a proxy the note still mentions in any form.
  let hay = "";
  try { const r = await readTextFile(notePath); hay = r + "\n" + safeDecodeLocal(r); } catch {}

  let removed = 0;
  const proxyDir = await join(assetsDir, PROXY_DIR);
  const thumbDir = await join(proxyDir, "thumb");

  const sweep = async (dir: string, checkNote: boolean) => {
    let entries: any[] = [];
    try { entries = await readDir(dir); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory || !e.name || !/\.webp$/i.test(e.name)) continue;
      if (!originals.has(e.name.slice(0, -5))) continue;
      if (checkNote && hay.includes(e.name)) continue;
      try { await moveToTrash(await join(dir, e.name)); removed++; }
      catch (err) { console.warn("[mediaFix] trash failed:", e.name, err); }
    }
  };
  onLog?.("Removing proxy files…");
  await sweep(proxyDir, true);
  await sweep(thumbDir, false);
  try { await remove(thumbDir); } catch {}   // only succeeds if empty

  notifyRewritten(notePath);
  return { removed, rewritten };
}
