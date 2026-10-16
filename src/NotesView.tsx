// src/NotesView.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  readDir, readTextFile, writeTextFile, mkdir, stat, rename as fsRename,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
  Plus, FileText, Search, Trash2, Clock, LayoutGrid,
  List as ListIcon, X, Pencil, Folder, FolderPlus, ChevronRight,
  ArrowUpDown, Filter, Pin, Tag, Check, Smile,
} from "lucide-react";
import EmojiPicker, { Theme, EmojiStyle } from "emoji-picker-react";
import { currentEmojiTheme } from "./emojiTheme";
import { useModal } from "./Modal";
import { parseNoteFile, serializeNoteFile } from "./noteFormat";
import { moveToTrash } from "./trash";
import TagPickerModal from "./TagPickerModal";
import { scanAllVaultTags, invalidateTagCache } from "./TagEditor";
import { makeFolderKey, type FolderMetaMap } from "./folderMeta";

interface NotesViewProps {
  sectionDir: string;
  sectionName: string;
  sectionIcon: string;
  categoryId: string;
  vaultPath: string;
  onOpenNote: (note: { path: string; name: string }) => void;
}

interface NoteEntry {
  path: string;
  fileName: string;
  title: string;
  icon: string;
  modified: number;
  created: number;
  wordCount: number;
  tags: string[];
  pinned: boolean;
  /** Relative folder path from section root ("Biology/Unit 2", or "" for root). */
  folderLabel: string;
}

interface FolderEntry {
  name: string;
  path: string;
}

type ViewMode = "grid" | "list";
const VIEW_MODE_KEY = "notes-view-mode";

type SortBy = "modified" | "created" | "title";
const SORT_KEY = "notes-sort-by";
const SORT_LABELS: Record<SortBy, string> = {
  modified: "Last modified",
  created: "Date created",
  title: "Title (A–Z)",
};

type IconPickerState =
  | { kind: "folder"; folder: FolderEntry; top: number; left: number }
  | { kind: "note"; note: NoteEntry; top: number; left: number }
  | null;

function notifyNoteDeleted(targetPath: string) {
  window.dispatchEvent(
    new CustomEvent("note-deleted", { detail: { path: targetPath } })
  );
}

function fmtDate(ms: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch { return ""; }
}

