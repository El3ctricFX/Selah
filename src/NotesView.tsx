// src/NotesView.tsx
import { useEffect, useMemo, useState } from "react";
import {
  readDir, readTextFile, writeTextFile, mkdir, stat, rename as fsRename,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
  Plus, FileText, Search, Trash2, Clock, LayoutGrid,
  List as ListIcon, X, Pencil, Folder, FolderPlus, ChevronRight,
} from "lucide-react";
import { useModal } from "./Modal";
import { parseNoteFile, serializeNoteFile } from "./noteFormat";
import { moveToTrash } from "./trash";

interface NotesViewProps {
  sectionDir: string;
  sectionName: string;
  sectionIcon: string;
  onOpenNote: (note: { path: string; name: string }) => void;
}

interface NoteEntry {
  path: string;
  fileName: string;
  title: string;
  icon: string;
  modified: number;
  wordCount: number;
}

interface FolderEntry {
  name: string;
  path: string;
}

type ViewMode = "grid" | "list";
const VIEW_MODE_KEY = "notes-view-mode";

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

export default function NotesView({
  sectionDir,
  sectionName,
  sectionIcon,
  onOpenNote,
}: NotesViewProps) {
  const [subPath, setSubPath] = useState<string>(""); // "" = root
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const v = localStorage.getItem(VIEW_MODE_KEY);
      return v === "list" ? "list" : "grid";
    } catch { return "grid"; }
  });
  const { modal, promptAsync, confirmAsync } = useModal();

  const updateViewMode = (next: ViewMode) => {
    setViewMode(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch {}
  };

  const currentDir = async () => {
    if (!subPath) return sectionDir;
    return await join(sectionDir, subPath);
  };

  const load = async () => {
    setLoading(true);
    try {
      try { await mkdir(sectionDir, { recursive: true }); } catch {}
      const dir = await currentDir();

      const entries = await readDir(dir);
      const noteList: NoteEntry[] = [];
      const folderList: FolderEntry[] = [];

      for (const e of entries) {
        if (!e.name) continue;
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory) {
          folderList.push({ name: e.name, path: await join(dir, e.name) });
          continue;
        }
        if (!e.name.endsWith(".selah")) continue;



        const full = await join(dir, e.name);
        let icon = "";
        let title = e.name.replace(/\.selah$/i, "");


        let wordCount = 0;
        try {
          const raw = await readTextFile(full);
          const { frontmatter, body } = parseNoteFile(raw);
          icon = (frontmatter.icon as string) || "";
          const fmTitle = (frontmatter.title as string) || "";
          if (fmTitle) title = fmTitle;
          wordCount = countWords(body);
        } catch {}

        let modified = 0;
        try { modified = mtimeToMs(await stat(full)); } catch {}

        noteList.push({ path: full, fileName: e.name, title, icon, modified, wordCount });
      }

      noteList.sort((a, b) => b.modified - a.modified);
      folderList.sort((a, b) => a.name.localeCompare(b.name));
      setNotes(noteList);
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

  // Follow the sidebar's active folder when it changes.
  useEffect(() => {
    const onFolder = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.folderPath) return;
      const rel = String(detail.folderPath)
        .replace(sectionDir.replace(/\\/g, "/"), "")
        .replace(/^\/+/, "");
      setSubPath(rel);
    };
    window.addEventListener("notes-folder-changed", onFolder);
    return () => window.removeEventListener("notes-folder-changed", onFolder);
  }, [sectionDir]);

  useEffect(() => {
    const onFileChanged = (e: Event) => {
      const p = (e as CustomEvent).detail?.path?.replace(/\\/g, "/");
      if (!p) return;
      const dir = sectionDir.replace(/\\/g, "/");
      if (p.startsWith(dir)) load();
    };
    const onFolderChanged = (e: Event) => {
      const p = (e as CustomEvent).detail?.path?.replace(/\\/g, "/");
      if (!p) return;
      const dir = sectionDir.replace(/\\/g, "/");
      if (p === dir || p.startsWith(dir + "/")) load();
    };
    window.addEventListener("file-changed", onFileChanged);
    window.addEventListener("folder-changed", onFolderChanged);
    return () => {
      window.removeEventListener("file-changed", onFileChanged);
      window.removeEventListener("folder-changed", onFolderChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionDir, subPath]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.title.toLowerCase().includes(q));
  }, [notes, query]);

  const filteredFolders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return folders;
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, query]);

  const uniqueNoteName = (): string => {
    const existing = new Set(notes.map((n) => n.fileName));
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
    try { await moveToTrash(note.path); await load(); }
    catch (e) { console.error("[notes] delete failed:", e); }
  };

  const deleteFolder = async (folder: FolderEntry) => {
    const ok = await confirmAsync(`Move the folder "${folder.name}" and everything inside to the trash?`);
    if (!ok) return;
    try { await moveToTrash(folder.path); await load(); }
    catch (e) { console.error("[notes] delete folder failed:", e); }
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
      await load();
    } catch (e) { console.error("[notes] rename folder failed:", e); }
  };

  // ── Breadcrumbs ────────────────────────────────────────────────────────
  const crumbs = useMemo(() => {
    if (!subPath) return [] as { label: string; sub: string }[];
    const parts = subPath.split(/[\\/]/).filter(Boolean);
    return parts.map((p, i) => ({
      label: p,
      sub: parts.slice(0, i + 1).join("/"),
    }));
  }, [subPath]);

  const renderFolders = () => (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mb-6">
      {filteredFolders.map((f) => (
        <div
          key={f.path}
          role="button"
          tabIndex={0}
          onClick={() => setSubPath(subPath ? `${subPath}/${f.name}` : f.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter") setSubPath(subPath ? `${subPath}/${f.name}` : f.name);
          }}
          className="group relative flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] cursor-pointer transition-colors"
        >
          <Folder size={16} className="text-amber-400 flex-shrink-0" />
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
      ))}
    </div>
  );

  const renderNoteGrid = () => (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {filtered.map((n) => (
        <div
          key={n.path}
          role="button"
          tabIndex={0}
          onClick={() => onOpenNote({ path: n.path, name: n.fileName })}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenNote({ path: n.path, name: n.fileName });
          }}
          className="group relative text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] transition-colors p-4 flex flex-col min-h-[8rem] cursor-pointer"
        >
          <div className="flex items-start gap-2 mb-2">
            <span className="text-xl flex-shrink-0 leading-none">{n.icon || "📄"}</span>
            <h4 className="text-sm font-medium text-gray-100 truncate flex-1 pt-0.5">{n.title}</h4>
          </div>
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
            <button type="button" onClick={(e) => { e.stopPropagation(); renameNote(n); }} className="p-1 rounded bg-black/60 text-white hover:bg-black/80" title="Rename"><Pencil size={11} /></button>
            <button type="button" onClick={(e) => { e.stopPropagation(); deleteNote(n); }} className="p-1 rounded bg-black/60 text-white hover:bg-red-600" title="Delete"><Trash2 size={11} /></button>
          </div>
        </div>
      ))}
    </div>
  );

  const renderNoteList = () => (
    <div className="space-y-2">
      {filtered.map((n) => (
        <div
          key={n.path}
          role="button"
          tabIndex={0}
          onClick={() => onOpenNote({ path: n.path, name: n.fileName })}
          onKeyDown={(e) => {
            if (e.key === "Enter") onOpenNote({ path: n.path, name: n.fileName });
          }}
          className="group w-full text-left rounded-lg border border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] transition-colors p-3 flex items-center gap-3 cursor-pointer"
        >
          <span className="text-2xl flex-shrink-0 leading-none">{n.icon || "📄"}</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-100 truncate">{n.title}</div>
            <div className="text-[10px] text-gray-500 mt-0.5 flex items-center gap-2">
              {n.modified > 0 && (<span className="flex items-center gap-1"><Clock size={9} /> {fmtDate(n.modified)}</span>)}
              {n.wordCount > 0 && (<><span className="text-gray-700">•</span><span>{n.wordCount} words</span></>)}
            </div>
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button type="button" onClick={(e) => { e.stopPropagation(); renameNote(n); }} className="p-1.5 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136]" title="Rename"><Pencil size={13} /></button>
            <button type="button" onClick={(e) => { e.stopPropagation(); deleteNote(n); }} className="p-1.5 rounded text-gray-500 hover:text-red-400 hover:bg-[#2a3136]" title="Delete"><Trash2 size={13} /></button>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="w-full h-full overflow-y-auto bg-[#0f1315]">
      {modal}
      <div className="max-w-6xl mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-4 gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-4xl flex-shrink-0 leading-none">{sectionIcon || "🗒️"}</span>
            <h2 className="text-3xl font-bold text-gray-100 truncate">{sectionName}</h2>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center bg-[#0f1315] border border-[#30363d] rounded p-0.5">
              <button type="button" onClick={() => updateViewMode("grid")} className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${viewMode === "grid" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"}`} title="Grid"><LayoutGrid size={13} /></button>
              <button type="button" onClick={() => updateViewMode("list")} className={`flex items-center justify-center w-7 h-7 rounded transition-colors cursor-pointer ${viewMode === "list" ? "bg-[#2a3136] text-gray-100" : "text-gray-500 hover:text-gray-300"}`} title="List"><ListIcon size={13} /></button>
            </div>
            <button onClick={createFolder} className="flex items-center gap-1.5 text-sm bg-[#1e2327] hover:bg-[#2a3136] border border-[#30363d] text-gray-200 px-3 py-1.5 rounded transition-colors cursor-pointer font-medium">
              <FolderPlus size={14} /> <span>New Folder</span>
            </button>
            <button onClick={createNote} className="flex items-center gap-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium">
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
          <div className="relative mb-4">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search this folder…"
              className="w-full bg-[#161a1d] border border-[#2a3136] rounded pl-9 pr-3 py-2 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
            />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200 p-1" title="Clear"><X size={12} /></button>
            )}
          </div>
        )}

        {loading ? (
          <div className="text-center py-12 text-sm text-gray-500">Loading notes…</div>
        ) : notes.length === 0 && folders.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-gray-500 mt-24">
            <FileText size={32} className="mb-3 opacity-60" />
            <p className="text-sm">
              {subPath ? "This folder is empty." : "No notes yet. Create your first one."}
            </p>
            <button onClick={createNote} className="mt-4 flex items-center gap-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors cursor-pointer font-medium">
              <Plus size={13} /> <span>New Note</span>
            </button>
          </div>
        ) : (
          <>
            {filteredFolders.length > 0 && renderFolders()}
            {filtered.length === 0 && query ? (
              <div className="text-center py-8 text-sm text-gray-500 italic">No matches for "{query}".</div>
            ) : viewMode === "grid" ? (
              renderNoteGrid()
            ) : (
              renderNoteList()
            )}
          </>
        )}
      </div>
    </div>
  );
}
