// src/SettingsModal.tsx
import { useEffect, useRef, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { getVersion } from "@tauri-apps/api/app";
import {
  X, Home, Palette, Sparkles, Info,
  GripHorizontal, Eye, EyeOff, Crosshair, Sliders,
  ExternalLink, Heart, Code2, MessageCircle,
} from "lucide-react";
import { writeFileAtomic } from "./safeWrite";
import { proxyFeatureEnabled, setProxyFeatureEnabled } from "./proxyFeature";
import {
  HomeSettingsPanel,
  DEFAULT_HOME_SETTINGS,
  type HomeSettings,
} from "./HomeSettings";
import AppearancePanel from "./AppearancePanel";

type SectionId = "home" | "general" | "appearance" | "about";

type Section = {
  id: SectionId;
  label: string;
  icon: any;
  description: string;
};

const SECTIONS: Section[] = [
  { id: "home",       label: "Home",       icon: Home,     description: "Customize your home screen" },
  { id: "general",    label: "General",    icon: Sliders,  description: "App-wide preferences" },
  { id: "appearance", label: "Appearance", icon: Palette,  description: "Themes, light mode, custom CSS" },
  { id: "about",      label: "About",      icon: Info,     description: "Version and info" },
];

const DEFAULT_W = 920;
const DEFAULT_H = 640;
const MIN_W = 720;
const MIN_H = 400;

type ResizeEdge = "right" | "bottom" | "corner";

function centeredPos(w: number, h: number) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1400;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  return {
    x: Math.max(12, (vw - w) / 2),
    y: Math.max(12, (vh - h) / 2),
  };
}

