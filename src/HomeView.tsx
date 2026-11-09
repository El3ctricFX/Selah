// src/HomeView.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Search, CalendarDays, BookOpen,
  NotebookText, ArrowRight, Link as LinkIcon, Plus, FileText,
} from "lucide-react";
import { parseNoteFile } from "./noteFormat";
import { WidgetSlot, useSlotWidgets } from "./PluginHomeWidgets";
import { PluginHomeScreenHost } from "./PluginHomeScreenHost";
import { usePlugins } from "./plugins";
import {
  DEFAULT_HOME_SETTINGS,
  useResolvedBackgroundUrl,
  type HomeSettings,
  type HomeShortcut,
} from "./HomeSettings";

interface HomeViewProps {
  vaultPath: string;
  onOpenNoteByPath: (path: string) => void;
  onOpenCategory: (cat: any) => void;
  onOpenJournalToday: (cat: any) => void;
  onCreateNote?: (catId: string) => void;
  onCreateEntry?: (catId: string) => void;
  onOpenJournalDay?: (cat: any, year: number, month: number, day: number) => void;
}

type NoteHit = {
  path: string;
  name: string;
  title: string;
  icon: string;
  tags: string[];
  folderLabel: string;
  categoryName: string;
  created: string;
  snippet: string;
};

