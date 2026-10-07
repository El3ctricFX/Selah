// src/CleanupPanel.tsx
import { useEffect, useMemo, useState } from "react";
import { readTextFile, readDir, stat, mkdir, rename, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight,
  Loader2, Sparkles, X, Wand2, Shield,
} from "lucide-react";
import { moveToTrash } from "./trash";
import { parseNoteFile } from "./noteFormat";

interface CatLike {
  id: string;
  name: string;
  mode: "journal" | "notes" | "gallery" | "abba";
  dirName: string;
}

type ActionType = "delete" | "organize" | "skip";

interface FileEntry {
  path: string;
  displayName: string;
  size: number;
  suggested: ActionType;
  target?: string;
  reason: string;
  safe: boolean;
}

interface Result {
  categoryId: string;
  categoryName: string;
  categoryMode: CatLike["mode"];
  files: FileEntry[];
  totalBytes: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  vaultPath: string;
  categories: CatLike[];
}

// ---------- utilities ----------

const MEDIA_EXT = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg",
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "webm",
]);

const SAFE_EXT = new Set(["note", "md", "json", "txt", "pdf"]);

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx + 1).toLowerCase();
}

function isMediaFile(name: string): boolean {
  const e = extOf(name);
  if (!e) return false;
  if (SAFE_EXT.has(e)) return false;
  return MEDIA_EXT.has(e);
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function fileSizeSafe(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return (info as any).size ?? 0;
  } catch {
    return 0;
  }
}

function parentDirOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.substring(0, i);
}

function relPath(vaultPath: string, absPath: string): string {
  if (!vaultPath) return absPath;
  const v = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = absPath.replace(/\\/g, "/");
  if (a === v) return ".";
  if (a.startsWith(v + "/")) return a.slice(v.length + 1);
  return absPath;
}

function splitPath(p: string): { dir: string; file: string } {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (idx === -1) return { dir: "", file: p };
  return { dir: p.slice(0, idx), file: p.slice(idx + 1) };
}

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

function contentMentions(content: string, filename: string): boolean {
  if (!filename) return false;
  if (content.includes(filename)) return true;
  const encoded = filename.replace(/ /g, "%20");
  if (encoded !== filename && content.includes(encoded)) return true;
  return false;
}

// ---------- gallery scan ----------

