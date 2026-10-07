// src/Sidebar.tsx
import { useEffect, useRef, useState } from 'react';
import {
  readDir, mkdir, writeTextFile, readTextFile, exists, rename as fsRename, remove,
} from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { createPortal } from 'react-dom';
import {
  ChevronRight, ChevronDown, Settings, Plus, Pencil, Smile, Trash2,
  CalendarDays, Image as ImageIcon, NotebookText, Check, FileText, FolderPlus, X,
  Tag, PanelLeftClose, Church, Sparkles, Folder, FolderOpen,
} from 'lucide-react';
import EmojiPicker, { Theme, EmojiStyle } from 'emoji-picker-react';
import { useModal } from './Modal';
import { moveToTrash } from './trash';
import CleanupPanel from './CleanupPanel';
import {
  type FolderMetaMap,
  makeFolderKey,
  colorForFolder,
  FOLDER_COLORS,
} from './folderMeta';
import { parseNoteFile, serializeNoteFile, type Frontmatter } from './noteFormat';

export interface Category {
  id: string;
  name: string;
  icon: string;
  mode: 'journal' | 'notes' | 'gallery' | 'abba';
  dirName: string;
  builtin?: boolean;
}

interface SidebarProps {
  vaultPath: string;
  activeCategoryId: string | null;
  activeView: any;
  onSelectCategory: (cat: Category) => void;
  onOpenJournalDay: (cat: Category, year: number, month: number, day: number) => void;
  onOpenJournalMonth: (cat: Category, year: number, month: number) => void;
  onOpenJournalToday: (cat: Category) => void;
  onOpenNote: (cat: Category, note: { path: string; name: string }) => void;
  onOpenGallery: (cat: Category) => void;
  onOpenAbba: (cat: Category) => void;
  onOpenNotes: (cat: Category) => void;
  onSwitchVault: () => void;
  onCollapse?: () => void;
}

function pad(n: number) { return n.toString().padStart(2, '0'); }

function formatDayName(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day);
  const monthName = d.toLocaleString("en-US", { month: "long" });
  return `${monthName} ${day}, ${year}`;
}

const NEW_DAY_RE = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\.(note|md)$/;
const OLD_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})\.(note|md)$/;

function parseDayFile(name: string): { day: number } | null {
  const nm = name.match(NEW_DAY_RE);
  if (nm) return { day: Number(nm[2]) };
  const om = name.match(OLD_DAY_RE);
  if (om) return { day: Number(om[3]) };
  return null;
}

function splitFilename(name: string): { base: string; ext: string } {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, idx), ext: name.slice(idx + 1) };
}

function parentDirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? p : p.substring(0, i);
}

/**
 * Write a text file atomically: write to a `.tmp` sibling, then rename into
 * place. Prevents the file from being left in a truncated state if the app
 * is killed mid-write — which, for `.vault_metadata.json`, would silently
 * reset the entire sidebar (categories, icons, colors).
 */
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeTextFile(tmp, contents);
  try {
    await fsRename(tmp, path);
  } catch (e) {
    try { await remove(tmp); } catch {}
    throw e;
  }
}

async function readNoteMeta(path: string): Promise<{ icon: string; color: string; title: string }> {
  try {
    const raw = await readTextFile(path);
    const { frontmatter } = parseNoteFile(raw);
    return {
      icon: (frontmatter.icon as string) || '',
      color: (frontmatter.color as string) || '',
      title: (frontmatter.title as string) || '',
    };
  } catch {
    return { icon: '', color: '', title: '' };
  }
}

async function writeNoteMeta(path: string, patch: Partial<Frontmatter>): Promise<void> {
  let raw: string | null = null;
  try { raw = await readTextFile(path); } catch { raw = null; }
  if (raw === null) {
    await writeFileAtomic(path, serializeNoteFile(patch, ''));
    return;
  }
  const { frontmatter, body } = parseNoteFile(raw);
  const merged: Frontmatter = { ...frontmatter, ...patch };
  for (const k of Object.keys(merged)) {
    if (merged[k] === '' || merged[k] === undefined || merged[k] === null) {
      delete merged[k];
    }
  }
  await writeFileAtomic(path, serializeNoteFile(merged, body));
}

async function ensureFolder(path: string, label: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    const ok = await exists(path);
    if (!ok) { console.error(`[vault] mkdir returned but folder is missing: ${path}`); return false; }
    return true;
  } catch (e) {
    console.error(`[vault] mkdir failed for ${label} (${path}):`, e);
    return false;
  }
}

const SHOW_EXT_KEY = 'sidebar-show-extensions';

