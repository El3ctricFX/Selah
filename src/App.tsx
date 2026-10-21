// src/App.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PanelLeftOpen } from "lucide-react";
import Editor from "./Editor";
import Sidebar, { type Category } from "./Sidebar";
import JournalView from "./JournalView";
import GalleryView from "./GalleryView";
import AbbaView from "./AbbaView";
import NotesView from "./NotesView";
import HomeView from "./HomeView";
import SettingsModal from "./SettingsModal";
import ProxyToggleHost from "./ProxyToggleHost";
import "./App.css";
import VaultWelcome from "./VaultWelcome";
import { useRecentVaults } from "./useRecentVaults";
import { flushAll } from "./flushRegistry";
import { migrateVaultPaths } from "./vaultMigration";
import { useTheme, setThemeVaultPath } from "./theme";
import ThemeBackground from "./ThemeBackground";

type JournalFocus = { year: number; month: number; day: number };
type ViewSnapshot = { view: ActiveView; categoryId: string | null };

type ActiveView =
  | { kind: "note"; path: string; name: string }
  | { kind: "journal"; dir: string; focus?: JournalFocus; focusMode?: "day" | "month" }
  | { kind: "gallery"; dir: string; name: string }
    | { kind: "abba"; dir: string; name: string; icon: string; focusSection?: string; focusNoteId?: string }
  | { kind: "notes"; dir: string; name: string; icon: string; categoryId: string }
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
  const [activeView, setActiveView] = useState<ActiveView>(null);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
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

    if (prev && !suppressed) {
      const viewChanged = !viewsEqual(prev.view, activeView);
      const catChanged = prev.categoryId !== activeCategoryId;
      if (viewChanged || catChanged) {
        historyRef.current.push(prev);
        if (historyRef.current.length > 50) historyRef.current.shift();
        forwardRef.current = [];
      }
    }
    prevSnapshotRef.current = snap;
  }, [activeView, activeCategoryId]);

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
      setActiveView(null);
      setActiveCategoryId(null);
      setFocusMode(false);
      setSidebarCollapsed(false);
    }
  };

  const handleOpenRecentVault = (path: string) => {
    setVaultPath(path);
    addRecentVault(path);
    setActiveView(null);
    setActiveCategoryId(null);
    setFocusMode(false);
    setSidebarCollapsed(false);
  };

  const handleReturnToWelcome = () => {
    setVaultPath(null);
    setActiveView(null);
    setActiveCategoryId(null);
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

  const journalKey =
    activeView?.kind === "journal"
      ? `${activeView.dir}-${activeView.focus?.year ?? "t"}-${activeView.focus?.month ?? "t"}-${activeView.focus?.day ?? "t"}-${activeView.focusMode ?? "day"}-${journalNonce}`
      : undefined;

  const sidebarHidden = focusMode || sidebarCollapsed;

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
  const openCategoryView = (cat: Category) => {
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
        className={`sidebar-shell h-full bg-[#161a1d] border-r border-[#2a3136] flex-shrink-0 flex flex-col overflow-hidden transition-all duration-200 ${
          sidebarHidden ? "w-0 border-r-0" : "w-72"
        }`}
      >
        {!sidebarHidden && (
          <Sidebar
            key={vaultPath}
            vaultPath={vaultPath}
            activeCategoryId={activeCategoryId}
            activeView={activeView}
            onSelectCategory={(cat) => {
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
              setActiveView({ kind: "journal", dir: dirOf(cat) });
            }}
            onOpenJournalDay={(cat, year, month, day) => {
              setActiveCategoryId(cat.id);
              setJournalNonce((n) => n + 1);
              setActiveView({
                kind: "journal",
                dir: dirOf(cat),
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
            onSwitchVault={handleReturnToWelcome}
            onOpenSettings={() => setSettingsOpen(true)}
            onGoHome={() => setActiveView(null)}
            onCollapse={() => setSidebarCollapsed(true)}
          />
        )}
      </div>

      <div className="content-shell flex-grow h-full overflow-hidden relative">
        {!focusMode && sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="absolute top-3 left-3 z-[90] p-2 rounded bg-[#1e2327] border border-[#2a3136] text-gray-400 hover:text-gray-100 cursor-pointer"
            title="Show sidebar (Ctrl+B)"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}

        {!activeView ? (
          <HomeView
            vaultPath={vaultPath}
            onOpenNoteByPath={openNoteByPath}
            onOpenCategory={openCategoryView}
            onOpenJournalToday={(cat) => {
              setActiveCategoryId(cat.id);
              setJournalNonce((n) => n + 1);
              setActiveView({ kind: "journal", dir: dirOf(cat) });
            }}
          />
        ) : activeView.kind === "note" ? (
          <Editor
            activeNote={activeView}
            vaultPath={vaultPath}
            focusMode={focusMode}
            onToggleFocus={() => setFocusMode((v) => !v)}
            onOpenNoteByPath={openNoteByPath}
            setActiveNote={(note) => setActiveView({ kind: "note", ...note })}
          />
        ) : activeView.kind === "journal" ? (
          <JournalView
            key={journalKey}
            vaultPath={vaultPath}
            journalDir={activeView.dir}
            initialDate={activeView.focus}
            initialMode={activeView.focusMode}
            focusMode={focusMode}
            onToggleFocus={() => setFocusMode((v) => !v)}
            onOpenNoteByPath={openNoteByPath}
          />
        ) : activeView.kind === "gallery" ? (
          <GalleryView sectionDir={activeView.dir} sectionName={activeView.name} />
        ) : activeView.kind === "abba" ? (
          <AbbaView
          abbaDir={activeView.dir}
          name={activeView.name}
          icon={activeView.icon}
          focusSection={activeView.focusSection}
          focusNoteId={activeView.focusNoteId}
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