async function scanGalleryWithFix(dir: string): Promise<FileEntry[]> {
  const filenameToItemId = new Map<string, string>();
  const itemIds = new Set<string>();

  /**
   * Register a filename as belonging to an item. First owner wins, so if
   * two items somehow claim the same file we don't clobber the map.
   */
  const claim = (filename: unknown, id: string) => {
    if (typeof filename !== "string" || !filename) return;
    if (!filenameToItemId.has(filename)) filenameToItemId.set(filename, id);
  };

  try {
    const raw = await readTextFile(await join(dir, "gallery.json"));
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const id = String(it.id ?? "");
        if (!id) continue;
        itemIds.add(id);

        // 1. Main images (fall back to legacy single `image` field).
        const main: string[] = Array.isArray(it.mainImages)
          ? it.mainImages.filter((x: any) => typeof x === "string")
          : (typeof it.image === "string" && it.image ? [it.image] : []);
        for (const f of main) claim(f, id);

        // 2. Reference images.
        const refs: string[] = Array.isArray(it.referenceImages)
          ? it.referenceImages.filter((x: any) => typeof x === "string")
          : [];
        for (const f of refs) claim(f, id);

        // 3. Version snapshots — this is what was missing.
        if (Array.isArray(it.versions)) {
          for (const v of it.versions) {
            if (v && typeof v.image === "string") claim(v.image, id);
          }
        }

        // 4. Progress entries — each may have an attached photo.
        if (Array.isArray(it.progress)) {
          for (const p of it.progress) {
            if (p && typeof p.image === "string") claim(p.image, id);
          }
        }

        // 5. Inline images embedded in the backstory markdown.
        if (typeof it.backstory === "string" && it.backstory) {
          const re = /!\[[^\]]*\]\(([^)]+)\)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(it.backstory)) !== null) {
            const ref = m[1].trim();
            if (/^(https?:|data:|blob:|asset:)/i.test(ref)) continue;
            let decoded = ref;
            try { decoded = decodeURIComponent(ref); } catch {}
            claim(decoded, id);
            // Also claim the raw form in case it was stored without encoding.
            if (decoded !== ref) claim(ref, id);
          }
        }
      }
    }
  } catch {
    return [];
  }

  const protectedAbs = new Set<string>();
  try {
    const raw = await readTextFile(await join(dir, "gallery.meta.json"));
    const meta = JSON.parse(raw);
    if (
      meta?.coverType === "image" &&
      typeof meta.coverValue === "string" &&
      meta.coverValue
    ) {
      protectedAbs.add(norm(meta.coverValue));
    }
  } catch {}

  const assetsDir = await join(dir, "assets");
  const out: FileEntry[] = [];

  let entries: any[] = [];
  try {
    entries = await readDir(assetsDir);
  } catch {
    return [];
  }

  for (const e of entries) {
    if (!e.name || e.name.startsWith(".")) continue;
    const full = await join(assetsDir, e.name);

    if (!e.isDirectory) {
      if (!isMediaFile(e.name)) continue;
      if (protectedAbs.has(norm(full))) continue;

      const owner = filenameToItemId.get(e.name);
      if (owner) {
        out.push({
          path: full,
          displayName: e.name,
          size: await fileSizeSafe(full),
          suggested: "organize",
          target: await join(assetsDir, owner, e.name),
          reason: `Referenced by item “${owner}” — move into its folder`,
          safe: false,
        });
      } else {
        out.push({
          path: full,
          displayName: e.name,
          size: await fileSizeSafe(full),
          suggested: "delete",
          reason: "Not referenced by any gallery item",
          safe: true,
        });
      }
      continue;
    }

    const itemId = e.name;
    const itemDir = full;
    const isKnownItem = itemIds.has(itemId);

    let subFiles: any[] = [];
    try {
      subFiles = await readDir(itemDir);
    } catch {
      continue;
    }

    for (const sf of subFiles) {
      if (sf.isDirectory || !sf.name || sf.name.startsWith(".")) continue;
      if (!isMediaFile(sf.name)) continue;
      const sfFull = await join(itemDir, sf.name);
      if (protectedAbs.has(norm(sfFull))) continue;

      if (!isKnownItem) {
        out.push({
          path: sfFull,
          displayName: sf.name,
          size: await fileSizeSafe(sfFull),
          suggested: "delete",
          reason: `Folder “${itemId}” doesn't match any item`,
          safe: true,
        });
        continue;
      }

      const owner = filenameToItemId.get(sf.name);
      if (owner === itemId) continue;
      if (owner) continue;

      out.push({
        path: sfFull,
        displayName: sf.name,
        size: await fileSizeSafe(sfFull),
        suggested: "delete",
        reason: `Not used by item “${itemId}”`,
        safe: true,
      });
    }
  }

  return out;
}

// ---------- abba scan ----------

const ABBA_SECTIONS = ["sermons", "prayers", "testimonies", "studies", "events", "links"];

interface AbbaNoteRec {
  section: string;
  /** The id from frontmatter (or filename base if missing). */
  id: string;
  /** The actual file on disk. */
  fileName: string;
  content: string;
}