export default function SettingsModal({
  open: isOpen,
  onClose,
  vaultPath,
}: {
  open: boolean;
  onClose: () => void;
  vaultPath: string;
}) {
  const [section, setSection] = useState<SectionId>("home");
  const [homeSettings, setHomeSettings] = useState<HomeSettings>(DEFAULT_HOME_SETTINGS);
  const [categories, setCategories] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  // ── Window chrome state ─────────────────────────────────────────────
  const [backdropOn, setBackdropOn] = useState(true);
  const [pos, setPos] = useState(() => centeredPos(DEFAULT_W, DEFAULT_H));
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });
  const userMovedRef = useRef(false);

  const [dragging, setDragging] = useState<
    { startX: number; startY: number; startPosX: number; startPosY: number } | null
  >(null);

  const [resizing, setResizing] = useState<
    {
      startX: number;
      startY: number;
      startW: number;
      startH: number;
      edge: ResizeEdge;
    } | null
  >(null);

  // True only while the user is pressing on the backdrop itself. Reset on
  // release. This is what stops a slider drag that ends outside the modal
  // from being mistaken for "click the backdrop to close".
  const modalRef = useRef<HTMLDivElement>(null);

  // True only while the user is pressing on the backdrop itself. Reset on
  // release. This is what stops a slider drag that ends outside the modal
  // from being mistaken for "click the backdrop to close".
  const backdropPressRef = useRef(false);

  // Load vault metadata (categories + home settings) each time we open.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
        const meta = JSON.parse(raw);
        if (cancelled) return;
        setCategories(meta.categories || []);
        if (meta.homeSettings && typeof meta.homeSettings === "object") {
          setHomeSettings({ ...DEFAULT_HOME_SETTINGS, ...meta.homeSettings });
        } else {
          setHomeSettings(DEFAULT_HOME_SETTINGS);
        }
      } catch {
        if (cancelled) return;
        setCategories([]);
        setHomeSettings(DEFAULT_HOME_SETTINGS);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, vaultPath]);

  // On open, if the user has never dragged the modal, recenter to the
  // current viewport.
  useEffect(() => {
    if (!isOpen) return;
    if (userMovedRef.current) return;
    setPos(centeredPos(size.w, size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Escape closes.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // ── Drag handling ───────────────────────────────────────────────────
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      setPos({
        x: dragging.startPosX + (e.clientX - dragging.startX),
        y: dragging.startPosY + (e.clientY - dragging.startY),
      });
    };
    const onUp = () => setDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, select, textarea")) return;
    e.preventDefault();
    userMovedRef.current = true;
    setDragging({
      startX: e.clientX,
      startY: e.clientY,
      startPosX: pos.x,
      startPosY: pos.y,
    });
  };

  // ── Resize handling ─────────────────────────────────────────────────
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - resizing.startX;
      const dy = e.clientY - resizing.startY;

      let nextW = resizing.startW;
      let nextH = resizing.startH;

      if (resizing.edge === "right" || resizing.edge === "corner") {
        nextW = Math.max(MIN_W, resizing.startW + dx);
      }
      if (resizing.edge === "bottom" || resizing.edge === "corner") {
        nextH = Math.max(MIN_H, resizing.startH + dy);
      }

      setSize({ w: nextW, h: nextH });
    };
    const onUp = () => setResizing(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizing]);

  const startResize =
    (edge: ResizeEdge) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = modalRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      userMovedRef.current = true;
      setResizing({
        startX: e.clientX,
        startY: e.clientY,
        startW: rect.width,
        startH: rect.height,
        edge,
      });
    };

  const recenter = () => {
    userMovedRef.current = false;
    setPos(centeredPos(size.w, size.h));
  };

  const resetAll = () => {
    userMovedRef.current = false;
    setSize({ w: DEFAULT_W, h: DEFAULT_H });
    setPos(centeredPos(DEFAULT_W, DEFAULT_H));
  };

  const saveHomeSettings = async (next: HomeSettings) => {
    setHomeSettings(next);
    try {
      let meta: any = {};
      try {
        const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
        meta = JSON.parse(raw);
      } catch {}
      meta.homeSettings = next;
      await writeFileAtomic(
        await join(vaultPath, ".vault_metadata.json"),
        JSON.stringify(meta, null, 2)
      );
      window.dispatchEvent(new CustomEvent("home-settings-changed", { detail: next }));
    } catch (e) {
      console.error("[settings] save home settings failed:", e);
    }
  };

  if (!isOpen) return null;

  const activeSection = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  const center = centeredPos(size.w, size.h);
  const centered =
    Math.abs(pos.x - center.x) < 2 && Math.abs(pos.y - center.y) < 2;
  const isDefaultSize = size.w === DEFAULT_W && size.h === DEFAULT_H;

  return (
    <div
      className={`fixed inset-0 z-[700] transition-colors duration-150 ${
        backdropOn
          ? "bg-black/70 pointer-events-auto"
          : "bg-transparent pointer-events-none"
      }`}
      onMouseDown={(e) => {
        backdropPressRef.current =
          backdropOn && e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (backdropPressRef.current && e.target === e.currentTarget) {
          onClose();
        }
        backdropPressRef.current = false;
      }}
    >
      <div
        ref={modalRef}
        data-opaque
        className="absolute bg-[#1e2327] border border-[#2a3136] rounded-xl shadow-2xl overflow-hidden flex pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
        style={{
          left: pos.x,
          top: pos.y,
          width: size.w,
          height: size.h,
          maxWidth: "96vw",
          maxHeight: "88vh",
          userSelect: resizing ? "none" : undefined,
        }}
      >
        {/* Left nav */}
        <div className="w-56 flex-shrink-0 border-r border-[#2a3136] bg-[#1a1e21] flex flex-col">
          <div
            className="px-4 py-4 border-b border-[#2a3136] cursor-move select-none flex items-center gap-2"
            onMouseDown={startDrag}
            title="Drag to move"
          >
            <GripHorizontal size={12} className="text-gray-600 flex-shrink-0" />
            <div className="text-sm font-semibold text-gray-100">Settings</div>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className={`w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors mb-0.5 ${
                    active
                      ? "bg-[#2a3136] text-gray-100"
                      : "text-gray-400 hover:text-gray-200 hover:bg-[#21262a]"
                  }`}
                >
                  <Icon size={14} />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>

          {/* Window chrome — bottom-left icons */}
          <div className="flex items-center gap-1 px-2 py-2 border-t border-[#2a3136] flex-shrink-0">
            <button
              type="button"
              onClick={() => setBackdropOn((v) => !v)}
              className={`p-1.5 rounded transition-colors ${
                backdropOn
                  ? "text-gray-500 hover:text-gray-200 hover:bg-[#2a3136]"
                  : "text-blue-400 hover:text-blue-300 hover:bg-[#2a3136]"
              }`}
              title={backdropOn ? "Hide dark background" : "Show dark background"}
            >
              {backdropOn ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button
              type="button"
              onClick={recenter}
              disabled={centered}
              className="p-1.5 rounded transition-colors text-gray-500 hover:text-gray-200 hover:bg-[#2a3136] disabled:opacity-30 disabled:cursor-not-allowed"
              title="Recenter window"
            >
              <Crosshair size={13} />
            </button>
            <button
              type="button"
              onClick={resetAll}
              disabled={centered && isDefaultSize}
              className="ml-auto text-[10px] px-2 py-1 rounded transition-colors text-gray-500 hover:text-gray-200 hover:bg-[#2a3136] disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
              title="Reset position and size"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Right content */}
        <div className="flex-1 flex flex-col min-w-0">
          <div
            className="flex items-center gap-3 px-5 py-4 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0 cursor-move select-none"
            onMouseDown={startDrag}
            title="Drag to move"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-gray-100">
                {activeSection.label}
              </div>
              <div className="text-[11px] text-gray-500 truncate">
                {activeSection.description}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 p-1 flex-shrink-0"
              title="Close (Esc)"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!loaded ? (
              <div className="p-8 text-center text-xs text-gray-500 italic">
                Loading…
              </div>
            ) : section === "home" ? (
              <HomeSettingsPanel
                settings={homeSettings}
                onChange={saveHomeSettings}
                categories={categories}
                vaultPath={vaultPath}
              />
            ) : section === "general" ? (
              <GeneralPanel vaultPath={vaultPath} />
            ) : section === "appearance" ? (
              <AppearancePanel />
            ) : (
              <AboutPanel />
            )}
          </div>
        </div>

        {/* Resize handles */}
        <div
          onMouseDown={startResize("right")}
          className="absolute top-0 right-0 w-1.5 cursor-ew-resize hover:bg-blue-500/40 transition-colors z-10"
          style={{ bottom: 12 }}
          title="Drag to resize"
        />
        <div
          onMouseDown={startResize("bottom")}
          className="absolute bottom-0 left-0 h-1.5 cursor-ns-resize hover:bg-blue-500/40 transition-colors z-10"
          style={{ right: 12 }}
          title="Drag to resize"
        />
        <div
          onMouseDown={startResize("corner")}
          className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize hover:bg-blue-500/60 transition-colors z-20 group"
          title="Drag to resize"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            className="absolute bottom-0.5 right-0.5 text-gray-600 group-hover:text-white/80 transition-colors pointer-events-none"
          >
            <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            <line x1="11" y1="7" x2="7" y2="11" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}