function formatPrettyDate(iso: string, fallbackName: string = "", folder: string = ""): string {
  // 1. Check if the filename is a text date like "October 17, 2026"
  const cleanName = fallbackName.replace(/\.selah$/i, "");
  const parsedNameDate = Date.parse(cleanName);
  if (!isNaN(parsedNameDate) && cleanName.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4})/i)) {
    return new Date(parsedNameDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  // 2. Look for YYYY-MM-DD or YYYY/MM/DD in the filename or folder path
  const textToSearch = `${folder} ${fallbackName}`;
  const match = textToSearch.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (match) {
    const d = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }

  // 3. Fallback to the raw ISO timestamp, forcing local noon if it's just a date
  if (iso) {
    const dateOnly = iso.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateOnly) {
       const d = new Date(`${dateOnly[1]}T12:00:00`);
       if (!isNaN(d.getTime())) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } else {
       const d = new Date(iso);
       if (!isNaN(d.getTime())) return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }
  return "";
}

function greetingForHour(h: number): { text: string; emoji: string } {
  if (h < 5) return { text: "Peaceful night", emoji: "🌙" };
  if (h < 12) return { text: "Good morning", emoji: "🌅" };
  if (h < 17) return { text: "Good afternoon", emoji: "☀️" };
  if (h < 21) return { text: "Good evening", emoji: "🌆" };
  return { text: "Good night", emoji: "🌙" };
}

async function walkNotes(
  dir: string,
  categoryName: string,
  rootDir: string,
  out: NoteHit[],
  depth = 0,
) {
  if (depth > 8) return;
  try {
    const entries = await readDir(dir);
    for (const e of entries) {
      if (!e.name || e.name.startsWith(".")) continue;
      if (e.name === "assets" || e.name === "_attachments") continue;
      const full = await join(dir, e.name);
      if (e.isDirectory) {
        await walkNotes(full, categoryName, rootDir, out, depth + 1);
      } else if (e.name.endsWith(".selah")) {
        try {
          const raw = await readTextFile(full);
          const { frontmatter, body } = parseNoteFile(raw);
          const base = e.name.replace(/\.selah$/, "");
          const fullNorm = full.replace(/\\/g, "/");
          const rootNorm = rootDir.replace(/\\/g, "/").replace(/\/+$/, "");
          const rel = fullNorm.startsWith(rootNorm + "/")
          ? fullNorm.slice(rootNorm.length + 1)
          : fullNorm;
          const lastSlash = rel.lastIndexOf("/");
          const folderLabel = lastSlash > 0 ? rel.slice(0, lastSlash) : "";
          out.push({
            path: full,
            name: e.name,
            title: (frontmatter.title as string) || base,
            icon: (frontmatter.icon as string) || "",
            tags: Array.isArray(frontmatter.tags)
              ? (frontmatter.tags as any[]).filter((t): t is string => typeof t === "string")
              : [],
            folderLabel,
            categoryName,
            created: (frontmatter.date as string) || (frontmatter.created as string) || "",
            snippet: (body || "").replace(/\s+/g, " ").trim().slice(0, 500),
          });
        } catch {}
      }
    }
  } catch {}
}

export default function HomeView({
  vaultPath,
  onOpenNoteByPath,
  onOpenCategory,
  onOpenJournalToday,
  onCreateNote,
  onCreateEntry,
  onOpenJournalDay,
}: HomeViewProps) {
  const [categories, setCategories] = useState<any[]>([]);
  const [notes, setNotes] = useState<NoteHit[] | null>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [settings, setSettings] = useState<HomeSettings>(DEFAULT_HOME_SETTINGS);
  const inputRef = useRef<HTMLInputElement>(null);

  const vaultName = vaultPath.split(/[/\\]/).pop() || "Vault";
  const greeting = greetingForHour(new Date().getHours());

  // Load categories + home settings.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await readTextFile(
          await join(vaultPath, ".vault_metadata.json")
        );
        const meta = JSON.parse(raw);
        if (cancelled) return;
        setCategories(meta.categories || []);
        if (meta.homeSettings && typeof meta.homeSettings === "object") {
          setSettings({ ...DEFAULT_HOME_SETTINGS, ...meta.homeSettings });
        } else {
          setSettings(DEFAULT_HOME_SETTINGS);
        }
      } catch {
        if (cancelled) return;
        setCategories([]);
        setSettings(DEFAULT_HOME_SETTINGS);
      }
    })();
    return () => { cancelled = true; };
  }, [vaultPath]);

  // React to changes saved from the Settings modal.
  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === "object") {
        setSettings({ ...DEFAULT_HOME_SETTINGS, ...detail });
      }
    };
    window.addEventListener("home-settings-changed", onChanged);
    return () => window.removeEventListener("home-settings-changed", onChanged);
  }, []);

  // Build a search index across notes/journal categories.
  useEffect(() => {
    if (!categories.length) return;
    let cancelled = false;
    (async () => {
      const out: NoteHit[] = [];
      for (const cat of categories) {
        if (!cat.dirName) continue;
        if (cat.mode === "gallery") continue;
        const dir = await join(vaultPath, cat.dirName);
        await walkNotes(dir, cat.name, dir, out);
      }
      if (!cancelled) setNotes(out);
    })();
      return () => { cancelled = true; };
  }, [vaultPath, categories]);

  // ⌘K / Ctrl+K focuses the search bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    if (!notes) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return notes
    .filter(
      (n) =>
      n.title.toLowerCase().includes(q) ||
      n.name.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q)) ||
      n.folderLabel.toLowerCase().includes(q) ||
      n.categoryName.toLowerCase().includes(q) ||
      n.snippet.toLowerCase().includes(q) ||
      formatPrettyDate(n.created, n.name, n.folderLabel).toLowerCase().includes(q)
    )
    .slice(0, 30);
  }, [notes, query]);

  const showResults = focused && query.trim().length > 0;

  // Auto-derive shortcuts when none are configured.
  const effectiveShortcuts: HomeShortcut[] = useMemo(() => {
    if (settings.shortcuts.length > 0) return settings.shortcuts;

    const auto: HomeShortcut[] = [];
    const hasJournal = categories.some((c) => c.mode === "journal");
    if (hasJournal) {
      auto.push({
        id: "auto-journal-today",
        label: "Today's Journal",
        kind: "journal-today",
        icon: "📅",
      });
    }
    for (const cat of categories) {
      if (cat.mode === "journal") continue;
      auto.push({
        id: `auto-${cat.id}`,
        label: cat.name,
        kind: "category",
        targetId: cat.id,
        icon: cat.icon || undefined,
      });
    }
    return auto;
  }, [settings.shortcuts, categories]);

  const handleShortcutClick = (sc: HomeShortcut) => {
    if (sc.kind === "journal-today") {
      const journal = categories.find((c) => c.id === sc.targetId) || categories.find((c) => c.mode === "journal");
      if (journal) onOpenJournalToday(journal);
      return;
    }
    if (sc.kind === "journal-date" && sc.targetId && sc.dateString) {
      const journal = categories.find((c) => c.id === sc.targetId);
      if (journal && onOpenJournalDay) {
        const d = new Date(sc.dateString + "T12:00:00");
        onOpenJournalDay(journal, d.getFullYear(), d.getMonth() + 1, d.getDate());
      }
      return;
    }
    if (sc.kind === "category") {
      const cat = categories.find((c) => c.id === sc.targetId);
      if (cat) onOpenCategory(cat);
      return;
    }
    if (sc.kind === "new-note" && sc.targetId) {
      onCreateNote?.(sc.targetId);
      return;
    }
    if (sc.kind === "new-entry" && sc.targetId) {
      onCreateEntry?.(sc.targetId);
      return;
    }
    if (sc.kind === "note" && sc.targetId) {
      onOpenNoteByPath(sc.targetId);
      return;
    }
    if (sc.kind === "plugin-action" && sc.targetId && sc.actionId) {
      const cat = categories.find(c => c.id === sc.targetId);
      if (cat) {
        const type = categoryTypes.find(t => t.mode === cat.mode);
        const action = type?.shortcutActions?.find(a => a.id === sc.actionId);
        if (action) {
          action.run();
          return;
        }
      }
    }
    if (sc.kind === "url" && sc.targetId) {
      openUrl(sc.targetId).catch((e) =>
      console.error("[home] openUrl failed:", e)
      );
    }
  };

  const resolvedBg = useResolvedBackgroundUrl(settings, vaultPath);

  // Plugin integrations
  const { categoryTypes, shortcuts: pluginShortcuts, homeScreens } = usePlugins();
  const slotHeader     = useSlotWidgets("header", settings.widgets);
  const slotAboveShort = useSlotWidgets("above-shortcuts", settings.widgets);
  const slotBelowShort = useSlotWidgets("below-shortcuts", settings.widgets);
  const slotAboveVerse = useSlotWidgets("above-verse", settings.widgets);

  const activeScreen = homeScreens.find((s) => s.key === settings.activeHomeScreen);
  const enabledPluginShortcuts = (settings.pluginShortcuts || [])
    .map((key) => pluginShortcuts.find((s) => s.key === key))
    .filter(Boolean) as any[];

  const allShortcuts = [
    ...effectiveShortcuts,
    ...enabledPluginShortcuts.map((s) => ({
      id: s.key,
      label: s.label,
      icon: s.icon,
      kind: "plugin" as const,
      onClick: s.onClick,
    })),
  ];

  const handleAnyShortcutClick = (sc: any) => {
    if (sc.kind === "plugin" && sc.onClick) {
      sc.onClick();
    } else {
      handleShortcutClick(sc);
    }
  };

  const widthClass =
    settings.contentWidth === "narrow" ? "max-w-xl" :
    settings.contentWidth === "wide" ? "max-w-5xl" :
    "max-w-2xl";

  return (
    <div className="w-full h-full flex flex-col bg-[#0f1315] relative overflow-hidden">
    {settings.backgroundType === "color" && (
      <div
      className="absolute inset-0 pointer-events-none"
      style={{ backgroundColor: settings.backgroundColor }}
      />
    )}

    {settings.backgroundType === "image" && resolvedBg && (
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
      <div
      className="absolute"
      style={{
        inset: settings.backgroundBlur > 0 ? -settings.backgroundBlur * 2 : 0,
        backgroundImage: `url("${resolvedBg}")`,
                                                           backgroundSize: "cover",
                                                           backgroundPosition: `${settings.backgroundPosX}% ${settings.backgroundPosY}%`,
                                                           backgroundRepeat: "no-repeat",
                                                           filter: settings.backgroundBlur > 0
                                                           ? `blur(${settings.backgroundBlur}px)`
                                                           : undefined,
                                                           opacity: settings.backgroundOpacity / 100,
      }}
      />
      </div>
    )}

    {settings.overlayOpacity > 0 && (
      <div
      className="absolute inset-0 pointer-events-none"
      style={{
        backgroundColor: settings.overlayColor,
        opacity: settings.overlayOpacity / 100,
      }}
      />
    )}

    <div className="relative flex-1 overflow-y-auto flex flex-col min-h-0">
    {activeScreen ? (
      <PluginHomeScreenHost pluginKey={activeScreen.key} vaultPath={vaultPath} />
    ) : (
      <div className="min-h-full flex items-center justify-center px-8 py-16">
        <div className={`w-full ${widthClass}`}>
          <WidgetSlot widgets={slotHeader} vaultPath={vaultPath} className="mb-8" />

          {settings.showGreeting && (
            <div className="text-center mb-10">
              <div className="text-[11px] uppercase tracking-[0.25em] text-gray-500 mb-3 flex items-center justify-center gap-2">
                <span className="text-sm leading-none">{greeting.emoji}</span>
                <span>{greeting.text}</span>
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-gray-100">
                {settings.greetingText || vaultName}
              </h1>
            </div>
          )}

    {settings.showSearch && (
      <div className="relative mb-10">
      <div
      className={`flex items-center gap-3 rounded-xl border bg-[#161a1d] px-4 py-2.5 transition-colors ${
        focused
        ? "border-[#3a4147]"
        : "border-[#1e2327] hover:border-[#2a3136]"
      }`}
      >
      <Search size={15} className="text-gray-500 flex-shrink-0" />
      <input
      ref={inputRef}
      type="text"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setTimeout(() => setFocused(false), 150)}
      placeholder="Search notes, journal entries, tags…"
      className="flex-1 bg-transparent border-none outline-none text-sm text-gray-100 placeholder-gray-600"
      />
      <kbd className="hidden md:flex items-center text-[10px] text-gray-600 border border-[#232a2e] rounded px-1.5 py-0.5 font-mono">
      ⌘K
      </kbd>
      </div>

      {showResults && (
        <div className="absolute left-0 right-0 top-full mt-2 z-30 rounded-xl border border-[#232a2e] bg-[#161a1d] shadow-2xl overflow-hidden max-h-[55vh] overflow-y-auto">
        {results.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-gray-500 italic">
          No matches for "{query}"
          </div>
        ) : (
          results.map((r) => (
            <button
            key={r.path}
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onOpenNoteByPath(r.path);
            }}
            className="w-full text-left px-4 py-2.5 hover:bg-[#1a1e21] flex items-center gap-3 transition-colors"
            >
            <span className="text-base flex-shrink-0">
            {r.icon || "📄"}
            </span>
            <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-100 truncate">
            {r.title}
            </div>
            <div className="text-[10px] text-gray-500 truncate flex items-center gap-1.5 mt-0.5">
              <span>{r.categoryName}</span>
              <span className="text-gray-700">·</span>
              <span>{formatPrettyDate(r.created, r.name, r.folderLabel) || r.folderLabel}</span>
            </div>
            </div>
            {r.tags.length > 0 && (
              <div className="flex gap-1 flex-shrink-0">
              {r.tags.slice(0, 2).map((t) => (
                <span
                key={t}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[#161a1d] border border-[#232a2e] text-gray-500"
                >
                {t}
                </span>
              ))}
              </div>
            )}
            <ArrowRight
            size={12}
            className="text-gray-700 flex-shrink-0"
            />
            </button>
          ))
        )}
        </div>
      )}
      </div>
    )}

    <WidgetSlot widgets={slotAboveShort} vaultPath={vaultPath} className="mb-6" />

    {allShortcuts.length > 0 ? (
      <div className={settings.shortcutsLayout === "list" ? "flex flex-col gap-2.5" : "grid grid-cols-2 sm:grid-cols-3 gap-2.5"}>
        {allShortcuts.map((sc) => (
          <ShortcutTile
            key={sc.id}
            shortcut={sc}
            onClick={() => handleAnyShortcutClick(sc)}
          />
        ))}
      </div>
    ) : (
      <div className="text-center text-xs text-gray-600 italic">
        Add shortcuts from Settings to fill this space.
      </div>
    )}

    <WidgetSlot widgets={slotBelowShort} vaultPath={vaultPath} className="mt-6" />
    </div>
    </div>
    )}
    </div>

    {/* Verse — always visible */}
    <div className="relative flex-shrink-0 px-8 pb-7 pt-5 border-t border-[#161a1d]">
    <WidgetSlot
    widgets={slotAboveVerse}
    vaultPath={vaultPath}
    className="max-w-3xl mx-auto mb-4"
    />
    <div className="max-w-3xl mx-auto text-center">
    <BookOpen size={11} className="text-gray-600 mx-auto mb-2.5" />
    <p
    className="text-[13px] md:text-sm text-gray-500 leading-relaxed"
    style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
    >
    "May my words and thoughts please you.
    <br className="hidden md:inline" />{" "}
    Lord, you are my Rock—the one who rescues me."
    </p>
    <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-gray-600">
    Psalm 19:14 · ERV
    </div>
    </div>
    </div>
    </div>
  );
}