async function scanAbbaWithFix(dir: string): Promise<FileEntry[]> {
  // Map: "section/id" -> note
  const noteByKey = new Map<string, AbbaNoteRec>();
  const allNotes: AbbaNoteRec[] = [];

  for (const section of ABBA_SECTIONS) {
    const sectionDir = await join(dir, section);
    let entries: any[] = [];
    try {
      entries = await readDir(sectionDir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name || e.isDirectory) continue;
      if (!e.name.endsWith(".note")) continue;
      const fileName = e.name;
      const fileNameBase = fileName.replace(/\.note$/i, "");

      let content = "";
      try {
        content = await readTextFile(await join(sectionDir, fileName));
      } catch {
        continue;
      }

      // Extract id from frontmatter. Falls back to the filename base.
      let id = fileNameBase;
      try {
        const { frontmatter } = parseNoteFile(content);
        if (typeof frontmatter.id === "string" && frontmatter.id.trim()) {
          id = frontmatter.id.trim();
        }
      } catch {}

      const rec: AbbaNoteRec = { section, id, fileName, content };
      allNotes.push(rec);

      // Key by id (canonical, matches asset folder names).
      const idKey = `${section}/${id}`;
      if (!noteByKey.has(idKey)) noteByKey.set(idKey, rec);
      // Also key by filename base, in case older notes use that layout.
      const fnKey = `${section}/${fileNameBase}`;
      if (!noteByKey.has(fnKey)) noteByKey.set(fnKey, rec);
    }
  }

  const assetsDir = await join(dir, "assets");
  const out: FileEntry[] = [];

  let entries: any[] = [];
  try {
    entries = await readDir(assetsDir);
  } catch {
    return [];
  }

  // Helper: given a set of filenames to test, find every note that mentions
  // any of them. Used to detect whether a flat file belongs to a specific note.
  const findOwner = (filename: string, section?: string): AbbaNoteRec[] => {
    const pool = section
      ? allNotes.filter((n) => n.section === section)
      : allNotes;
    return pool.filter((n) => contentMentions(n.content, filename));
  };

  for (const e of entries) {
    if (!e.name || e.name.startsWith(".")) continue;
    const full = await join(assetsDir, e.name);

    if (!e.isDirectory) {
      // Flat file directly in assets/.
      if (!isMediaFile(e.name)) continue;

      const owners = findOwner(e.name);
      if (owners.length === 1) {
        const o = owners[0];
        out.push({
          path: full,
          displayName: e.name,
          size: await fileSizeSafe(full),
          suggested: "organize",
          target: await join(assetsDir, o.section, o.id, e.name),
          reason: `Referenced by ${o.section} note “${o.id}” — move into its folder`,
          safe: false,
        });
      } else if (owners.length === 0) {
        out.push({
          path: full,
          displayName: e.name,
          size: await fileSizeSafe(full),
          suggested: "delete",
          reason: "Not referenced by any note",
          safe: true,
        });
      }
      // Multiple owners → ambiguous, skip.
      continue;
    }

    const sectionName = e.name;

    if (!ABBA_SECTIONS.includes(sectionName)) {
      let sf: any[] = [];
      try {
        sf = await readDir(full);
      } catch {
        continue;
      }
      for (const child of sf) {
        if (child.isDirectory || !child.name || child.name.startsWith(".")) continue;
        if (!isMediaFile(child.name)) continue;
        const cf = await join(full, child.name);

        const owners = findOwner(child.name);
        if (owners.length === 0) {
          out.push({
            path: cf,
            displayName: child.name,
            size: await fileSizeSafe(cf),
            suggested: "delete",
            reason: `Lives in unknown folder “${sectionName}” and isn't referenced`,
            safe: true,
          });
        }
      }
      continue;
    }

    // Known section folder.
    let sectionEntries: any[] = [];
    try {
      sectionEntries = await readDir(full);
    } catch {
      continue;
    }

    for (const se of sectionEntries) {
      if (!se.name || se.name.startsWith(".")) continue;
      const sePath = await join(full, se.name);

      if (!se.isDirectory) {
        // Stray file at section level.
        if (!isMediaFile(se.name)) continue;

        const owners = findOwner(se.name, sectionName);
        if (owners.length === 1) {
          const o = owners[0];
          out.push({
            path: sePath,
            displayName: se.name,
            size: await fileSizeSafe(sePath),
            suggested: "organize",
            target: await join(assetsDir, sectionName, o.id, se.name),
            reason: `Referenced by note “${o.id}” — move into its folder`,
            safe: false,
          });
        } else if (owners.length === 0) {
          out.push({
            path: sePath,
            displayName: se.name,
            size: await fileSizeSafe(sePath),
            suggested: "delete",
            reason: "Not referenced by any note",
            safe: true,
          });
        }
        continue;
      }

      // Per-note asset folder. Its name is the note's *id*, not its filename.
      const folderId = se.name;
      const note = noteByKey.get(`${sectionName}/${folderId}`);

      let subFiles: any[] = [];
      try {
        subFiles = await readDir(sePath);
      } catch {
        continue;
      }

      for (const sf of subFiles) {
        if (sf.isDirectory || !sf.name || sf.name.startsWith(".")) continue;
        if (!isMediaFile(sf.name)) continue;
        const sfPath = await join(sePath, sf.name);

        if (note && contentMentions(note.content, sf.name)) continue;

        // If we can't find the note by id, try a broader match: is any note
        // in the same section referencing this exact filename? If yes, we
        // assume the file is fine and skip it (avoids false positives when
        // the folder name and note id have drifted apart).
        if (!note) {
          const owners = findOwner(sf.name, sectionName);
          if (owners.length > 0) continue;
          out.push({
            path: sfPath,
            displayName: sf.name,
            size: await fileSizeSafe(sfPath),
            suggested: "delete",
            reason: `Not referenced by any ${sectionName} note`,
            safe: true,
          });
          continue;
        }

        out.push({
          path: sfPath,
          displayName: sf.name,
          size: await fileSizeSafe(sfPath),
          suggested: "delete",
          reason: `Not referenced by note “${note.fileName.replace(/\.note$/, "")}”`,
          safe: true,
        });
      }
    }
  }

  return out;
}