function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
    type="button"
    onClick={onClick}
    className="relative rounded-full transition-colors flex-shrink-0"
    style={{ width: 28, height: 16, backgroundColor: on ? "#3b82f6" : "#3a4147" }}
    aria-pressed={on}
    >
    <span
    className="absolute rounded-full bg-white"
    style={{
      width: 12, height: 12, top: 2,
      left: on ? 14 : 2,
      transition: "left 150ms ease",
      boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
    }}
    />
    </button>
  );
}

function GeneralPanel({ vaultPath }: { vaultPath: string }) {
  const [showExtensions, setShowExtensions] = useState<boolean>(() => {
    try { return localStorage.getItem("sidebar-show-extensions") === "true"; }
    catch { return false; }
  });
  const [proxies, setProxies] = useState<boolean>(() => proxyFeatureEnabled());
  const [confirmOff, setConfirmOff] = useState(false);

  const toggleExtensions = () => {
    setShowExtensions((prev) => {
      const next = !prev;
      try { localStorage.setItem("sidebar-show-extensions", String(next)); } catch {}
      window.dispatchEvent(new Event("sidebar-show-extensions-changed"));
      return next;
    });
  };

  const toggleProxies = () => {
    if (proxies) { setConfirmOff(true); return; } // turning off: ask first
    setProxies(true);
    setProxyFeatureEnabled(true);
  };

  const finishOff = (deleteProxies: boolean) => {
    setConfirmOff(false);
    setProxies(false);
    setProxyFeatureEnabled(false);
    if (deleteProxies) {
      window.dispatchEvent(
        new CustomEvent("proxy-toggle-request", {
          detail: { path: "", next: false, vaultPath },
        })
      );
    }
  };

  return (
    <div className="p-5 space-y-6">
    <div>
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3">
    Sidebar
    </div>
    <label className="flex items-center justify-between text-xs text-gray-300 cursor-pointer py-1">
    <span>Show file extensions</span>
    <Switch on={showExtensions} onClick={toggleExtensions} />
    </label>
    <p className="text-[10px] text-gray-600 mt-2 leading-snug">
    Shows the file extension (e.g. <span className="font-mono">.selah</span>)
    next to entries in the sidebar tree.
    </p>
    </div>

    <div>
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3">
    Images
    </div>
    <label className="flex items-center justify-between text-xs text-gray-300 cursor-pointer py-1">
    <span>Enable image proxies</span>
    <Switch on={proxies} onClick={toggleProxies} />
    </label>
    <p className="text-[10px] text-gray-600 mt-2 leading-snug">
    Off by default. When on, a Proxies button appears in each note's toolbar
    and you choose which notes get smaller WebP copies for smoother scrolling.
    When you turn this off, you'll be asked whether to delete the existing
    proxies or keep them.
    </p>

    {confirmOff && (
      <div className="mt-3 rounded-md border border-[#2a3136] bg-[#0f1315] p-3">
      <div className="text-xs text-gray-200 mb-1">Delete existing proxies?</div>
      <p className="text-[10px] text-gray-500 leading-snug mb-3">
      <span className="text-gray-300">Yes</span> moves every proxy and thumbnail in
      this vault to your system trash and points your notes back at the original
      photos. <span className="text-gray-300">No</span> keeps everything as it is:
      notes keep using the proxies they already have, but new photos won't get any.
      </p>
      <div className="flex items-center gap-2">
      <button
      type="button"
      onClick={() => finishOff(true)}
      className="px-3 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded cursor-pointer"
      >
      Yes, delete them
      </button>
      <button
      type="button"
      onClick={() => finishOff(false)}
      className="px-3 py-1 text-xs bg-[#2a3136] hover:bg-[#343c42] text-gray-200 rounded cursor-pointer"
      >
      No, keep them
      </button>
      <button
      type="button"
      onClick={() => setConfirmOff(false)}
      className="px-2 py-1 text-xs text-gray-500 hover:text-gray-300 cursor-pointer"
      >
      Cancel
      </button>
      </div>
      </div>
    )}
    </div>
    </div>
  );
}

