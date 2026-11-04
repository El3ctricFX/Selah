// src/PluginsPanel.tsx
import { useState, useEffect, useRef } from "react";
import { Puzzle, FolderOpen, RefreshCw, AlertTriangle, Copy, Check, Trash2, MoreVertical, Settings } from "lucide-react";
import { mkdir } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { usePlugins, loadPlugins, setPluginEnabled, pluginsDir, removePlugin } from "./plugins";
import { usePluginFeature } from "./pluginFeature";
import { useModal } from "./Modal";

const DOCS = String.raw`<vault>/.plugins/my-plugin/
manifest.json
index.js

manifest.json
{ "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
    "description": "What it does", "author": "You" }

    index.js  (runs when the vault opens; "selah" is the API)

    // A new category type. It appears under "New category".
    selah.registerCategoryType({
        id: "my-type", label: "My Type", icon: "✨",
        async render(container, ctx) {
            // ctx.dir  ctx.name  ctx.icon  ctx.vaultPath
            // ctx.fs   -> read/write files, sandboxed to this category's folder
            // ctx.theme -> { bg, surface, border, text, accent } tailwind classes
            container.textContent = "Hello from " + ctx.name;
            return () => { /* optional cleanup */ };
        },
        // Optional custom actions that users can pin to their home screen.
        shortcutActions: [
            {
                id: "do-something",
                label: "Do Something Cool",
                icon: "🚀",
                run() {
                    console.log("Shortcut clicked!");
                    // You can use ctx.fs or trigger custom logic here.
                }
            }
        ]
    });

    // A home-screen widget. Users enable it in Settings > Home > Widgets.
    selah.registerHomeWidget({
        id: "my-widget", label: "My Widget", icon: "📖",
        slot: "above-verse",   // header | above-shortcuts | below-shortcuts | above-verse
        render(container, ctx) {
            // ctx.fs (plugin data folder), ctx.vaultPath, ctx.name
            // Style with CSS vars: var(--c-text), var(--c-text-muted), var(--c-accent)
            container.textContent = "Hello";
            return () => { /* optional cleanup */ };
        },
    });

    // A slash-menu template. Type "/" in any note.
    selah.registerSlashItem({
        title: "My template", icon: "📝", aliases: ["tpl"],
        markdown: "## Heading\n\n- [ ] item",   // or a function returning a string
        // run(editor) { ... }                    // or custom code
    });

    // A home-screen shortcut button. Users enable it in Settings > Home > Widgets.
    selah.registerShortcut({
        id: "my-shortcut", label: "Open Timer", icon: "⏱️",
        onClick() { console.log("Shortcut clicked!"); },
    });

    // A fully custom home screen (replaces greeting, search, shortcuts).
    // The Psalm 19:14 verse is always pinned below it.
    selah.registerHomeScreen({
        id: "my-custom-home", label: "Sveltab Layout",
        render(container, ctx) {
            container.innerHTML = "<div style='color:white; padding:20px;'>My custom React/DOM grid!</div>";
        }
    });

    // Persistent per-plugin settings (stored in <plugin>/data/settings.json).
    selah.settings.set("theme", "dark");
    const theme = selah.settings.get("theme", "light");

    // Register a callback to run when the plugin reloads or is disabled.
    // Any setInterval / setTimeout created through selah.setInterval /
    // selah.setTimeout is cleaned up automatically — use those instead of
    // the raw globals to avoid leaking timers.
    selah.onUnload(() => { /* teardown */ });

    // 🚀 Advanced: Rendering the actual Selah Rich Text Editor!
    // Require React from the API (passed as the 2nd arg to index.js)
    render(container, ctx, React, ReactDOM) {
        const root = ReactDOM.createRoot(container);
        root.render(React.createElement(selah.Editor, {
            path: ctx.dir + "/my-note.selah",
            vaultPath: ctx.vaultPath
        }));
    }

    // 📂 Advanced File APIs
    await ctx.fs.readFile("image.png") -> Uint8Array
    await ctx.fs.writeFile("audio.mp3", bytes)
    await ctx.fs.copyFile("a.png", "b.png")

    // 📝 Pick a note from the vault
    const notePath = await selah.pickNote();

    Extras
    selah.fs          private storage in <plugin>/data/
    selah.vaultPath   the open vault
    Top-level await works in index.js.`;

    function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
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
            style={{ width: 12, height: 12, top: 2, left: on ? 14 : 2, transition: "left 150ms ease" }}
            />
            </button>
        );
    }

    export default function PluginsPanel({ vaultPath }: { vaultPath: string }) {
        const { plugins, ready } = usePlugins();
        const pluginsEnabled = usePluginFeature();
        const [busy, setBusy] = useState(false);
        const { modal, confirmAsync } = useModal();
        const [activeMenu, setActiveMenu] = useState<string | null>(null);
        const [configuring, setConfiguring] = useState<any | null>(null);
        const configHostRef = useRef<HTMLDivElement>(null);

        // New state for folder opening errors
        const [openError, setOpenError] = useState<string | null>(null);
        const [copied, setCopied] = useState(false);

        useEffect(() => {
            if (!activeMenu) return;
            const close = () => setActiveMenu(null);
            document.addEventListener("click", close);
            return () => document.removeEventListener("click", close);
        }, [activeMenu]);

        useEffect(() => {
            if (!configuring || !configHostRef.current) return;
            const el = configHostRef.current;
            el.innerHTML = "";
            let disposed = false;
            let cleanup: (() => void) | undefined;

            Promise.resolve()
                .then(() => configuring.configure!(el))
                .then((r) => {
                    if (typeof r !== "function") return;
                    if (disposed) { try { r(); } catch {} } else cleanup = r;
                })
                .catch((e) => console.error("[plugins] config render failed:", e));

            return () => {
                disposed = true;
                try { cleanup?.(); } catch {}
                el.innerHTML = "";
            };
        }, [configuring]);

        const reload = async () => {
            setBusy(true);
            try { await loadPlugins(vaultPath); } finally { setBusy(false); }
        };

        const handleRemove = async (p: any) => {
            const ok = await confirmAsync(
                `Are you sure you want to completely remove "${p.manifest?.name || p.id}"?\n\nThis will permanently move the plugin's folder and all associated data to your system trash.`
            );
            if (!ok) return;
            setBusy(p.id);
            try {
                await removePlugin(vaultPath, p.id);
            } finally {
                setBusy(false);
            }
        };

        const openFolder = async () => {
            setOpenError(null);
            try {
                const dir = await pluginsDir(vaultPath);
                await mkdir(dir, { recursive: true });
                // revealItemInDir opens the parent folder and highlights the target.
                // This bypasses Tauri's restriction on opening hidden dotfolders directly.
                await revealItemInDir(dir);
            } catch (e: any) {
                console.warn("[plugins] reveal folder failed, opening vault root instead:", e);
                // Fallback: try to reveal the vault root if the hidden .plugins folder fails
                try {
                    await revealItemInDir(vaultPath);
                } catch (err) {
                    // If both fail, show the path so the user can copy it manually
                    setOpenError(await pluginsDir(vaultPath));
                }
            }
        };

        const copyPath = async () => {
            if (!openError) return;
            try {
                await navigator.clipboard.writeText(openError);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            } catch {}
        };

        if (!pluginsEnabled) {
            return (
                <div className="p-5 flex flex-col items-center justify-center text-center h-full min-h-[300px]">
                    <Puzzle size={32} className="text-gray-600 mb-4 opacity-50" />
                    <p className="text-sm text-gray-300 mb-2">Plugins are currently disabled.</p>
                    <p className="text-xs text-gray-500 max-w-xs leading-relaxed">
                        To protect your app, plugins are turned off by default. You can enable them by going to <strong>Settings → General</strong> and turning on "Enable plugins".
                    </p>
                </div>
            );
        }

        return (
            <>
            {modal}
            <div className="p-5 space-y-6">
            <div>
            <div className="flex flex-wrap items-center gap-2 mb-3">
            <button
            type="button"
            onClick={openFolder}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] hover:text-gray-100 hover:border-[#3a4147] active:scale-95 transition-all duration-150 border border-[#30363d] rounded text-gray-200 cursor-pointer"
            >
            <FolderOpen size={12} /> Open plugins folder
            </button>
            <button
            type="button"
            onClick={reload}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] hover:text-gray-100 hover:border-[#3a4147] active:scale-95 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 border border-[#30363d] rounded text-gray-200 cursor-pointer"
            >
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Reload plugins
            </button>
            </div>

            {/* Folder error fallback UI */}
            {openError && (
                <div className="flex items-center gap-2 mb-3 p-2 rounded border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-300">
                <AlertTriangle size={14} className="flex-shrink-0" />
                <span className="flex-1 break-all font-mono">{openError}</span>
                <button
                onClick={copyPath}
                className="flex items-center gap-1 px-2 py-1 bg-amber-500/20 hover:bg-amber-500/30 rounded border border-amber-500/40 transition-colors whitespace-nowrap"
                >
                {copied ? <Check size={11} /> : <Copy size={11} />}
                {copied ? "Copied" : "Copy Path"}
                </button>
                </div>
            )}
            </div>

            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-300">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            <span>
            Plugins are code that runs inside Selah and can read and write files in your vault.
            Only install plugins you trust.
            </span>
            </div>

            <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
            Installed plugins
            </div>
            {!ready ? (
                <p className="text-xs text-gray-500 italic">Loading…</p>
            ) : plugins.length === 0 ? (
                <p className="text-xs text-gray-500 italic">
                No plugins yet. Drop a plugin folder into the plugins folder, then press Reload.
                </p>
            ) : (
                <div className="space-y-1.5">
                {plugins.map((p) => (
                    <div key={p.dir} className="rounded-md border border-[#2a3136] bg-[#131819] px-3 py-2.5">
                    <div className="flex items-center gap-2">
                    <Puzzle size={13} className="text-blue-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-100 truncate">
                    {p.manifest?.name || p.id}
                    {p.manifest?.version && (
                        <span className="ml-2 text-[10px] text-gray-500 font-mono">v{p.manifest.version}</span>
                    )}
                    </div>
                    {p.manifest?.description && (
                        <div className="text-[10px] text-gray-500 truncate">{p.manifest.description}</div>
                    )}
                    </div>
                    <Toggle
                    on={p.enabled}
                    onClick={() => void setPluginEnabled(vaultPath, p.id, !p.enabled)}
                    />
                    <div className="relative flex-shrink-0 ml-1">
                        <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === p.id ? null : p.id); }}
                        className="p-1.5 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136] transition-colors"
                        >
                        <MoreVertical size={13} />
                        </button>
                        {activeMenu === p.id && (
                            <div className="absolute right-0 top-full mt-1 z-50 bg-[#1e2327] border border-[#2a3136] rounded-md shadow-2xl py-1 w-40">
                                {p.configure && (
                                    <button
                                    type="button"
                                    onClick={() => { setActiveMenu(null); setConfiguring(p); }}
                                    className="w-full text-left px-3 py-1.5 text-sm text-gray-200 hover:bg-[#2a3136] flex items-center gap-2"
                                    >
                                    <Settings size={13} /> Configure
                                    </button>
                                )}
                                <button
                                type="button"
                                onClick={() => { handleRemove(p); setActiveMenu(null); }}
                                className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2 border-t border-[#2a3136]"
                                >
                                <Trash2 size={13} /> Delete
                                </button>
                            </div>
                        )}
                    </div>
                    </div>
                    {p.manifest?.permissions && p.manifest.permissions.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                            {p.manifest.permissions.map((perm) => (
                                <span
                                    key={perm}
                                    className="text-[9px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0f1315] text-gray-500 font-mono"
                                    title={`Declared permission: ${perm}`}
                                >
                                    {perm}
                                </span>
                            ))}
                        </div>
                    )}
                    {p.error && (
                        <div className="mt-1.5 text-[10px] text-red-400 break-words">{p.error}</div>
                    )}
                    {p.enabled && !p.error && (p.categoryTypes.length > 0 || p.slashItems.length > 0) && (
                        <div className="mt-1.5 text-[10px] text-gray-500">
                        {p.categoryTypes.length > 0 &&
                            `Category types: ${p.categoryTypes.map((t) => t.label).join(", ")}`}
                            {p.categoryTypes.length > 0 && p.slashItems.length > 0 && " · "}
                            {p.slashItems.length > 0 &&
                                `Slash items: ${p.slashItems.map((s) => s.title).join(", ")}`}
                                </div>
                    )}
                    </div>
                ))}
                </div>
            )}
            </div>

            <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
            Making a plugin
            </div>
            <pre className="text-[10px] leading-relaxed text-gray-300 bg-[#0f1315] border border-[#2a3136] rounded-md p-3 overflow-x-auto whitespace-pre font-mono">
            {DOCS}
            </pre>
            </div>
            </div>
            </>
        );
    }
