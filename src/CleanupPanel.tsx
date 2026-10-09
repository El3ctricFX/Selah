// src/CleanupPanel.tsx
import { useEffect, useMemo, useState } from "react";
import { readTextFile, readDir, stat, mkdir, rename, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight,
  Loader2, Sparkles, X, Shield, Trash2, Move,
} from "lucide-react";
import { moveToTrash } from "./trash";
import { parseNoteFile } from "./noteFormat";

interface CatLike {
  id: string;
  name: string;
  mode: "journal" | "notes" | "gallery" | "abba";
  dirName: string;
}

type ActionType = "delete" | "organize";

interface FileEntry {
  path: string;
  displayName: string;
  size: number;
  /** What the scanner thinks should happen. */
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
  "mp4", "mov", "mkv", "m4v", "avi", "ogv", "wmv", "flv",
]);

const SAFE_EXT = new Set(["selah", "md", "json", "txt", "pdf"]);

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

        const main: string[] = Array.isArray(it.mainImages)
          ? it.mainImages.filter((x: any) => typeof x === "string")
          : (typeof it.image === "string" && it.image ? [it.image] : []);
        for (const f of main) claim(f, id);

        const refs: string[] = Array.isArray(it.referenceImages)
          ? it.referenceImages.filter((x: any) => typeof x === "string")
          : [];
        for (const f of refs) claim(f, id);

        if (Array.isArray(it.versions)) {
          for (const v of it.versions) {
            if (v && typeof v.image === "string") claim(v.image, id);
          }
        }

        if (Array.isArray(it.progress)) {
          for (const p of it.progress) {
            if (p && typeof p.image === "string") claim(p.image, id);
          }
        }

        if (typeof it.backstory === "string" && it.backstory) {
          const re = /!\[[^\]]*\]\(([^)]+)\)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(it.backstory)) !== null) {
            const ref = m[1].trim();
            if (/^(https?:|data:|blob:|asset:)/i.test(ref)) continue;
            let decoded = ref;
            try { decoded = decodeURIComponent(ref); } catch {}
            claim(decoded, id);
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
  id: string;
  fileName: string;
  content: string;
}