// ---------- journal scan ----------

async function scanJournal(dir: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];

  let yearEntries: any[] = [];
  try {
    yearEntries = await readDir(dir);
  } catch {
    return [];
  }

  for (const yearEntry of yearEntries) {
    if (!yearEntry.isDirectory) continue;
    if (!/^\d{4}$/.test(yearEntry.name)) continue;
    const yearDir = await join(dir, yearEntry.name);

    let monthEntries: any[] = [];
    try {
      monthEntries = await readDir(yearDir);
    } catch {
      continue;
    }

    for (const monthEntry of monthEntries) {
      if (!monthEntry.isDirectory) continue;
      const monthDir = await join(yearDir, monthEntry.name);
      const assetsDir = await join(monthDir, "assets");

      let assetsEntries: any[] = [];
      try {
        assetsEntries = await readDir(assetsDir);
      } catch {
        continue;
      }

      let monthFiles: any[] = [];
      try {
        monthFiles = await readDir(monthDir);
      } catch {
        continue;
      }

      const noteContents: { name: string; content: string }[] = [];
      for (const f of monthFiles) {
        if (f.isDirectory || !f.name || !/\.(note|md)$/i.test(f.name)) continue;
        const baseName = f.name.replace(/\.(note|md)$/i, "");
        let content = "";
        try {
          content = await readTextFile(await join(monthDir, f.name));
        } catch {}
        noteContents.push({ name: baseName, content });
      }

      for (const subEntry of assetsEntries) {
        if (!subEntry.name || subEntry.name.startsWith(".")) continue;

        if (!subEntry.isDirectory) {
          if (!isMediaFile(subEntry.name)) continue;
          const referenced = noteContents.some((nc) =>
            contentMentions(nc.content, subEntry.name)
          );
          if (!referenced) {
            const full = await join(assetsDir, subEntry.name);
            out.push({
              path: full,
              displayName: subEntry.name,
              size: await fileSizeSafe(full),
              suggested: "delete",
              reason: "Not referenced by any entry in this month",
              safe: true,
            });
          }
          continue;
        }

        const noteBaseName = subEntry.name;
        const match = noteContents.find((nc) => nc.name === noteBaseName);
        const subDirPath = await join(assetsDir, noteBaseName);

        let subFiles: any[] = [];
        try {
          subFiles = await readDir(subDirPath);
        } catch {
          continue;
        }

        for (const assetFile of subFiles) {
          if (assetFile.isDirectory || !assetFile.name || assetFile.name.startsWith(".")) continue;
          if (!isMediaFile(assetFile.name)) continue;
          const full = await join(subDirPath, assetFile.name);

          if (!match) {
            out.push({
              path: full,
              displayName: assetFile.name,
              size: await fileSizeSafe(full),
              suggested: "delete",
              reason: `Entry “${noteBaseName}” no longer exists`,
              safe: true,
            });
            continue;
          }

          if (!contentMentions(match.content, assetFile.name)) {
            out.push({
              path: full,
              displayName: assetFile.name,
              size: await fileSizeSafe(full),
              suggested: "delete",
              reason: `Not used by “${noteBaseName}”`,
              safe: true,
            });
          }
        }
      }
    }
  }

  return out;
}