export default function Sidebar(props: SidebarProps) {
  const {
    vaultPath, activeCategoryId, activeView,
    onSelectCategory, onOpenJournalDay, onOpenJournalMonth, onOpenJournalToday,
    onOpenNote, onOpenGallery, onOpenAbba, onOpenNotes, onSwitchVault, onCollapse,
  } = props;

  const [categories, setCategories] = useState<Category[]>([]);
  const [metadata, setMetadata] = useState<any>({});
  const [folderMeta, setFolderMeta] = useState<FolderMetaMap>({});
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [showExtensions, setShowExtensions] = useState<boolean>(() => {
    try { return localStorage.getItem(SHOW_EXT_KEY) === 'true'; } catch { return false; }
  });
  const { modal, promptAsync, confirmAsync } = useModal();
  const switcherRef = useRef<HTMLDivElement>(null);

  const toggleShowExtensions = () => {
    setShowExtensions((prev) => {
      const next = !prev;
      try { localStorage.setItem(SHOW_EXT_KEY, String(next)); } catch {}
      return next;
    });
  };

  const activeCategory =
    categories.find((c) => c.id === activeCategoryId) || categories[0] || null;

  const categoryDir = async (cat: Category) =>
    cat.dirName ? await join(vaultPath, cat.dirName) : vaultPath;

  const saveMetadata = async (next: any) => {
    setMetadata(next);
    try {
      await writeFileAtomic(
        await join(vaultPath, '.vault_metadata.json'),
        JSON.stringify(next, null, 2)
      );
      window.dispatchEvent(new Event('metadata-changed'));
    } catch (e) { console.error('[vault] metadata write failed:', e); }
  };

  const saveFolderMeta = async (patch: Record<string, any>) => {
    const next: FolderMetaMap = { ...folderMeta, ...patch };
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (!v.icon && !v.color) delete next[k];
    }
    setFolderMeta(next);
    const merged = { ...metadata, folderMeta: next };
    setMetadata(merged);
    try {
      await writeFileAtomic(
        await join(vaultPath, '.vault_metadata.json'),
        JSON.stringify(merged, null, 2)
      );
      window.dispatchEvent(new Event('metadata-changed'));
    } catch (e) { console.error('[vault] folderMeta write failed:', e); }
  };

  const loadVault = async () => {
    if (!vaultPath) return;

    let meta: any = {
      categories: [], categoryOrder: [], activeCategory: null, folderMeta: {},
    };
    try {
      const raw = await readTextFile(await join(vaultPath, '.vault_metadata.json'));
      meta = { ...meta, ...JSON.parse(raw) };
    } catch {}

    if (!meta.categories?.length && Array.isArray(meta.sections) && meta.sections.length) {
      const migrated = meta.sections.map((s: any) => ({
        id: s.id, name: s.name, icon: s.icon,
        mode: s.type === 'journal' ? 'journal' : s.type === 'gallery' ? 'gallery' : 'notes',
        dirName: s.dirName, builtin: s.builtin,
      }));
      meta = {
        ...meta,
        categories: migrated,
        categoryOrder:
          Array.isArray(meta.sectionOrder) && meta.sectionOrder.length
            ? meta.sectionOrder
            : migrated.map((c: any) => c.id),
      };
      delete meta.sections;
      delete meta.sectionOrder;
      await saveMetadata(meta);
    }

    if (!meta.categories?.length) {
      const journal: Category = {
        id: 'journal', name: 'Daily Journal', icon: '📅',
        mode: 'journal', dirName: 'Daily Journal', builtin: true,
      };
      await ensureFolder(await join(vaultPath, journal.dirName), 'Daily Journal');
      meta = {
        ...meta,
        categories: [journal],
        categoryOrder: [journal.id],
        activeCategory: journal.id,
      };
      await saveMetadata(meta);
    } else {
      setMetadata(meta);
    }

    setFolderMeta(meta.folderMeta || {});

    const order = Array.isArray(meta.categoryOrder) ? meta.categoryOrder : [];
    const ordered: Category[] = order
      .map((id: string) => meta.categories.find((c: Category) => c.id === id))
      .filter(Boolean)
      .concat(meta.categories.filter((c: Category) => !order.includes(c.id)));

    setCategories(ordered);

    for (const c of ordered) {
      if (c.builtin || !c.dirName) continue;
      try {
        const folderPath = await join(vaultPath, c.dirName);
        if (!(await exists(folderPath))) {
          await ensureFolder(folderPath, `repair "${c.name}"`);
        }
      } catch {}
    }
  };

  useEffect(() => {
    loadVault();
    const onMeta = () => loadVault();
    window.addEventListener('metadata-changed', onMeta);
    return () => window.removeEventListener('metadata-changed', onMeta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath]);

  useEffect(() => {
    if (!switcherOpen) return;
    const handler = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [switcherOpen]);

  const sanitizeDirName = (name: string) => {
    let trimmed = name.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/[\x00-\x1f]/g, '');
    if (trimmed.length > 100) trimmed = trimmed.slice(0, 100);
    trimmed = trimmed.replace(/[. ]+$/, '');
    if (!trimmed || trimmed === '.' || trimmed === '..') return 'Category';
    return trimmed;
  };

  const selectCategory = (cat: Category) => {
    if (cat.mode === 'gallery') { onOpenGallery(cat); return; }
    if (cat.mode === 'abba') { onOpenAbba(cat); return; }
    if (cat.mode === 'notes') { onOpenNotes(cat); return; }
    onSelectCategory(cat);
  };

  const createCategory = async (mode: Category['mode']) => {
    setSwitcherOpen(false);
    const label =
      mode === 'journal' ? 'journal' :
      mode === 'gallery' ? 'gallery' :
      mode === 'abba' ? 'Abba (faith)' : 'notes';
    const rawName = await promptAsync(`Name your new ${label} category:`);
    if (!rawName) return;

    const dirName = sanitizeDirName(rawName);
    const id = `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const icon =
      mode === 'journal' ? '📅' :
      mode === 'gallery' ? '🎨' :
      mode === 'abba' ? '🙏' : '🗒️';
    const cat: Category = { id, name: rawName.trim() || dirName, icon, mode, dirName };

    const folderPath = await join(vaultPath, dirName);
    const created = await ensureFolder(folderPath, `category "${cat.name}"`);
    if (!created) {
      await confirmAsync(`Could not create folder:\n\n${folderPath}`);
      return;
    }

    if (mode === 'journal') {
      const now = new Date();
      const yearStr = String(now.getFullYear());
      const monthStr = String(now.getMonth() + 1).padStart(2, '0');
      await ensureFolder(await join(folderPath, yearStr), `year "${yearStr}"`);
      await ensureFolder(await join(folderPath, yearStr, monthStr), `month "${monthStr}"`);
    }

    let latest: any = { categories: [], categoryOrder: [], folderMeta: {}, activeCategory: null };
    try {
      const raw = await readTextFile(await join(vaultPath, '.vault_metadata.json'));
      latest = { ...latest, ...JSON.parse(raw) };
    } catch {}

    const currentCategories: Category[] = Array.isArray(latest.categories) ? latest.categories : [];
    const currentOrder: string[] = Array.isArray(latest.categoryOrder) ? latest.categoryOrder : [];

    await saveMetadata({
      ...latest,
      categories: [...currentCategories, cat],
      categoryOrder: [...currentOrder, id],
    });
    await loadVault();
    selectCategory(cat);
  };

  const renameCategory = async (cat: Category) => {
    const newName = await promptAsync('Rename category:', cat.name);
    if (!newName || newName === cat.name) return;
    await saveMetadata({
      ...metadata,
      categories: metadata.categories.map((c: Category) =>
        c.id === cat.id ? { ...c, name: newName } : c
      ),
    });
    await loadVault();
  };

  const changeCategoryIcon = async (cat: Category) => {
    const emoji = await promptAsync(`Icon for ${cat.name}:`, cat.icon);
    if (!emoji) return;
    await saveMetadata({
      ...metadata,
      categories: metadata.categories.map((c: Category) =>
        c.id === cat.id ? { ...c, icon: emoji } : c
      ),
    });
    await loadVault();
  };

  const deleteCategory = async (cat: Category) => {
    if (cat.builtin) return;
    const isRoot = !cat.dirName;
    if (isRoot) {
      const ok = await confirmAsync(`Remove "${cat.name}" from the sidebar?`);
      if (!ok) return;
    } else {
      const ok = await confirmAsync(`Move the entire "${cat.name}" folder to the trash?`);
      if (!ok) return;
      try {
        const dir = await join(vaultPath, cat.dirName);
        if (await exists(dir)) await moveToTrash(dir);
      } catch (e) { console.error('[vault] could not trash category:', e); }
    }
    const cleanedFolderMeta: FolderMetaMap = {};
    for (const k of Object.keys(folderMeta)) {
      if (!k.startsWith(cat.id + '/')) cleanedFolderMeta[k] = folderMeta[k];
    }
    setFolderMeta(cleanedFolderMeta);
    await saveMetadata({
      ...metadata,
      categories: metadata.categories.filter((c: Category) => c.id !== cat.id),
      categoryOrder: (metadata.categoryOrder || []).filter((id: string) => id !== cat.id),
      folderMeta: cleanedFolderMeta,
    });
    await loadVault();
  };

  const vaultName = vaultPath.split(/[/\\]/).pop() || 'Vault';

  return (
    <div className="h-full flex flex-col bg-[#161a1d] text-gray-200 select-none">
      {modal}

      <CleanupPanel
        open={cleanupOpen}
        onClose={() => setCleanupOpen(false)}
        vaultPath={vaultPath}
        categories={categories}
      />

      <div className="flex-shrink-0 border-b border-[#2a3136]">
        <div className="px-3 pt-3 pb-2 flex items-center justify-between">
          <div
            className="font-semibold text-xs text-gray-400 uppercase tracking-wider truncate cursor-pointer hover:text-gray-200"
            onClick={onSwitchVault}
            title={vaultPath}
          >
            {vaultName}
          </div>
          <div className="flex items-center space-x-0.5">
            <button
              onClick={toggleShowExtensions}
              className={`p-1 rounded hover:bg-[#1e2327] transition-colors ${
                showExtensions ? 'text-blue-400 hover:text-blue-300' : 'text-gray-500 hover:text-gray-200'
              }`}
              title={showExtensions ? 'Hide file extensions' : 'Show file extensions'}
            >
              <Tag size={13} />
            </button>
            <button
              onClick={() => setCleanupOpen(true)}
              className="text-gray-500 hover:text-blue-300 p-1 rounded hover:bg-[#1e2327] transition-colors"
              title="Clean up unused media"
            >
              <Sparkles size={13} />
            </button>
            <button
              onClick={() => setSwitcherOpen(true)}
              className="text-gray-500 hover:text-gray-200 p-1 rounded hover:bg-[#1e2327]"
              title="New category"
            >
              <Plus size={13} />
            </button>
            <button
              onClick={onSwitchVault}
              className="text-gray-500 hover:text-gray-200 p-1 rounded hover:bg-[#1e2327]"
              title="Switch vault"
            >
              <Settings size={13} />
            </button>
            {onCollapse && (
              <button
                onClick={onCollapse}
                className="text-gray-500 hover:text-gray-200 p-1 rounded hover:bg-[#1e2327]"
                title="Collapse sidebar (Ctrl+B)"
              >
                <PanelLeftClose size={13} />
              </button>
            )}
          </div>
        </div>

        <div className="px-2 pb-2 relative" ref={switcherRef}>
          <button
            onClick={() => setSwitcherOpen((o) => !o)}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-[#1e2327] transition-colors"
          >
            <div className="flex items-center space-x-2 truncate">
              <span className="text-base flex-shrink-0">{activeCategory?.icon || '📄'}</span>
              <span className="text-sm font-medium truncate">{activeCategory?.name || 'No category'}</span>
            </div>
            <ChevronDown
              size={13}
              className={`text-gray-500 transition-transform ${switcherOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {switcherOpen && (
            <div className="absolute left-2 right-2 top-full mt-1 z-40 bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1">
              {categories.map((c) => (
                <div
                  key={c.id}
                  className={`group/cat flex items-center justify-between px-3 py-1.5 text-sm hover:bg-[#2a3136] ${
                    c.id === activeCategory?.id ? 'text-gray-100' : 'text-gray-300'
                  }`}
                >
                  <button
                    onClick={() => { setSwitcherOpen(false); selectCategory(c); }}
                    className="flex items-center space-x-2 truncate flex-grow text-left"
                  >
                    <span>{c.icon}</span>
                    <span className="truncate">{c.name}</span>
                    {c.id === activeCategory?.id && (
                      <Check size={12} className="text-blue-400 flex-shrink-0" />
                    )}
                  </button>
                  {!c.builtin && (
                    <div className="flex items-center space-x-0.5 opacity-0 group-hover/cat:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); renameCategory(c); }} className="text-gray-500 hover:text-gray-200 p-1">
                        <Pencil size={11} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); changeCategoryIcon(c); }} className="text-gray-500 hover:text-gray-200 p-1">
                        <Smile size={11} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); deleteCategory(c); }} className="text-gray-500 hover:text-red-400 p-1">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
              <div className="border-t border-[#2a3136] mt-1 pt-1">
                <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wider">New category</div>
                <button onClick={() => createCategory('journal')} className="w-full flex items-center space-x-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-[#2a3136] text-left">
                  <CalendarDays size={13} /> <span>Journal</span>
                </button>
                <button onClick={() => createCategory('notes')} className="w-full flex items-center space-x-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-[#2a3136] text-left">
                  <NotebookText size={13} /> <span>Notes</span>
                </button>
                <button onClick={() => createCategory('gallery')} className="w-full flex items-center space-x-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-[#2a3136] text-left">
                  <ImageIcon size={13} /> <span>Gallery</span>
                </button>
                <button onClick={() => createCategory('abba')} className="w-full flex items-center space-x-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-[#2a3136] text-left">
                  <Church size={13} /> <span>Abba (faith)</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex-grow overflow-y-auto min-h-0">
        {activeCategory?.mode === 'journal' && (
          <JournalTree
            key={activeCategory.id}
            category={activeCategory}
            categoryDir={categoryDir}
            activeView={activeView}
            folderMeta={folderMeta}
            saveFolderMeta={saveFolderMeta}
            showExtensions={showExtensions}
            onOpenDay={onOpenJournalDay}
            onOpenMonth={onOpenJournalMonth}
            onOpenToday={onOpenJournalToday}
            onOpenNote={onOpenNote}
            confirmAsync={confirmAsync}
            promptAsync={promptAsync}
          />
        )}
        {activeCategory?.mode === 'notes' && (
          <NotesTree
            key={activeCategory.id}
            category={activeCategory}
            categoryDir={categoryDir}
            activeView={activeView}
            folderMeta={folderMeta}
            saveFolderMeta={saveFolderMeta}
            showExtensions={showExtensions}
            onOpenNote={onOpenNote}
            onOpenNotes={onOpenNotes}
            confirmAsync={confirmAsync}
            promptAsync={promptAsync}
          />
        )}
      </div>
    </div>
  );
}

// ── notes tree ───────────────────────────────────────────────────────────────

type NoteEntry = {
  fileName: string;
  path: string;
  title: string;
  icon: string;
  color: string;
};

type FolderContents = {
  folders: string[];
  notes: NoteEntry[];
};

type NotesCtx =
  | { kind: 'note'; note: NoteEntry; x: number; y: number }
  | { kind: 'folder'; folderPath: string; folderName: string; x: number; y: number }
  | { kind: 'background'; folderPath: string; x: number; y: number }
  | null;

function sortNotes(notes: NoteEntry[]): NoteEntry[] {
  return [...notes].sort((a, b) => a.title.localeCompare(b.title));
}

function NotesTree({
  category,
  categoryDir,
  activeView,
  folderMeta,
  saveFolderMeta,
  showExtensions,
  onOpenNote,
  onOpenNotes,
  confirmAsync,
  promptAsync,
}: {
  category: Category;
  categoryDir: (cat: Category) => Promise<string>;
  activeView: any;
  folderMeta: FolderMetaMap;
  saveFolderMeta: (patch: Record<string, any>) => Promise<void>;
  showExtensions: boolean;
  onOpenNote: (cat: Category, note: { path: string; name: string }) => void;
  onOpenNotes: (cat: Category) => void;
  confirmAsync: (msg: string) => Promise<boolean>;
  promptAsync: (msg: string, defaultValue?: string) => Promise<string | null>;
}) {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [root, setRoot] = useState<FolderContents | null>(null);
  const [children, setChildren] = useState<Record<string, FolderContents>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [ctx, setCtx] = useState<NotesCtx>(null);
  const [dragNote, setDragNote] = useState<NoteEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [iconPicker, setIconPicker] = useState<{
    folderKey: string;
    folderName: string;
    top: number;
    left: number;
  } | null>(null);
  const iconPickerRef = useRef<HTMLDivElement>(null);

  const expandedRef = useRef<Record<string, boolean>>({});
  const rootPathRef = useRef<string | null>(null);
  useEffect(() => { rootPathRef.current = rootPath; }, [rootPath]);

  const justDroppedRef = useRef(false);

  /**
   * Build the folderMeta key for any folder path (absolute).
   *
   * Before `rootPath` loads, we can't compute the canonical relative key.
   * We use the last two path segments as a best-effort stable suffix so we
   * don't create two conflicting keys for the same folder across renders.
   */
  const folderKeyFor = (absPath: string): string => {
    const rp = rootPathRef.current;
    if (!rp) {
      const parts = absPath.replace(/\\/g, '/').split('/').filter(Boolean);
      return makeFolderKey(category.id, ...parts.slice(-2));
    }
    const norm = absPath.replace(/\\/g, '/');
    const rootNorm = rp.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!norm.startsWith(rootNorm)) return makeFolderKey(category.id, absPath);
    const rel = norm.slice(rootNorm.length).replace(/^\/+/, '');
    const parts = rel.split('/').filter(Boolean);
    return makeFolderKey(category.id, ...parts);
  };

  const loadFolder = async (absPath: string): Promise<FolderContents> => {
    const entries = await readDir(absPath);
    const folders: string[] = [];
    const notes: NoteEntry[] = [];
    for (const e of entries) {
      if (!e.name || e.name.startsWith('.')) continue;
      if (e.isDirectory) { folders.push(e.name); continue; }
      if (!e.name.endsWith('.note')) continue;
      const full = await join(absPath, e.name);
      const meta = await readNoteMeta(full);
      const base = e.name.replace(/\.note$/i, '');
      notes.push({
        fileName: e.name,
        path: full,
        title: meta.title || base,
        icon: meta.icon,
        color: meta.color,
      });
    }
    folders.sort((a, b) => a.localeCompare(b));
    notes.sort((a, b) => a.title.localeCompare(b.title));
    return { folders, notes };
  };

  const reload = async (extra: string[] = []) => {
    const dir = await categoryDir(category);
    await ensureFolder(dir, `notes "${category.name}"`);

    let rootContents: FolderContents;
    try { rootContents = await loadFolder(dir); }
    catch { rootContents = { folders: [], notes: [] }; }

    const toRefresh = new Set<string>();
    for (const k of Object.keys(expandedRef.current)) {
      if (expandedRef.current[k]) toRefresh.add(k);
    }
    for (const p of extra) toRefresh.add(p);

    const loaded: Record<string, FolderContents> = {};
    for (const k of toRefresh) {
      try { loaded[k] = await loadFolder(k); } catch {}
    }

    setRootPath(dir);
    setRoot(rootContents);
    setChildren((prev) => {
      const merged: Record<string, FolderContents> = {};
      for (const k of Object.keys(prev)) {
        if (expandedRef.current[k]) merged[k] = prev[k];
      }
      for (const k of Object.keys(loaded)) merged[k] = loaded[k];
      return merged;
    });
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category.id]);

  useEffect(() => {
    const onFolderChanged = (e: Event) => {
      const p = (e as CustomEvent).detail?.path?.replace(/\\/g, '/');
      if (!p) return;
      if (category.dirName && !p.includes(category.dirName)) return;
      reload();
    };
    const onFileChanged = (e: Event) => {
      const p = (e as CustomEvent).detail?.path?.replace(/\\/g, '/');
      if (!p) return;
      if (category.dirName && !p.includes(category.dirName)) return;
      reload();
    };
    window.addEventListener('folder-changed', onFolderChanged);
    window.addEventListener('file-changed', onFileChanged);
    return () => {
      window.removeEventListener('folder-changed', onFolderChanged);
      window.removeEventListener('file-changed', onFileChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category.id, category.dirName]);

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [ctx]);

  useEffect(() => {
    if (!iconPicker) return;
    const onDown = (e: MouseEvent) => {
      if (iconPickerRef.current?.contains(e.target as Node)) return;
      setIconPicker(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIconPicker(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [iconPicker]);

  const expandFolder = (absPath: string) => {
    if (expandedRef.current[absPath]) return;
    const updated = { ...expandedRef.current, [absPath]: true };
    expandedRef.current = updated;
    setExpanded(updated);
  };

  const toggleFolder = async (absPath: string) => {
    if (justDroppedRef.current) return;
    const isOpen = !!expandedRef.current[absPath];
    const next = !isOpen;
    const updated = { ...expandedRef.current, [absPath]: next };
    expandedRef.current = updated;
    setExpanded(updated);

    if (next && !children[absPath]) {
      try {
        const contents = await loadFolder(absPath);
        setChildren((p) => ({ ...p, [absPath]: contents }));
      } catch (e) { console.error('[notes-tree] load child failed:', e); }
    }
  };

  const createNote = async (folderPath: string) => {
    try {
      await ensureFolder(folderPath, 'notes folder');
      const existing = new Set<string>();
      if (folderPath === rootPathRef.current && root) {
        for (const n of root.notes) existing.add(n.fileName);
      } else if (children[folderPath]) {
        for (const n of children[folderPath].notes) existing.add(n.fileName);
      }
      let i = 1;
      let fileName = `Untitled-${i}.note`;
      while (existing.has(fileName)) { i++; fileName = `Untitled-${i}.note`; }
      const full = await join(folderPath, fileName);
      const now = new Date().toISOString();
      await writeTextFile(full, `---\ncreated: ${now}\nmodified: ${now}\n---\n\n`);
      if (folderPath !== rootPathRef.current) expandFolder(folderPath);
      await reload(folderPath !== rootPathRef.current ? [folderPath] : []);
      onOpenNote(category, { path: full, name: fileName });
    } catch (e) { console.error('[notes-tree] create failed:', e); }
  };

  const createFolder = async (parentPath: string) => {
    const raw = await promptAsync('New folder name:');
    if (!raw) return;
    const name = raw.trim().replace(/[\\/:*?"<>|]/g, '-');
    if (!name) return;
    try {
      const full = await join(parentPath, name);
      await ensureFolder(full, `folder "${name}"`);
      if (parentPath !== rootPathRef.current) expandFolder(parentPath);
      await reload(parentPath !== rootPathRef.current ? [parentPath] : []);
      window.dispatchEvent(
        new CustomEvent('folder-changed', { detail: { path: parentPath } })
      );
    } catch (e) { console.error('[notes-tree] create folder failed:', e); }
  };

  const renameFolder = async (folderPath: string, folderName: string) => {
    const raw = await promptAsync('Rename folder:', folderName);
    if (!raw || raw === folderName) return;
    const safe = raw.trim().replace(/[\\/:*?"<>|]/g, '-');
    if (!safe || safe === folderName) return;
    const parent = parentDirOf(folderPath);
    const dest = await join(parent, safe);
    try {
      await fsRename(folderPath, dest);
      const n = { ...expandedRef.current };
      delete n[folderPath];
      expandedRef.current = n;
      setExpanded(n);
      setChildren((p) => { const x = { ...p }; delete x[folderPath]; return x; });
      await reload(parent !== rootPathRef.current ? [parent] : []);
    } catch (e) { console.error('[notes-tree] rename folder failed:', e); }
  };

  const deleteFolder = async (folderPath: string, folderName: string) => {
    const ok = await confirmAsync(`Move the folder "${folderName}" and everything inside it to the trash?`);
    if (!ok) return;
    try {
      await moveToTrash(folderPath);
      const n = { ...expandedRef.current };
      delete n[folderPath];
      expandedRef.current = n;
      setExpanded(n);
      setChildren((p) => { const x = { ...p }; delete x[folderPath]; return x; });
      const prefix = folderKeyFor(folderPath) + '/';
      const cleanedMeta: FolderMetaMap = {};
      for (const k of Object.keys(folderMeta)) {
        if (k !== folderKeyFor(folderPath) && !k.startsWith(prefix)) cleanedMeta[k] = folderMeta[k];
      }
      if (Object.keys(cleanedMeta).length !== Object.keys(folderMeta).length) {
        await saveFolderMeta(cleanedMeta as any);
      }
      const parent = parentDirOf(folderPath);
      await reload(parent !== rootPathRef.current ? [parent] : []);
    } catch (e) { console.error('[notes-tree] delete folder failed:', e); }
  };

  const deleteNote = async (note: NoteEntry) => {
    const ok = await confirmAsync(`Move "${note.title}" to the trash?`);
    if (!ok) return;
    try {
      await moveToTrash(note.path);
      await reload();
    } catch (e) { console.error('[notes-tree] delete failed:', e); }
  };

  const renameNote = async (note: NoteEntry) => {
    const next = await promptAsync('Rename note:', note.title);
    if (!next || next === note.title) return;
    try {
      const raw = await readTextFile(note.path);
      const { frontmatter, body } = parseNoteFile(raw);
      const fm = { ...frontmatter, title: next.trim(), modified: new Date().toISOString() };
      await writeFileAtomic(note.path, serializeNoteFile(fm, body));
      await reload();
      window.dispatchEvent(new CustomEvent('note-frontmatter-changed', { detail: { path: note.path } }));
    } catch (e) { console.error('[notes-tree] rename failed:', e); }
  };

  const changeNoteIcon = async (note: NoteEntry) => {
    const emoji = await promptAsync(`Icon for "${note.title}":`, note.icon || '');
    if (emoji === null) return;
    await writeNoteMeta(note.path, { icon: emoji });
    await reload();
    window.dispatchEvent(new CustomEvent('note-frontmatter-changed', { detail: { path: note.path } }));
  };

  const openFolderIconPicker = (
    folderPath: string,
    folderName: string,
    x: number,
    y: number
  ) => {
    const key = folderKeyFor(folderPath);
    const W = 340;
    const H = 460;
    const left = Math.min(x, window.innerWidth - W - 12);
    const top = Math.min(y, window.innerHeight - H - 12);
    setIconPicker({
      folderKey: key,
      folderName,
      top: Math.max(12, top),
      left: Math.max(12, left),
    });
    setCtx(null);
  };

  const applyFolderIcon = async (emoji: string) => {
    if (!iconPicker) return;
    const prev = folderMeta[iconPicker.folderKey] || {};
    await saveFolderMeta({
      [iconPicker.folderKey]: { ...prev, icon: emoji },
    });
    if (emoji === '') setIconPicker(null);
  };

  const handleDrop = async (folderPath: string) => {
    justDroppedRef.current = true;
    setDropTarget(null);
    const dragged = dragNote;
    setDragNote(null);
    if (!dragged) {
      justDroppedRef.current = false;
      return;
    }

    const currentDir = parentDirOf(dragged.path);
    if (currentDir === folderPath) {
      justDroppedRef.current = false;
      return;
    }

    const dest = await join(folderPath, dragged.fileName);
    try {
      if (await exists(dest)) {
        const ok = await confirmAsync(`A note called "${dragged.fileName}" already exists there. Move the existing file to the trash and replace it?`);
        if (!ok) {
          justDroppedRef.current = false;
          return;
        }
        // Actually move the target to trash before renaming — otherwise
        // `rename` silently clobbers on Unix and fails on Windows.
        try { await moveToTrash(dest); } catch (e) {
          console.warn('[notes-tree] could not trash overwrite target:', e);
        }
      }
      await fsRename(dragged.path, dest);

      const updatedExpanded: Record<string, boolean> = { ...expandedRef.current };
      const foldersToLoad: string[] = [];
      if (folderPath !== rootPathRef.current) {
        updatedExpanded[folderPath] = true;
        foldersToLoad.push(folderPath);
        let p = parentDirOf(folderPath);
        while (p && p.length > (rootPathRef.current?.length ?? 0)) {
          if (p !== rootPathRef.current) {
            updatedExpanded[p] = true;
            foldersToLoad.push(p);
          }
          const nx = parentDirOf(p);
          if (nx === p) break;
          p = nx;
        }
      }
      expandedRef.current = updatedExpanded;
      setExpanded(updatedExpanded);

      const loadedMap: Record<string, FolderContents> = {};
      for (const p of foldersToLoad) {
        try { loadedMap[p] = await loadFolder(p); } catch {}
      }

      const destContents = loadedMap[folderPath] ?? { folders: [], notes: [] };
      const alreadyThere = destContents.notes.some((n) => n.fileName === dragged.fileName);
      const destNotes = alreadyThere
        ? destContents.notes
        : sortNotes([
            ...destContents.notes,
            {
              fileName: dragged.fileName,
              path: dest,
              title: dragged.title,
              icon: dragged.icon,
              color: dragged.color,
            },
          ]);
      loadedMap[folderPath] = { folders: destContents.folders, notes: destNotes };

      setChildren((prev) => {
        const next: Record<string, FolderContents> = { ...prev };
        for (const [k, v] of Object.entries(loadedMap)) {
          next[k] = v;
        }
        if (currentDir && next[currentDir]) {
          next[currentDir] = {
            folders: next[currentDir].folders,
            notes: next[currentDir].notes.filter((n) => n.fileName !== dragged.fileName),
          };
        }
        return next;
      });

      if (currentDir === rootPathRef.current) {
        setRoot((prev) =>
          prev
            ? { ...prev, notes: prev.notes.filter((n) => n.fileName !== dragged.fileName) }
            : prev
        );
      }

      const extras: string[] = [];
      if (folderPath !== rootPathRef.current) extras.push(folderPath);
      if (currentDir && currentDir !== rootPathRef.current) extras.push(currentDir);
      await reload(extras);

      setChildren((prev) => {
        const cached = prev[folderPath];
        if (!cached) return prev;
        if (cached.notes.some((n) => n.fileName === dragged.fileName)) return prev;
        return {
          ...prev,
          [folderPath]: {
            folders: cached.folders,
            notes: sortNotes([
              ...cached.notes,
              {
                fileName: dragged.fileName,
                path: dest,
                title: dragged.title,
                icon: dragged.icon,
                color: dragged.color,
              },
            ]),
          },
        };
      });

      window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: folderPath } }));
      window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: currentDir } }));
    } catch (e) {
      console.error('[notes-tree] move failed:', e);
    } finally {
      setTimeout(() => { justDroppedRef.current = false; }, 0);
    }
  };

  const isActive = (note: NoteEntry) => {
    if (activeView?.kind !== 'note') return false;
    const a = (activeView.path || '').replace(/\\/g, '/');
    const b = note.path.replace(/\\/g, '/');
    return a === b;
  };

  const renderNote = (note: NoteEntry, depth: number) => {
    const active = isActive(note);
    const { ext } = splitFilename(note.fileName);
    const colorText = note.color ? FOLDER_COLORS[note.color]?.text || '' : '';
    const isDragging = dragNote?.path === note.path;
    return (
      <div
        key={note.path}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          setDragNote(note);
          try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', note.fileName);
          } catch {}
        }}
        onDragEnd={() => { setDragNote(null); setDropTarget(null); }}
        onClick={() => onOpenNote(category, { path: note.path, name: note.fileName })}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtx({ kind: 'note', note, x: e.clientX, y: e.clientY });
        }}
        className={`py-1.5 pr-2 rounded cursor-grab active:cursor-grabbing text-sm flex items-center space-x-2 ${
          active ? 'bg-[#2a3136]' : 'hover:bg-[#1e2327]'
        } ${isDragging ? 'opacity-40' : ''}`}
        style={{
          color: active ? colorText || '#e5e7eb' : colorText || undefined,
          paddingLeft: `${8 + depth * 12 + 14}px`,
        }}
        title={note.fileName}
      >
        <span className="flex-shrink-0 text-sm leading-none">{note.icon || '📄'}</span>
        <span className="truncate flex-1">{note.title}</span>
        {showExtensions && ext && (
          <span className="flex-shrink-0 text-[9px] uppercase tracking-wider leading-none px-1 py-0.5 rounded border border-[#30363d] bg-[#1a1e21] text-gray-500">
            {ext}
          </span>
        )}
      </div>
    );
  };

  const renderFolder = (folderPath: string, folderName: string, depth: number) => {
    const isOpen = !!expanded[folderPath];
    const contents = children[folderPath];
    const isDrop = dropTarget === folderPath;
    const isDraggingAny = !!dragNote;
    const fKey = folderKeyFor(folderPath);
    const customIcon = folderMeta[fKey]?.icon;

    return (
      <div key={folderPath}>
        <div
          onClick={() => toggleFolder(folderPath)}
          onDragEnter={(e) => {
            if (!dragNote) return;
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(folderPath);
          }}
          onDragOver={(e) => {
            if (!dragNote) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (dropTarget !== folderPath) setDropTarget(folderPath);
          }}
          onDragLeave={(e) => {
            const related = e.relatedTarget as Node | null;
            if (related && (e.currentTarget as Node).contains(related)) return;
            if (dropTarget === folderPath) setDropTarget(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleDrop(folderPath);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtx({ kind: 'folder', folderPath, folderName, x: e.clientX, y: e.clientY });
          }}
          className={`py-1.5 pr-2 rounded cursor-pointer text-sm flex items-center space-x-1.5 transition-colors ${
            isDrop
              ? 'bg-blue-500/30 ring-2 ring-blue-400 shadow-[0_0_12px_rgba(96,165,250,0.5)]'
              : isDraggingAny
                ? 'ring-1 ring-blue-500/30 hover:bg-[#1e2327]'
                : 'hover:bg-[#1e2327]'
          }`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          {isOpen
            ? <ChevronDown size={11} className="text-gray-500 flex-shrink-0" />
            : <ChevronRight size={11} className="text-gray-500 flex-shrink-0" />}
          {customIcon ? (
            <span className="flex-shrink-0 text-sm leading-none">{customIcon}</span>
          ) : isOpen
            ? <FolderOpen size={13} className={isDrop ? 'text-blue-300 flex-shrink-0' : 'text-amber-400 flex-shrink-0'} />
            : <Folder size={13} className={isDrop ? 'text-blue-300 flex-shrink-0' : 'text-amber-400/70 flex-shrink-0'} />}
          <span className={`truncate flex-1 ${isDrop ? 'text-blue-100 font-medium' : 'text-gray-200'}`}>
            {folderName}
          </span>
          {contents && !isDrop && (
            <span className="text-[10px] text-gray-600 flex-shrink-0">
              {contents.folders.length + contents.notes.length}
            </span>
          )}
          {isDrop && (
            <span className="text-[10px] text-blue-200 flex-shrink-0 font-medium">
              Drop here
            </span>
          )}
        </div>

        {isOpen && contents && (
          <div>
            {contents.folders.map((f) => {
              const childPath = `${folderPath}/${f}`.replace(/\/+/g, '/');
              return renderFolder(childPath, f, depth + 1);
            })}
            {contents.notes.map((n) => renderNote(n, depth + 1))}
            {contents.folders.length === 0 && contents.notes.length === 0 && (
              <div
                className="py-1 text-xs text-gray-600 italic"
                style={{ paddingLeft: `${8 + (depth + 1) * 12 + 14}px` }}
              >
                Empty folder
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="p-2 min-h-full"
      onContextMenu={(e) => {
        if (!rootPath) return;
        e.preventDefault();
        setCtx({ kind: 'background', folderPath: rootPath, x: e.clientX, y: e.clientY });
      }}
      onDragOver={(e) => {
        if (!dragNote || !rootPath) return;
        e.preventDefault();
        setDropTarget(rootPath);
      }}
      onDragLeave={(e) => {
        const related = e.relatedTarget as Node | null;
        if (related && (e.currentTarget as Node).contains(related)) return;
        if (dropTarget === rootPath) setDropTarget(null);
      }}
      onDrop={(e) => {
        if (!rootPath) return;
        e.preventDefault();
        handleDrop(rootPath);
      }}
    >
      {ctx && (
        <div
          className="fixed z-50 bg-[#1e2327] border border-[#2a3136] rounded shadow-xl py-1 w-60"
          style={{ top: ctx.y, left: ctx.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctx.kind === 'background' && (
            <>
              <button
                onClick={() => { const p = ctx.folderPath; setCtx(null); createFolder(p); }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2"
              >
                <FolderPlus size={13} /> <span>New folder</span>
              </button>
              <button
                onClick={() => { const p = ctx.folderPath; setCtx(null); createNote(p); }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-t border-[#2a3136]"
              >
                <Plus size={13} /> <span>New note</span>
              </button>
            </>
          )}

          {ctx.kind === 'folder' && (
            <>
              <button
                onClick={() => { const p = ctx.folderPath; setCtx(null); createNote(p); }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2"
              >
                <Plus size={13} /> <span>New note inside</span>
              </button>
              <button
                onClick={() => { const p = ctx.folderPath; setCtx(null); createFolder(p); }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]"
              >
                <FolderPlus size={13} /> <span>New folder</span>
              </button>
              <button
                onClick={() => {
                  const p = ctx.folderPath;
                  const n = ctx.folderName;
                  const x = ctx.x;
                  const y = ctx.y;
                  openFolderIconPicker(p, n, x, y);
                }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]"
              >
                <Smile size={13} /> <span>Change icon</span>
              </button>
              <button
                onClick={() => { const p = ctx.folderPath; const n = ctx.folderName; setCtx(null); renameFolder(p, n); }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2"
              >
                <Pencil size={13} /> <span>Rename folder</span>
              </button>
              <button
                onClick={() => { const p = ctx.folderPath; const n = ctx.folderName; setCtx(null); deleteFolder(p, n); }}
                className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2 border-t border-[#2a3136]"
              >
                <Trash2 size={13} /> <span>Move folder to trash</span>
              </button>
            </>
          )}

          {ctx.kind === 'note' && (
            <>
              <button
                onClick={() => { const n = ctx.note; setCtx(null); onOpenNote(category, { path: n.path, name: n.fileName }); }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]"
              >
                <FileText size={13} /> <span>Open</span>
              </button>
              <button onClick={() => { const n = ctx.note; setCtx(null); renameNote(n); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2">
                <Pencil size={13} /> <span>Rename</span>
              </button>
              <button onClick={() => { const n = ctx.note; setCtx(null); changeNoteIcon(n); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                <Smile size={13} /> <span>Change icon</span>
              </button>
              <button
                onClick={() => { const p = parentDirOf(ctx.note.path); setCtx(null); createFolder(p); }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]"
              >
                <FolderPlus size={13} /> <span>New folder here</span>
              </button>
              <button
                onClick={() => { const p = parentDirOf(ctx.note.path); setCtx(null); createNote(p); }}
                className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]"
              >
                <Plus size={13} /> <span>New note here</span>
              </button>
              <button onClick={() => { const n = ctx.note; setCtx(null); deleteNote(n); }} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2">
                <Trash2 size={13} /> <span>Move to trash</span>
              </button>
            </>
          )}
        </div>
      )}

      {iconPicker && createPortal(
        <div
          ref={iconPickerRef}
          className="fixed z-[100] bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl overflow-hidden"
          style={{ top: iconPicker.top, left: iconPicker.left }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136]">
            <span className="text-xs text-gray-400 truncate">
              Icon for <span className="text-gray-200">{iconPicker.folderName}</span>
            </span>
            <button
              onClick={() => setIconPicker(null)}
              className="text-gray-500 hover:text-gray-300 p-0.5"
            >
              <X size={12} />
            </button>
          </div>
          <EmojiPicker
            theme={Theme.DARK}
            emojiStyle={EmojiStyle.NATIVE}
            onEmojiClick={(d) => applyFolderIcon(d.emoji)}
            width={320}
            height={360}
            previewConfig={{ showPreview: false }}
          />
          <button
            onClick={() => applyFolderIcon('')}
            className="w-full text-left text-xs text-gray-500 hover:text-red-400 hover:bg-[#2a3136] px-3 py-2 border-t border-[#2a3136]"
          >
            Remove icon
          </button>
        </div>,
        document.body
      )}

      <div className="flex items-center justify-between px-1 py-1 mb-1 gap-1">
        <button
          onClick={() => onOpenNotes(category)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs whitespace-nowrap transition-colors ${
            activeView?.kind === 'notes'
              ? 'bg-[#1e2327] text-gray-100'
              : 'text-gray-400 hover:text-gray-100 hover:bg-[#1e2327]'
          }`}
          title="All Notes overview"
        >
          <FileText size={12} />
          <span>All Notes</span>
        </button>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {rootPath && (
            <button
              onClick={() => createFolder(rootPath)}
              className="p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors"
              title="New folder"
            >
              <FolderPlus size={14} />
            </button>
          )}
          {rootPath && (
            <button
              onClick={() => createNote(rootPath)}
              className="p-1.5 rounded text-gray-400 hover:text-gray-100 hover:bg-[#1e2327] transition-colors"
              title="New note"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
      </div>

      {root === null && <div className="px-3 py-2 text-xs text-gray-600">Loading…</div>}

      {root && root.folders.length === 0 && root.notes.length === 0 && (
        <div className="px-3 py-6 text-center">
          <p className="text-xs text-gray-600 mb-3">No notes yet.</p>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => createFolder(rootPath!)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#1e2327] hover:bg-[#2a3136] border border-[#30363d] rounded text-gray-200 whitespace-nowrap"
            >
              <FolderPlus size={12} /> <span>Folder</span>
            </button>
            <button
              onClick={() => createNote(rootPath!)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded whitespace-nowrap"
            >
              <Plus size={12} /> <span>Note</span>
            </button>
          </div>
          <p className="text-[10px] text-gray-600 mt-3">
            Or right-click anywhere in this panel.
          </p>
        </div>
      )}

      {root && (root.folders.length > 0 || root.notes.length > 0) && (
        <>
          {root.folders.map((f) => {
            const childPath = `${rootPath}/${f}`.replace(/\/+/g, '/');
            return renderFolder(childPath, f, 0);
          })}
          {root.notes.map((n) => renderNote(n, 0))}
        </>
      )}
    </div>
  );
}

// ── journal tree ─────────────────────────────────────────────────────────────

type Day = { day: number; file: string; icon: string; color: string };

type Ctx =
  | { kind: 'day'; year: string; month: string; day: number; file: string; x: number; y: number }
  | { kind: 'month'; year: string; month: string; x: number; y: number }
  | { kind: 'year'; year: string; x: number; y: number }
  | { kind: 'yearNote'; year: string; x: number; y: number }
  | { kind: 'background'; x: number; y: number }
  | null;

type PickerState = {
  kind: 'icon' | 'color';
  folderKey?: string;
  notePath?: string;
  label: string;
  top: number;
  left: number;
} | null;

function JournalTree({
  category,
  categoryDir,
  activeView,
  folderMeta,
  saveFolderMeta,
  showExtensions,
  onOpenDay,
  onOpenMonth,
  onOpenToday,
  onOpenNote,
  confirmAsync,
  promptAsync,
}: {
  category: Category;
  categoryDir: (cat: Category) => Promise<string>;
  activeView: any;
  folderMeta: FolderMetaMap;
  saveFolderMeta: (patch: Record<string, any>) => Promise<void>;
  showExtensions: boolean;
  onOpenDay: (cat: Category, year: number, month: number, day: number) => void;
  onOpenMonth: (cat: Category, year: number, month: number) => void;
  onOpenToday: (cat: Category) => void;
  onOpenNote: (cat: Category, note: { path: string; name: string }) => void;
  confirmAsync: (msg: string) => Promise<boolean>;
  promptAsync: (msg: string, defaultValue?: string) => Promise<string | null>;
}) {
  const [years, setYears] = useState<string[] | null>(null);
  const [expandedYears, setExpandedYears] = useState<Record<string, boolean>>({});
  const [months, setMonths] = useState<Record<string, string[]>>({});
  const [expandedMonths, setExpandedMonths] = useState<Record<string, boolean>>({});
  const [days, setDays] = useState<Record<string, Day[]>>({});
  const [yearNotes, setYearNotes] = useState<Record<string, { icon: string; color: string } | null>>({});
  const [ctx, setCtx] = useState<Ctx>(null);
  const [picker, setPicker] = useState<PickerState>(null);
  const [currentDate, setCurrentDate] = useState<{ year: number; month: number; day: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const expandedYearsRef = useRef(expandedYears);
  const expandedMonthsRef = useRef(expandedMonths);
  useEffect(() => { expandedYearsRef.current = expandedYears; }, [expandedYears]);
  useEffect(() => { expandedMonthsRef.current = expandedMonths; }, [expandedMonths]);

  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current?.contains(e.target as Node)) return;
      setPicker(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicker(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [picker]);

  const monthLabel = (m: string) =>
    new Date(2000, Number(m) - 1, 1).toLocaleString('default', { month: 'long' });

  const yearKey = (y: string) => makeFolderKey(category.id, y);
  const monthKey = (y: string, m: string) => makeFolderKey(category.id, y, m);

  const dayFilePath = async (year: string, month: string, file: string) => {
    const dir = await categoryDir(category);
    return join(dir, year, month, file);
  };

  const yearNotePath = async (year: string) => {
    const dir = await categoryDir(category);
    return join(dir, year, `_${year}-Year.note`);
  };

  const readYears = async () => {
    const dir = await categoryDir(category);
    try {
      if (!(await exists(dir))) return [];
      const entries = await readDir(dir);
      const ys = entries.filter((e) => e.isDirectory).map((e) => e.name).sort((a, b) => Number(b) - Number(a));
      const status: Record<string, { icon: string; color: string } | null> = {};
      for (const y of ys) {
        const candidates = [await join(dir, y, `_${y}-Year.note`), await join(dir, y, `_${y}-Year.md`)];
        let found: string | null = null;
        for (const p of candidates) {
          try { if (await exists(p)) { found = p; break; } } catch {}
        }
        status[y] = found ? await readNoteMeta(found) : null;
      }
      setYearNotes(status);
      return ys;
    } catch { return []; }
  };

  const readMonths = async (year: string) => {
    const dir = await categoryDir(category);
    const fullPath = await join(dir, year);
    try {
      if (!(await exists(fullPath))) return [];
      const entries = await readDir(fullPath);
      return entries.filter((e) => e.isDirectory).map((e) => e.name).sort((a, b) => Number(b) - Number(a));
    } catch { return []; }
  };

  const readDays = async (year: string, month: string): Promise<Day[]> => {
    const dir = await categoryDir(category);
    const fullPath = await join(dir, year, month);
    try {
      if (!(await exists(fullPath))) return [];
      const entries = await readDir(fullPath);
      const list: Day[] = [];
      for (const e of entries) {
        if (!e.name) continue;
        const parsed = parseDayFile(e.name);
        if (!parsed) continue;
        const meta = await readNoteMeta(await join(fullPath, e.name));
        list.push({ file: e.name, day: parsed.day, icon: meta.icon, color: meta.color });
      }
      list.sort((a, b) => a.day - b.day);
      return list;
    } catch { return []; }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const dir = await categoryDir(category);
        await ensureFolder(dir, `journal "${category.name}"`);
      } catch {}
      const ys = await readYears();
      if (mounted) setYears(ys);
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category.id]);

  useEffect(() => {
    const onFolderChanged = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { path?: string } | undefined;
      const changed = detail?.path;
      if (!changed) return;
      const catDir = await categoryDir(category);
      const normalizedChanged = changed.replace(/\\/g, '/');
      const normalizedCatDir = catDir.replace(/\\/g, '/');
      if (!normalizedChanged.startsWith(normalizedCatDir)) return;
      const rel = normalizedChanged.slice(normalizedCatDir.length).replace(/^\/+/, '');
      const parts = rel.split('/').filter(Boolean);
      if (parts.length === 0) { setYears(await readYears()); return; }
      if (parts.length === 1 && expandedYearsRef.current[parts[0]]) {
        const ms = await readMonths(parts[0]);
        setMonths((p) => ({ ...p, [parts[0]]: ms }));
        return;
      }
      if (parts.length === 2 && expandedMonthsRef.current[`${parts[0]}/${parts[1]}`]) {
        const ds = await readDays(parts[0], parts[1]);
        setDays((p) => ({ ...p, [`${parts[0]}/${parts[1]}`]: ds }));
      }
    };
    const onFileChanged = async (e: Event) => {
      const p = (e as CustomEvent).detail?.path?.replace(/\\/g, '/');
      if (!p) return;
      for (const key of Object.keys(expandedMonthsRef.current)) {
        if (!expandedMonthsRef.current[key]) continue;
        const [yearStr, monthStr] = key.split('/');
        if (p.includes(`/${yearStr}/${monthStr}/`)) {
          const ds = await readDays(yearStr, monthStr);
          setDays((prev) => ({ ...prev, [key]: ds }));
          break;
        }
      }
      for (const year of Object.keys(yearNotes)) {
        if (p.endsWith(`_${year}-Year.note`)) {
          const found = await readNoteMeta(p);
          setYearNotes((prev) => ({ ...prev, [year]: found }));
          break;
        }
      }
    };
    window.addEventListener('folder-changed', onFolderChanged);
    window.addEventListener('file-changed', onFileChanged);
    return () => {
      window.removeEventListener('folder-changed', onFolderChanged);
      window.removeEventListener('file-changed', onFileChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category.id]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      const dirName = category.dirName;
      if (dirName && detail.dir && !String(detail.dir).endsWith(dirName)) return;
      setCurrentDate({ year: detail.year, month: detail.month, day: detail.day });
      const yearStr = String(detail.year);
      const monthStr = pad(detail.month);
      setExpandedYears((p) => ({ ...p, [yearStr]: true }));
      setExpandedMonths((p) => ({ ...p, [`${yearStr}/${monthStr}`]: true }));
      (async () => {
        const ms = await readMonths(yearStr);
        setMonths((p) => ({ ...p, [yearStr]: ms }));
        const ds = await readDays(yearStr, monthStr);
        setDays((p) => ({ ...p, [`${yearStr}/${monthStr}`]: ds }));
      })();
    };
    window.addEventListener('journal-date-changed', handler);
    return () => window.removeEventListener('journal-date-changed', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category.id, category.dirName]);

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [ctx]);

  const toggleYear = async (year: string) => {
    if (expandedYears[year]) { setExpandedYears((p) => ({ ...p, [year]: false })); return; }
    setExpandedYears((p) => ({ ...p, [year]: true }));
    if (months[year] === undefined) {
      const ms = await readMonths(year);
      setMonths((p) => ({ ...p, [year]: ms }));
    }
  };

  const toggleMonth = async (year: string, month: string) => {
    const key = `${year}/${month}`;
    if (expandedMonths[key]) { setExpandedMonths((p) => ({ ...p, [key]: false })); return; }
    setExpandedMonths((p) => ({ ...p, [key]: true }));
    if (days[key] === undefined) {
      const ds = await readDays(year, month);
      setDays((p) => ({ ...p, [key]: ds }));
    }
  };

  const openPicker = (kind: 'icon' | 'color', target: { folderKey?: string; notePath?: string; label: string }, x: number, y: number) => {
    const W = kind === 'icon' ? 340 : 240;
    const H = kind === 'icon' ? 460 : 220;
    const left = Math.min(x, window.innerWidth - W - 12);
    const top = Math.min(y, window.innerHeight - H - 12);
    setPicker({ kind, ...target, top: Math.max(12, top), left: Math.max(12, left) });
    setCtx(null);
  };

  const currentPickerValue = (): string => {
    if (!picker) return '';
    if (picker.folderKey) {
      if (picker.kind === 'icon') return folderMeta[picker.folderKey]?.icon || '';
      return folderMeta[picker.folderKey]?.color || 'default';
    }
    if (picker.notePath) {
      for (const k of Object.keys(days)) {
        const match = days[k].find((x) => picker.notePath!.endsWith(x.file));
        if (match) return picker.kind === 'icon' ? match.icon : match.color || 'default';
      }
      for (const y of Object.keys(yearNotes)) {
        const yn = yearNotes[y];
        if (yn && picker.notePath.endsWith(`_${y}-Year.note`)) {
          return picker.kind === 'icon' ? yn.icon : yn.color || 'default';
        }
      }
    }
    return picker.kind === 'icon' ? '' : 'default';
  };

  const applyPickerValue = async (value: string) => {
    if (!picker) return;
    if (picker.folderKey) {
      await saveFolderMeta({
        [picker.folderKey]: { ...(folderMeta[picker.folderKey] || {}), [picker.kind]: value },
      });
    } else if (picker.notePath) {
      await writeNoteMeta(picker.notePath, { [picker.kind]: value });
      window.dispatchEvent(new CustomEvent('file-changed', { detail: { path: picker.notePath } }));
      window.dispatchEvent(new CustomEvent('note-frontmatter-changed', { detail: { path: picker.notePath } }));
    }
    if (picker.kind === 'icon') setPicker(null);
  };

  const clearFolderMeta = async (key: string) => { await saveFolderMeta({ [key]: {} }); };

  const createFolder = async () => {
    const input = await promptAsync('Name this folder (e.g. 2024):');
    if (!input) return;
    const safe = input.trim().replace(/[\\/:*?"<>|]/g, '-');
    if (!safe) return;
    const dir = await categoryDir(category);
    const target = await join(dir, safe);
    await ensureFolder(target, `year folder "${safe}"`);
    const ys = await readYears();
    setYears(ys);
    if (/^\d{4}$/.test(safe)) {
      setExpandedYears((p) => ({ ...p, [safe]: true }));
      setMonths((p) => ({ ...p, [safe]: [] }));
    }
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: dir } }));
  };

  const createMonth = async (year: string) => {
    const input = await promptAsync(`Month for ${year} (1-12 or name):`);
    if (!input) return;
    const trimmed = input.trim();
    const names = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    let num: number | null = null;
    if (/^\d{1,2}$/.test(trimmed)) { const n = Number(trimmed); if (n >= 1 && n <= 12) num = n; }
    if (num === null) {
      const lower = trimmed.toLowerCase();
      const idx = names.findIndex((n) => n === lower || n.startsWith(lower));
      if (idx !== -1 && lower.length >= 3) num = idx + 1;
    }
    if (num === null) { await confirmAsync('Could not parse that month.'); return; }
    const mm = pad(num);
    const dir = await categoryDir(category);
    const target = await join(dir, year, mm);
    await ensureFolder(target, `month folder "${mm}"`);
    const ms = await readMonths(year);
    setMonths((p) => ({ ...p, [year]: ms }));
    setExpandedYears((p) => ({ ...p, [year]: true }));
    setExpandedMonths((p) => ({ ...p, [`${year}/${mm}`]: true }));
    setDays((p) => ({ ...p, [`${year}/${mm}`]: [] }));
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: await join(dir, year) } }));
  };

  const createDayEntry = async (year: string, month: string) => {
    const y = Number(year);
    const m = Number(month);
    const input = await promptAsync(`Day number in ${monthLabel(month)} ${year}:`);
    if (!input) return;
    const dayNum = Number(input.trim());
    if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) { await confirmAsync('Invalid day.'); return; }
    const maxDay = new Date(y, m, 0).getDate();
    if (dayNum > maxDay) { await confirmAsync(`Max is ${maxDay}.`); return; }
    const fileName = `${formatDayName(y, m, dayNum)}.note`;
    const dir = await categoryDir(category);
    const monthPath = await join(dir, year, month);
    await ensureFolder(monthPath, 'month');
    const filePath = await join(monthPath, fileName);
    try {
      if (await exists(filePath)) {
        const ok = await confirmAsync(`Entry already exists. Open it?`);
        if (ok) onOpenDay(category, y, m, dayNum);
        return;
      }
    } catch {}
    try {
      await writeTextFile(filePath, `---\ncreated: ${new Date().toISOString()}\n---\n\n`);
    } catch (e) { await confirmAsync(`Write failed: ${String(e)}`); return; }
    const ds = await readDays(year, month);
    setDays((p) => ({ ...p, [`${year}/${month}`]: ds }));
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: monthPath } }));
    onOpenDay(category, y, m, dayNum);
  };

  const openYearNote = async (year: string) => {
    const path = await yearNotePath(year);
    onOpenNote(category, { path, name: `_${year}-Year.note` });
  };

  const addYearNote = async (year: string) => {
    const path = await yearNotePath(year);
    try { await readTextFile(path); } catch {
      await writeTextFile(path, `---\ncreated: ${new Date().toISOString()}\n---\n\n`);
    }
    setYearNotes((p) => ({ ...p, [year]: { icon: '', color: '' } }));
    const dir = await categoryDir(category);
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: await join(dir, year) } }));
    onOpenNote(category, { path, name: `_${year}-Year.note` });
  };

  const deleteYearNote = async (year: string) => {
    const ok = await confirmAsync(`Move the ${year} year note to the trash?`);
    if (!ok) return;
    const dir = await categoryDir(category);
    for (const p of [await join(dir, year, `_${year}-Year.note`), await join(dir, year, `_${year}-Year.md`)]) {
      try { if (await exists(p)) await moveToTrash(p); } catch {}
    }
    setYearNotes((p) => ({ ...p, [year]: null }));
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: await join(dir, year) } }));
  };

  const deleteYear = async () => {
    if (!ctx || ctx.kind !== 'year') return;
    const { year } = ctx;
    setCtx(null);
    const ok = await confirmAsync(`Move the entire ${year} folder to the trash?`);
    if (!ok) return;
    const dir = await categoryDir(category);
    await moveToTrash(await join(dir, year));
    setYears((p) => (p || []).filter((y) => y !== year));
    setMonths((p) => { const n = { ...p }; delete n[year]; return n; });
    setYearNotes((p) => { const n = { ...p }; delete n[year]; return n; });
    setDays((p) => { const next: typeof p = {}; for (const k of Object.keys(p)) if (!k.startsWith(`${year}/`)) next[k] = p[k]; return next; });
    setExpandedYears((p) => { const n = { ...p }; delete n[year]; return n; });
    await clearFolderMeta(yearKey(year));
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: dir } }));
  };

  const deleteDay = async () => {
    if (!ctx || ctx.kind !== 'day') return;
    const { year, month, file } = ctx;
    setCtx(null);
    const ok = await confirmAsync(`Move ${file} to the trash?`);
    if (!ok) return;
    const dir = await categoryDir(category);
    const monthPath = await join(dir, year, month);
    await moveToTrash(await join(monthPath, file));
    setDays((p) => ({
      ...p,
      [`${year}/${month}`]: (p[`${year}/${month}`] || []).filter((d) => d.file !== file),
    }));
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: monthPath } }));
  };

  const deleteMonthNote = async () => {
    if (!ctx || ctx.kind !== 'month') return;
    const { year, month } = ctx;
    setCtx(null);
    const dir = await categoryDir(category);
    const monthPath = await join(dir, year, month);
    for (const p of [await join(monthPath, `_${year}-${month}-Month.note`), await join(monthPath, `_${year}-${month}-Month.md`)]) {
      try { if (await exists(p)) await moveToTrash(p); } catch {}
    }
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: monthPath } }));
  };

  const deleteEntireMonth = async () => {
    if (!ctx || ctx.kind !== 'month') return;
    const { year, month } = ctx;
    setCtx(null);
    const ok = await confirmAsync(`Move the entire ${monthLabel(month)} ${year} folder to the trash?`);
    if (!ok) return;
    const dir = await categoryDir(category);
    await moveToTrash(await join(dir, year, month));
    setMonths((p) => ({ ...p, [year]: (p[year] || []).filter((m) => m !== month) }));
    setDays((p) => { const n = { ...p }; delete n[`${year}/${month}`]; return n; });
    setExpandedMonths((p) => { const n = { ...p }; delete n[`${year}/${month}`]; return n; });
    await clearFolderMeta(monthKey(year, month));
    window.dispatchEvent(new CustomEvent('folder-changed', { detail: { path: await join(dir, year) } }));
  };

  const isActiveDay = (y: string, m: string, d: number) => {
    if (currentDate) return currentDate.year === Number(y) && currentDate.month === Number(m) && currentDate.day === d;
    return activeView?.kind === 'journal' && activeView.focus?.year === Number(y) && activeView.focus?.month === Number(m) && activeView.focus?.day === d && activeView.focusMode === 'day';
  };

  const pickerCurrent = currentPickerValue();

  return (
    <div
      className="p-2 min-h-full"
      onContextMenu={(e) => { e.preventDefault(); setCtx({ kind: 'background', x: e.clientX, y: e.clientY }); }}
    >
      {ctx && (
        <div
          className="fixed z-50 bg-[#1e2327] border border-[#2a3136] rounded shadow-xl py-1 w-60"
          style={{ top: ctx.y, left: ctx.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctx.kind === 'background' && (
            <button onClick={() => { setCtx(null); createFolder(); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2">
              <FolderPlus size={13} /> <span>Add folder</span>
            </button>
          )}

          {ctx.kind === 'year' && (
            <>
              {yearNotes[ctx.year] ? (
                <button onClick={() => { const y = ctx.year; setCtx(null); openYearNote(y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                  <FileText size={13} /> <span>Open year note</span>
                </button>
              ) : (
                <button onClick={() => { const y = ctx.year; setCtx(null); addYearNote(y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                  <FileText size={13} /> <span>Add year note</span>
                </button>
              )}
              <button onClick={() => { const y = ctx.year; setCtx(null); createMonth(y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                <Plus size={13} /> <span>Add month</span>
              </button>
              <button onClick={() => { const y = ctx.year; openPicker('icon', { folderKey: yearKey(y), label: y }, ctx.x, ctx.y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2">
                <Smile size={13} /> <span>Change icon</span>
              </button>
              <button onClick={() => { const y = ctx.year; openPicker('color', { folderKey: yearKey(y), label: y }, ctx.x, ctx.y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                <Pencil size={13} /> <span>Change color</span>
              </button>
              <button onClick={deleteYear} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2">
                <Trash2 size={13} /> <span>Move year to trash</span>
              </button>
            </>
          )}

          {ctx.kind === 'month' && (
            <>
              <button onClick={() => { const { year, month } = ctx; setCtx(null); createDayEntry(year, month); }} className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                <Plus size={13} /> <span>Add entry</span>
              </button>
              <button onClick={() => { const { year, month } = ctx; openPicker('icon', { folderKey: monthKey(year, month), label: `${monthLabel(month)} ${year}` }, ctx.x, ctx.y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2">
                <Smile size={13} /> <span>Change icon</span>
              </button>
              <button onClick={() => { const { year, month } = ctx; openPicker('color', { folderKey: monthKey(year, month), label: `${monthLabel(month)} ${year}` }, ctx.x, ctx.y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                <Pencil size={13} /> <span>Change color</span>
              </button>
              <button onClick={deleteMonthNote} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                <Trash2 size={13} /> <span>Delete month note (→ trash)</span>
              </button>
              <button onClick={deleteEntireMonth} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2">
                <Trash2 size={13} /> <span>Move month to trash</span>
              </button>
            </>
          )}

          {ctx.kind === 'day' && (
            <>
              <button onClick={async () => { const { year, month, file } = ctx; const path = await dayFilePath(year, month, file); openPicker('icon', { notePath: path, label: file.replace(/\.(note|md)$/, '') }, ctx.x, ctx.y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2">
                <Smile size={13} /> <span>Change icon</span>
              </button>
              <button onClick={async () => { const { year, month, file } = ctx; const path = await dayFilePath(year, month, file); openPicker('color', { notePath: path, label: file.replace(/\.(note|md)$/, '') }, ctx.x, ctx.y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                <Pencil size={13} /> <span>Change color</span>
              </button>
              <button onClick={deleteDay} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2">
                <Trash2 size={13} /> <span>Move entry to trash</span>
              </button>
            </>
          )}

          {ctx.kind === 'yearNote' && (
            <>
              <button onClick={async () => { const y = ctx.year; const path = await yearNotePath(y); openPicker('icon', { notePath: path, label: `${y} year note` }, ctx.x, ctx.y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2">
                <Smile size={13} /> <span>Change icon</span>
              </button>
              <button onClick={async () => { const y = ctx.year; const path = await yearNotePath(y); openPicker('color', { notePath: path, label: `${y} year note` }, ctx.x, ctx.y); }} className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#2a3136] flex items-center space-x-2 border-b border-[#2a3136]">
                <Pencil size={13} /> <span>Change color</span>
              </button>
              <button onClick={() => { const y = ctx.year; setCtx(null); deleteYearNote(y); }} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center space-x-2">
                <Trash2 size={13} /> <span>Move year note to trash</span>
              </button>
            </>
          )}
        </div>
      )}

      {picker && picker.kind === 'icon' && createPortal(
        <div ref={pickerRef} className="fixed z-[100] bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl overflow-hidden" style={{ top: picker.top, left: picker.left }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a3136]">
            <span className="text-xs text-gray-400 truncate">Icon for <span className="text-gray-200">{picker.label}</span></span>
            <button onClick={() => setPicker(null)} className="text-gray-500 hover:text-gray-300 p-0.5"><X size={12} /></button>
          </div>
          <EmojiPicker theme={Theme.DARK} emojiStyle={EmojiStyle.NATIVE} onEmojiClick={(d) => applyPickerValue(d.emoji)} width={320} height={360} previewConfig={{ showPreview: false }} />
          <button onClick={() => applyPickerValue('')} className="w-full text-left text-xs text-gray-500 hover:text-red-400 hover:bg-[#2a3136] px-3 py-2 border-t border-[#2a3136]">Remove icon</button>
        </div>,
        document.body
      )}

      {picker && picker.kind === 'color' && createPortal(
        <div ref={pickerRef} className="fixed z-[100] bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl p-3 w-56" style={{ top: picker.top, left: picker.left }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-wider text-gray-500">Color for <span className="text-gray-300 normal-case">{picker.label}</span></span>
            <button onClick={() => setPicker(null)} className="text-gray-500 hover:text-gray-300 p-0.5"><X size={12} /></button>
          </div>
          <div className="grid grid-cols-5 gap-2 mb-3">
            {Object.entries(FOLDER_COLORS).filter(([k]) => k !== 'default').map(([k, v]) => {
              const active = pickerCurrent === k;
              return (
                <button key={k} title={v.label} onClick={() => applyPickerValue(k)}
                  className={`w-7 h-7 rounded-full transition-transform hover:scale-110 ${active ? 'ring-2 ring-white ring-offset-1 ring-offset-[#1e2327]' : ''}`}
                  style={{ backgroundColor: v.text }} />
              );
            })}
          </div>
          <button onClick={() => applyPickerValue('default')} className="w-full text-left text-xs text-gray-500 hover:text-gray-300 hover:bg-[#2a3136] px-2 py-1.5 rounded">Reset to default</button>
        </div>,
        document.body
      )}

      <button onClick={() => onOpenToday(category)} className="w-full text-left px-3 py-1.5 rounded text-sm text-gray-300 hover:bg-[#1e2327] flex items-center space-x-2 mb-1">
        <CalendarDays size={13} className="text-gray-500" />
        <span>Today</span>
      </button>

      {years === null && <div className="px-3 py-2 text-xs text-gray-600">Loading…</div>}
      {years?.length === 0 && <div className="px-3 py-2 text-xs text-gray-600">Right-click here to add a folder.</div>}

      {(years || []).map((year) => {
        const yMeta = folderMeta[yearKey(year)];
        const yColor = colorForFolder(yMeta);
        return (
          <div key={year}>
            <div
              onClick={() => toggleYear(year)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ kind: 'year', year, x: e.clientX, y: e.clientY }); }}
              className="flex items-center space-x-2 py-1.5 px-2 rounded cursor-pointer hover:bg-[#1e2327] text-xs uppercase tracking-wider"
              style={{ color: yColor }}
            >
              {expandedYears[year] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {yMeta?.icon && <span className="text-sm">{yMeta.icon}</span>}
              <span>{year}</span>
            </div>

            {expandedYears[year] && (
              <>
                {yearNotes[year] && (
                  <button
                    onClick={() => openYearNote(year)}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ kind: 'yearNote', year, x: e.clientX, y: e.clientY }); }}
                    className="w-full text-left py-1 pl-6 pr-2 rounded text-sm hover:bg-[#1e2327] flex items-center space-x-2"
                    style={{ color: yearNotes[year]!.color ? FOLDER_COLORS[yearNotes[year]!.color]?.text || '#9ca3af' : '#6b7280' }}
                  >
                    {yearNotes[year]!.icon ? <span className="text-sm">{yearNotes[year]!.icon}</span> : <FileText size={11} />}
                    <span>Year note</span>
                  </button>
                )}

                {months[year] === undefined && <div className="pl-6 pr-2 py-1 text-xs text-gray-600 italic">Loading…</div>}
                {months[year] !== undefined && months[year].length === 0 && <div className="pl-6 pr-2 py-1 text-xs text-gray-600 italic">No months yet</div>}

                {(months[year] || []).map((month) => {
                  const key = `${year}/${month}`;
                  const mKey = monthKey(year, month);
                  const mMeta = folderMeta[mKey];
                  const mColor = colorForFolder(mMeta);
                  return (
                    <div key={key}>
                      <div
                        className="group flex items-center justify-between py-1 pl-6 pr-2 rounded hover:bg-[#1e2327] text-sm"
                        style={{ color: mColor }}
                        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ kind: 'month', year, month, x: e.clientX, y: e.clientY }); }}
                      >
                        <div className="flex items-center space-x-2 cursor-pointer flex-grow" onClick={() => toggleMonth(year, month)}>
                          {expandedMonths[key] ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          {mMeta?.icon && <span className="text-sm">{mMeta.icon}</span>}
                          <span>{monthLabel(month)}</span>
                        </div>
                        <button onClick={() => onOpenMonth(category, Number(year), Number(month))} className="opacity-0 group-hover:opacity-100 text-[10px] uppercase tracking-wide text-gray-500 hover:text-gray-200" title="Open month note">Month</button>
                      </div>

                      {expandedMonths[key] && days[key] === undefined && <div className="pl-12 pr-2 py-1 text-xs text-gray-600 italic">Loading…</div>}
                      {expandedMonths[key] && days[key] !== undefined && days[key].length === 0 && <div className="pl-12 pr-2 py-1 text-xs text-gray-600 italic">No entries</div>}

                      {expandedMonths[key] && (days[key] || []).map(({ day, file, icon, color }) => {
                        const active = isActiveDay(year, month, day);
                        const dayColor = color ? FOLDER_COLORS[color]?.text || '' : '';
                        const { base, ext } = splitFilename(file);
                        return (
                          <div
                            key={file}
                            onClick={() => onOpenDay(category, Number(year), Number(month), day)}
                            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ kind: 'day', year, month, day, file, x: e.clientX, y: e.clientY }); }}
                            className={`py-1 pl-12 pr-2 rounded cursor-pointer text-sm flex items-center space-x-1.5 ${active ? 'bg-[#2a3136]' : 'hover:bg-[#1e2327]'}`}
                            style={{ color: active ? dayColor || '#e5e7eb' : dayColor || undefined }}
                          >
                            {icon && <span className="flex-shrink-0">{icon}</span>}
                            <span className="truncate">{base}</span>
                            {showExtensions && ext && <span className="flex-shrink-0 text-[9px] uppercase tracking-wider leading-none px-1 py-0.5 rounded border border-[#30363d] bg-[#1a1e21] text-gray-500">{ext}</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}