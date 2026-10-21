// src/mediaVault.ts
import { readDir, readTextFile, exists, stat } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { parseNoteFile } from "./noteFormat";
import { proxyFeatureEnabled } from "./proxyFeature";

export const PROXY_DIR = "proxy";
export const KEEP_FILE = "keep.json";
export const THUMB_DIR = "thumb"; // proxy/thumb/<name>.webp, 640px
const OLD_LAYOUT_DIRS = ["originals", "previews", "proxy videos"];
const IMAGE_CONVERTIBLE_RE = /\.(png|jpe?g|avif|bmp|tiff?)$/i;

export interface BrokenRef {
  notePath: string;
  noteBase: string;
  raw: string;
  absPath: string;
  fix:
    | { kind: "move"; from: string; to: string }
    | { kind: "regenerate"; source: string }
    | { kind: "downgrade"; original: string }
    | { kind: "unfixable" };
}

export interface UnusedFile {
  absPath: string;
  notePath: string;
  size: number;
  inProxy: boolean;
  /** An original photo whose WebP proxy is what the note actually uses. */
  hasProxyCopy?: boolean;
}

export interface OldLayoutFolder {
  absPath: string;
  notePath: string;
  noteBase: string;
  subfolders: string[];
}

export interface MissingProxiesForNote {
  notePath: string;
  noteBase: string;
  assetsDir: string;
  /** hasProxy=true means the .webp already exists but the note still
   *  points at the full-size original, so only a rewrite is needed. */
  sources: {
    name: string;
    size: number;
    hasProxy: boolean;
    hasThumb: boolean;
    /** original was trashed; build the thumbnail from the proxy instead */
    originalMissing?: boolean;
    /** the note still loads the full-size original somewhere */
    refsOriginal: boolean;
  }[];
}

export interface ImageStats {
  /** Convertible images (png/jpg/avif/bmp/tiff) that a note actually uses. */
  total: number;
  /** Of those, how many the note already loads via the WebP proxy. */
  optimized: number;
  /** images that have a 640px thumbnail for gallery/timeline cells */
  withThumb: number;
  originalBytes: number;
  proxyBytes: number;
}

/** A note whose images are referenced but whose 640px thumbnail is missing
 *  on disk. Every gallery tile / timeline card that loads one of these
 *  images fires a 404 in the console until the thumbnail is regenerated. */
export interface MissingThumbForNote {
  notePath: string;
  noteBase: string;
  assetsDir: string;
  sources: {
    /** Original image filename (e.g. `pasted-1791887787328.png`). */
    name: string;
    /** Path to encode the thumbnail from: the original if it's still on
     *  disk, otherwise the note's WebP proxy. */
    sourceAbs: string;
  }[];
}

/** A note with proxies switched OFF that still has proxy/thumb files. */
export interface ProxiesOffNote {
  notePath: string;
  noteBase: string;
  assetsDir: string;
  files: number;
  bytes: number;
}

