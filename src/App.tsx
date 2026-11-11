// src/App.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PanelLeftOpen, Columns2 } from "lucide-react";
import PaneShell from "./PaneShell";
import Editor from "./Editor";
import Sidebar, { type Category } from "./Sidebar";
import JournalView from "./JournalView";
import GalleryView from "./GalleryView";
import EntriesView from "./EntriesView";
import AbbaView from "./AbbaView";
import NotesView from "./NotesView";
import HomeView from "./HomeView";
import SettingsModal from "./SettingsModal";
import ProxyToggleHost from "./ProxyToggleHost";
import "./App.css";
import VaultWelcome from "./VaultWelcome";
import { useRecentVaults } from "./useRecentVaults";
import { createEntry } from "./entries";
import { flushAll } from "./flushRegistry";
import { migrateVaultPaths } from "./vaultMigration";
import { useTheme, setThemeVaultPath } from "./theme";
import ThemeBackground from "./ThemeBackground";
import PluginView from "./PluginView";
import { loadPlugins, clearPlugins } from "./plugins";

type JournalFocus = { year: number; month: number; day: number };
type ViewSnapshot = { view: ActiveView; categoryId: string | null };

type ActiveView =
  | { kind: "note"; path: string; name: string }
  | { kind: "journal"; dir: string; name: string; focus?: JournalFocus; focusMode?: "day" | "month" }
  | { kind: "gallery"; dir: string; name: string }
  | { kind: "plugin"; dir: string; name: string; icon: string; categoryId: string; mode: string }
    | { kind: "abba"; dir: string; name: string; icon: string; focusSection?: string; focusNoteId?: string }
  | { kind: "notes"; dir: string; name: string; icon: string; categoryId: string }
  | { kind: "entries"; dir: string; name: string; icon: string; categoryId: string }
  | null;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parseJournalDayFilename(
  name: string
): { year: number; month: number; day: number } | null {
  const m = name.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\.(selah|md)$/);
  if (!m) return null;
  const monthIdx = MONTH_NAMES.findIndex(
    (x) => x.toLowerCase() === m[1].toLowerCase()
  );
  if (monthIdx === -1) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  return { year, month: monthIdx + 1, day };
}