async function scanAbbaWithFix(dir: string): Promise<FileEntry[]> {
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
      if (!e.name.endsWith(".selah")) continue;
      const fileName = e.name;
      const fileNameBase = fileName.replace(/\.selah$/i, "");

      let content = "";
      try {
        content = await readTextFile(await join(sectionDir, fileName));
      } catch {
        continue;
      }

      let id = fileNameBase;
      try {
        const { frontmatter } = parseNoteFile(content);
        if (typeof frontmatter.id === "string" && frontmatter.id.trim()) {
          id = frontmatter.id.trim();
        }
      } catch {}

      const rec: AbbaNoteRec = { section, id, fileName, content };
      allNotes.push(rec);

      const idKey = `${section}/${id}`;
      if (!noteByKey.has(idKey)) noteByKey.set(idKey, rec);
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
          reason: `Not referenced by note “${note.fileName.replace(/\.selah$/, "")}”`,
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

      let monthFiles: any[] = [];
      try {
        monthFiles = await readDir(monthDir);
      } catch {
        continue;
      }

      const noteContents: { name: string; content: string }[] = [];
      for (const f of monthFiles) {
        if (f.isDirectory || !f.name || !/\.(selah|md)$/i.test(f.name)) continue;
        const baseName = f.name.replace(/\.(selah|md)$/i, "");
        let content = "";
        try {
          content = await readTextFile(await join(monthDir, f.name));
        } catch {}
        noteContents.push({ name: baseName, content });
      }

      const isReferenced = (filename: string): boolean =>
        noteContents.some((nc) => contentMentions(nc.content, filename));

      let assetsEntries: any[] = [];
      try {
        assetsEntries = await readDir(assetsDir);
      } catch {
        continue;
      }

      for (const subEntry of assetsEntries) {
        if (!subEntry.name || subEntry.name.startsWith(".")) continue;

        if (!subEntry.isDirectory) {
          if (/\.tmp$/i.test(subEntry.name)) {
            const full = await join(assetsDir, subEntry.name);
            out.push({
              path: full,
              displayName: subEntry.name,
              size: await fileSizeSafe(full),
              suggested: "delete",
              reason: "Leftover partial conversion",
              safe: true,
            });
            continue;
          }
          if (!isMediaFile(subEntry.name)) continue;
          if (isReferenced(subEntry.name)) continue;
          const full = await join(assetsDir, subEntry.name);
          out.push({
            path: full,
            displayName: subEntry.name,
            size: await fileSizeSafe(full),
            suggested: "delete",
            reason: "Not referenced by any note in this month",
            safe: true,
          });
          continue;
        }

        const folderName = subEntry.name;
        const folderPath = await join(assetsDir, folderName);

        let subFiles: any[] = [];
        try {
          subFiles = await readDir(folderPath);
        } catch {
          continue;
        }

        for (const sf of subFiles) {
          if (!sf.name || sf.name.startsWith(".")) continue;

          if (sf.isDirectory) {
            if (sf.name !== "proxy videos") continue;
            const proxyDir = await join(folderPath, sf.name);

            let proxyFiles: any[] = [];
            try {
              proxyFiles = await readDir(proxyDir);
            } catch {
              continue;
            }

            for (const pf of proxyFiles) {
              if (pf.isDirectory || !pf.name || pf.name.startsWith(".")) continue;

              if (/\.tmp$/i.test(pf.name)) {
                const full = await join(proxyDir, pf.name);
                out.push({
                  path: full,
                  displayName: pf.name,
                  size: await fileSizeSafe(full),
                  suggested: "delete",
                  reason: "Leftover partial conversion",
                  safe: true,
                });
                continue;
              }

              if (!isMediaFile(pf.name)) continue;
              const original = pf.name.replace(/\.(webm|ogv)$/i, "");
              if (isReferenced(original)) continue;

              const full = await join(proxyDir, pf.name);
              out.push({
                path: full,
                displayName: pf.name,
                size: await fileSizeSafe(full),
                suggested: "delete",
                reason: `Proxy for unreferenced "${original}"`,
                safe: true,
              });
            }
            continue;
          }

          if (/\.tmp$/i.test(sf.name)) {
            const full = await join(folderPath, sf.name);
            out.push({
              path: full,
              displayName: sf.name,
              size: await fileSizeSafe(full),
              suggested: "delete",
              reason: "Leftover partial conversion",
              safe: true,
            });
            continue;
          }

          if (!isMediaFile(sf.name)) continue;
          if (isReferenced(sf.name)) continue;

          const full = await join(folderPath, sf.name);
          out.push({
            path: full,
            displayName: sf.name,
            size: await fileSizeSafe(full),
            suggested: "delete",
            reason: `Not referenced by any note (in "${folderName}")`,
            safe: true,
          });
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
  const isTmp = /\.tmp$/i.test(f.displayName);
  if (!isTmp && !isMediaFile(f.displayName)) {
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
  const [appliedLabel, setAppliedLabel] = useState<"fixed" | "deleted">("fixed");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [included, setIncluded] = useState<Record<string, boolean>>({});

  const runScan = async () => {
    const all: Result[] = [];
    for (const cat of categories) {
      const r = await scanOne(cat, vaultPath);
      all.push(r);
    }
    return all.filter((r) => r.files.length > 0);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setPhase("scanning");
    setResults([]);
    setError(null);
    setAppliedCount(0);
    setExpanded(new Set());
    setIncluded({});

    (async () => {
      try {
        const nonEmpty = await runScan();
        if (cancelled) return;
        const inc: Record<string, boolean> = {};
        for (const r of nonEmpty) {
          for (const f of r.files) inc[f.path] = false;
        }
        setResults(nonEmpty);
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
    let fixable = 0;
    let checked = 0;
    for (const f of allFiles) {
      if (!included[f.path]) continue;
      checked++;
      if (f.suggested === "organize" && f.target) fixable++;
    }
    return { fixable, checked, total: allFiles.length };
  }, [allFiles, included]);

  const toggleIncluded = (f: FileEntry) => {
    setIncluded((p) => ({ ...p, [f.path]: !p[f.path] }));
  };

  const selectAllSafe = () => {
    const inc: Record<string, boolean> = {};
    for (const f of allFiles) inc[f.path] = f.safe;
    setIncluded(inc);
  };

  const deselectAll = () => {
    const inc: Record<string, boolean> = {};
    for (const f of allFiles) inc[f.path] = false;
    setIncluded(inc);
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const performApply = async (mode: "fix" | "delete") => {
    setPhase("applying");
    let count = 0;
    const touchedFolders = new Set<string>();

    for (const f of allFiles) {
      if (!included[f.path]) continue;

      let action: ActionType;
      if (mode === "fix") {
        if (f.suggested !== "organize" || !f.target) continue;
        action = "organize";
      } else {
        action = "delete";
      }

      const ok = await applyAction(f, action);
      if (ok) {
        count++;
        touchedFolders.add(parentDirOf(f.path));
        if (f.target && action === "organize") touchedFolders.add(parentDirOf(f.target));
      }
    }

    setAppliedCount(count);
    setAppliedLabel(mode === "fix" ? "fixed" : "deleted");

    for (const folder of touchedFolders) {
      window.dispatchEvent(
        new CustomEvent("folder-changed", { detail: { path: folder } })
      );
      window.dispatchEvent(
        new CustomEvent("file-changed", { detail: { path: folder } })
      );
    }

    const nonEmpty = await runScan();
    const inc: Record<string, boolean> = {};
    for (const r of nonEmpty) {
      for (const f of r.files) inc[f.path] = false;
    }
    if (nonEmpty.length === 0) {
      setResults([]);
      setPhase("done");
    } else {
      setResults(nonEmpty);
      setIncluded(inc);
      setExpanded(new Set(nonEmpty.map((r) => r.categoryId)));
      setPhase("results");
    }
  };

  if (!open) return null;

  const hasChecked = counts.checked > 0;
  const canFix = counts.fixable > 0;

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
              <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-red-300 font-medium">Scan failed.</p>
                <p className="text-xs text-red-400/70 mt-1 break-words">{error}</p>
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
                    leftover {counts.total === 1 ? "file" : "files"} found
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1 flex items-center gap-1.5">
                    <Shield size={11} className="text-emerald-400" />
                    <span>
                      Check what you want to act on, then Fix or Delete.
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
                  const catChecked = r.files.filter((f) => included[f.path]).length;
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
                          {catChecked}/{r.files.length} selected
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
                            const isChecked = included[f.path] ?? false;
                            const isMove =
                              f.suggested === "organize" && !!f.target;
                            return (
                              <label
                                key={f.path}
                                className={`flex items-start gap-3 px-3 py-2 text-xs transition-colors cursor-pointer ${
                                  isChecked ? "bg-[#141819]" : "hover:bg-[#141819]"
                                }`}
                                title={f.path}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleIncluded(f)}
                                  className="mt-1 accent-blue-500 flex-shrink-0 cursor-pointer"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={`truncate font-medium ${
                                        isChecked ? "text-gray-200" : "text-gray-400"
                                      }`}
                                    >
                                      {f.displayName}
                                    </span>
                                    {/* Explicit action badge */}
                                    {isMove ? (
                                      <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex-shrink-0 font-medium">
                                        <Move size={9} /> Move
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/30 text-red-300 flex-shrink-0 font-medium">
                                        <Trash2 size={9} /> Delete
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[10px] text-gray-500 truncate font-mono mt-0.5">
                                    {dir || "."}
                                  </div>
                                  <div className="text-[10px] text-gray-500 mt-1 truncate">
                                    {f.reason}
                                  </div>
                                  {isMove && (
                                    <div className="text-[10px] text-blue-300/80 truncate font-mono mt-0.5">
                                      → {relPath(vaultPath, f.target!)}
                                    </div>
                                  )}
                                </div>
                                <span className="text-gray-500 tabular-nums flex-shrink-0 mt-0.5">
                                  {formatBytes(f.size)}
                                </span>
                              </label>
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
                {appliedLabel === "fixed" ? "Fixed" : "Deleted"}{" "}
                <span className="font-semibold text-gray-100">
                  {appliedCount}
                </span>{" "}
                {appliedCount === 1 ? "file" : "files"}.
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Deleted files went to your system trash and can be restored
                from there.
              </p>
            </div>
          )}
        </div>

        {phase === "results" && results.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
            <div className="text-[11px] text-gray-500">
              {hasChecked
                ? `${counts.checked} selected${
                    canFix ? ` · ${counts.fixable} fixable` : ""
                  }`
                : "nothing selected"}
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
                onClick={() => performApply("fix")}
                disabled={!canFix}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium"
                title="Move selected fixable files to their correct folder"
              >
                <Move size={12} />
                <span>Fix {counts.fixable || ""}</span>
              </button>
              <button
                type="button"
                onClick={() => performApply("delete")}
                disabled={!hasChecked}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded transition-colors font-medium"
                title="Move selected files to the trash"
              >
                <Trash2 size={12} />
                <span>Delete {counts.checked || ""}</span>
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