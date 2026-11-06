// src/PluginsPanel.tsx
import { useState, useEffect, useRef } from "react";
import { Puzzle, FolderOpen, RefreshCw, AlertTriangle, Copy, Check, Trash2, MoreVertical, Settings, Store, Download } from "lucide-react";
import { mkdir, readDir, readTextFile, copyFile, exists } from "@tauri-apps/plugin-fs";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { usePlugins, loadPlugins, setPluginEnabled, pluginsDir, removePlugin } from "./plugins";
import { usePluginFeature } from "./pluginFeature";
import { useModal } from "./Modal";
import CommunityPlugins from "./CommunityPlugins";
import { REGISTRY_REPO } from "./communityPlugins";

const DOCS = String.raw`<vault>/.plugins/my-plugin/
manifest.json
index.js

manifest.json
{ "id": "my-plugin", "name": "My Plugin", "version": "1.0.0",
    "description": "What it does", "author": "You", "icon": "✨" }

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
        const [showCommunityModal, setShowCommunityModal] = useState(false);

        // New state for folder opening errors
        const [openError, setOpenError] = useState<string | null>(null);
        const [copied, setCopied] = useState(false);

        // Intercept Escape key to close only the Community modal
        useEffect(() => {
            if (!showCommunityModal) return;
            const handleEscape = (e: KeyboardEvent) => {
                if (e.key === "Escape") {
                    e.stopPropagation();
                    e.preventDefault();
                    setShowCommunityModal(false);
                }
            };
            // Use capture phase to intercept the event before Settings modal sees it
            window.addEventListener("keydown", handleEscape, true);
            return () => window.removeEventListener("keydown", handleEscape, true);
        }, [showCommunityModal]);

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

        const importPlugin = async () => {
            setBusy(true);
            try {
                const selected = await open({ directory: true, multiple: false });
                if (!selected || typeof selected !== "string") return;

                const manifestPath = await join(selected, "manifest.json");
                if (!(await exists(manifestPath))) {
                    alert("The selected folder does not contain a manifest.json file.");
                    return;
                }

                const manifestRaw = await readTextFile(manifestPath);
                const manifest = JSON.parse(manifestRaw);
                const id = manifest.id;

                if (!id) {
                    alert("Invalid manifest.json: missing 'id'.");
                    return;
                }

                const pluginsRoot = await pluginsDir(vaultPath);
                const destDir = await join(pluginsRoot, id);

                if (await exists(destDir)) {
                    const overwrite = await confirmAsync(`A plugin with the id "${id}" already exists. Overwrite it?`);
                    if (!overwrite) return;
                    await removePlugin(vaultPath, id);
                }

                await mkdir(destDir, { recursive: true });

                // Recursively copy files (skipping data folders so we don't overwrite settings)
                const copyDir = async (src: string, dest: string) => {
                    await mkdir(dest, { recursive: true });
                    const entries = await readDir(src);
                    for (const entry of entries) {
                        if (entry.name.startsWith(".") || entry.name === "data") continue;
                        const srcPath = await join(src, entry.name);
                        const destPath = await join(dest, entry.name);
                        if (entry.isDirectory) {
                            await copyDir(srcPath, destPath);
                        } else {
                            await copyFile(srcPath, destPath);
                        }
                    }
                };

                await copyDir(selected, destDir);
                await loadPlugins(vaultPath);
                alert(`Successfully imported plugin: ${manifest.name || id}`);
            } catch (e: any) {
                console.error(e);
                alert("Failed to import plugin: " + String(e));
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
            onClick={importPlugin}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white active:scale-95 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 rounded cursor-pointer font-medium"
            >
            <Download size={12} /> Import Plugin
            </button>
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

            {/* Community Plugins Button */}
            <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
            Community
            </div>
            <button
            type="button"
            onClick={() => setShowCommunityModal(true)}
            className="w-full flex items-center justify-between px-4 py-3 bg-[#131819] hover:bg-[#1a2024] border border-[#2a3136] rounded-md transition-colors cursor-pointer text-left"
            >
            <div>
            <div className="text-sm text-gray-100 font-medium">Browse Community Plugins</div>
            <div className="text-[11px] text-gray-500">Discover and install plugins reviewed by the maintainer.</div>
            </div>
            <Store size={16} className="text-gray-400" />
            </button>
            </div>

            {/* Installed Plugins */}
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
                {plugins.map((p) => {
                    const isMaintainer = p.manifest?.author?.toLowerCase() === REGISTRY_REPO.split('/')[0].toLowerCase();

                    return (
                        <div key={p.dir} className="rounded-md border border-[#2a3136] bg-[#131819] px-3 py-2.5">
                        <div className="flex items-center gap-2">
                        <span className="text-base leading-none w-6 text-center flex-shrink-0">{p.manifest?.icon || "🧩"}</span>
                        <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-100 flex items-center gap-2 truncate">
                        <span className="truncate">{p.manifest?.name || p.id}</span>
                        {isMaintainer && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border bg-blue-500/20 text-blue-300 border-blue-500/30">
                            Official
                            </span>
                        )}
                        {p.manifest?.version && (
                            <span className="text-[10px] text-gray-500 font-mono">v{p.manifest.version}</span>
                        )}
                        </div>
                        <div className="text-[10px] text-gray-500 truncate flex items-center gap-2">
                        {p.manifest?.description}
                        {p.manifest?.author && <span className="opacity-60">by {p.manifest.author}</span>}
                        </div>
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
                    )})}
                    </div>
            )}
            </div>

            <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
            Developer Resources
            </div>
            <button
                type="button"
                onClick={async () => {
                    const url = `https://github.com/${REGISTRY_REPO}/wiki/API-Reference`;
                    try {
                        await openUrl(url);
                    } catch (err) {
                        console.error("Failed to open URL with native API:", err);
                        window.open(url, "_blank");
                    }
                }}
                className="w-full flex items-center justify-between px-4 py-3 bg-[#131819] hover:bg-[#1a2024] border border-[#2a3136] rounded-md transition-colors cursor-pointer text-left"
            >
                <div>
                    <div className="text-sm text-gray-100 font-medium">Documentation & API Guide</div>
                    <div className="text-[11px] text-gray-500">Learn how to build and submit your own plugins.</div>
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
            </button>
            </div>
            </div>

            {/* Plugin Configuration Modal */}
            {configuring && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-[#0f1315] border border-[#2a3136] rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden">
                        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a3136] bg-[#131819]">
                            <h2 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
                                <Settings size={16} className="text-blue-400" />
                                Configure {configuring.manifest?.name || configuring.id}
                            </h2>
                            <button onClick={() => setConfiguring(null)} className="text-gray-500 hover:text-gray-200 p-1 rounded-md hover:bg-[#2a3136]">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        </div>
                        <div className="p-5 overflow-y-auto max-h-[60vh]">
                            <div ref={configHostRef} />
                        </div>
                        <div className="p-4 border-t border-[#2a3136] bg-[#131819] flex justify-end">
                            <button onClick={() => setConfiguring(null)} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-sm font-semibold">
                                Done
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Community Plugins Modal */}
            {showCommunityModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 bg-black/60 backdrop-blur-sm">
                <div
                className="bg-[#0f1315] border border-[#2a3136] rounded-xl shadow-2xl w-full max-w-2xl h-[80vh] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
                >
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a3136] bg-[#131819] flex-shrink-0">
                <h2 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
                <Store size={16} className="text-blue-400" />
                Community Plugins
                </h2>
                <button
                onClick={() => setShowCommunityModal(false)}
                className="text-gray-500 hover:text-gray-200 p-1 rounded-md hover:bg-[#2a3136] transition-colors"
                >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
                </div>
                <div className="flex-1 overflow-hidden p-5 bg-[#0f1315]">
                <CommunityPlugins vaultPath={vaultPath} />
                </div>
                </div>
                </div>
            )}
            </>
        );
    }
