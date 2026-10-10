// src/App.tsx
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { PanelLeftOpen } from "lucide-react";
import Editor from "./Editor";
import Sidebar, { type Category } from "./Sidebar";
import JournalView from "./JournalView";
import GalleryView from "./GalleryView";
import AbbaView from "./AbbaView";
import NotesView from "./NotesView";
import "./App.css";
import VaultWelcome from "./VaultWelcome";
import { useRecentVaults } from "./useRecentVaults";

type JournalFocus = { year: number; month: number; day: number };

type ActiveView =
  | { kind: "note"; path: string; name: string }
  | { kind: "journal"; dir: string; focus?: JournalFocus; focusMode?: "day" | "month" }
  | { kind: "gallery"; dir: string; name: string }
  | { kind: "abba"; dir: string; name: string; icon: string }
  | { kind: "notes"; dir: string; name: string; icon: string }
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
  // Bumped on every journal navigation (sidebar click, Today button, or a
  // note-link that resolves to a journal day). It is folded into JournalView's
  // React key so that clicking a day in the sidebar always remounts the view —
  // even when the target date happens to match whatever `activeView.focus`
  // already was (which is the case if you arrow-navigated away and then
  // clicked back to where you started).
  const [journalNonce, setJournalNonce] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
    addRecentVault(path); // bumps to top + updates lastOpened
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

    const dayInfo = parseJournalDayFilename(name);
    if (dayInfo) {
      const parts = normalized.split("/");
      const journalDir = parts.slice(0, -3).join("/");
      // Bump the nonce so a note-link that points at a day we're already
      // "on" (per activeView.focus) still remounts JournalView with the
      // right initialDate.
      setJournalNonce((n) => n + 1);
      setActiveView({
        kind: "journal",
        dir: journalDir,
        focus: { year: dayInfo.year, month: dayInfo.month, day: dayInfo.day },
        focusMode: "day",
      });
      return;
    }

    setActiveView({ kind: "note", path, name });
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-[#0f1315] text-gray-200 flex flex-row font-sans">
      <div
        className={`h-full bg-[#161a1d] border-r border-[#2a3136] flex-shrink-0 flex flex-col overflow-hidden transition-all duration-200 ${
          sidebarHidden ? "w-0 border-r-0" : "w-72"
        }`}
      >
        {!sidebarHidden && (
          // Key the Sidebar on vaultPath so switching vaults fully resets its
          // internal state (categories, folderMeta, and — crucially — the
          // JournalTree / NotesTree child trees). Built-in category IDs like
          // "journal" are identical across vaults, so without this React
          // would reuse the same component instance and stale state would
          // bleed from the previous vault into the new one.
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
              // Always bump: the target date may equal activeView.focus
              // (e.g. the user arrow-navigated away and is now clicking
              // back to where they started), and without a fresh nonce the
              // journalKey would be unchanged and JournalView would not
              // remount — leaving its local `date` stuck on the arrowed-to
              // day.
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
              });
            }}
            onSwitchVault={handleSelectVault}
            onCollapse={() => setSidebarCollapsed(true)}
          />
        )}
      </div>

      <div className="flex-grow h-full overflow-hidden relative">
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
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <h2 className="text-xl">Pick something from the sidebar</h2>
          </div>
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
          />
        ) : (
          <NotesView
            key={activeView.dir}
            sectionDir={activeView.dir}
            sectionName={activeView.name}
            sectionIcon={activeView.icon}
            onOpenNote={(note) =>
              setActiveView({ kind: "note", path: note.path, name: note.name })
            }
          />
        )}
      </div>
    </div>
  );
}