function ShortcutTile({
  shortcut,
  onClick,
}: {
  shortcut: HomeShortcut;
  onClick: () => void;
}) {
  const Fallback =
  shortcut.kind === "journal-today" ? CalendarDays
  : shortcut.kind === "journal-date" ? CalendarDays
  : shortcut.kind === "url" ? LinkIcon
  : shortcut.kind === "new-note" ? Plus
  : shortcut.kind === "new-entry" ? FileText
  : shortcut.kind === "note" ? FileText
  : NotebookText;

  const icon = shortcut.icon && shortcut.icon.trim() ? shortcut.icon : null;

  const customStyle = shortcut.color
    ? { backgroundColor: shortcut.color, borderColor: "rgba(255,255,255,0.1)" }
    : {};

  // If a custom color is picked, we strip the default Tailwind bg classes
  // so App.css doesn't override the custom inline style with !important.
  const bgClass = shortcut.color ? "" : "bg-[#161a1d] hover:bg-[#1a1e21]";

  // Same for text color
  const textClass = shortcut.textColor ? "" : "text-gray-300 group-hover:text-gray-100";
  const textStyle = shortcut.textColor ? { color: shortcut.textColor } : {};

  return (
    <button
    type="button"
    onClick={onClick}
    className={`group flex items-center gap-3 rounded-lg border border-[#1e2327] ${bgClass} hover:border-[#2a3136] px-3.5 py-3 transition-colors text-left min-w-0`}
    style={customStyle}
    title={shortcut.kind === "url" ? shortcut.targetId : undefined}
    >
    <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
    {icon ? (
      <span className="text-lg leading-none">{icon}</span>
    ) : (
      <Fallback size={14} className={shortcut.textColor ? "" : "text-gray-500"} style={textStyle} />
    )}
    </div>
    <span className={`text-sm ${textClass} truncate flex-1`} style={textStyle}>
    {shortcut.label}
    </span>
    </button>
  );
}