async function scanOne(cat: CatLike, vaultPath: string): Promise<Result> {
  const dir = cat.dirName ? await join(vaultPath, cat.dirName) : vaultPath;

  let files: FileEntry[] = [];
  try {
    if (cat.mode === "abba") files = await scanAbbaWithFix(dir);
    else if (cat.mode === "gallery") files = await scanGalleryWithFix(dir);
    else if (cat.mode === "journal") files = await scanJournal(dir);
  } catch (e) {
    console.error("[cleanup] scan failed for", cat.name, e);
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  return {
    categoryId: cat.id,
    categoryName: cat.name,
    categoryMode: cat.mode,
    files,
    totalBytes,
  };
}

// ---------- apply one action ----------

async function applyAction(f: FileEntry, action: ActionType): Promise<boolean> {
  if (!isMediaFile(f.displayName)) {
    console.warn("[cleanup] refusing non-media file:", f.path);
    return false;
  }

  try {
    if (action === "delete") {
      await moveToTrash(f.path);
      return true;
    }
    if (action === "organize" && f.target) {
      const parent = parentDirOf(f.target);
      await mkdir(parent, { recursive: true });
      if (await exists(f.target)) {
        console.warn("[cleanup] target exists, skipping:", f.target);
        return false;
      }
      await rename(f.path, f.target);
      return true;
    }
  } catch (e) {
    console.error("[cleanup] applyAction failed:", f.path, action, e);
  }
  return false;
}

// ---------- panel ----------

export default function CleanupPanel({
  open,
  onClose,
  vaultPath,
  categories,
}: Props) {
  const [phase, setPhase] = useState<
    "scanning" | "results" | "applying" | "done" | "error"
  >("scanning");
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [actions, setActions] = useState<Record<string, ActionType>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setPhase("scanning");
    setResults([]);
    setError(null);
    setAppliedCount(0);
    setExpanded(new Set());
    setActions({});
    setIncluded({});

    (async () => {
      try {
        const all: Result[] = [];
        for (const cat of categories) {
          const r = await scanOne(cat, vaultPath);
          if (cancelled) return;
          all.push(r);
        }
        if (cancelled) return;

        const nonEmpty = all.filter((r) => r.files.length > 0);

        const a: Record<string, ActionType> = {};
        const inc: Record<string, boolean> = {};
        for (const r of nonEmpty) {
          for (const f of r.files) {
            a[f.path] = "skip";
            inc[f.path] = false;
          }
        }

        setResults(nonEmpty);
        setActions(a);
        setIncluded(inc);
        setExpanded(new Set(nonEmpty.map((r) => r.categoryId)));
        setPhase("results");
      } catch (e: any) {
        if (cancelled) return;
        console.error("[cleanup] scan failed:", e);
        setError(e?.message ?? String(e));
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, vaultPath, categories]);

  const allFiles = useMemo(() => results.flatMap((r) => r.files), [results]);

  const counts = useMemo(() => {
    let toFix = 0, toDelete = 0, skipped = 0;
    for (const f of allFiles) {
      if (!included[f.path]) { skipped++; continue; }
      const a = actions[f.path] ?? "skip";
      if (a === "organize") toFix++;
      else if (a === "delete") toDelete++;
      else skipped++;
    }
    return { toFix, toDelete, skipped, total: allFiles.length };
  }, [allFiles, actions, included]);

  const setAction = (f: FileEntry, action: ActionType) => {
    setActions((p) => ({ ...p, [f.path]: action }));
    setIncluded((p) => ({ ...p, [f.path]: action !== "skip" }));
  };

  const toggleIncluded = (f: FileEntry) => {
    setIncluded((p) => {
      const next = { ...p, [f.path]: !p[f.path] };
      if (next[f.path]) {
        setActions((a) => ({ ...a, [f.path]: f.suggested }));
      } else {
        setActions((a) => ({ ...a, [f.path]: "skip" }));
      }
      return next;
    });
  };

  const selectAllSafe = () => {
    const inc: Record<string, boolean> = {};
    const act: Record<string, ActionType> = {};
    for (const f of allFiles) {
      if (f.safe) {
        inc[f.path] = true;
        act[f.path] = f.suggested;
      } else {
        inc[f.path] = false;
        act[f.path] = "skip";
      }
    }
    setIncluded(inc);
    setActions(act);
  };

  const deselectAll = () => {
    const inc: Record<string, boolean> = {};
    const act: Record<string, ActionType> = {};
    for (const f of allFiles) {
      inc[f.path] = false;
      act[f.path] = "skip";
    }
    setIncluded(inc);
    setActions(act);
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applySelected = async () => {
    setPhase("applying");
    let count = 0;
    const touchedFolders = new Set<string>();

    for (const f of allFiles) {
      if (!included[f.path]) continue;
      const a = actions[f.path] ?? "skip";
      if (a === "skip") continue;
      const ok = await applyAction(f, a);
      if (ok) {
        count++;
        touchedFolders.add(parentDirOf(f.path));
        if (f.target) touchedFolders.add(parentDirOf(f.target));
      }
    }

    setAppliedCount(count);

    for (const folder of touchedFolders) {
      window.dispatchEvent(
        new CustomEvent("folder-changed", { detail: { path: folder } })
      );
      window.dispatchEvent(
        new CustomEvent("file-changed", { detail: { path: folder } })
      );
    }

    const all: Result[] = [];
    for (const cat of categories) {
      const r = await scanOne(cat, vaultPath);
      all.push(r);
    }
    const nonEmpty = all.filter((r) => r.files.length > 0);

    const a: Record<string, ActionType> = {};
    const inc: Record<string, boolean> = {};
    for (const r of nonEmpty) {
      for (const f of r.files) {
        a[f.path] = "skip";
        inc[f.path] = false;
      }
    }

    if (nonEmpty.length === 0) {
      setResults([]);
      setPhase("done");
    } else {
      setResults(nonEmpty);
      setActions(a);
      setIncluded(inc);
      setExpanded(new Set(nonEmpty.map((r) => r.categoryId)));
      setPhase("results");
    }
  };

  if (!open) return null;

  const anySelected = counts.toFix + counts.toDelete > 0;

  return (
    <div
      className="fixed inset-0 z-[250] bg-black/70 flex items-center justify-center p-6"
      onClick={() => {
        if (phase === "applying") return;
        onClose();
      }}
    >
      <div
        className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[780px] max-w-[94vw] max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
          <Sparkles size={14} className="text-blue-400" />
          <span className="text-sm font-medium text-gray-100">
            Clean up unused media
          </span>
          <button
            type="button"
            onClick={() => {
              if (phase === "applying") return;
              onClose();
            }}
            disabled={phase === "applying"}
            className="ml-auto text-gray-500 hover:text-gray-300 p-0.5 disabled:opacity-40"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {phase === "scanning" && (
            <div className="flex items-center gap-3 py-12 justify-center text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" />
              <span>Scanning the whole vault…</span>
            </div>
          )}

          {phase === "error" && (
            <div className="flex items-start gap-3">
              <AlertTriangle
                size={16}
                className="text-red-400 flex-shrink-0 mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-red-300 font-medium">Scan failed.</p>
                <p className="text-xs text-red-400/70 mt-1 break-words">
                  {error}
                </p>
              </div>
            </div>
          )}

          {phase === "results" && results.length === 0 && (
            <div className="text-center py-12">
              <Check size={28} className="text-emerald-400 mx-auto mb-3" />
              <p className="text-sm text-gray-200">All clean.</p>
              <p className="text-xs text-gray-500 mt-1">
                Nothing left to fix or remove.
              </p>
            </div>
          )}

          {phase === "results" && results.length > 0 && (
            <>
              <div className="mb-3 flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-sm text-gray-200">
                    <span className="font-semibold text-gray-100">
                      {counts.total}
                    </span>{" "}
                    leftover {counts.total === 1 ? "file" : "files"} found —{" "}
                    <span className="text-blue-300">{counts.toFix} to fix</span>
                    {" · "}
                    <span className="text-red-300">{counts.toDelete} to delete</span>
                    {counts.skipped > 0 && (
                      <>
                        {" · "}
                        <span className="text-gray-500">
                          {counts.skipped} unchecked
                        </span>
                      </>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-1.5">
                    <Shield size={11} className="text-emerald-400" />
                    <span>
                      Notes, JSON files, and referenced media are never flagged.
                      Nothing happens until you click Apply.
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={selectAllSafe}
                    className="text-[11px] px-2 py-1 rounded text-gray-400 hover:text-gray-100 hover:bg-[#2a3136]"
                    title="Select only files that are definitely safe to act on"
                  >
                    Select all safe
                  </button>
                  <button
                    type="button"
                    onClick={deselectAll}
                    className="text-[11px] px-2 py-1 rounded text-gray-400 hover:text-gray-100 hover:bg-[#2a3136]"
                  >
                    Deselect all
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {results.map((r) => {
                  const isOpen = expanded.has(r.categoryId);
                  const catIncluded = r.files.filter((f) => included[f.path]).length;
                  return (
                    <div
                      key={r.categoryId}
                      className="rounded-md border border-[#2a3136] bg-[#0f1315] overflow-hidden"
                    >
                      <button
                        type="button"
                        onClick={() => toggleExpand(r.categoryId)}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#161a1d] transition-colors text-left"
                      >
                        {isOpen ? (
                          <ChevronDown size={13} className="text-gray-500 flex-shrink-0" />
                        ) : (
                          <ChevronRight size={13} className="text-gray-500 flex-shrink-0" />
                        )}
                        <span className="text-xs font-medium text-gray-200 truncate flex-1">
                          {r.categoryName}
                          <span className="text-gray-500 ml-2 font-normal uppercase tracking-wider text-[9px]">
                            {r.categoryMode}
                          </span>
                        </span>
                        <span className="text-[10px] text-gray-500 tabular-nums flex-shrink-0">
                          {catIncluded}/{r.files.length} selected
                        </span>
                        <span className="text-[10px] text-amber-300/90 tabular-nums flex-shrink-0 ml-2">
                          {formatBytes(r.totalBytes)}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="border-t border-[#2a3136] max-h-80 overflow-y-auto divide-y divide-[#1a1e21]">
                          {r.files.map((f) => {
                            const rel = relPath(vaultPath, f.path);
                            const { dir } = splitPath(rel);
                            const action = actions[f.path] ?? "skip";
                            const isIncluded = included[f.path] ?? false;
                            const hasTarget = !!f.target;
                            return (
                              <div
                                key={f.path}
                                className={`flex items-start gap-3 px-3 py-2 text-xs transition-colors ${
                                  isIncluded ? "bg-[#141819]" : ""
                                }`}
                                title={f.path}
                              >
                                <input
                                  type="checkbox"
                                  checked={isIncluded}
                                  onChange={() => toggleIncluded(f)}
                                  className="mt-1 accent-blue-500 flex-shrink-0 cursor-pointer"
                                />
                                <div className="flex-1 min-w-0">
                                  <div
                                    className={`truncate font-medium ${
                                      isIncluded ? "text-gray-200" : "text-gray-400"
                                    }`}
                                  >
                                    {f.displayName}
                                  </div>
                                  <div className="text-[10px] text-gray-500 truncate font-mono mt-0.5">
                                    {dir || "."}
                                  </div>
                                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                    <select
                                      value={action}
                                      onChange={(e) =>
                                        setAction(f, e.target.value as ActionType)
                                      }
                                      className="text-[10px] bg-[#0f1315] border border-[#30363d] rounded px-1.5 py-0.5 text-gray-200 outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
                                    >
                                      <option value="skip">Skip</option>
                                      {hasTarget && (
                                        <option value="organize">Fix location</option>
                                      )}
                                      <option value="delete">Move to trash</option>
                                    </select>
                                    <span className="text-[10px] text-gray-500 truncate">
                                      {f.reason}
                                    </span>
                                  </div>
                                  {action === "organize" && hasTarget && (
                                    <div className="text-[10px] text-blue-300/80 truncate font-mono mt-1">
                                      → {relPath(vaultPath, f.target!)}
                                    </div>
                                  )}
                                </div>
                                <span className="text-gray-500 tabular-nums flex-shrink-0 mt-0.5">
                                  {formatBytes(f.size)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {phase === "applying" && (
            <div className="flex items-center gap-3 py-12 justify-center text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" />
              <span>Applying changes…</span>
            </div>
          )}

          {phase === "done" && (
            <div className="text-center py-12">
              <Check size={28} className="text-emerald-400 mx-auto mb-3" />
              <p className="text-sm text-gray-200">
                Applied{" "}
                <span className="font-semibold text-gray-100">
                  {appliedCount}
                </span>{" "}
                {appliedCount === 1 ? "change" : "changes"}.
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Deleted files went to your system trash and can be restored from there.
              </p>
            </div>
          )}
        </div>

        {phase === "results" && results.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
            <div className="text-[11px] text-gray-500">
              {counts.toFix > 0 && (
                <span className="text-blue-300">{counts.toFix} fix</span>
              )}
              {counts.toFix > 0 && counts.toDelete > 0 && (
                <span className="text-gray-600"> · </span>
              )}
              {counts.toDelete > 0 && (
                <span className="text-red-300">{counts.toDelete} delete</span>
              )}
              {!anySelected && <span>nothing selected</span>}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                onClick={applySelected}
                disabled={!anySelected}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium"
              >
                <Wand2 size={12} />
                <span>Apply {counts.toFix + counts.toDelete} changes</span>
              </button>
            </div>
          </div>
        )}

        {(phase === "done" ||
          (phase === "results" && results.length === 0)) && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}