function ComingSoon({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="p-10 text-center">
      <Sparkles size={22} className="text-gray-600 mx-auto mb-3" />
      <div className="text-sm text-gray-300 font-medium mb-1">{title}</div>
      <div className="text-xs text-gray-500 max-w-sm mx-auto leading-relaxed">
        {hint}
      </div>
    </div>
  );
}

function AboutPanel() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    getVersion()
    .then((v) => {
      if (!cancelled) setVersion(v);
    })
    .catch((e) => {
      console.warn("[about] could not read app version:", e);
      if (!cancelled) setVersion("");
    });
      return () => { cancelled = true; };
  }, []);

  return (
    <div className="p-8 max-w-2xl">
    {/* Logo + name + version */}
    <div className="flex items-center gap-4 mb-6">
    <img
    src="/logo.png"
    alt="Selah"
    className="w-14 h-14 flex-shrink-0 select-none"
    draggable={false}
    />
    <div className="min-w-0">
    <div className="text-2xl font-bold text-gray-100 tracking-tight">
    Selah
    </div>
    <div className="flex items-center gap-2 mt-1">
    {version && (
      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#2a3136] border border-[#30363d] text-gray-400 font-mono">
      v{version}
      </span>
    )}
    <span className="text-[10px] uppercase tracking-wider text-amber-400/80">
    Early development
    </span>
    </div>
    </div>
    </div>

    {/* Tagline */}
    <p className="text-sm text-gray-300 leading-relaxed mb-5">
    Selah is a work-in-progress, local-first journaling and note-taking
    app inspired by the flexibility of Notion and the personal knowledge
    approach of Obsidian. It is being built as a calm space for daily
    journaling, prayer, Scripture study, dreams, testimonies, and the
    thoughts and moments worth keeping.
    </p>

    {/* Verse */}
    <div className="border-l-2 border-blue-500/40 pl-4 py-1 mb-8">
    <p
    className="text-sm text-gray-400 italic leading-relaxed"
    style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
    >
    "Be still, and know that I am God."
    </p>
    <div className="text-[10px] uppercase tracking-[0.2em] text-gray-600 mt-1.5">
    Psalm 46:10
    </div>
    </div>

    {/* Why "Selah" */}
    <div className="mb-8">
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
    Why "Selah"?
    </div>
    <p className="text-sm text-gray-400 leading-relaxed">
    <em>Selah</em> appears throughout the Psalms and other poetic
    passages of Scripture. Its exact meaning is debated, but it is
    often associated with a pause or moment of reflection. That idea
    captures the heart of this project: making room to slow down,
    write honestly, reflect on Scripture, and remember meaningful
    moments.
    </p>
    </div>

    {/* Links */}
    <div>
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
    Links
    </div>
    <div className="space-y-1.5">
    <a
    href="https://github.com/El3ctricFX/Selah"
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => {
      e.preventDefault();
      import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
      openUrl("https://github.com/El3ctricFX/Selah").catch(() => {})
      );
    }}
    className="flex items-center gap-3 px-3 py-2 rounded-md border border-[#2a3136] bg-[#131819] hover:border-[#3a4147] hover:bg-[#161a1d] transition-colors text-sm text-gray-300 hover:text-gray-100 group"
    >
    <Code2 size={14} className="text-gray-500 group-hover:text-gray-300 flex-shrink-0" />
    <div className="flex-1 min-w-0">
    <div className="text-xs">Selah on GitHub</div>
    <div className="text-[10px] text-gray-600 font-mono truncate">
    github.com/El3ctricFX/Selah
    </div>
    </div>
    <ExternalLink size={12} className="text-gray-600 flex-shrink-0" />
    </a>

    <a
    href="https://github.com/El3ctricFX/Selah/issues"
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => {
      e.preventDefault();
      import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
      openUrl("https://github.com/El3ctricFX/Selah/issues").catch(() => {})
      );
    }}
    className="flex items-center gap-3 px-3 py-2 rounded-md border border-[#2a3136] bg-[#131819] hover:border-[#3a4147] hover:bg-[#161a1d] transition-colors text-sm text-gray-300 hover:text-gray-100 group"
    >
    <Heart size={14} className="text-gray-500 group-hover:text-gray-300 flex-shrink-0" />
    <div className="flex-1 min-w-0">
    <div className="text-xs">Report an issue or share feedback</div>
    <div className="text-[10px] text-gray-600 font-mono truncate">
    github.com/El3ctricFX/Selah/issues
    </div>
    </div>
    <ExternalLink size={12} className="text-gray-600 flex-shrink-0" />
    </a>

    <a
    href="https://discord.gg/JSQFShPTkD"
    target="_blank"
    rel="noopener noreferrer"
    onClick={(e) => {
      e.preventDefault();
      import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
      openUrl("https://discord.gg/JSQFShPTkD").catch(() => {})
      );
    }}
    className="flex items-center gap-3 px-3 py-2 rounded-md border border-[#2a3136] bg-[#131819] hover:border-[#3a4147] hover:bg-[#161a1d] transition-colors text-sm text-gray-300 hover:text-gray-100 group"
    >
    <MessageCircle size={14} className="text-gray-500 group-hover:text-gray-300 flex-shrink-0" />
    <div className="flex-1 min-w-0">
    <div className="text-xs">Join the Discord</div>
    <div className="text-[10px] text-gray-600 font-mono truncate">
    discord.gg/JSQFShPTkD
    </div>
    </div>
    <ExternalLink size={12} className="text-gray-600 flex-shrink-0" />
    </a>
    </div>
    </div>

    {/* Footer */}
    <div className="mt-10 pt-5 border-t border-[#2a3136] text-center">
    <div className="text-[10px] uppercase tracking-[0.25em] text-gray-700">
    Pause · Reflect · Write · Grow
    </div>
    </div>
    </div>
  );
}
