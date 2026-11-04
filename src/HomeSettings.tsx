// src/HomeSettings.tsx
import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { mkdir, copyFile, readDir, readFile, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { moveToTrash } from "./trash";
import { usePlugins, type HomeWidgetSlot } from "./plugins";
import {
  Plus, Trash2, ChevronUp, ChevronDown, Link as LinkIcon,
  Image as ImageIcon, Palette,
  RotateCcw, Puzzle, FileText, X,
} from "lucide-react";

export interface HomeShortcut {
  id: string;
  label: string;
  kind: "journal-today" | "category" | "url" | "plugin" | "new-note" | "new-entry" | "note" | "journal-date" | "plugin-action";
  targetId?: string;
  actionId?: string; // for plugin-action
  icon?: string;
  color?: string; // hex color or empty for default
  textColor?: string; // hex color or empty for default
  dateString?: string; // for journal-date
}

export interface HomeSettings {
  backgroundType: "none" | "color" | "image";
  backgroundColor: string;
  backgroundImage: string;
  backgroundBlur: number;
  backgroundOpacity: number;
  backgroundPosX: number;
  backgroundPosY: number;
  overlayColor: string;
  overlayOpacity: number;
  showGreeting: boolean;
  showSearch: boolean;
  greetingText: string;
  contentWidth: "narrow" | "default" | "wide";
  shortcutsLayout: "grid" | "list";
  shortcuts: HomeShortcut[];

  /** Plugin widgets enabled, "<pluginId>:<widgetId>", in order. */
  widgets: string[];

  /** Plugin shortcuts enabled, "<pluginId>:<shortcutId>", in order. */
  pluginShortcuts: string[];

  /** The active custom home screen plugin ID, if any. */
  activeHomeScreen?: string;
}

export const DEFAULT_HOME_SETTINGS: HomeSettings = {
  backgroundType: "none",
  backgroundColor: "#0f1315",
  backgroundImage: "",
  backgroundBlur: 0,
  backgroundOpacity: 100,
  backgroundPosX: 50,
  backgroundPosY: 50,
  overlayColor: "#0f1315",
  overlayOpacity: 0,
  showGreeting: true,
  showSearch: true,
  greetingText: "",
  contentWidth: "default",
  shortcutsLayout: "grid",
  shortcuts: [],
  widgets: [],
  pluginShortcuts: [],
  activeHomeScreen: undefined,
};

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function HomeSettingsPanel({
  settings,
  onChange,
  categories,
  vaultPath,
}: {
  settings: HomeSettings;
  onChange: (next: HomeSettings) => void;
  categories: any[];
  vaultPath: string;
}) {
  const [tab, setTab] = useState<"shortcuts" | "widgets" | "appearance">("shortcuts");

  // Add Modal State
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<"category" | "note" | "url">("category");
  const [addCatId, setAddCatId] = useState("");
  const [addAction, setAddAction] = useState<string>("open");
  const [addNotePath, setAddNotePath] = useState("");
  const [addNoteSearch, setAddNoteSearch] = useState("");
  const [addDate, setAddDate] = useState(new Date().toISOString().slice(0, 10));
  const [addUrl, setAddUrl] = useState("");
  const [allCategories, setAllCategories] = useState<any[]>(categories);
  const [vaultNotes, setVaultNotes] = useState<{ path: string, name: string }[]>([]);
  const [isFetchingNotes, setIsFetchingNotes] = useState(false);

  // Fetch ALL categories directly from the vault so we don't miss any
  useEffect(() => {
    (async () => {
      try {
        const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
        const meta = JSON.parse(raw);
        if (Array.isArray(meta.categories)) {
          setAllCategories(meta.categories);
        }
      } catch (e) {
        console.error("Failed to load categories for shortcuts", e);
      }
    })();
  }, [vaultPath, categories]);

  const patch = (p: Partial<HomeSettings>) => onChange({ ...settings, ...p });

  useEffect(() => {
    if (addTarget !== "note" || vaultNotes.length > 0) return;
    setIsFetchingNotes(true);
    const fetchNotes = async () => {
      const notes: { path: string, name: string }[] = [];
      const walk = async (dir: string, depth = 0) => {
        if (depth > 8) return;
        try {
          const entries = await readDir(dir);
          for (const e of entries) {
            if (!e.name || e.name.startsWith(".") || e.name === "assets" || e.name === "_attachments") continue;
            const full = await join(dir, e.name);
            if (e.isDirectory) await walk(full, depth + 1);
            else if (e.name.endsWith(".selah")) notes.push({ path: full, name: e.name.replace(/\.selah$/, "") });
          }
        } catch {}
      };
      await walk(vaultPath);
      setVaultNotes(notes);
      setIsFetchingNotes(false);
    };
    fetchNotes();
  }, [addTarget, vaultPath, vaultNotes.length]);

  const handleAddSubmit = () => {
    let sc: HomeShortcut | null = null;

    if (addTarget === "category") {
      const cat = allCategories.find((c) => c.id === addCatId);
      if (!cat) return;

      let kind: HomeShortcut["kind"] = "category";
      let label = cat.name;
      let icon = cat.icon || "📁";

      if (addAction === "journal-today") {
        kind = "journal-today";
        label = `${cat.name} (Today)`;
        icon = "📅";
      } else if (addAction.startsWith("plugin-action:")) {
        kind = "plugin-action";
        const actionId = addAction.split(":")[1];
        const act = (cat as any).shortcutActions?.find((a: any) => a.id === actionId);
        label = act ? act.label : cat.name;
        icon = act?.icon || cat.icon || "🧩";
      } else if (addAction === "journal-date") {
        if (!addDate) return;
        kind = "journal-date";
        const d = new Date(addDate + "T12:00:00");
        label = `${cat.name} (${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;
        icon = "📅";
      } else if (addAction === "new-note") {
        kind = "new-note";
        label = `New Note: ${cat.name}`;
        icon = "📝";
      } else if (addAction === "new-entry") {
        kind = "new-entry";
        label = `New Entry: ${cat.name}`;
        icon = "📔";
      }

      sc = {
        id: uid("sc"),
        label,
        kind,
        targetId: cat.id,
        actionId: addAction.startsWith("plugin-action:") ? addAction.split(":")[1] : undefined,
        icon,
        dateString: addAction === "journal-date" ? addDate : undefined
      };
    } else if (addTarget === "note") {
      const path = addNotePath.trim();
      if (!path) return;
      const name = path.split(/[/\\]/).pop()?.replace(/\.selah$/i, "") || "Note";
      sc = { id: uid("sc"), label: name, kind: "note", targetId: path, icon: "📄" };
    } else {
      const url = addUrl.trim();
      if (!url) return;
      sc = { id: uid("sc"), label: url, kind: "url", targetId: url, icon: "🔗" };
    }

    if (!sc) return;
    patch({ shortcuts: [...settings.shortcuts, sc] });
    setAddModalOpen(false);
    setAddCatId("");
    setAddUrl("");
    setAddNotePath("");
  };

  const removeShortcut = (id: string) =>
  patch({ shortcuts: settings.shortcuts.filter((s) => s.id !== id) });

  const updateShortcut = (id: string, p: Partial<HomeShortcut>) =>
  patch({ shortcuts: settings.shortcuts.map((s) => (s.id === id ? { ...s, ...p } : s)) });

  const moveShortcut = (id: string, dir: -1 | 1) => {
    const idx = settings.shortcuts.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const next = [...settings.shortcuts];
    const t = idx + dir;
    if (t < 0 || t >= next.length) return;
    [next[idx], next[t]] = [next[t], next[idx]];
    patch({ shortcuts: next });
  };

  const pickBackgroundImage = async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png","jpg","jpeg","webp","gif","avif","bmp","svg"] }],
      });
      if (!picked || typeof picked !== "string") return;

      const assetsDir = await join(vaultPath, ".assets");
      await mkdir(assetsDir, { recursive: true });

      const rawExt = (picked.split(".").pop() || "png").toLowerCase();
      const safeExt = rawExt.replace(/[^a-z0-9]/g, "") || "png";
      const destName = `home-background.${safeExt}`;
      const destPath = await join(assetsDir, destName);

      const srcNorm = picked.replace(/\\/g, "/");
      const dstNorm = destPath.replace(/\\/g, "/");

      if (srcNorm !== dstNorm) {
        try {
          const entries = await readDir(assetsDir);
          for (const e of entries) {
            if (!e.name || e.name === destName) continue;
            if (!/^home-background\./i.test(e.name)) continue;
            const oldPath = await join(assetsDir, e.name);
            try { await moveToTrash(oldPath); } catch {}
          }
        } catch {}

        await copyFile(picked, destPath);
      }

      patch({
        backgroundImage: `.assets/${destName}`,
        backgroundType: "image",
      });
    } catch (e) { console.error("[home] pick bg failed:", e); }
  };

  return (
    <div>
    <div className="flex items-center px-5 pt-3 border-b border-[#2a3136] gap-1">
    {[
      { id: "shortcuts" as const, label: "Shortcuts", icon: LinkIcon },
      { id: "widgets" as const, label: "Widgets", icon: Puzzle },
      { id: "appearance" as const, label: "Appearance", icon: Palette },
    ].map(({ id, label, icon: Icon }) => {
      const active = tab === id;
      return (
        <button
        key={id}
        type="button"
        onClick={() => setTab(id)}
        className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t transition-colors whitespace-nowrap ${
          active
          ? "text-gray-100 bg-[#161a1d] border-b-2 border-blue-500"
          : "text-gray-500 hover:text-gray-300"
        }`}
        >
        <Icon size={12} />
        <span>{label}</span>
        </button>
      );
    })}
    </div>

    <div className="p-5">
    {tab === "shortcuts" && (
      <div className="space-y-5">
      <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
      Your shortcuts
      </div>
      {settings.shortcuts.length === 0 ? (
        <p className="text-xs text-gray-500 italic py-3">
        No custom shortcuts yet. When empty, the home screen shows
        Today's Journal plus every category automatically. Add one
        below to take over.
        </p>
      ) : (
        <div className="space-y-1.5">
        {settings.shortcuts.map((sc, idx) => (
          <div
          key={sc.id}
          className="group flex items-center gap-2 rounded-md border border-[#2a3136] bg-[#131819] px-2.5 py-2"
          >
          <div className="flex flex-col">
          <button
          type="button"
          onClick={() => moveShortcut(sc.id, -1)}
          disabled={idx === 0}
          className="text-gray-600 hover:text-gray-300 disabled:opacity-30 p-0.5"
          title="Move up"
          >
          <ChevronUp size={11} />
          </button>
          <button
          type="button"
          onClick={() => moveShortcut(sc.id, 1)}
          disabled={idx === settings.shortcuts.length - 1}
          className="text-gray-600 hover:text-gray-300 disabled:opacity-30 p-0.5"
          title="Move down"
          >
          <ChevronDown size={11} />
          </button>
          </div>

          <input
          type="text"
          value={sc.icon || ""}
          onChange={(e) => updateShortcut(sc.id, { icon: e.target.value })}
          placeholder="📄"
          className="w-9 text-center bg-transparent border border-[#232a2e] rounded px-1 py-1 text-sm text-gray-200 outline-none focus:border-[#3a4147]"
          title="Emoji icon"
          />

          <input
          type="text"
          value={sc.label}
          onChange={(e) => updateShortcut(sc.id, { label: e.target.value })}
          className="flex-1 min-w-0 bg-transparent border border-[#232a2e] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-[#3a4147]"
          />
          <div className="flex items-center gap-1 flex-shrink-0">
          <input
          type="color"
          value={sc.color || "#161a1d"}
          onChange={(e) => updateShortcut(sc.id, { color: e.target.value })}
          className="w-6 h-6 rounded border border-[#30363d] bg-transparent cursor-pointer"
          title="Background color"
          />
          <input
          type="color"
          value={sc.textColor || "#d1d5db"}
          onChange={(e) => updateShortcut(sc.id, { textColor: e.target.value })}
          className="w-6 h-6 rounded border border-[#30363d] bg-transparent cursor-pointer"
          title="Text color"
          />
          {(sc.color || sc.textColor) && (
            <button
              type="button"
              onClick={() => updateShortcut(sc.id, { color: undefined, textColor: undefined })}
              className="text-gray-500 hover:text-red-400 p-1"
              title="Reset colors"
            >
              <RotateCcw size={12} />
            </button>
          )}
          </div>

          <span className="text-[10px] uppercase tracking-wider text-gray-600 flex-shrink-0 px-1">
          {sc.kind === "journal-today" ? "journal"
            : sc.kind === "category" ? "category" : "link"}
            </span>

            <button
            type="button"
            onClick={() => removeShortcut(sc.id)}
            className="text-gray-600 hover:text-red-400 p-1 flex-shrink-0"
            title="Remove"
            >
            <Trash2 size={12} />
            </button>
            </div>
        ))}
        </div>
      )}
      </div>

      <div className="border-t border-[#2a3136] pt-4">
        <button
          type="button"
          onClick={() => setAddModalOpen(true)}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
        >
          <Plus size={14} /> Add Shortcut
        </button>
      </div>
      </div>
    )}

    {/* ADD SHORTCUT MODAL */}
    {addModalOpen && (
      <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-6" onClick={() => setAddModalOpen(false)}>
        <div className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[420px] max-w-full flex flex-col" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] rounded-t-lg">
            <h3 className="text-sm font-medium text-gray-100">Add Shortcut</h3>
            <button onClick={() => setAddModalOpen(false)} className="text-gray-500 hover:text-gray-300"><X size={14} /></button>
          </div>
          <div className="p-4 space-y-4">

            <div className="flex gap-2">
              <button type="button" onClick={() => setAddTarget("category")} className={`flex-1 py-1.5 text-xs rounded border transition-colors ${addTarget === "category" ? "bg-blue-600/15 border-blue-500/50 text-blue-300" : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200"}`}>Category</button>
              <button type="button" onClick={() => setAddTarget("note")} className={`flex-1 py-1.5 text-xs rounded border transition-colors ${addTarget === "note" ? "bg-blue-600/15 border-blue-500/50 text-blue-300" : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200"}`}>Specific Note</button>
              <button type="button" onClick={() => setAddTarget("url")} className={`flex-1 py-1.5 text-xs rounded border transition-colors ${addTarget === "url" ? "bg-blue-600/15 border-blue-500/50 text-blue-300" : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200"}`}>URL</button>
            </div>

            {addTarget === "category" && (
              <>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 block">Select Category</label>
                  <DarkSelect
                    value={addCatId}
                    onChange={(v) => { setAddCatId(v); setAddAction("open"); }}
                    placeholder="Pick a category…"
                    options={allCategories.map((c: any) => ({ value: c.id, label: c.name, icon: c.icon }))}
                  />
                </div>

                {addCatId && (() => {
                  const cat = allCategories.find(c => c.id === addCatId);
                  if (!cat) return null;
                  return (
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-wider text-gray-500 block">Action</label>
                      <div className="flex flex-col gap-1.5 bg-[#131819] border border-[#2a3136] p-3 rounded">
                        {cat.mode === "journal" && (
                          <>
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="radio" name="action" checked={addAction === "journal-today"} onChange={() => setAddAction("journal-today")} /> Create Today's Journal</label>
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="radio" name="action" checked={addAction === "journal-date"} onChange={() => setAddAction("journal-date")} /> View Specific Date</label>
                            {addAction === "journal-date" && (
                              <input
                                type="date"
                                value={addDate}
                                onChange={(e) => setAddDate(e.target.value)}
                                className="mt-2 w-full bg-[#131819] border border-[#30363d] rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-blue-500"
                              />
                            )}
                          </>
                        )}
                        {cat.mode === "notes" && (
                          <>
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="radio" name="action" checked={addAction === "open"} onChange={() => setAddAction("open")} /> Open Notes View</label>
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="radio" name="action" checked={addAction === "new-note"} onChange={() => setAddAction("new-note")} /> Create New Note</label>
                          </>
                        )}
                        {cat.mode === "entries" && (
                          <>
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="radio" name="action" checked={addAction === "open"} onChange={() => setAddAction("open")} /> Open Entries View</label>
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="radio" name="action" checked={addAction === "new-entry"} onChange={() => setAddAction("new-entry")} /> Create New Entry</label>
                          </>
                        )}
                        {cat.mode === "abba" && (
                          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="radio" name="action" checked={addAction === "open"} onChange={() => setAddAction("open")} /> Open Abba</label>
                        )}
                        {cat.mode.startsWith("plugin:") && (
                          <>
                            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer"><input type="radio" name="action" checked={addAction === "open"} onChange={() => setAddAction("open")} /> Open Plugin</label>
                            {(cat as any).shortcutActions?.map((act: any) => (
                              <label key={act.id} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                                <input type="radio" name="action" checked={addAction === `plugin-action:${act.id}`} onChange={() => setAddAction(`plugin-action:${act.id}`)} />
                                {act.icon && <span>{act.icon}</span>} {act.label}
                              </label>
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}

            {addTarget === "note" && (
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 block">Search Notes</label>
                <input
                  type="text"
                  value={addNoteSearch}
                  onChange={(e) => setAddNoteSearch(e.target.value)}
                  placeholder="Type to search..."
                  className="w-full bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-[#3a4147] mb-2"
                />
                <div className="max-h-48 overflow-y-auto border border-[#2a3136] rounded bg-[#131819]">
                  {isFetchingNotes ? (
                    <div className="p-3 text-xs text-gray-500 italic">Loading notes...</div>
                  ) : (
                    vaultNotes.filter(n => n.name.toLowerCase().includes(addNoteSearch.toLowerCase())).slice(0, 50).map(n => (
                      <button
                        key={n.path}
                        type="button"
                        onClick={() => setAddNotePath(n.path)}
                        className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-[#2a3136] ${addNotePath === n.path ? "bg-blue-600/20 text-blue-300" : "text-gray-300"}`}
                      >
                        <FileText size={12} className="flex-shrink-0" />
                        <span className="truncate">{n.name}</span>
                      </button>
                    ))
                  )}
                  {vaultNotes.filter(n => n.name.toLowerCase().includes(addNoteSearch.toLowerCase())).length === 0 && !isFetchingNotes && (
                    <div className="p-3 text-xs text-gray-500 italic">No notes found.</div>
                  )}
                </div>
              </div>
            )}

            {addTarget === "url" && (
              <div>
                <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 block">URL</label>
                <input type="text" value={addUrl} onChange={e => setAddUrl(e.target.value)} placeholder="https://…" className="w-full bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-[#3a4147] font-mono" />
              </div>
            )}
          </div>
          <div className="px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex justify-end gap-2 rounded-b-lg">
            <button onClick={() => setAddModalOpen(false)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors">Cancel</button>
            <button
              onClick={handleAddSubmit}
              disabled={addTarget === "category" ? !addCatId : addTarget === "note" ? !addNotePath.trim() : !addUrl.trim()}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded font-medium transition-colors"
            >
              Add Shortcut
            </button>
          </div>
        </div>
      </div>
    )}

    {tab === "widgets" && <WidgetsTab settings={settings} patch={patch} />}

    {tab === "appearance" && (
      <AppearanceTab
      settings={settings}
      patch={patch}
      pickBackgroundImage={pickBackgroundImage}
      vaultPath={vaultPath}
      />
    )}
    </div>
    </div>
  );
}

const SLOT_LABELS: Record<HomeWidgetSlot, string> = {
  "header": "top",
  "above-shortcuts": "above shortcuts",
  "below-shortcuts": "below shortcuts",
  "above-verse": "above the verse",
};

function WidgetsTab({
  settings,
  patch,
}: {
  settings: HomeSettings;
  patch: (p: Partial<HomeSettings>) => void;
}) {
  const { homeWidgets, shortcuts: pluginShortcuts, homeScreens } = usePlugins();
  const enabled = settings.widgets ?? [];
  const enabledShortcuts = settings.pluginShortcuts ?? [];

  const toggle = (key: string) =>
  patch({
    widgets: enabled.includes(key)
    ? enabled.filter((k) => k !== key)
    : [...enabled, key],
  });

  const move = (key: string, dir: -1 | 1) => {
    const i = enabled.indexOf(key);
    const t = i + dir;
    if (i === -1 || t < 0 || t >= enabled.length) return;
    const next = [...enabled];
    [next[i], next[t]] = [next[t], next[i]];
    patch({ widgets: next });
  };

  return (
    <div className="space-y-5">
    <div>
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
    Plugin widgets
    </div>
    {homeWidgets.length === 0 ? (
      <p className="text-xs text-gray-500 italic py-3">
      No widgets available. Enable plugins in Settings → General, then install a plugin
      that calls <span className="font-mono">selah.registerHomeWidget()</span>.
      </p>
    ) : (
      <div className="space-y-1.5">
      {homeWidgets.map((w) => {
        const on = enabled.includes(w.key);
        const idx = enabled.indexOf(w.key);
        return (
          <div
          key={w.key}
          className="flex items-center gap-2 rounded-md border border-[#2a3136] bg-[#131819] px-2.5 py-2"
          >
          <span className="text-base leading-none w-6 text-center flex-shrink-0">
          {w.icon || "🧩"}
          </span>
          <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-100 truncate">{w.label}</div>
          <div className="text-[10px] text-gray-500 truncate">
          {SLOT_LABELS[w.slot]}
          {w.description ? ` · ${w.description}` : ""}
          </div>
          </div>
          {on && (
            <div className="flex flex-col">
            <button
            type="button"
            onClick={() => move(w.key, -1)}
            disabled={idx === 0}
            className="text-gray-600 hover:text-gray-300 disabled:opacity-30 p-0.5"
            title="Move up"
            >
            <ChevronUp size={11} />
            </button>
            <button
            type="button"
            onClick={() => move(w.key, 1)}
            disabled={idx === enabled.length - 1}
            className="text-gray-600 hover:text-gray-300 disabled:opacity-30 p-0.5"
            title="Move down"
            >
            <ChevronDown size={11} />
            </button>
            </div>
          )}
          <button
          type="button"
          onClick={() => toggle(w.key)}
          className="relative rounded-full transition-colors flex-shrink-0"
          style={{ width: 28, height: 16, backgroundColor: on ? "#3b82f6" : "#3a4147" }}
          aria-pressed={on}
          >
          <span
          className="absolute rounded-full bg-white"
          style={{ width: 12, height: 12, top: 2, left: on ? 14 : 2, transition: "left 150ms ease" }}
          />
          </button>
          </div>
        );
      })}
      </div>
    )}

    {/* Plugin Shortcuts */}
    {pluginShortcuts.length > 0 && (
      <div className="border-t border-[#2a3136] pt-4 mt-4">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
          Plugin Shortcuts
        </div>
        <div className="space-y-1.5">
          {pluginShortcuts.map((s) => {
            const on = enabledShortcuts.includes(s.key);
            return (
              <div key={s.key} className="flex items-center gap-2 rounded-md border border-[#2a3136] bg-[#131819] px-2.5 py-2">
                <span className="text-base leading-none w-6 text-center flex-shrink-0">{s.icon || "🔗"}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-100 truncate">{s.label}</div>
                  <div className="text-[10px] text-gray-500 truncate">From {s.pluginId}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    patch({
                      pluginShortcuts: on
                        ? enabledShortcuts.filter((k) => k !== s.key)
                        : [...enabledShortcuts, s.key],
                    });
                  }}
                  className="relative rounded-full transition-colors flex-shrink-0"
                  style={{ width: 28, height: 16, backgroundColor: on ? "#3b82f6" : "#3a4147" }}
                >
                  <span className="absolute rounded-full bg-white" style={{ width: 12, height: 12, top: 2, left: on ? 14 : 2, transition: "left 150ms ease" }} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    )}

    {/* Custom Home Screens */}
    {homeScreens.length > 0 && (
      <div className="border-t border-[#2a3136] pt-4 mt-4">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
          Custom Home Screen
        </div>
        <select
          value={settings.activeHomeScreen || ""}
          onChange={(e) => patch({ activeHomeScreen: e.target.value || undefined })}
          className="w-full bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-[#3a4147]"
        >
          <option value="">Default Home Screen</option>
          {homeScreens.map((s) => (
            <option key={s.key} value={s.key}>{s.label} (from {s.pluginId})</option>
          ))}
        </select>
        <p className="text-[10px] text-gray-500 mt-1">
          Replaces the standard home layout. The Psalm 19:14 verse will still appear at the bottom.
        </p>
      </div>
    )}
    </div>
    </div>
  );
}

function AppearanceTab({
  settings, patch, pickBackgroundImage, vaultPath,
}: {
  settings: HomeSettings;
  patch: (p: Partial<HomeSettings>) => void;
  pickBackgroundImage: () => void;
  vaultPath: string;
}) {
  const [urlDraft, setUrlDraft] = useState("");
  const resolvedBg = useResolvedBackgroundUrl(settings, vaultPath);

  const isRemote = /^(https?|data|blob):/i.test(settings.backgroundImage);

  const applyUrl = () => {
    const url = urlDraft.trim();
    if (!url) return;
    patch({ backgroundImage: url, backgroundType: "image" });
    setUrlDraft("");
  };

  return (
    <div className="space-y-6">
    <div>
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
    <ImageIcon size={10} /> Background
    </div>

    <div className="flex gap-1.5 mb-3">
    {(["none", "color", "image"] as const).map((t) => {
      const active = settings.backgroundType === t;
      return (
        <button
        key={t}
        type="button"
        onClick={() => patch({ backgroundType: t })}
        className={`flex-1 px-3 py-1.5 text-xs rounded border transition-colors ${
          active
          ? "bg-blue-600/15 border-blue-500/50 text-blue-300"
          : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200"
        }`}
        >
        {t === "none" ? "None" : t === "color" ? "Solid color" : "Image"}
        </button>
      );
    })}
    </div>

    {settings.backgroundType === "color" && (
      <div className="flex items-center gap-2">
      <input
      type="color"
      value={settings.backgroundColor}
      onChange={(e) => patch({ backgroundColor: e.target.value })}
      className="w-9 h-9 rounded border border-[#2a3136] bg-transparent cursor-pointer"
      />
      <input
      type="text"
      value={settings.backgroundColor}
      onChange={(e) => patch({ backgroundColor: e.target.value })}
      className="flex-1 bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-[#3a4147] font-mono"
      />
      </div>
    )}

    {settings.backgroundType === "image" && (
      <div className="space-y-3">
      <div className="space-y-2">
      <div className="flex items-center gap-2">
      <button
      type="button"
      onClick={pickBackgroundImage}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 whitespace-nowrap flex-shrink-0"
      >
      <ImageIcon size={12} /> Choose file…
      </button>
      <div className="flex-1 flex items-center gap-1.5 min-w-0">
      <input
      type="text"
      value={urlDraft}
      onChange={(e) => setUrlDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") applyUrl();
      }}
      placeholder="or paste image URL…"
      className="flex-1 min-w-0 bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-[#3a4147] font-mono"
      />
      <button
      type="button"
      onClick={applyUrl}
      disabled={!urlDraft.trim()}
      className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded whitespace-nowrap flex-shrink-0"
      >
      Apply
      </button>
      </div>
      </div>

      {settings.backgroundImage && (
        <div className="flex items-center gap-2 text-[10px]">
        <span
        className={`px-1.5 py-0.5 rounded uppercase tracking-wider font-medium flex-shrink-0 border ${
          isRemote
          ? "bg-blue-500/15 text-blue-300 border-blue-500/30"
          : "bg-[#2a3136] text-gray-400 border-[#30363d]"
        }`}
        title={
          isRemote
          ? "Loaded from the internet — the app needs a connection to render it"
          : "Loaded from your local disk — never copied or uploaded"
        }
        >
        {isRemote ? "URL" : "Local"}
        </span>
        <span
        className="text-gray-500 truncate flex-1 font-mono"
        title={settings.backgroundImage}
        >
        {settings.backgroundImage}
        </span>
        <button
        type="button"
        onClick={() => patch({ backgroundImage: "" })}
        className="text-[11px] text-gray-500 hover:text-red-400 flex-shrink-0"
        >
        Clear
        </button>
        </div>
      )}
      </div>

      {resolvedBg && (
        <div className="rounded border border-[#232a2e] overflow-hidden h-24 bg-[#131819]">
        <img
        src={resolvedBg}
        alt=""
        className="w-full h-full object-cover"
        style={{
          objectPosition: `${settings.backgroundPosX}% ${settings.backgroundPosY}%`,
          filter: settings.backgroundBlur > 0 ? `blur(${settings.backgroundBlur}px)` : undefined,
                      opacity: settings.backgroundOpacity / 100,
        }}
        />
        </div>
      )}

      <SliderRow
      label="Blur" value={settings.backgroundBlur}
      min={0} max={40} unit="px"
      onChange={(v) => patch({ backgroundBlur: v })}
      />
      <SliderRow
      label="Opacity" value={settings.backgroundOpacity}
      min={0} max={100} unit="%"
      onChange={(v) => patch({ backgroundOpacity: v })}
      />
      <SliderRow
      label="Position X" value={settings.backgroundPosX}
      min={0} max={100} unit="%"
      onChange={(v) => patch({ backgroundPosX: v })}
      />
      <SliderRow
      label="Position Y" value={settings.backgroundPosY}
      min={0} max={100} unit="%"
      onChange={(v) => patch({ backgroundPosY: v })}
      />
      </div>
    )}
    </div>

    <div className="border-t border-[#2a3136] pt-4">
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 flex items-center gap-1.5">
    <Palette size={10} /> Color overlay
    </div>
    <p className="text-[10px] text-gray-600 mb-3 leading-snug">
    A translucent layer over the background. Useful for tinting a photo
    or softening a busy image behind your shortcuts.
    </p>

    <div className="flex items-center gap-2 mb-3">
    <input
    type="color"
    value={settings.overlayColor}
    onChange={(e) => patch({ overlayColor: e.target.value })}
    className="w-9 h-9 rounded border border-[#2a3136] bg-transparent cursor-pointer"
    />
    <input
    type="text"
    value={settings.overlayColor}
    onChange={(e) => patch({ overlayColor: e.target.value })}
    className="flex-1 bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-[#3a4147] font-mono"
    />
    <span
    className="w-9 h-9 rounded border border-[#2a3136]"
    style={{
      backgroundColor: settings.overlayColor,
      opacity: settings.overlayOpacity / 100,
    }}
    title="Preview"
    />
    </div>

    <SliderRow
    label="Overlay opacity" value={settings.overlayOpacity}
    min={0} max={100} unit="%"
    onChange={(v) => patch({ overlayOpacity: v })}
    />
    </div>

    <div className="border-t border-[#2a3136] pt-4">
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3">
    Layout
    </div>

    <div className="space-y-4">
    <div>
    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 block">
    Content Width
    </label>
    <div className="flex gap-1.5">
    {(["narrow", "default", "wide"] as const).map((w) => (
      <button
      key={w}
      type="button"
      onClick={() => patch({ contentWidth: w })}
      className={`flex-1 px-3 py-1.5 text-xs rounded border transition-colors ${
        settings.contentWidth === w
        ? "bg-blue-600/15 border-blue-500/50 text-blue-300"
        : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200"
      }`}
      >
      {w.charAt(0).toUpperCase() + w.slice(1)}
      </button>
    ))}
    </div>
    </div>

    <div>
    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 block">
    Shortcuts Layout
    </label>
    <div className="flex gap-1.5">
    {(["grid", "list"] as const).map((l) => (
      <button
      key={l}
      type="button"
      onClick={() => patch({ shortcutsLayout: l })}
      className={`flex-1 px-3 py-1.5 text-xs rounded border transition-colors ${
        settings.shortcutsLayout === l
        ? "bg-blue-600/15 border-blue-500/50 text-blue-300"
        : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200"
      }`}
      >
      {l.charAt(0).toUpperCase() + l.slice(1)}
      </button>
    ))}
    </div>
    </div>

    <div>
    <label className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5 block">
    Custom Greeting
    </label>
    <input
    type="text"
    value={settings.greetingText}
    onChange={(e) => patch({ greetingText: e.target.value })}
    placeholder="Defaults to Vault Name"
    className="w-full bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-[#3a4147]"
    />
    </div>
    </div>
    </div>

    <div className="border-t border-[#2a3136] pt-4">
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3">
    Elements
    </div>

    <div className="space-y-2">
    <ToggleRow
    label="Show greeting"
    value={settings.showGreeting}
    onChange={(v) => patch({ showGreeting: v })}
    />
    <ToggleRow
    label="Show search bar"
    value={settings.showSearch}
    onChange={(v) => patch({ showSearch: v })}
    />
    </div>
    </div>

    <div className="border-t border-[#2a3136] pt-4">
    <button
    type="button"
    onClick={() =>
      patch({
        ...DEFAULT_HOME_SETTINGS,
        shortcuts: settings.shortcuts,
      })
    }
    className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-[#2a3136] rounded transition-colors"
    title="Reset background, overlay, and element toggles. Shortcuts are kept."
    >
    <RotateCcw size={11} /> Reset appearance
    </button>
    </div>
    </div>
  );
}

function SliderRow({
  label, value, min, max, unit, onChange,
}: {
  label: string; value: number; min: number; max: number;
  unit: string; onChange: (v: number) => void;
}) {
  return (
    <div>
    <label className="flex justify-between text-[10px] uppercase tracking-wider text-gray-500 mb-1">
    <span>{label}</span>
    <span className="text-gray-400 normal-case tabular-nums">
    {value}{unit}
    </span>
    </label>
    <input
    type="range" min={min} max={max} value={value}
    onChange={(e) => onChange(Number(e.target.value))}
    className="w-full accent-blue-500"
    />
    </div>
  );
}

function ToggleRow({
  label, value, onChange,
}: {
  label: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between text-xs text-gray-300 cursor-pointer py-1">
    <span>{label}</span>
    <button
    type="button"
    onClick={() => onChange(!value)}
    className="relative rounded-full transition-colors flex-shrink-0"
    style={{
      width: 28, height: 16,
      backgroundColor: value ? "#3b82f6" : "#3a4147",
    }}
    aria-pressed={value}
    >
    <span
    className="absolute rounded-full bg-white"
    style={{
      width: 12, height: 12, top: 2,
      left: value ? 14 : 2,
      transition: "left 150ms ease",
      boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
    }}
    />
    </button>
    </label>
  );
}

function DarkSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; icon?: string }[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) || null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const idx = options.findIndex((o) => o.value === value);
    setHighlight(idx >= 0 ? idx : 0);
  }, [open, value, options]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setHighlight((h) => Math.min(h + 1, options.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const opt = options[highlight];
      if (opt) choose(opt.value);
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
    <button
    type="button"
    onClick={() => setOpen((o) => !o)}
    onKeyDown={onKeyDown}
    className="w-full flex items-center gap-2 bg-[#131819] border border-[#2a3136] rounded px-2 py-1.5 text-xs text-left outline-none focus:border-[#3a4147] hover:border-[#3a4147] transition-colors"
    >
    {selected ? (
      <>
      {selected.icon && <span className="flex-shrink-0">{selected.icon}</span>}
      <span className="flex-1 truncate text-gray-200">{selected.label}</span>
      </>
    ) : (
      <span className="flex-1 truncate text-gray-500">{placeholder || "Select…"}</span>
    )}
    <ChevronDown
    size={11}
    className={`text-gray-500 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
    />
    </button>

    {open && (
      <div className="absolute left-0 right-0 top-full mt-1 z-[50] bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 max-h-60 overflow-y-auto">
      {options.length === 0 ? (
        <div className="px-3 py-2 text-xs text-gray-500 italic">
        No categories available.
        </div>
      ) : (
        options.map((opt, i) => {
          const isSelected = opt.value === value;
          const isHighlighted = i === highlight;
          return (
            <button
            key={opt.value}
            type="button"
            onMouseEnter={() => setHighlight(i)}
            onClick={() => choose(opt.value)}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
              isHighlighted
              ? "bg-[#2a3136] text-gray-100"
              : "text-gray-300 hover:bg-[#232a2e]"
            }`}
            >
            {opt.icon && <span className="flex-shrink-0">{opt.icon}</span>}
            <span className="flex-1 truncate">{opt.label}</span>
            {isSelected && (
              <span className="text-blue-400 text-xs flex-shrink-0">●</span>
            )}
            </button>
          );
        })
      )}
      </div>
    )}
    </div>
  );
}

export function useResolvedBackgroundUrl(
  settings: HomeSettings,
  vaultPath: string
): string {
  const [url, setUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    let revoke: string | null = null;

    (async () => {
      if (settings.backgroundType !== "image" || !settings.backgroundImage) {
        setUrl("");
        return;
      }
      const v = settings.backgroundImage;

      if (/^(https?:|data:|blob:)/i.test(v)) {
        setUrl(v);
        return;
      }

      let abs: string;
      if (/^([a-zA-Z]:[\\/]|\/)/.test(v)) {
        abs = v;
      } else {
        const base = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
        abs = `${base}/${v.replace(/^\/+/, "")}`;
      }

      try {
        const bytes = await readFile(abs);
        if (cancelled) return;
        const blob = new Blob([bytes as any], { type: mimeFromExt(abs) });
        const blobUrl = URL.createObjectURL(blob);
        revoke = blobUrl;
        setUrl(blobUrl);
      } catch (e) {
        console.warn("[home-bg] could not read background:", abs, e);
        if (!cancelled) setUrl("");
      }
    })();

    return () => {
      cancelled = true;
      if (revoke) {
        try { URL.revokeObjectURL(revoke); } catch {}
      }
    };
  }, [settings.backgroundType, settings.backgroundImage, vaultPath]);

  return url;
}

function mimeFromExt(p: string): string {
  const ext = (p.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "avif": return "image/avif";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}