function countWords(body: string): number {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[.*?\]\(.*?\)/g, " ")
    .replace(/\[([^\]]*)\]\(.*?\)/g, "$1")
    .replace(/[#*_>`~\-|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return 0;
  return plain.split(" ").filter(Boolean).length;
}

function mtimeToMs(info: any): number {
  if (!info) return 0;
  const v = info.mtime ?? info.modified;
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Read one .selah file into a NoteEntry. Returns null on read failure. */
async function readNoteEntry(full: string, fileName: string): Promise<NoteEntry | null> {
  let icon = "";
  let title = fileName.replace(/\.selah$/i, "");
  let tags: string[] = [];
  let pinned = false;
  let created = 0;
  let wordCount = 0;

  try {
    const raw = await readTextFile(full);
    const { frontmatter, body } = parseNoteFile(raw);
    icon = (frontmatter.icon as string) || "";
    const fmTitle = (frontmatter.title as string) || "";
    if (fmTitle) title = fmTitle;
    if (Array.isArray(frontmatter.tags)) {
      tags = (frontmatter.tags as any[]).filter(
        (t): t is string => typeof t === "string"
      );
    }
    pinned = frontmatter.pinned === true;
    if (typeof frontmatter.created === "string") {
      const t = new Date(frontmatter.created).getTime();
      if (Number.isFinite(t)) created = t;
    }
    wordCount = countWords(body);
  } catch {
    return null;
  }

  let modified = 0;
  try { modified = mtimeToMs(await stat(full)); } catch {}
  if (!created) created = modified;

  return {
    path: full,
    fileName,
    title,
    icon,
    modified,
    created,
    wordCount,
    tags,
    pinned,
    folderLabel: "",
  };
}

/** Recursively walk `currentDir` under `rootDir` collecting every .selah
 *  note. `folderLabel` on each entry is the path relative to `rootDir`,
 *  without the file name. */
async function scanNotesRecursive(
  rootDir: string,
  currentDir: string,
  out: NoteEntry[],
  depth = 0
): Promise<void> {
  if (depth > 8) return;
  try {
    const entries = await readDir(currentDir);
    for (const e of entries) {
      if (!e.name || e.name.startsWith(".")) continue;
      if (e.name === "assets" || e.name === "_attachments") continue;
      const full = await join(currentDir, e.name);
      if (e.isDirectory) {
        await scanNotesRecursive(rootDir, full, out, depth + 1);
      } else if (e.name.endsWith(".selah")) {
        const entry = await readNoteEntry(full, e.name);
        if (!entry) continue;
        const fullNorm = normPath(full);
        const rootNorm = normPath(rootDir).replace(/\/+$/, "");
        if (fullNorm.startsWith(rootNorm + "/")) {
          const rel = fullNorm.slice(rootNorm.length + 1);
          const lastSlash = rel.lastIndexOf("/");
          entry.folderLabel = lastSlash > 0 ? rel.slice(0, lastSlash) : "";
        }
        out.push(entry);
      }
    }
  } catch {}
}

export default function NotesView({
  sectionDir,
  sectionName,
  sectionIcon,
  categoryId,
  vaultPath,
  onOpenNote,
}: NotesViewProps) {
  const [subPath, setSubPath] = useState<string>("");
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [folderMeta, setFolderMeta] = useState<FolderMetaMap>({});

  const [sortBy, setSortBy] = useState<SortBy>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY);
      if (v === "created" || v === "title" || v === "modified") return v;
    } catch {}
    return "modified";
  });
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    note: NoteEntry;
    x: number;
    y: number;
  } | null>(null);

  const [folderCtx, setFolderCtx] = useState<{
    folder: FolderEntry;
    x: number;
    y: number;
  } | null>(null);

  const [iconPicker, setIconPicker] = useState<IconPickerState>(null);
  const iconPickerRef = useRef<HTMLDivElement>(null);

  const [vaultTags, setVaultTags] = useState<string[]>([]);
  const [tagPickerNote, setTagPickerNote] = useState<NoteEntry | null>(null);

  const filterRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      return v === "list" ? "list" : "grid";
    } catch { return "grid"; }
  });
  const { modal, promptAsync, confirmAsync } = useModal();

  // True when the current view should ignore folder boundaries: either a
  // tag filter or pinned-only is on, or the user has typed a search term.
  // In those cases we show notes from every folder in the section, and
  // each card gets a folder chip so it's obvious where it came from.
  const q = query.trim();
  const unscope = activeTags.size > 0 || pinnedOnly || q.length > 0;

  const updateViewMode = (next: ViewMode) => {
    setViewMode(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch {}
  };

  const currentDir = async () => {
    if (!subPath) return sectionDir;
    return await join(sectionDir, subPath);
  };

  // Same key format the Sidebar uses when it writes folderMeta.
  const folderKeyFor = (absPath: string): string => {
    const rootNorm = normPath(sectionDir).replace(/\/+$/, "");
    const norm = normPath(absPath).replace(/\/+$/, "");
    if (!norm.startsWith(rootNorm)) {
      const parts = norm.split("/").filter(Boolean);
      return makeFolderKey(categoryId, ...parts.slice(-2));
    }
    const rel = norm.slice(rootNorm.length).replace(/^\/+/, "");
    const parts = rel.split("/").filter(Boolean);
    return makeFolderKey(categoryId, ...parts);
  };

  const loadFolderMeta = async () => {
    try {
      const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
      const meta = JSON.parse(raw);
      setFolderMeta(meta.folderMeta || {});
    } catch {
      setFolderMeta({});
    }
  };

  const saveFolderMeta = async (patch: Record<string, any>) => {
    const next: FolderMetaMap = { ...folderMeta, ...patch };
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (!v.icon && !v.color) delete next[k];
    }
    setFolderMeta(next);
    try {
      let meta: any = {};
      try {
        const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
        meta = JSON.parse(raw);
      } catch {}
      meta.folderMeta = next;
      await writeTextFile(
        await join(vaultPath, ".vault_metadata.json"),
        JSON.stringify(meta, null, 2)
      );
      window.dispatchEvent(new Event("metadata-changed"));
    } catch (e) {
      console.error("[notes] folder meta save failed:", e);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      try { await mkdir(sectionDir, { recursive: true }); } catch {}

      await loadFolderMeta();

      // Always walk the whole section. This keeps tag counts, search, and
      // filtered views consistent regardless of which folder is open.
      const all: NoteEntry[] = [];
      await scanNotesRecursive(sectionDir, sectionDir, all);
      setNotes(all);

      // Folders are per-current-directory: they're navigation, not content.
      const dir = await currentDir();
      const entries = await readDir(dir);
      const folderList: FolderEntry[] = [];
      for (const e of entries) {
        if (!e.name) continue;
        if (e.name.startsWith(".")) continue;
        if (!e.isDirectory) continue;
        if (e.name === "assets" || e.name === "_attachments") continue;
        folderList.push({ name: e.name, path: await join(dir, e.name) });
      }
      folderList.sort((a, b) => a.name.localeCompare(b.name));
      setFolders(folderList);
    } catch (err) {
      console.error("[notes] load failed:", err);
      setNotes([]);
      setFolders([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionDir, subPath]);

  // Vault-wide tag scan for the picker modal.
  useEffect(() => {
    if (!vaultPath) return;
    let cancelled = false;
    scanAllVaultTags(vaultPath).then((list) => {
      if (!cancelled) setVaultTags(list);
    });
    return () => { cancelled = true; };
  }, [vaultPath]);

  // Listen for metadata changes (e.g. from the Sidebar) so folder icons stay
  // in sync across views.
  useEffect(() => {
    const onMetaChanged = () => { loadFolderMeta(); };
    window.addEventListener("metadata-changed", onMetaChanged);
    return () => window.removeEventListener("metadata-changed", onMetaChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath]);

  // Follow the sidebar's active folder when it changes.
  useEffect(() => {
    const onFolder = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.folderPath) return;
      const rel = normPath(String(detail.folderPath))
        .replace(normPath(sectionDir).replace(/\/+$/, ""), "")
        .replace(/^\/+/, "");
      setSubPath(rel);
    };
    window.addEventListener("notes-folder-changed", onFolder);
    return () => window.removeEventListener("notes-folder-changed", onFolder);
  }, [sectionDir]);

  useEffect(() => {
    const onFileChanged = (e: Event) => {
      const p = normPath((e as CustomEvent).detail?.path || "");
      if (!p) return;
      if (p.startsWith(normPath(sectionDir))) load();
    };
    const onFolderChanged = (e: Event) => {
      const p = normPath((e as CustomEvent).detail?.path || "");
      if (!p) return;
      const dir = normPath(sectionDir);
      if (p === dir || p.startsWith(dir + "/")) load();
    };
    // Note icons (and titles/tags) live in frontmatter. When the sidebar
    // changes a note's icon it fires `note-frontmatter-changed`, not
    // `file-changed`, so we need to listen for it explicitly to keep the
    // main-view cards in sync with the sidebar tree.
    const onFrontmatterChanged = (e: Event) => {
      const p = normPath((e as CustomEvent).detail?.path || "");
      if (!p) return;
      if (p.startsWith(normPath(sectionDir))) load();
    };
    window.addEventListener("file-changed", onFileChanged);
    window.addEventListener("folder-changed", onFolderChanged);
    window.addEventListener("note-frontmatter-changed", onFrontmatterChanged);
    return () => {
      window.removeEventListener("file-changed", onFileChanged);
      window.removeEventListener("folder-changed", onFolderChanged);
      window.removeEventListener("note-frontmatter-changed", onFrontmatterChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionDir, subPath]);

  // Close the filter/sort dropdowns on outside click or Escape.
  useEffect(() => {
    if (!filterOpen && !sortOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (filterRef.current?.contains(t)) return;
      if (sortRef.current?.contains(t)) return;
      setFilterOpen(false);
      setSortOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setFilterOpen(false); setSortOpen(false); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [filterOpen, sortOpen]);

  // Close the right-click context menu on outside click or Escape.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCtxMenu(null); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // Folder context menu + emoji picker dismissal.
  useEffect(() => {
    if (!folderCtx && !iconPicker) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (iconPickerRef.current?.contains(t)) return;
      setFolderCtx(null);
      setIconPicker(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFolderCtx(null);
        setIconPicker(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [folderCtx, iconPicker]);

  // Tag counts always reflect the whole section — not just the folder
  // you're looking at — so the numbers stay accurate when you filter.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) {
      for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  }, [notes]);

  const filtered = useMemo(() => {
    let list = notes;

    // Scope by folder only when the user isn't filtering or searching.
    // Filtering by tag/pin and typing in the search box are intentionally
    // cross-folder.
    if (!unscope) {
      const rootNorm = normPath(sectionDir).replace(/\/+$/, "");
      if (!subPath) {
        list = list.filter((n) => {
          const rel = normPath(n.path).slice(rootNorm.length + 1);
          return !rel.includes("/");
        });
      } else {
        const prefix = normPath(subPath).replace(/^\/+|\/+$/g, "");
        list = list.filter((n) => {
          const rel = normPath(n.path).slice(rootNorm.length + 1);
          const folder = rel.split("/").slice(0, -1).join("/");
          return folder === prefix;
        });
      }
    }

    if (q) {
      const lq = q.toLowerCase();
      list = list.filter(
        (n) =>
          n.title.toLowerCase().includes(lq) ||
          n.tags.some((t) => t.toLowerCase().includes(lq)) ||
          n.folderLabel.toLowerCase().includes(lq)
      );
    }
    if (activeTags.size > 0) {
      list = list.filter((n) => n.tags.some((t) => activeTags.has(t)));
    }
    if (pinnedOnly) {
      list = list.filter((n) => n.pinned);
    }

    const sorted = [...list];
    if (sortBy === "title") sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sortBy === "created") sorted.sort((a, b) => b.created - a.created);
    else sorted.sort((a, b) => b.modified - a.modified);

    return sorted;
  }, [notes, sectionDir, subPath, q, unscope, activeTags, pinnedOnly, sortBy]);

  const pinnedNotes = useMemo(
    () =>
      pinnedOnly || sortBy === "title"
        ? []
        : filtered.filter((n) => n.pinned),
    [filtered, pinnedOnly, sortBy]
  );
  const otherNotes = useMemo(
    () => (pinnedNotes.length ? filtered.filter((n) => !n.pinned) : filtered),
    [filtered, pinnedNotes.length]
  );

  const filteredFolders = useMemo(() => {
    // Hide folder shortcuts when we're showing cross-folder results.
    if (unscope) return [];
    return folders;
  }, [folders, unscope]);

  const activeFilterCount = activeTags.size + (pinnedOnly ? 1 : 0);

  const clearAllFilters = () => {
    setActiveTags(new Set());
    setPinnedOnly(false);
  };

  const uniqueNoteName = (): string => {
    // Uniqueness is per-folder: the same file name can exist in different
    // subfolders without conflict.
    const dir = normPath(sectionDir).replace(/\/+$/, "");
    const prefix = subPath ? `${dir}/${normPath(subPath).replace(/^\/+|\/+$/g, "")}/` : `${dir}/`;
    const existing = new Set(
      notes
        .filter((n) => {
          const np = normPath(n.path);
          if (!np.startsWith(prefix)) return false;
          const rest = np.slice(prefix.length);
          return !rest.includes("/");
        })
        .map((n) => n.fileName)
    );
    let i = 1;
    while (true) {
      const candidate = `Untitled-${i}.selah`;
      if (!existing.has(candidate)) return candidate;
      i++;
    }
  };

  const createNote = async () => {
    try {
      const dir = await currentDir();
      const fileName = uniqueNoteName();
      const fullPath = await join(dir, fileName);
      const now = new Date().toISOString();
      await writeTextFile(fullPath, `---\ncreated: ${now}\nmodified: ${now}\n---\n\n`);
      await load();
      onOpenNote({ path: fullPath, name: fileName });
    } catch (e) { console.error("[notes] create failed:", e); }
  };

  const createFolder = async () => {
    const raw = await promptAsync("Folder name:");
    if (!raw) return;
    const name = raw.trim().replace(/[\\/:*?"<>|]/g, "-");
    if (!name) return;
    try {
      const dir = await currentDir();
      await mkdir(await join(dir, name), { recursive: true });
      await load();
    } catch (e) { console.error("[notes] create folder failed:", e); }
  };

  const deleteNote = async (note: NoteEntry) => {
    const ok = await confirmAsync(`Move "${note.title}" to the trash?`);
    if (!ok) return;
    try {
      notifyNoteDeleted(note.path);
      await moveToTrash(note.path);
      await load();
    } catch (e) { console.error("[notes] delete failed:", e); }
  };

  const deleteFolder = async (folder: FolderEntry) => {
    const ok = await confirmAsync(`Move the folder "${folder.name}" and everything inside to the trash?`);
    if (!ok) return;
    try {
      notifyNoteDeleted(folder.path);
      await moveToTrash(folder.path);

      // Clean up any folderMeta keys that referred to this folder or its
      // descendants, so we don't leave orphaned icons behind.
      const prefix = folderKeyFor(folder.path) + "/";
      const selfKey = folderKeyFor(folder.path);
      const cleaned: FolderMetaMap = {};
      for (const k of Object.keys(folderMeta)) {
        if (k !== selfKey && !k.startsWith(prefix)) cleaned[k] = folderMeta[k];
      }
      if (Object.keys(cleaned).length !== Object.keys(folderMeta).length) {
        await saveFolderMeta(cleaned);
      }

      await load();
    } catch (e) { console.error("[notes] delete folder failed:", e); }
  };

  const renameNote = async (note: NoteEntry) => {
    const next = await promptAsync("Rename note:", note.title);
    if (!next || next === note.title) return;
    try {
      const raw = await readTextFile(note.path);
      const { frontmatter, body } = parseNoteFile(raw);
      const fm = { ...frontmatter, title: next.trim(), modified: new Date().toISOString() };
      await writeTextFile(note.path, serializeNoteFile(fm, body));
      await load();
    } catch (e) { console.error("[notes] rename failed:", e); }
  };

  const renameFolder = async (folder: FolderEntry) => {
    const next = await promptAsync("Rename folder:", folder.name);
    if (!next || next === folder.name) return;
    const safe = next.trim().replace(/[\\/:*?"<>|]/g, "-");
    if (!safe || safe === folder.name) return;
    try {
      const parent = folder.path.replace(/[\\/][^\\/]+$/, "");
      const dest = await join(parent, safe);
      await fsRename(folder.path, dest);

      // Migrate folderMeta keys: remove the old key (and any descendant keys)
      // and re-write them under the new prefix.
      const oldKey = folderKeyFor(folder.path);
      const newKey = folderKeyFor(dest);
      const oldPrefix = oldKey + "/";
      const newPrefix = newKey + "/";
      const updated: FolderMetaMap = {};
      let changed = false;
      for (const k of Object.keys(folderMeta)) {
        if (k === oldKey) {
          updated[newKey] = folderMeta[k];
          changed = true;
        } else if (k.startsWith(oldPrefix)) {
          updated[newPrefix + k.slice(oldPrefix.length)] = folderMeta[k];
          changed = true;
        } else {
          updated[k] = folderMeta[k];
        }
      }
      if (changed) await saveFolderMeta(updated);

      await load();
    } catch (e) { console.error("[notes] rename folder failed:", e); }
  };

  const writeNoteMeta = async (
    note: NoteEntry,
    patch: { tags?: string[]; pinned?: boolean; icon?: string }
  ) => {
    try {
      const raw = await readTextFile(note.path);
      const { frontmatter, body } = parseNoteFile(raw);
      const merged: any = { ...frontmatter };
      if (patch.tags !== undefined) {
        if (patch.tags.length > 0) merged.tags = patch.tags;
        else delete merged.tags;
      }
      if (patch.pinned !== undefined) {
        if (patch.pinned) merged.pinned = true;
        else delete merged.pinned;
      }
      if (patch.icon !== undefined) {
        if (patch.icon) merged.icon = patch.icon;
        else delete merged.icon;
      }
      await writeTextFile(note.path, serializeNoteFile(merged, body));
      window.dispatchEvent(
        new CustomEvent("file-changed", { detail: { path: note.path } })
      );
      window.dispatchEvent(
        new CustomEvent("note-frontmatter-changed", { detail: { path: note.path } })
      );
      await load();
    } catch (e) {
      console.error("[notes] write meta failed:", e);
    }
  };

  const applyIcon = async (emoji: string) => {
    if (!iconPicker) return;
    if (iconPicker.kind === "folder") {
      const key = folderKeyFor(iconPicker.folder.path);
      const prev = folderMeta[key] || {};
      await saveFolderMeta({ [key]: { ...prev, icon: emoji } });
    } else {
      await writeNoteMeta(iconPicker.note, { icon: emoji });
    }
    if (emoji === "") setIconPicker(null);
  };

  const togglePin = async (note: NoteEntry) => {
    await writeNoteMeta(note, { pinned: !note.pinned });
  };

  const openTagPicker = (note: NoteEntry) => {
    setCtxMenu(null);
    setTagPickerNote(note);
  };

  const commitTags = async (next: string[]) => {
    if (!tagPickerNote) return;
    await writeNoteMeta(tagPickerNote, { tags: next });
    invalidateTagCache();
    if (vaultPath) {
      scanAllVaultTags(vaultPath, true).then(setVaultTags);
    }
  };

  const crumbs = useMemo(() => {
    if (!subPath) return [] as { label: string; sub: string }[];
    const parts = normPath(subPath).split("/").filter(Boolean);
    return parts.map((p, i) => ({
      label: p,
      sub: parts.slice(0, i + 1).join("/"),
    }));
  }, [subPath]);

  const renderFolders = () => (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mb-6">
      {filteredFolders.map((f) => {
        const fKey = folderKeyFor(f.path);
        const customIcon = folderMeta[fKey]?.icon;
        return (
          <div
            key={f.path}
            role="button"
            tabIndex={0}
            onClick={() => setSubPath(subPath ? `${subPath}/${f.name}` : f.name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setSubPath(subPath ? `${subPath}/${f.name}` : f.name);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setFolderCtx({ folder: f, x: e.clientX, y: e.clientY });
            }}
            className="group relative flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] cursor-pointer transition-colors"
          >
            {customIcon ? (
              <span className="text-lg leading-none flex-shrink-0">{customIcon}</span>
            ) : (
              <Folder size={16} className="text-amber-400 flex-shrink-0" />
            )}
            <span className="text-sm text-gray-200 truncate flex-1">{f.name}</span>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); renameFolder(f); }}
                className="p-1 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136]"
                title="Rename"
              >
                <Pencil size={11} />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); deleteFolder(f); }}
                className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-[#2a3136]"
                title="Delete"
              >
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderNoteGrid = (list: NoteEntry[]) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {list.map((n) => (
        <div
          key={n.path}
          role="button"
          tabIndex={0}
          onClick={() => onOpenNote({ path: n.path, name: n.fileName })}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenNote({ path: n.path, name: n.fileName });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ note: n, x: e.clientX, y: e.clientY });
          }}
          className="group relative text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] transition-colors p-4 flex flex-col min-h-[8rem] cursor-pointer"
        >
          {n.pinned && (
            <Pin
              size={11}
              className="absolute top-2 left-2 text-blue-400"
              fill="currentColor"
            />
          )}
          <div className="flex items-start gap-2 mb-2">
            <span className="text-xl flex-shrink-0 leading-none">{n.icon || "📄"}</span>
            <h4 className="text-sm font-medium text-gray-100 truncate flex-1 pt-0.5">{n.title}</h4>
          </div>
          {unscope && n.folderLabel && (
            <div
              className="flex items-center gap-1 text-[10px] text-blue-300/70 mb-1.5 truncate"
              title={n.folderLabel}
            >
              <Folder size={9} className="flex-shrink-0" />
              <span className="truncate">{n.folderLabel}</span>
            </div>
          )}
          {n.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1">
              {n.tags.slice(0, 3).map((t) => (
                <span
                  key={t}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 truncate max-w-[80px]"
                  title={t}
                >
                  {t}
                </span>
              ))}
              {n.tags.length > 3 && (
                <span className="text-[10px] text-gray-500" title={n.tags.join(", ")}>
                  +{n.tags.length - 3}
                </span>
              )}
            </div>
          )}
          <div className="mt-auto pt-2 flex items-center gap-2 text-[10px] text-gray-500 flex-wrap">
            {n.modified > 0 && (
              <span className="flex items-center gap-1"><Clock size={9} /> {fmtDate(n.modified)}</span>
            )}
            {n.wordCount > 0 && (
              <>
                <span className="text-gray-700">•</span>
                <span>{n.wordCount} {n.wordCount === 1 ? "word" : "words"}</span>
              </>
            )}
          </div>
          <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); togglePin(n); }}
              className={`p-1 rounded bg-black/60 hover:bg-black/80 ${n.pinned ? "text-blue-400" : "text-white"}`}
              title={n.pinned ? "Unpin" : "Pin"}
            >
              <Pin size={11} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); renameNote(n); }}
              className="p-1 rounded bg-black/60 text-white hover:bg-black/80"
              title="Rename"
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); deleteNote(n); }}
              className="p-1 rounded bg-black/60 text-white hover:bg-red-600"
              title="Delete"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  const renderNoteList = (list: NoteEntry[]) => (
    <div className="space-y-2">
      {list.map((n) => (
        <div
          key={n.path}
          role="button"
          tabIndex={0}
          onClick={() => onOpenNote({ path: n.path, name: n.fileName })}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenNote({ path: n.path, name: n.fileName });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ note: n, x: e.clientX, y: e.clientY });
          }}
          className="group w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] transition-colors p-3 flex items-center gap-3 cursor-pointer"
        >
          <span className="text-2xl flex-shrink-0 leading-none">{n.icon || "📄"}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-100 truncate flex items-center gap-1.5">
              {n.pinned && (
                <Pin size={11} className="text-blue-400 flex-shrink-0" fill="currentColor" />
              )}
              <span className="truncate">{n.title}</span>
            </div>
            {unscope && n.folderLabel && (
              <div
                className="flex items-center gap-1 text-[10px] text-blue-300/70 mt-0.5 truncate"
                title={n.folderLabel}
              >
                <Folder size={9} className="flex-shrink-0" />
                <span className="truncate">{n.folderLabel}</span>
              </div>
            )}
            {n.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {n.tags.slice(0, 4).map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 truncate max-w-[90px]"
                    title={t}
                  >
                    {t}
                  </span>
                ))}
                {n.tags.length > 4 && (
                  <span className="text-[10px] text-gray-500" title={n.tags.join(", ")}>
                    +{n.tags.length - 4}
                  </span>
                )}
              </div>
            )}
            <div className="text-[10px] text-gray-500 mt-1 flex items-center gap-2">
              {n.modified > 0 && (
                <span className="flex items-center gap-1"><Clock size={9} /> {fmtDate(n.modified)}</span>
              )}
              {n.wordCount > 0 && (
                <>
                  <span className="text-gray-700">•</span>
                  <span>{n.wordCount} words</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); togglePin(n); }}
              className={`p-1.5 rounded hover:bg-[#2a3136] ${n.pinned ? "text-blue-400" : "text-gray-500 hover:text-gray-100"}`}
              title={n.pinned ? "Unpin" : "Pin"}
            >
              <Pin size={13} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); renameNote(n); }}
              className="p-1.5 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136]"
              title="Rename"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); deleteNote(n); }}
              className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-[#2a3136]"
              title="Delete"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  // Scoped count: how many notes exist in the currently-visible folder, so
  // the header count is honest about what's on screen.
  const scopedTotal = useMemo(() => {
    if (unscope) return notes.length;
    const rootNorm = normPath(sectionDir).replace(/\/+$/, "");
    if (!subPath) {
      return notes.filter((n) => {
        const rel = normPath(n.path).slice(rootNorm.length + 1);
        return !rel.includes("/");
      }).length;
    }
    const prefix = normPath(subPath).replace(/^\/+|\/+$/g, "");
    return notes.filter((n) => {
      const rel = normPath(n.path).slice(rootNorm.length + 1);
      const folder = rel.split("/").slice(0, -1).join("/");
      return folder === prefix;
    }).length;
  }, [notes, sectionDir, subPath, unscope]);

  const pickerLabel = iconPicker
    ? iconPicker.kind === "folder"
      ? iconPicker.folder.name
      : iconPicker.note.title
    : "";

  return (
    <div className="w-full h-full overflow-y-auto bg-[#0f1315]">
      {modal}

      {tagPickerNote && (
        <TagPickerModal
          noteTitle={tagPickerNote.title}
          initialTags={tagPickerNote.tags}
          allTags={vaultTags}
          onCommit={commitTags}
          onClose={() => setTagPickerNote(null)}
        />
      )}

      {ctxMenu && (
        <div
          className="fixed z-[400] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-52"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => { togglePin(ctxMenu.note); setCtxMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
          >
            <Pin size={13} />
            <span>{ctxMenu.note.pinned ? "Unpin" : "Pin"}</span>
          </button>
          <button
            type="button"
            onClick={() => openTagPicker(ctxMenu.note)}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
          >
            <Tag size={13} />
            <span>Edit tags…</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIconPicker({
                kind: "note",
                note: ctxMenu.note,
                top: Math.max(12, Math.min(ctxMenu.y, window.innerHeight - 460 - 12)),
                left: Math.max(12, Math.min(ctxMenu.x, window.innerWidth - 340 - 12)),
              });
              setCtxMenu(null);
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
          >
            <Smile size={13} />
            <span>Change icon</span>
          </button>
          <button
            type="button"
            onClick={() => { renameNote(ctxMenu.note); setCtxMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2 border-t border-[#2a3136]"
          >
            <Pencil size={13} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            onClick={() => { deleteNote(ctxMenu.note); setCtxMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2"
          >
            <Trash2 size={13} />
            <span>Move to trash</span>
          </button>
        </div>
      )}

      {folderCtx && (
        <div
          className="fixed z-[400] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-48"
          style={{ top: folderCtx.y, left: folderCtx.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              const W = 340;
              const H = 460;
              setIconPicker({
                kind: "folder",
                folder: folderCtx.folder,
                top: Math.max(12, Math.min(folderCtx.y, window.innerHeight - H - 12)),
                left: Math.max(12, Math.min(folderCtx.x, window.innerWidth - W - 12)),
              });
              setFolderCtx(null);
            }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
          >
            <Smile size={13} />
            <span>Change icon</span>
          </button>
          <button
            type="button"
            onClick={() => { renameFolder(folderCtx.folder); setFolderCtx(null); }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2 border-t border-[#2a3136]"
          >
            <Pencil size={13} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            onClick={() => { deleteFolder(folderCtx.folder); setFolderCtx(null); }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2"
          >
            <Trash2 size={13} />
            <span>Move to trash</span>
          </button>
        </div>
      )}

      {iconPicker && createPortal(
        <div
          ref={iconPickerRef}
          className="fixed z-[500] bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl overflow-hidden"
          style={{ top: iconPicker.top, left: iconPicker.left }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136]">
            <span className="text-xs text-gray-400 truncate">
              Icon for <span className="text-gray-200">{pickerLabel}</span>
            </span>
            <button
              onClick={() => setIconPicker(null)}
              className="text-gray-500 hover:text-gray-300 p-0.5"
              title="Close"
            >
              <X size={12} />
            </button>
          </div>
          <EmojiPicker
            theme={Theme.DARK}
            emojiStyle={EmojiStyle.NATIVE}
            onEmojiClick={(d) => applyIcon(d.emoji)}
            width={320}
            height={360}
            previewConfig={{ showPreview: false }}
          />
          <button
            onClick={() => applyIcon('')}
            className="w-full text-left text-xs text-gray-500 hover:text-red-400 hover:bg-[#2a3136] px-3 py-2 border-t border-[#2a3136]"
          >
            Remove icon
          </button>
        </div>,
        document.body
      )}

      <div className="max-w-6xl mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-4xl flex-shrink-0 leading-none">{sectionIcon || "🗒️"}</span>
            <h2 className="text-3xl font-bold text-gray-100 truncate">{sectionName}</h2>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center bg-[#0f1315] border border-[#30363d] rounded p-0.5">
              <button
                type="button"
                onClick={() => updateViewMode("grid")}
                className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${
                  viewMode === "grid" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
                }`}
                title="Grid"
              >
                <LayoutGrid size={13} />
              </button>
              <button
                type="button"
                onClick={() => updateViewMode("list")}
                className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${
                  viewMode === "list" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"
                }`}
                title="List"
              >
                <ListIcon size={13} />
              </button>
            </div>
            <button
              onClick={createFolder}
              className="flex items-center gap-1.5 text-sm bg-[#1e2327] hover:bg-[#2a3136] border border-[#30363d] text-gray-200 px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
            >
              <FolderPlus size={14} /> <span>New Folder</span>
            </button>
            <button
              onClick={createNote}
              className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
            >
              <Plus size={14} /> <span>New Note</span>
            </button>
          </div>
        </div>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 mb-5 text-xs text-gray-500 flex-wrap">
          <button
            onClick={() => setSubPath("")}
            className="hover:text-gray-200 px-1.5 py-0.5 rounded hover:bg-[#1e2327]"
          >
            {sectionName}
          </button>
          {crumbs.map((c, i) => (
            <span key={c.sub} className="flex items-center gap-1">
              <ChevronRight size={11} className="text-gray-700" />
              {i === crumbs.length - 1 ? (
                <span className="text-gray-300 px-1.5">{c.label}</span>
              ) : (
                <button
                  onClick={() => setSubPath(c.sub)}
                  className="hover:text-gray-200 px-1.5 py-0.5 rounded hover:bg-[#1e2327]"
                >
                  {c.label}
                </button>
              )}
            </span>
          ))}
        </div>

        {(notes.length > 0 || folders.length > 0) && (
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1">
              <Search
                size={13}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={unscope ? "Search all folders…" : "Search this folder…"}
                className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200 p-1"
                  title="Clear"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Sort dropdown */}
            <div className="relative flex-shrink-0" ref={sortRef}>
              <button
                type="button"
                onClick={() => { setSortOpen((o) => !o); setFilterOpen(false); }}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded border transition-colors cursor-pointer ${
                  sortOpen
                    ? "bg-blue-600/15 border-blue-500/50 text-blue-300"
                    : "bg-[#161a1d] border-[#2a3136] text-gray-400 hover:text-gray-200 hover:border-[#3a4147]"
                }`}
                title="Sort notes"
              >
                <ArrowUpDown size={13} />
                <span className="hidden md:inline">{SORT_LABELS[sortBy]}</span>
              </button>
              {sortOpen && (
                <div className="absolute right-0 top-full mt-1 z-40 w-44 bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1">
                  {(Object.keys(SORT_LABELS) as SortBy[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        setSortBy(k);
                        try { localStorage.setItem(SORT_KEY, k); } catch {}
                        setSortOpen(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[#2a3136] flex items-center justify-between ${
                        sortBy === k ? "text-gray-100" : "text-gray-300"
                      }`}
                    >
                      <span>{SORT_LABELS[k]}</span>
                      {sortBy === k && <span className="text-blue-400 text-xs">●</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Filter dropdown */}
            <div className="relative flex-shrink-0" ref={filterRef}>
              <button
                type="button"
                onClick={() => { setFilterOpen((o) => !o); setSortOpen(false); }}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded border transition-colors cursor-pointer ${
                  filterOpen || activeFilterCount > 0
                    ? "bg-blue-600/15 border-blue-500/50 text-blue-300"
                    : "bg-[#161a1d] border-[#2a3136] text-gray-400 hover:text-gray-200 hover:border-[#3a4147]"
                }`}
                title="Filter notes"
              >
                <Filter size={13} />
                <span>Filter</span>
                {activeFilterCount > 0 && (
                  <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-blue-600 text-white text-[10px] font-semibold tabular-nums">
                    {activeFilterCount}
                  </span>
                )}
              </button>
              {filterOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-40 w-[320px] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl overflow-hidden"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 pt-3 pb-2 border-b border-[#2a3136]">
                    <button
                      type="button"
                      onClick={() => setPinnedOnly((v) => !v)}
                      className={`w-full flex items-center justify-between text-xs px-2 py-1.5 rounded transition-colors ${
                        pinnedOnly
                          ? "bg-blue-600/20 text-blue-200"
                          : "text-gray-300 hover:bg-[#2a3136]"
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <Pin size={11} /> Pinned only
                      </span>
                      {pinnedOnly && <Check size={12} />}
                    </button>
                  </div>

                  {allTags.length > 0 && (
                    <div className="px-3 pt-3 pb-2 max-h-64 overflow-y-auto">
                      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
                        <Tag size={10} /> Tags
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {allTags.map(([tag, count]) => {
                          const active = activeTags.has(tag);
                          return (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => {
                                setActiveTags((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(tag)) next.delete(tag);
                                  else next.add(tag);
                                  return next;
                                });
                              }}
                              className={`px-2.5 py-1 rounded-full text-[11px] transition-colors cursor-pointer flex items-center gap-1 ${
                                active
                                  ? "bg-blue-600 text-white border border-blue-500"
                                  : "bg-[#0f1315] text-gray-400 hover:text-gray-100 border border-[#2a3136] hover:border-[#3a4147]"
                              }`}
                            >
                              <span>{tag}</span>
                              <span className={active ? "text-blue-100" : "text-gray-600"}>
                                {count}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between px-3 py-2 border-t border-[#2a3136] bg-[#1a1e21]">
                    <span className="text-[10px] text-gray-500">
                      {activeFilterCount > 0
                        ? `${filtered.length} of ${notes.length} shown`
                        : `${scopedTotal} note${scopedTotal === 1 ? "" : "s"}`}
                    </span>
                    {activeFilterCount > 0 && (
                      <button
                        type="button"
                        onClick={clearAllFilters}
                        className="text-[11px] text-gray-400 hover:text-gray-100 px-2 py-0.5 rounded hover:bg-[#2a3136] transition-colors"
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {unscope && (
          <div className="text-[11px] text-gray-500 mb-3 flex items-center gap-1.5">
            <Folder size={11} className="text-blue-400/70" />
            <span>
              Showing {filtered.length} {filtered.length === 1 ? "note" : "notes"} from all {new Set(notes.map(n => n.folderLabel || "(root)")).size} folder{new Set(notes.map(n => n.folderLabel || "(root)")).size === 1 ? "" : "s"}
            </span>
          </div>
        )}

        {/* Active filter pills */}
        {activeFilterCount > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-4">
            {pinnedOnly && (
              <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-blue-600/15 border border-blue-500/40 text-blue-300">
                <Pin size={10} />
                <span>Pinned</span>
                <button
                  type="button"
                  onClick={() => setPinnedOnly(false)}
                  className="text-blue-300/70 hover:text-blue-100 ml-0.5"
                  title="Remove filter"
                >
                  <X size={10} />
                </button>
              </span>
            )}
            {Array.from(activeTags).map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-blue-600/15 border border-blue-500/40 text-blue-300"
              >
                <Tag size={10} />
                <span>{tag}</span>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTags((prev) => {
                      const next = new Set(prev);
                      next.delete(tag);
                      return next;
                    });
                  }}
                  className="text-blue-300/70 hover:text-blue-100 ml-0.5"
                  title="Remove filter"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-[11px] text-gray-500 hover:text-gray-200 px-1.5 py-0.5 rounded hover:bg-[#1e2327] transition-colors cursor-pointer"
            >
              Clear all
            </button>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-sm text-gray-500">Loading notes…</div>
        ) : notes.length === 0 && folders.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-gray-500 mt-24">
            <FileText size={32} className="mb-3 opacity-60" />
            <p className="text-sm">
              {unscope
                ? "No notes match the current filters."
                : subPath
                  ? "This folder is empty."
                  : "No notes yet. Create your first one."}
            </p>
            {!unscope && (
              <button
                onClick={createNote}
                className="mt-4 flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium"
              >
                <Plus size={13} /> <span>New Note</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {filteredFolders.length > 0 && renderFolders()}

            {pinnedNotes.length > 0 && (
              <div className="mb-6">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
                  <Pin size={10} /> Pinned
                </div>
                {viewMode === "grid"
                  ? renderNoteGrid(pinnedNotes)
                  : renderNoteList(pinnedNotes)}
              </div>
            )}

            {otherNotes.length > 0 && (
              <>
                {pinnedNotes.length > 0 && (
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 mt-2">
                    All notes
                  </div>
                )}
                {viewMode === "grid"
                  ? renderNoteGrid(otherNotes)
                  : renderNoteList(otherNotes)}
              </>
            )}

            {otherNotes.length === 0 && pinnedNotes.length === 0 && (
              <div className="text-center py-8 text-sm text-gray-500 italic">
                {q || activeFilterCount > 0
                  ? "No notes match the current filters."
                  : "No notes in this folder."}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