export interface VaultReport {
  totalNotes: number;
  totalAssets: number;
  totalBytes: number;
  brokenRefs: BrokenRef[];
  unusedFiles: UnusedFile[];
  oldLayout: OldLayoutFolder[];
  missingProxies: MissingProxiesForNote[];
  missingThumbs: MissingThumbForNote[];
  imageStats: ImageStats;
  proxiesOff: ProxiesOffNote[];
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.substring(0, i);
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.substring(i + 1);
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function refToAbs(ref: string, noteDir: string): string {
  if (!ref) return "";
  if (/^([a-zA-Z]:[\\/]|\/)/.test(ref)) return ref;

  // asset://localhost/<encoded-abs>  — Tauri's convertFileSrc output,
  // which is what the note actually contains for captioned images.
  const assetMatch = ref.match(/^asset:\/\/(?:localhost\/)?(.+)$/);
  if (assetMatch) {
    try { return decodeURIComponent(assetMatch[1]); } catch { return assetMatch[1]; }
  }

  const decoded = safeDecode(ref.replace(/^<|>$/g, ""));
  const sep = noteDir.includes("\\") ? "\\" : "/";
  return noteDir.replace(/[\\/]+$/, "") + sep + decoded;
}

/** Extract every asset reference in a note body + frontmatter. */
function extractRefs(body: string, fm: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  let m: RegExpExecArray | null;

  // Balanced-paren markdown image matcher.
  //
  // Tauri's convertFileSrc() uses encodeURIComponent, which does NOT escape
  // "(" or ")". A vault folder like `thólos (copy)` therefore puts a literal
  // "(copy)" inside the URL. The URL body must be a run of "non-paren chars
  // OR one balanced (...) group". The old `[^)]+` first piece consumed the
  // "(" of "(copy)", then took the ")" as the end of the markdown image,
  // yielding the truncated `...th%C3%B3los%20(copy` "broken reference".
  const mdRe = /!\[[^\]]*\]\(((?:[^()]|\([^)]*\))+)\)/g;
  while ((m = mdRe.exec(body)) !== null) refs.add(m[1]);

  // BlockNote serializes any image with a caption as raw HTML:
  //   <figure><img src="asset://localhost/..."><figcaption>…</figcaption></figure>
  // The URL lives in an HTML attribute, invisible to the markdown regex
  // above. Without this, every captioned image looked unused.
  const htmlImgRe = /<img\b[^>]*\bsrc="([^"]+)"/g;
  while ((m = htmlImgRe.exec(body)) !== null) {
    const src = m[1].trim();
    if (src) refs.add(src);
  }

  // IMPORTANT: the URLs stored inside a grid are HTML-escaped only at the
  // attribute boundaries (`&quot;`), never inside the URL itself — so
  // `&quot;src&quot;:&quot;assets/foo.png&quot;` decodes to `assets/foo.png`
  // exactly as it appears in the body. We decode ONLY the attribute
  // escaping here, not the URL. Using the decoded form as a search key
  // would fail to match against the note body later.
  const gridRe = /::: imagegallery[^\n]*?\bgrid="([^"]*)"/g;
  while ((m = gridRe.exec(body)) !== null) {
    try {
      // Decode attribute escaping so JSON.parse can see real quotes.
      const decoded = m[1]
        .replace(/&quot;/g, '"').replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
      const grid = JSON.parse(decoded);
      if (Array.isArray(grid)) for (const row of grid) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (!cell?.src) continue;
          // Re-encode any characters that `escAttr` would have escaped
          // when this grid was written, so the string we hand back is
          // byte-identical to what lives in the note body.
          const inBody = String(cell.src)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/\n/g, "&#10;");
          refs.add(inBody);
        }
      }
    } catch {}
  }

  const dmRe = /::: dmarchive[^\n]*?\bsrcs="([^"]*)"/g;
  while ((m = dmRe.exec(body)) !== null) {
    const raw = m[1]
      .replace(/&quot;/g, '"').replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
    for (const s of raw.split("\u001E")) if (s) refs.add(s);
  }

  const vidRe = /::: video[^\n]*?\bsrc="([^"]*)"/g;
  while ((m = vidRe.exec(body)) !== null) {
    const raw = m[1]
      .replace(/&quot;/g, '"').replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
    if (raw) refs.add(raw);
  }

  const cv = fm.coverValue;
  if (typeof cv === "string" && cv && !/^(https?:|data:|blob:)/i.test(cv)) {
    refs.add(cv);
  }

  // Catch-all: scan the raw body for every asset:// URL, regardless of
  // what structure it lives in. The targeted regexes above are all
  // "delimited URL" matchers, and any of them can fail when the URL
  // itself contains characters that also appear in the delimiters — the
  // most common case being a folder name with raw parens, like
  // `thólos (copy)`, which makes the markdown-image regex `\(([^)]+)\)`
  // stop at the first `)` and capture a truncated URL. This fallback
  // matches `%XX` sequences and any other non-whitespace / non-quote
  // character, so those URLs get picked up whole.
  // Balanced-paren URL matcher.
  //
  // The previous character class `[^\s"'<>`\\]` did NOT exclude `)`, so
  // when this ran over a markdown image like `![alt](asset://…)` it kept
  // matching past the closing `)` of the markdown syntax and captured a
  // URL with a stray trailing `)`. That decoded to a non-existent path and
  // showed up as "broken reference / cannot fix".
  //
  // Parens are balanced inside the alternation now: `(` and `)` alone are
  // excluded, but `\([^)]*\)` matches a whole balanced group in one step.
  // That covers `thólos (copy)` (one balanced pair mid-URL) without
  // swallowing the markdown image's closing paren.
  const assetUrlRe = /asset:\/\/(?:localhost\/)?(?:%[0-9A-Fa-f]{2}|[^\s"'<>`\\()]|\([^)]*\))+/g;
  while ((m = assetUrlRe.exec(body)) !== null) {
    const u = m[0];
    if (u.length > 20) refs.add(u);
  }

  // Normalise: strip the editor's width hint (`?w=300` / `&w=300`) and any
  // query string. A real "?" in a file name is always encoded (%3F), so a
  // literal "?" is always a query.
  const out = new Set<string>();
  for (const r of refs) {
    const clean = r.replace(/[?&]w=\d+$/, "").split("?")[0].trim();
    if (clean) out.add(clean);
  }
  return Array.from(out);
}

async function inferFix(
  absPath: string,
  assetsDir: string,
): Promise<BrokenRef["fix"]> {
  const name = basename(absPath);
  const parentName = basename(dirname(absPath));

  // Helper: look through every old-layout folder for this filename.
  const findOld = async (): Promise<string | null> => {
    for (const old of OLD_LAYOUT_DIRS) {
      const p = await join(assetsDir, old, name);
      try { if (await exists(p)) return p; } catch {}
    }
    return null;
  };

  if (parentName === PROXY_DIR) {
    // Note expects a proxy. Two repair paths, in order of preference:
    //
    //   1. "move" — a proxy for this file exists somewhere else on disk
    //      (flat, or in an old-layout subfolder). Relocate it; the note
    //      keeps using the small WebP copy.
    //
    //   2. "downgrade" — the proxy is gone, but the original survives.
    //      Rewrite the note's reference back to the original. The note
    //      renders immediately with the full-size file; no re-encoding
    //      required, no data lost.
    //
    // We deliberately no longer default to "regenerate" here. Encoding a
    // full-size original into a 1600px WebP is slow and can silently
    // fail on large PNGs. Falling back to the original is always correct.
    if (name.endsWith(".webp") || name.endsWith(".webm")) {
      // Relocate if a stray copy exists somewhere.
      const flat = await join(assetsDir, name);
      try { if (await exists(flat)) return { kind: "move", from: flat, to: absPath }; } catch {}
      const old = await findOld();
      if (old) return { kind: "move", from: old, to: absPath };

      // Otherwise, downgrade to the surviving original.
      const sourceName = name.replace(/\.(webp|webm)$/i, "");
      const srcPath = await join(assetsDir, sourceName);
      try {
        if (await exists(srcPath)) {
          return { kind: "downgrade", original: srcPath };
        }
      } catch {}
    }
    return { kind: "unfixable" };
  }

  // Note expects a flat path. Try proxy/.
  const proxyPath = await join(assetsDir, PROXY_DIR, name);
  try { if (await exists(proxyPath)) return { kind: "move", from: proxyPath, to: absPath }; } catch {}
  const old = await findOld();
  if (old) return { kind: "move", from: old, to: absPath };
  return { kind: "unfixable" };
}

export async function auditVault(vaultPath: string): Promise<VaultReport> {
  const report: VaultReport = {
    totalNotes: 0,
    totalAssets: 0,
    totalBytes: 0,
    brokenRefs: [],
    unusedFiles: [],
    oldLayout: [],
    missingProxies: [],
    missingThumbs: [],
    proxiesOff: [],
    imageStats: { total: 0, optimized: 0, withThumb: 0, originalBytes: 0, proxyBytes: 0 },
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    let entries: any[] = [];
    try { entries = await readDir(dir); } catch { return; }
    for (const e of entries) {
      if (!e.name || e.name.startsWith(".")) continue;
      if (e.name === "assets" || e.name === "_attachments") continue;
      const full = await join(dir, e.name);
      if (e.isDirectory) { await walk(full, depth + 1); continue; }
      if (!e.name.endsWith(".selah")) continue;
      report.totalNotes++;
      await auditNote(full, e.name, report);
    }
  };
  await walk(vaultPath, 0);
  return report;
}

async function auditNote(
  notePath: string,
  noteFileName: string,
  report: VaultReport,
): Promise<void> {
  const noteBase = noteFileName.replace(/\.selah$/, "");
  const noteDir = dirname(notePath);
  const assetsDir = await join(noteDir, "assets", noteBase);

  let raw: string;
  try { raw = await readTextFile(notePath); } catch { return; }
  const { frontmatter, body } = parseNoteFile(raw);
  const refs = extractRefs(body, frontmatter as Record<string, unknown>);

  const topFiles = new Map<string, number>();   // name -> bytes
  const proxyFiles = new Map<string, number>(); // name -> bytes
  const thumbFiles = new Map<string, number>(); // name -> bytes
  const proxiesOff = frontmatter.proxies !== true || !proxyFeatureEnabled();
  let keepList: string[] = [];

  const sizeOf = async (p: string) => {
    try { return (await stat(p)).size || 0; } catch { return 0; }
  };

  try {
    const entries = await readDir(assetsDir);
    for (const e of entries) {
      if (!e.name) continue;
      if (e.name === KEEP_FILE) {
        try {
          const raw = await readTextFile(await join(assetsDir, KEEP_FILE));
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) keepList = parsed.filter((x) => typeof x === "string");
        } catch {}
        continue;
      }
      if (e.isDirectory) {
        if (OLD_LAYOUT_DIRS.includes(e.name)) {
          const ex = report.oldLayout.find((o) => o.absPath === assetsDir);
          if (ex) { if (!ex.subfolders.includes(e.name)) ex.subfolders.push(e.name); }
          else report.oldLayout.push({
            absPath: assetsDir, notePath, noteBase, subfolders: [e.name],
          });
        }
        continue;
      }
      topFiles.set(e.name, await sizeOf(await join(assetsDir, e.name)));
    }
  } catch {}

  try {
    const entries = await readDir(await join(assetsDir, PROXY_DIR));
    for (const e of entries) {
      if (!e.isDirectory && e.name) {
        proxyFiles.set(e.name, await sizeOf(await join(assetsDir, PROXY_DIR, e.name)));
      }
    }
  } catch {}

  try {
    const entries = await readDir(await join(assetsDir, PROXY_DIR, THUMB_DIR));
    for (const e of entries) {
      if (!e.isDirectory && e.name) {
        const tsz = await sizeOf(await join(assetsDir, PROXY_DIR, THUMB_DIR, e.name));
        thumbFiles.set(e.name, tsz);
        report.totalAssets++;
        report.totalBytes += tsz;
      }
    }
  } catch {}

  // Every real file on disk counts toward the totals (previously only
  // unused files did, which is why the header said "0 files").
  for (const sz of topFiles.values()) { report.totalAssets++; report.totalBytes += sz; }
  for (const sz of proxyFiles.values()) { report.totalAssets++; report.totalBytes += sz; }

  const referencedTop = new Set<string>();
  const referencedProxy = new Set<string>();

  for (const ref of refs) {
    if (!ref) continue;
    if (/^(https?:|data:|blob:)/i.test(ref)) continue;
    const abs = refToAbs(ref, noteDir);

    let ok = false;
    try { ok = await exists(abs); } catch {}
    if (ok) {
      const parts = abs.replace(/\\/g, "/").split("/");
      const name = parts[parts.length - 1];
      if (parts[parts.length - 2] === PROXY_DIR) referencedProxy.add(name);
      else referencedTop.add(name);
      continue;
    }

    const fix = await inferFix(abs, assetsDir);
    report.brokenRefs.push({ notePath, noteBase, raw: ref, absPath: abs, fix });
  }

  // Unused originals.
  for (const [name, size] of topFiles) {
    if (referencedTop.has(name)) continue;
    // An original counts as in use (archival) when the note references it
    // directly OR references its WebP proxy / the video block derives its proxy.
    if (referencedProxy.has(`${name}.webp`) || referencedProxy.has(`${name}.webm`)) continue;
    if (keepList.includes(name)) continue;
    report.unusedFiles.push({
      absPath: await join(assetsDir, name), notePath, size, inProxy: false,
    });
  }

  // Unused proxies.
  for (const [name, size] of proxyFiles) {
    let used = referencedProxy.has(name);
    if (!used) {
      // photo.jpg.webp -> photo.jpg ; video.mp4.webm -> video.mp4
      const dotIdx = name.lastIndexOf(".");
      if (dotIdx > 0 && referencedTop.has(name.slice(0, dotIdx))) used = true;
    }
    if (!used) {
      report.unusedFiles.push({
        absPath: await join(assetsDir, PROXY_DIR, name), notePath, size, inProxy: true,
      });
    }
  }

  // Image optimisation status (skipped for notes with proxies switched off).
  if (!proxiesOff) {
  //
  // A convertible image the note uses is "pending" whenever the note still
  // points at the full-size original. That covers two cases:
  //   - no proxy exists yet             -> encode + rewrite
  //   - proxy exists, note ignores it   -> rewrite only
  // (The second case used to go unreported, so a vault whose proxies existed
  //  but whose notes still loaded the originals showed nothing at all.)
  const missing: MissingProxiesForNote["sources"] = [];
  for (const [name, size] of topFiles) {
    if (!IMAGE_CONVERTIBLE_RE.test(name)) continue;
    if (size === 0) continue; // Ignore 0-byte corrupt files
    const proxyName = `${name}.webp`;
    const hasProxy = proxyFiles.has(proxyName);
    const hasThumb = thumbFiles.has(proxyName);
    const refsOriginal = referencedTop.has(name);
    const refsProxy = referencedProxy.has(proxyName);
    if (!refsOriginal && !refsProxy) continue; // unused: handled above

    report.imageStats.total++;
    report.imageStats.originalBytes += size;
    if (hasProxy) report.imageStats.proxyBytes += proxyFiles.get(proxyName) || 0;

    if (hasThumb) report.imageStats.withThumb++;
    if (!refsOriginal) report.imageStats.optimized++;
    // Pending if the note still loads the original OR no thumbnail exists.
    if (refsOriginal || !hasThumb) {
      missing.push({ name, size, hasProxy, hasThumb, refsOriginal });
    }
  }
  // Originals already trashed, but the note uses the proxy and it has no
  // thumbnail yet: build the thumbnail from the proxy.
  for (const [pname, psize] of proxyFiles) {
    if (!/\.webp$/i.test(pname)) continue;
    const srcName = pname.slice(0, -5);
    if (topFiles.has(srcName) || !IMAGE_CONVERTIBLE_RE.test(srcName)) continue;
    if (!referencedProxy.has(pname)) continue;
    report.imageStats.total++;
    report.imageStats.optimized++;
    report.imageStats.proxyBytes += psize;
    if (thumbFiles.has(pname)) { report.imageStats.withThumb++; continue; }
    missing.push({
      name: srcName, size: psize, hasProxy: true, hasThumb: false,
      refsOriginal: false, originalMissing: true,
    });
  }
  if (missing.length > 0) {
    report.missingProxies.push({ notePath, noteBase, assetsDir, sources: missing });
  }
  } else {
    // Proxies are OFF for this note: offer to reclaim any proxy/thumb files
    // whose original still exists (so nothing becomes unrecoverable).
    let files = 0;
    let bytes = 0;
    for (const [pname, sz] of proxyFiles) {
      if (/\.webp$/i.test(pname) && topFiles.has(pname.slice(0, -5))) { files++; bytes += sz; }
    }
    for (const [tname, sz] of thumbFiles) {
      if (topFiles.has(tname.slice(0, -5))) { files++; bytes += sz; }
    }
    if (files > 0) report.proxiesOff.push({ notePath, noteBase, assetsDir, files, bytes });
  }

  // ── Missing thumbnails ────────────────────────────────────────────────
  // ... but only for notes that want proxies. A note with proxies off has
  // opted out of the entire proxy/ folder — thumbnails included. Reporting
  // missing thumbs for it would push the user to recreate exactly the
  // files they just asked us to stop making.
  if (!proxiesOff) {
    const missingThumbsForNote: MissingThumbForNote["sources"] = [];

    // Images the note references by original name.
    for (const [name, size] of topFiles) {
      if (!IMAGE_CONVERTIBLE_RE.test(name)) continue;
      if (size === 0) continue; // Ignore 0-byte corrupt files
      if (!referencedTop.has(name)) continue;
      if (thumbFiles.has(`${name}.webp`)) continue;
      missingThumbsForNote.push({
        name,
        sourceAbs: await join(assetsDir, name),
      });
    }

    // Images the note references by proxy name.
    for (const [pname] of proxyFiles) {
      if (!/\.webp$/i.test(pname)) continue;
      if (!referencedProxy.has(pname)) continue;
      const srcName = pname.slice(0, -5);
      if (!IMAGE_CONVERTIBLE_RE.test(srcName)) continue;
      if (thumbFiles.has(pname)) continue;
      if (missingThumbsForNote.some((s) => s.name === srcName)) continue;

      const originalPath = await join(assetsDir, srcName);
      let sourceAbs = originalPath;
      try {
        if (!(await exists(originalPath))) {
          sourceAbs = await join(assetsDir, PROXY_DIR, pname);
        }
      } catch {
        sourceAbs = await join(assetsDir, PROXY_DIR, pname);
      }
      missingThumbsForNote.push({ name: srcName, sourceAbs });
    }

    if (missingThumbsForNote.length > 0) {
      report.missingThumbs.push({
        notePath, noteBase, assetsDir,
        sources: missingThumbsForNote,
      });
    }
  }


  // Old-layout folder contents count as assets too.
  for (const sub of OLD_LAYOUT_DIRS) {
    const subDir = await join(assetsDir, sub);
    try {
      const entries = await readDir(subDir);
      for (const e of entries) {
        if (!e.name || e.isDirectory) continue;
        report.totalBytes += await sizeOf(await join(subDir, e.name));
        report.totalAssets++;
      }
    } catch {}
  }
}

export { dirname, basename };

export async function auditSingleNote(notePath: string): Promise<VaultReport> {
  const report: VaultReport = {
    totalNotes: 1,
    totalAssets: 0,
    totalBytes: 0,
    brokenRefs: [],
    unusedFiles: [],
    oldLayout: [],
    missingProxies: [],
    missingThumbs: [],
    proxiesOff: [],
    imageStats: { total: 0, optimized: 0, withThumb: 0, originalBytes: 0, proxyBytes: 0 },
  };
  await auditNote(notePath, basename(notePath), report);
  return report;
}