export default function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  // ── Split panes ──────────────────────────────────────────────────────
  // `activeView` / `setActiveView` now mean "the FOCUSED pane's view", so
  // every existing call (sidebar clicks, back/forward, etc.) keeps working.
  const [mainView, setMainView] = useState<ActiveView>(null);
  const [splitView, setSplitView] = useState<ActiveView>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [focusedPane, setFocusedPane] = useState<"main" | "split">("main");
  const mainViewRef = useRef<ActiveView>(null);
  const splitViewRef = useRef<ActiveView>(null);
  const splitOpenRef = useRef(false);
  const focusedPaneRef = useRef<"main" | "split">("main");
  const paneNonceRef = useRef({ main: 0, split: 0 });
  mainViewRef.current = mainView;
  splitViewRef.current = splitView;
  splitOpenRef.current = splitOpen;
  focusedPaneRef.current = focusedPane;

  const activeView: ActiveView =
    splitOpen && focusedPane === "split" ? splitView : mainView;
  const setActiveView = (v: React.SetStateAction<ActiveView>) => {
    if (focusedPaneRef.current === "split" && splitOpenRef.current) setSplitView(v);
    else setMainView(v);
  };
  const [mainCategoryId, setMainCategoryId] = useState<string | null>(null);
  const [splitCategoryId, setSplitCategoryId] = useState<string | null>(null);
  const mainCategoryIdRef = useRef<string | null>(null);
  const splitCategoryIdRef = useRef<string | null>(null);
  mainCategoryIdRef.current = mainCategoryId;
  splitCategoryIdRef.current = splitCategoryId;

  const activeCategoryId = splitOpen && focusedPane === "split" ? splitCategoryId : mainCategoryId;
  const setActiveCategoryId = (id: React.SetStateAction<string | null>) => {
    if (focusedPaneRef.current === "split" && splitOpenRef.current) setSplitCategoryId(id);
    else setMainCategoryId(id);
  };
  const [journalNonce, setJournalNonce] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [vaultCategories, setVaultCategories] = useState<
  Array<{ id: string; name: string; icon: string; mode: string; dirName: string }>
  >([]);

  // Applies the saved theme to :root and keeps it in sync with the
  // Appearance panel. The panel uses the same hook, so both stay in step.
  useTheme();

  // Load the vault's theme whenever we switch vaults. Without this, the
  // theme would stick to whatever was last saved (previously in
  // localStorage, now in the currently-open vault's metadata).
  useEffect(() => {
    void setThemeVaultPath(vaultPath);
  }, [vaultPath]);

  const {
    vaults: recentVaults,
    add: addRecentVault,
    remove: removeRecentVault,
  } = useRecentVaults();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        setFocusMode((v) => !v);
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === "B" || e.key === "b")) {
        const active = document.activeElement as HTMLElement | null;
        if (
          active?.closest(".ProseMirror") ||
          active?.tagName === "INPUT" ||
          active?.tagName === "TEXTAREA"
        ) {
          return;
        }
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Escape exits focus mode — unless a modal / popover / menu is open,
  // in which case that layer handles Escape itself. Anything fixed at
  // z-index >= 100 counts as "an open overlay", so the lightbox, settings,
  // pickers, bookmark menus, etc. all keep priority.
  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const fixedEls = document.querySelectorAll<HTMLElement>(".fixed");
      for (const el of Array.from(fixedEls)) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const z = parseInt(style.zIndex, 10);
        if (!Number.isNaN(z) && z >= 100) return;
      }
      e.preventDefault();
      setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode]);


  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let closing = false;

    (async () => {
      try {
        const win = getCurrentWindow();
        const un = await win.onCloseRequested(async (event) => {
          event.preventDefault();

          if (closing) {
            try {
              await win.destroy();
            } catch (e) {
              console.error("[app] forced destroy failed:", e);
            }
            return;
          }
          closing = true;

          try {
            await Promise.race([
              flushAll(),
              new Promise<void>((resolve) => setTimeout(resolve, 2500)),
            ]);
          } catch (e) {
            console.error("[app] flush on close failed:", e);
          }

          try {
            await win.destroy();
          } catch (e) {
            console.error("[app] destroy failed:", e);
          }
        });
        if (cancelled) un();
        else unlisten = un;
      } catch (e) {
        console.warn("[app] close handler not registered:", e);
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!vaultPath) return;
    migrateVaultPaths(vaultPath).catch((e) =>
    console.warn("[app] migration failed:", e)
    );
  }, [vaultPath]);

  // Load this vault's plugins whenever the vault changes or the feature is toggled.
  useEffect(() => {
    if (!vaultPath) { clearPlugins(); return; }

    const reload = () => { void loadPlugins(vaultPath); };
    reload();

    window.addEventListener("plugins-feature-changed", reload);
    return () => window.removeEventListener("plugins-feature-changed", reload);
  }, [vaultPath]);

  // Listen for folder renames to update the active view instantly
  useEffect(() => {
    const handler = (e: Event) => {
      const { oldDir, newDir } = (e as CustomEvent).detail;
      if (!oldDir || !newDir) return;

      setActiveView((prev) => {
        if (!prev || prev.kind === "note" || prev.kind === "journal") return prev;
        // Check if the active view's directory belongs to the renamed folder
        const normDir = prev.dir.replace(/\\/g, "/");
        if (normDir.includes(`/${oldDir}`) || normDir.endsWith(oldDir)) {
          const nextDir = normDir.replace(oldDir, newDir);
          return { ...prev, dir: nextDir };
        }
        return prev;
      });
    };
    window.addEventListener("folder-renamed", handler);
    return () => window.removeEventListener("folder-renamed", handler);
  }, []);

  useEffect(() => {
    const handleNoteDeleted = (e: Event) => {
      const deletedPath = (e as CustomEvent).detail?.path;
      if (!deletedPath) return;

      const norm = (p: string) => p.replace(/\\/g, "/");
      const target = norm(deletedPath);

      // Only intercept if the currently open view is a note that was just deleted
      if (activeView?.kind === "note" && norm(activeView.path) === target) {
        const normVault = norm(vaultPath ?? "").replace(/\/+$/, "");
        const owner = vaultCategories.find(cat => {
          if (!cat.dirName) return false;
          const prefix = `${normVault}/${cat.dirName}/`;
          return target.startsWith(prefix);
        });

        if (owner) {
          // Switch back to the category's root view (e.g., the Diary list)
          if (owner.mode === "entries") {
            setActiveCategoryId(owner.id);
            setActiveView({ kind: "entries", dir: `${vaultPath}/${owner.dirName}`, name: owner.name, icon: owner.icon, categoryId: owner.id });
          } else if (owner.mode === "notes") {
            setActiveCategoryId(owner.id);
            setActiveView({ kind: "notes", dir: `${vaultPath}/${owner.dirName}`, name: owner.name, icon: owner.icon, categoryId: owner.id });
          } else if (owner.mode === "journal") {
            setActiveCategoryId(owner.id);
            setActiveView({ kind: "journal", dir: `${vaultPath}/${owner.dirName}`, name: owner.name });
          } else if (owner.mode === "gallery") {
            setActiveCategoryId(owner.id);
            setActiveView({ kind: "gallery", dir: `${vaultPath}/${owner.dirName}`, name: owner.name });
          } else if (owner.mode === "abba") {
            setActiveCategoryId(owner.id);
            setActiveView({ kind: "abba", dir: `${vaultPath}/${owner.dirName}`, name: owner.name, icon: owner.icon });
          }
        } else {
          // Fallback: If we can't figure out which category it belonged to, go Home
          setActiveView(null);
        }
      }
    };

    window.addEventListener("note-deleted", handleNoteDeleted);
    return () => window.removeEventListener("note-deleted", handleNoteDeleted);
  }, [activeView, vaultPath, vaultCategories]);

  useEffect(() => {
    if (!vaultPath) {
      setVaultCategories([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
        const meta = JSON.parse(raw);
        if (cancelled) return;
        setVaultCategories(Array.isArray(meta.categories) ? meta.categories : []);
      } catch {
        if (!cancelled) setVaultCategories([]);
      }
    })();
    return () => { cancelled = true; };
  }, [vaultPath]);

  // ── View history (mouse-back / Alt+← navigation) ─────────────────────
  const historyRef = useRef<ViewSnapshot[]>([]);
  const forwardRef = useRef<ViewSnapshot[]>([]);
  const prevSnapshotRef = useRef<ViewSnapshot | null>(null);
  const suppressHistoryRef = useRef(false);
  const prevPaneRef = useRef<"main" | "split">("main");
  const activeViewRef = useRef<ActiveView>(null);
  const activeCategoryRef = useRef<string | null>(null);

  useEffect(() => { activeViewRef.current = activeView; }, [activeView]);
  useEffect(() => { activeCategoryRef.current = activeCategoryId; }, [activeCategoryId]);

  const viewsEqual = (a: ActiveView, b: ActiveView): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    try { return JSON.stringify(a) === JSON.stringify(b); }
    catch { return false; }
  };

  // Whenever the view or category changes, push the *previous* state onto
  // the history stack — unless the change came from goBack / goForward,
  // in which case we've already updated the stack ourselves.
  useEffect(() => {
    const prev = prevSnapshotRef.current;
    const snap: ViewSnapshot = { view: activeView, categoryId: activeCategoryId };
    const suppressed = suppressHistoryRef.current;
    suppressHistoryRef.current = false;

    const paneSwitched = prevPaneRef.current !== focusedPane;
    prevPaneRef.current = focusedPane;
    if (prev && !suppressed && !paneSwitched) {
      const viewChanged = !viewsEqual(prev.view, activeView);
      const catChanged = prev.categoryId !== activeCategoryId;
      if (viewChanged || catChanged) {
        historyRef.current.push(prev);
        if (historyRef.current.length > 50) historyRef.current.shift();
        forwardRef.current = [];
      }
    }
    prevSnapshotRef.current = snap;
  }, [activeView, activeCategoryId, focusedPane]);

  const goBack = useCallback(() => {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    const target = hist.pop()!;
    forwardRef.current.push({
      view: activeViewRef.current,
      categoryId: activeCategoryRef.current,
    });
    suppressHistoryRef.current = true;
    setActiveCategoryId(target.categoryId);
    setActiveView(target.view);
    if (target.view?.kind === "journal") setJournalNonce((n) => n + 1);
  }, []);

    const goForward = useCallback(() => {
      const fwd = forwardRef.current;
      if (fwd.length === 0) return;
      const target = fwd.pop()!;
      historyRef.current.push({
        view: activeViewRef.current,
        categoryId: activeCategoryRef.current,
      });
      suppressHistoryRef.current = true;
      setActiveCategoryId(target.categoryId);
      setActiveView(target.view);
      if (target.view?.kind === "journal") setJournalNonce((n) => n + 1);
    }, []);

      // Mouse buttons 3 (back) and 4 (forward). Capture phase so we see them
      // before ProseMirror, sidebar drag handlers, or anything else that might
      // stop the event.
      useEffect(() => {
        const onMouseDown = (e: MouseEvent) => {
          if (e.button === 3) {
            e.preventDefault();
            e.stopPropagation();
            goBack();
          } else if (e.button === 4) {
            e.preventDefault();
            e.stopPropagation();
            goForward();
          }
        };
        window.addEventListener("mousedown", onMouseDown, true);
        return () => window.removeEventListener("mousedown", onMouseDown, true);
      }, [goBack, goForward]);

      // ── Keep the history snapshot's journal date in sync ─────────────────
      // JournalView manages its own `date` state internally (arrow keys,
      // month/year clicks). App's `activeView.focus` never sees those
      // changes, so when the user clicks away, the pushed history snapshot
      // would carry whatever `focus` was at the time the journal was opened
      // — usually `undefined`, which makes the back button land on "today".
      //
      // JournalView already fires `journal-date-changed` on every date
      // change. We listen for it and mutate the pending history snapshot so
      // the date it carries always matches what the user is actually
      // looking at. No re-render, no remount of JournalView — just keeping
      // the not-yet-committed snapshot honest.
      useEffect(() => {
        const onDateChanged = (e: Event) => {
          const d = (e as CustomEvent).detail;
          if (!d) return;
          const prev = prevSnapshotRef.current;
          if (!prev) return;
          const pv: any = prev.view;
          if (!pv || pv.kind !== "journal") return;

          const normDir = (s: string) =>
          s.replace(/\\/g, "/").replace(/\/+$/, "");
          if (normDir(pv.dir) !== normDir(d.dir)) return;

          if (
            pv.focus &&
            pv.focus.year === d.year &&
            pv.focus.month === d.month &&
            pv.focus.day === d.day
          ) return;

          prevSnapshotRef.current = {
            ...prev,
            view: {
              ...pv,
              focus: { year: d.year, month: d.month, day: d.day },
              focusMode: "day",
            },
          };
        };
        window.addEventListener("journal-date-changed", onDateChanged);
        return () => window.removeEventListener("journal-date-changed", onDateChanged);
      }, []);

      // Alt+← / Alt+→ as a keyboard fallback for machines without side
      // buttons.
      useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
          if (!e.altKey) return;
          if (e.key === "ArrowLeft") { e.preventDefault(); goBack(); }
          else if (e.key === "ArrowRight") { e.preventDefault(); goForward(); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, [goBack, goForward]);

  // ── Split pane controls ──────────────────────────────────────────────
  useEffect(() => {
    // New vault → start with a single clean pane.
    setMainView(null);
    setSplitView(null);
    setMainCategoryId(null);
    setSplitCategoryId(null);
    setSplitOpen(false);
    setFocusedPane("main");
  }, [vaultPath]);

  const openSplit = () => {
    if (splitOpenRef.current) return;
    setSplitView(activeViewRef.current); // duplicate the focused view
    setSplitCategoryId(mainCategoryIdRef.current); // duplicate the focused category
    setSplitOpen(true);
    setFocusedPane("split");             // next sidebar click opens on the right
  };

  const closePane = (pane: "main" | "split") => {
    if (pane === "main") {
      setMainView(splitViewRef.current); // promote right pane
      setMainCategoryId(splitCategoryIdRef.current); // promote right category
    }
    setSplitOpen(false);
    setSplitView(null);
    setFocusedPane("main");
  };

  const swapPanes = () => {
    const m = mainViewRef.current;
    const s = splitViewRef.current;
    setMainView(s);
    setSplitView(m);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "\\") {
        e.preventDefault();
        if (splitOpenRef.current) closePane("split");
        else openSplit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectVault = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Vault",
    });
    if (selected) {
      const path = selected as string;
      setVaultPath(path);
      addRecentVault(path);
      setMainView(null);
      setSplitView(null);
      setMainCategoryId(null);
      setSplitCategoryId(null);
      setSplitOpen(false);
      setFocusedPane("main");
      setFocusMode(false);
      setSidebarCollapsed(false);
    }
  };

  const handleOpenRecentVault = (path: string) => {
    setVaultPath(path);
    addRecentVault(path);
    setMainView(null);
    setSplitView(null);
    setMainCategoryId(null);
    setSplitCategoryId(null);
    setSplitOpen(false);
    setFocusedPane("main");
    setFocusMode(false);
    setSidebarCollapsed(false);
  };

  const handleReturnToWelcome = () => {
    setVaultPath(null);
    setMainView(null);
    setSplitView(null);
    setMainCategoryId(null);
    setSplitCategoryId(null);
    setSplitOpen(false);
    setFocusedPane("main");
    setFocusMode(false);
    setSidebarCollapsed(false);
  };

  if (!vaultPath) {
    return (
      <VaultWelcome
        recentVaults={recentVaults}
        onOpenVault={handleSelectVault}
        onSelectVault={handleOpenRecentVault}
        onRemoveVault={removeRecentVault}
      />
    );
  }

  const dirOf = (cat: Category) =>
    cat.dirName ? `${vaultPath}/${cat.dirName}` : vaultPath;

  const journalKeyFor = (activeView: ActiveView, pane: "main" | "split") =>
    activeView?.kind === "journal"
      ? `${activeView.dir}-${activeView.focus?.year ?? "t"}-${activeView.focus?.month ?? "t"}-${activeView.focus?.day ?? "t"}-${activeView.focusMode ?? "day"}-${paneNonceRef.current[pane]}`
      : undefined;

  const sidebarHidden = focusMode || sidebarCollapsed;

  // The focused pane keeps the live journal nonce; the other keeps its last
  // one, so reopening "Today" in one pane doesn't reset the other pane.
  paneNonceRef.current[focusedPane] = journalNonce;
  const paneList: { pane: "main" | "split"; view: ActiveView }[] = splitOpen
    ? [{ pane: "main", view: mainView }, { pane: "split", view: splitView }]
    : [{ pane: "main", view: mainView }];

  const isEntryFor = (view: ActiveView): boolean => {
    if (view?.kind !== "note") return false;
    const normVault = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const p = view.path.replace(/\\/g, "/");
    return vaultCategories.some(
      (c) => c.mode === "entries" && !!c.dirName && p.startsWith(`${normVault}/${c.dirName}/`)
    );
  };

  const dirFor = (view: ActiveView): string => {
    if (view?.kind !== "note") return vaultPath;
    const normVault = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const p = view.path.replace(/\\/g, "/");
    for (const cat of vaultCategories) {
      if (!cat.dirName) continue;
      if (p.startsWith(`${normVault}/${cat.dirName}/`)) return `${vaultPath}/${cat.dirName}`;
    }
    return vaultPath;
  };

  const sameTarget = (a: ActiveView, b: ActiveView): boolean => {
    if (!a || !b) return false;
    const n = (p: string) => p.replace(/\\/g, "/");
    if (a.kind === "note") return b.kind === "note" && n(a.path) === n(b.path);
    if (a.kind === "gallery" || a.kind === "abba" || a.kind === "plugin") {
      return b.kind === a.kind && n(a.dir) === n((b as typeof a).dir);
    }
    return false;
  };

  const paneTitle = (v: ActiveView): string => {
    if (!v) return "Home";
    if (v.kind === "note") return v.name.replace(/\.(selah|md)$/i, "");
    if (v.kind === "journal") return "Journal";
    return v.name;
  };

  const openNoteByPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const name = normalized.split("/").pop() || "note.selah";

    // ── Which category owns this file? ────────────────────────────────
    // Walk the category list and find the one whose directory is a
    // prefix of the file's path. If nothing matches, the file lives at
    // the vault root (or in an orphan folder) and gets the plain editor.
    const normVault = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
    let owner: typeof vaultCategories[number] | null = null;
    let relPath = "";
    for (const cat of vaultCategories) {
      if (!cat.dirName) continue;
      const prefix = `${normVault}/${cat.dirName}/`;
      if (normalized.startsWith(prefix)) {
        owner = cat;
        relPath = normalized.slice(prefix.length);
        break;
      }
    }

    // ── Journal categories ────────────────────────────────────────────
    // A day file is named like "January 1, 2024.selah" — that shape is
    // what routes it to the journal view. We accept it either when the
    // owning category is explicitly a journal, or when there's no owner
    // at all (legacy vaults, or files at the vault root).
    const dayInfo = parseJournalDayFilename(name);
    if (dayInfo && (!owner || owner.mode === "journal")) {
      const journalDir = owner
      ? `${vaultPath}/${owner.dirName}`
      : normalized.split("/").slice(0, -3).join("/");
      if (owner) setActiveCategoryId(owner.id);
      setJournalNonce((n) => n + 1);
      setActiveView({
        kind: "journal",
        dir: journalDir,
        name: owner ? owner.name : "Journal",
        focus: { year: dayInfo.year, month: dayInfo.month, day: dayInfo.day },
        focusMode: "day",
      });
      return;
    }

    // ── Abba categories ───────────────────────────────────────────────
    // Abba files live as `<section>/<id>.selah`, so the first path
    // segment is the tab to open and the filename is the entry to focus.
    if (owner?.mode === "abba") {
      const relParts = relPath.split("/");
      if (relParts.length >= 2) {
        const section = relParts[0];
        const fileName = relParts[relParts.length - 1];
        const noteId = fileName.replace(/\.selah$/i, "");
        setActiveCategoryId(owner.id);
        setActiveView({
          kind: "abba",
          dir: `${vaultPath}/${owner.dirName}`,
          name: owner.name,
          icon: owner.icon,
          focusSection: section,
          focusNoteId: noteId,
        });
        return;
      }
    }

    // ── Notes categories ──────────────────────────────────────────────
    // A note category's files are plain .selah documents. Open the one
    // the user clicked in the regular editor, but point the sidebar at
    // the owning category so the tree on the left is showing the right
    // folder.
    if (owner?.mode === "notes") {
      setActiveCategoryId(owner.id);
      setActiveView({ kind: "note", path, name });
      return;
    }

    // ── Fallback ──────────────────────────────────────────────────────
    // Unknown mode, gallery (shouldn't happen — no .selah files), or a
    // file at the vault root. Just open the editor.
    if (owner) setActiveCategoryId(owner.id);
    setActiveView({ kind: "note", path, name });
  };

  // Shared handler so both the sidebar and the homepage quick-action cards
  // route to the right view.
  const handleCreateNewNote = async (catId: string) => {
    const cat = vaultCategories.find(c => c.id === catId);
    if (!cat || !cat.dirName) return;
    const dir = `${vaultPath}/${cat.dirName}`;
    const now = new Date().toISOString();
    const fileName = `Untitled-${Date.now()}.selah`;
    const fullPath = `${dir}/${fileName}`;
    try {
      await writeTextFile(fullPath, `---\ncreated: ${now}\nmodified: ${now}\n---\n\n`);
      openNoteByPath(fullPath);
    } catch (e) {
      console.error("[app] failed to create note:", e);
    }
  };

  const handleCreateNewEntry = async (catId: string) => {
    const cat = vaultCategories.find(c => c.id === catId);
    if (!cat || !cat.dirName) return;
    const dir = `${vaultPath}/${cat.dirName}`;
    try {
      const { path } = await createEntry(dir);
      openNoteByPath(path);
    } catch (e) {
      console.error("[app] failed to create entry:", e);
    }
  };

  const openCategoryView = (cat: Category) => {
    if (cat.mode.startsWith("plugin:")) {
      setActiveCategoryId(cat.id);
      setActiveView({ kind: "plugin", dir: dirOf(cat), name: cat.name, icon: cat.icon, categoryId: cat.id, mode: cat.mode });
      return;
    }
    if (cat.mode === "entries") {
      setActiveCategoryId(cat.id);
      setActiveView({ kind: "entries", dir: dirOf(cat), name: cat.name, icon: cat.icon, categoryId: cat.id });
      return;
    }
    setActiveCategoryId(cat.id);
    if (cat.mode === "abba") {
      setActiveView({ kind: "abba", dir: dirOf(cat), name: cat.name, icon: cat.icon });
    } else if (cat.mode === "gallery") {
      setActiveView({ kind: "gallery", dir: dirOf(cat), name: cat.name });
    } else if (cat.mode === "notes") {
      setActiveView({
        kind: "notes",
        dir: dirOf(cat),
        name: cat.name,
        icon: cat.icon,
        categoryId: cat.id,
      });
    } else {
      setActiveView(null);
    }
  };

  return (
    <div className="app-shell w-screen h-screen overflow-hidden bg-[#0f1315] text-gray-200 flex flex-row font-sans">
      <ThemeBackground />
      <div
        className={`sidebar-shell h-full bg-[#161a1d] border-r border-[#2a3136] flex-shrink-0 flex flex-col overflow-hidden ${
          focusMode ? "" : "transition-[width] duration-150 ease-out"
        } ${sidebarHidden ? "w-0 border-r-0 pointer-events-none" : "w-72"}`}
      >
        <Sidebar
            key={vaultPath}
            vaultPath={vaultPath}
            activeCategoryId={activeCategoryId}
            activeView={activeView}
            onSelectCategory={(cat) => {
              if (cat.mode.startsWith("plugin:")) { openCategoryView(cat); return; }
              if (cat.mode === "entries") {
                setActiveCategoryId(cat.id);
                setActiveView({ kind: "entries", dir: dirOf(cat), name: cat.name, icon: cat.icon, categoryId: cat.id });
                return;
              }
              setActiveCategoryId(cat.id);
              if (cat.mode === "abba") {
                setActiveView({
                  kind: "abba",
                  dir: dirOf(cat),
                  name: cat.name,
                  icon: cat.icon,
                });
              } else if (cat.mode === "gallery") {
                setActiveView({
                  kind: "gallery",
                  dir: dirOf(cat),
                  name: cat.name,
                });
              } else if (cat.mode === "notes") {
                setActiveView({
                  kind: "notes",
                  dir: dirOf(cat),
                  name: cat.name,
                  icon: cat.icon,
                  categoryId: cat.id,
                });
              } else {
                setActiveView(null);
              }
            }}
            onOpenJournalToday={(cat) => {
              setActiveCategoryId(cat.id);
              setJournalNonce((n) => n + 1);
              setActiveView({ kind: "journal", dir: dirOf(cat), name: cat.name });
            }}
            onOpenJournalDay={(cat, year, month, day) => {
              setActiveCategoryId(cat.id);
              setJournalNonce((n) => n + 1);
              setActiveView({
                kind: "journal",
                dir: dirOf(cat),
                name: cat.name,
                focus: { year, month, day },
                focusMode: "day",
              });
            }}
            onOpenJournalMonth={(cat, year, month) => {
              setActiveCategoryId(cat.id);
              setJournalNonce((n) => n + 1);
              setActiveView({
                kind: "journal",
                dir: dirOf(cat),
                name: cat.name,
                focus: { year, month, day: 1 },
                focusMode: "month",
              });
            }}
            onOpenNote={(cat, note) => {
              setActiveCategoryId(cat.id);
              setActiveView({ kind: "note", ...note });
            }}
            onOpenGallery={(cat) => {
              setActiveCategoryId(cat.id);
              setActiveView({ kind: "gallery", dir: dirOf(cat), name: cat.name });
            }}
            onOpenAbba={(cat) => {
              setActiveCategoryId(cat.id);
              setActiveView({
                kind: "abba",
                dir: dirOf(cat),
                name: cat.name,
                icon: cat.icon,
              });
            }}
            onOpenNotes={(cat) => {
              setActiveCategoryId(cat.id);
              setActiveView({
                kind: "notes",
                dir: dirOf(cat),
                name: cat.name,
                icon: cat.icon,
                categoryId: cat.id,
              });
            }}
            onOpenEntries={(cat) => {
              setActiveCategoryId(cat.id);
              setActiveView({ kind: "entries", dir: dirOf(cat), name: cat.name, icon: cat.icon, categoryId: cat.id });
            }}
            onSwitchVault={handleReturnToWelcome}
            onOpenSettings={() => setSettingsOpen(true)}
            onGoHome={() => setActiveView(null)}
            onCollapse={() => setSidebarCollapsed(true)}
          />
      </div>

      <div className="content-shell flex flex-row flex-grow h-full overflow-hidden relative">
        {!focusMode && sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="absolute top-3 left-3 z-[90] p-2 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 hover:text-gray-100 cursor-pointer"
            title="Show sidebar (Ctrl+B)"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}

        {!splitOpen && !focusMode && (
          <button
            onClick={openSplit}
            className="absolute bottom-3 right-3 z-[90] p-2 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 hover:text-gray-100 cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
            title="Split right (Ctrl+\)"
          >
            <Columns2 size={14} />
          </button>
        )}

        {paneList.map(({ pane, view: activeView }) => (
          <PaneShell
            key={pane}
            split={splitOpen}
            isSecond={pane === "split"}
            title={paneTitle(activeView)}
            focused={focusedPane === pane}
            forceRead={pane === "split" && sameTarget(mainView, splitView)}
            onFocus={() => setFocusedPane(pane)}
            onClose={() => closePane(pane)}
            onSwap={swapPanes}
          >
        {!activeView ? (
          <HomeView
            vaultPath={vaultPath}
            onOpenNoteByPath={openNoteByPath}
            onOpenCategory={openCategoryView}
            onOpenJournalToday={(cat) => {
              setActiveCategoryId(cat.id);
              setJournalNonce((n) => n + 1);
              setActiveView({ kind: "journal", dir: dirOf(cat), name: cat.name });
            }}
            onOpenJournalDay={(cat, year, month, day) => {
              setActiveCategoryId(cat.id);
              setJournalNonce((n) => n + 1);
              setActiveView({
                kind: "journal",
                dir: dirOf(cat),
                name: cat.name,
                focus: { year, month, day },
                focusMode: "day",
              });
            }}
            onCreateNote={handleCreateNewNote}
            onCreateEntry={handleCreateNewEntry}
          />
        ) : activeView.kind === "note" ? (
          <Editor
            activeNote={activeView}
            vaultPath={vaultPath}
            tagsDir={dirFor(activeView)}
            focusMode={focusMode}
            onToggleFocus={() => setFocusMode((v) => !v)}
            onOpenNoteByPath={openNoteByPath}
            setActiveNote={(note) => setActiveView({ kind: "note", ...note })}
            entryMode={isEntryFor(activeView)}
          />
        ) : activeView.kind === "journal" ? (
          <JournalView
            key={journalKeyFor(activeView, pane)}
            vaultPath={vaultPath}
            journalDir={activeView.dir}
            categoryName={activeView.name}
            initialDate={activeView.focus}
            initialMode={activeView.focusMode}
            focusMode={focusMode}
            onToggleFocus={() => setFocusMode((v) => !v)}
            onOpenNoteByPath={openNoteByPath}
          />
        ) : activeView.kind === "gallery" ? (
          <GalleryView sectionDir={activeView.dir} sectionName={activeView.name} />
        ) : activeView.kind === "entries" ? (
          <EntriesView
            key={activeView.dir}
            sectionDir={activeView.dir}
            sectionName={activeView.name}
            sectionIcon={activeView.icon}
            onOpenNote={(note) =>
              setActiveView({ kind: "note", path: note.path, name: note.name })
            }
          />
        ) : activeView.kind === "plugin" ? (
          <PluginView
            key={activeView.dir}
            vaultPath={vaultPath}
            dir={activeView.dir}
            name={activeView.name}
            icon={activeView.icon}
            mode={activeView.mode}
          />
        ) : activeView.kind === "abba" ? (
          <AbbaView
          abbaDir={activeView.dir}
          name={activeView.name}
          icon={activeView.icon}
          focusSection={activeView.focusSection}
          focusNoteId={activeView.focusNoteId}
          vaultPath={vaultPath}
          onOpenNoteByPath={openNoteByPath}
          />
        ) : (
          <NotesView
            key={activeView.dir}
            sectionDir={activeView.dir}
            sectionName={activeView.name}
            sectionIcon={activeView.icon}
            categoryId={activeView.categoryId}
            vaultPath={vaultPath}
            onOpenNote={(note) =>
              setActiveView({ kind: "note", path: note.path, name: note.name })
            }
          />
        )}
          </PaneShell>
        ))}
      </div>

      <ProxyToggleHost />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        vaultPath={vaultPath}
      />
    </div>
  );
}
