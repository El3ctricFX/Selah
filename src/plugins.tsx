// src/plugins.tsx
import React, { useEffect, useState } from "react";
import * as ReactDOM from "react-dom/client";
import { readDir, readTextFile, mkdir, exists, readFile, writeFile, copyFile } from "@tauri-apps/plugin-fs";
import { open, save } from "@tauri-apps/plugin-dialog";
import NoteBody from "./NoteBody";
import { join } from "@tauri-apps/api/path";
import { writeFileAtomic } from "./safeWrite";
import { moveToTrash } from "./trash";
import { pluginFeatureEnabled } from "./pluginFeature";

export interface PluginManifest {
    id: string;
    name: string;
    version?: string;
    description?: string;
    author?: string;
    /** Advisory only — shown on the plugin card. The sandbox does not
     *  actually enforce these because `new Function` gives plugins the
     *  whole window; declaring them is a warning to the user, not a gate. */
    permissions?: string[];
}

/** File access limited to one folder. ".." is rejected. */
export interface PluginFs {
    readText(rel: string): Promise<string | null>;
    writeText(rel: string, content: string): Promise<void>;
    readFile(rel: string): Promise<Uint8Array | null>;
    writeFile(rel: string, content: Uint8Array): Promise<void>;
    copyFile(srcRel: string, destRel: string): Promise<void>;
    exists(rel: string): Promise<boolean>;
    list(rel?: string): Promise<string[]>;
    mkdir(rel: string): Promise<void>;
    remove(rel: string): Promise<void>; // moves to system trash
    saveDialog(options?: any): Promise<string | null>;
}

export interface PluginEditorProps {
    path: string;
    vaultPath: string;
}

export interface PluginViewContext {
    vaultPath: string;
    /** Absolute path of this category's folder. */
    dir: string;
    name: string;
    icon: string;
    /** Sandboxed to this category's folder. */
    fs: PluginFs;
    /** An empty container in Selah's sidebar that the plugin can render into. */
    sidebarContainer?: HTMLElement;
    /** Helper strings for consistent styling */
    theme: {
        bg: string;
        surface: string;
        border: string;
        text: string;
        accent: string;
    };
}

export interface PluginShortcutActionDef {
    id: string;
    label: string;
    icon?: string;
    /** Function to run when the home screen shortcut is clicked. */
    run: () => void | Promise<void>;
}

export interface PluginCategoryTypeDef {
    id: string;
    label: string;
    icon?: string;
    description?: string;
    /** Custom actions that appear in the "Add Shortcut" menu for this plugin. */
    shortcutActions?: PluginShortcutActionDef[];
    /**
     * "default" = shows Selah's sidebar tree next to the plugin.
     * "full"    = currently behaves the same as "default" (sidebar is never hidden).
     */
    layout?: "default" | "full";
    /** Draw into `container`. May return (or resolve to) a cleanup function. */
    render: (
        container: HTMLElement,
        ctx: PluginViewContext
    ) => void | (() => void) | Promise<void | (() => void)>;
}

export interface PluginSlashItemDef {
    title: string;
    subtext?: string;
    icon?: string;
    aliases?: string[];
    /** Markdown inserted into the note (string or function returning one). */
    markdown?: string | (() => string);
    /** Or run custom code with the BlockNote editor. */
    run?: (editor: any) => void;
}

export interface PluginShortcutDef {
    id: string;
    label: string;
    icon?: string;
    onClick: () => void;
}

export interface PluginHomeScreenDef {
    id: string;
    label: string;
    description?: string;
    render: (
        container: HTMLElement,
        ctx: { vaultPath: string }
    ) => void | (() => void) | Promise<void | (() => void)>;
}

export interface RegisteredPluginShortcut extends PluginShortcutDef {
    pluginId: string;
    key: string;
}

export interface RegisteredPluginHomeScreen extends PluginHomeScreenDef {
    pluginId: string;
    key: string;
}

export type HomeWidgetSlot =
    | "header"
    | "above-shortcuts"
    | "below-shortcuts"
    | "above-verse";

export interface PluginHomeWidgetContext {
    vaultPath: string;
    /** Private storage for this plugin: <plugin>/data/ */
    fs: PluginFs;
    name: string;
    slot: HomeWidgetSlot;
    theme: {
        bg: string;
        surface: string;
        border: string;
        text: string;
        accent: string;
    };
}

export interface PluginHomeWidgetDef {
    id: string;
    label: string;
    description?: string;
    icon?: string;
    /** Default: "below-shortcuts" */
    slot?: HomeWidgetSlot;
    /** Draw into `container`. May return (or resolve to) a cleanup fn. */
    render: (
        container: HTMLElement,
        ctx: PluginHomeWidgetContext
    ) => void | (() => void) | Promise<void | (() => void)>;
}

export interface RegisteredHomeWidget extends PluginHomeWidgetDef {
    pluginId: string;
    /** "<pluginId>:<widgetId>" — this is what HomeSettings stores. */
    key: string;
    slot: HomeWidgetSlot;
    fs: PluginFs;
}

export interface RegisteredCategoryType extends PluginCategoryTypeDef {
    pluginId: string;
    /** Stored as the category's `mode`: "plugin:<pluginId>:<typeId>" */
    mode: string;
}

export interface PluginRecord {
    id: string;
    dir: string;
    manifest: PluginManifest | null;
    enabled: boolean;
    error?: string;
    categoryTypes: RegisteredCategoryType[];
    slashItems: PluginSlashItemDef[];
    homeWidgets: RegisteredHomeWidget[];
    shortcuts: RegisteredPluginShortcut[];
    homeScreens: RegisteredPluginHomeScreen[];
    /** Callbacks registered via `selah.onUnload(cb)`, run on reload/disable. */
    cleanups: (() => void)[];
    /** In-memory cache of <plugin>/data/settings.json. */
    settingsCache: Record<string, unknown> | null;
    configure?: (container: HTMLElement) => void | (() => void);
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

let records: PluginRecord[] = [];
let ready = false;
let loadSeq = 0;
const emit = () => window.dispatchEvent(new Event("plugins-changed"));

export async function pluginsDir(vaultPath: string): Promise<string> {
    return await join(vaultPath, ".plugins");
}

export function scopedFs(root: string): PluginFs {
    const parts = (rel: string) => {
        const p = (rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
        if (p.some((s) => s === "..")) throw new Error("Path escapes the allowed folder");
        return p;
    };
    const abs = async (rel: string) => {
        const p = parts(rel);
        return p.length ? await join(root, ...p) : root;
    };
    return {
        async readText(rel) {
            try { return await readTextFile(await abs(rel)); } catch { return null; }
        },
        async writeText(rel, content) {
            const p = parts(rel);
            if (p.length === 0) throw new Error("A file path is required");
            if (!(await exists(root))) return;
            const parent = p.length > 1 ? await join(root, ...p.slice(0, -1)) : root;
            await mkdir(parent, { recursive: true });
            await writeFileAtomic(await join(root, ...p), content);
        },
        async readFile(rel) {
            try { return await readFile(await abs(rel)); } catch { return null; }
        },
        async writeFile(rel, content) {
            const p = parts(rel);
            if (p.length === 0) throw new Error("A file path is required");
            if (!(await exists(root))) return;
            const parent = p.length > 1 ? await join(root, ...p.slice(0, -1)) : root;
            await mkdir(parent, { recursive: true });
            await writeFile(await join(root, ...p), content);
        },
        async copyFile(srcRel, destRel) {
            const srcP = parts(srcRel);
            const destP = parts(destRel);
            if (srcP.length === 0 || destP.length === 0) throw new Error("A file path is required");
            const destParent = destP.length > 1 ? await join(root, ...destP.slice(0, -1)) : root;
            await mkdir(destParent, { recursive: true });
            await copyFile(await join(root, ...srcP), await join(root, ...destP));
        },
        async exists(rel) {
            try { return await exists(await abs(rel)); } catch { return false; }
        },
        async list(rel = "") {
            try {
                const es = await readDir(await abs(rel));
                return es.map((e) => e.name).filter(Boolean) as string[];
            } catch { return []; }
        },
        async mkdir(rel) {
            await mkdir(await abs(rel), { recursive: true });
        },
        async remove(rel) {
            await moveToTrash(await abs(rel));
        },
        saveDialog: (options?: any) => save(options),
    };
}

async function readPluginSettings(dir: string): Promise<Record<string, unknown>> {
    try {
        const raw = await readTextFile(await join(dir, "data", "settings.json"));
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

async function writePluginSettings(dir: string, next: Record<string, unknown>): Promise<void> {
    const dataDir = await join(dir, "data");
    try { await mkdir(dataDir, { recursive: true }); } catch {}
    await writeFileAtomic(
        await join(dataDir, "settings.json"),
        JSON.stringify(next, null, 2)
    );
}

async function runPlugin(vaultPath: string, rec: PluginRecord) {
    try {
        const code = await readTextFile(await join(rec.dir, "index.js"));
        const dataDir = await join(rec.dir, "data");
        // Claude bug fix: the data folder never existed on a fresh plugin,
        // so scopedFs.writeText silently bailed on the first write.
        try { await mkdir(dataDir, { recursive: true }); } catch {}

        // Load persisted settings once, cache on the record.
        if (rec.settingsCache === null) {
            rec.settingsCache = await readPluginSettings(rec.dir);
        }

        let settingsDirty: Record<string, unknown> | null = null;
        let settingsTimer: ReturnType<typeof setTimeout> | null = null;
        const flushSettings = () => {
            if (!settingsDirty) return;
            const toWrite = settingsDirty;
            settingsDirty = null;
            void writePluginSettings(rec.dir, toWrite).catch((e: unknown) =>
                console.warn(`[plugins] ${rec.id} settings write failed:`, e));
        };

        const api = {
            apiVersion: 1,
            vaultPath,
            manifest: rec.manifest,
            /** Private storage for the plugin: <plugin>/data/ */
            fs: scopedFs(dataDir),

            /** The actual Selah Rich Text Editor component. */
            Editor: (props: PluginEditorProps) => {
                // NoteBody relies on the global useNoteMode context provided by App.tsx.
                return React.createElement(NoteBody, { path: props.path, vaultPath: props.vaultPath });
            },

            /** Opens the native file picker to select a note. */
            pickNote: async (): Promise<string | null> => {
                const picked = await open({
                    multiple: false,
                    filters: [{ name: "Selah Note", extensions: ["selah"] }],
                });
                return typeof picked === "string" ? picked : null;
            },

            /** Register a cleanup that runs on plugin reload / disable. */
            onUnload(cb: () => void) {
                if (typeof cb === "function") rec.cleanups.push(cb);
            },

            /** Auto-cleaned timer helpers. Use these instead of raw setInterval. */
            setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
                const id = setInterval(fn, ms);
                rec.cleanups.push(() => clearInterval(id));
                return id;
            },
            setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
                const id = setTimeout(fn, ms);
                rec.cleanups.push(() => clearTimeout(id));
                return id;
            },

            /** Persistent key/value settings, stored in <plugin>/data/settings.json. */
            settings: {
                get<T = unknown>(key: string, fallback?: T): T | undefined {
                    const cache = rec.settingsCache || {};
                    return (key in cache ? (cache[key] as T) : fallback);
                },
                set(key: string, value: unknown): void {
                    const next = { ...(rec.settingsCache || {}), [key]: value };
                    rec.settingsCache = next;
                    settingsDirty = next;
                    if (settingsTimer) clearTimeout(settingsTimer);
                    settingsTimer = setTimeout(flushSettings, 250);
                },
            },

            registerCategoryType(def: PluginCategoryTypeDef) {
                if (!def || !ID_RE.test(def.id || "")) throw new Error("registerCategoryType: id must be letters, numbers, - or _");
                if (!def.label) throw new Error("registerCategoryType: label is required");
                if (typeof def.render !== "function") throw new Error("registerCategoryType: render(container, ctx) is required");
                if (def.shortcutActions) {
                    if (!Array.isArray(def.shortcutActions)) throw new Error("registerCategoryType: shortcutActions must be an array");
                    for (const act of def.shortcutActions) {
                        if (!ID_RE.test(act.id || "")) throw new Error("registerCategoryType: shortcutAction id must be letters, numbers, - or _");
                        if (!act.label) throw new Error("registerCategoryType: shortcutAction label is required");
                        if (typeof act.run !== "function") throw new Error("registerCategoryType: shortcutAction run() is required");
                    }
                }
                rec.categoryTypes.push({ ...def, pluginId: rec.id, mode: `plugin:${rec.id}:${def.id}` });
            },

            registerSlashItem(def: PluginSlashItemDef) {
                if (!def || !def.title) throw new Error("registerSlashItem: title is required");
                if (!def.markdown && typeof def.run !== "function") throw new Error("registerSlashItem: provide markdown or run()");
                rec.slashItems.push(def);
            },

            registerHomeWidget(def: PluginHomeWidgetDef) {
                if (!def || !ID_RE.test(def.id || "")) throw new Error("registerHomeWidget: id must be letters, numbers, - or _");
                if (!def.label) throw new Error("registerHomeWidget: label is required");
                if (typeof def.render !== "function") throw new Error("registerHomeWidget: render(container, ctx) is required");
                const slots: HomeWidgetSlot[] = ["header", "above-shortcuts", "below-shortcuts", "above-verse"];
                const slot = (slots.includes(def.slot as HomeWidgetSlot) ? def.slot : "below-shortcuts") as HomeWidgetSlot;
                rec.homeWidgets.push({
                    ...def,
                    slot,
                    pluginId: rec.id,
                    key: `${rec.id}:${def.id}`,
                    fs: scopedFs(dataDir),
                });
            },

            registerShortcut(def: PluginShortcutDef) {
                if (!def || !ID_RE.test(def.id || "")) throw new Error("registerShortcut: id must be letters, numbers, - or _");
                if (!def.label) throw new Error("registerShortcut: label is required");
                if (typeof def.onClick !== "function") throw new Error("registerShortcut: onClick is required");
                rec.shortcuts.push({
                    ...def,
                    pluginId: rec.id,
                    key: `${rec.id}:${def.id}`,
                });
            },

            registerHomeScreen(def: PluginHomeScreenDef) {
                if (!def || !ID_RE.test(def.id || "")) throw new Error("registerHomeScreen: id must be letters, numbers, - or _");
                if (!def.label) throw new Error("registerHomeScreen: label is required");
                if (typeof def.render !== "function") throw new Error("registerHomeScreen: render(container, ctx) is required");
                rec.homeScreens.push({
                    ...def,
                    pluginId: rec.id,
                    key: `${rec.id}:${def.id}`,
                });
            },

            registerConfiguration(cb: (container: HTMLElement) => void | (() => void)) {
                if (typeof cb === "function") rec.configure = cb;
            },
        };

        // Track a flush of pending settings so reload/disable writes them.
        rec.cleanups.push(flushSettings);

        const fn = new Function("selah", "React", "ReactDOM", `"use strict"; return (async () => {\n${code}\n})();`);
        await fn(api, React, ReactDOM);
    } catch (e: any) {
        rec.error = e?.message ?? String(e);
        rec.categoryTypes = [];
        rec.slashItems = [];
        rec.homeWidgets = [];
        console.error(`[plugins] ${rec.id} failed:`, e);
    }
}

async function runCleanups(list: PluginRecord[]): Promise<void> {
    for (const rec of list) {
        for (const cb of rec.cleanups) {
            try { cb(); } catch (e) { console.warn(`[plugins] ${rec.id} cleanup failed:`, e); }
        }
        rec.cleanups = [];
    }
}

export async function loadPlugins(vaultPath: string): Promise<void> {
    if (!pluginFeatureEnabled()) {
        clearPlugins();
        return;
    }
    const seq = ++loadSeq;

    // Claude bug fix: run cleanups on the previous load so setInterval /
    // event listeners don't leak across reloads.
    await runCleanups(records);

    let disabled: string[] = [];
    try {
        const meta = JSON.parse(await readTextFile(await join(vaultPath, ".vault_metadata.json")));
        if (Array.isArray(meta?.plugins?.disabled)) {
            disabled = meta.plugins.disabled.filter((x: any) => typeof x === "string");
        }
    } catch {}

    const root = await pluginsDir(vaultPath);
    let entries: any[] = [];
    try { entries = await readDir(root); } catch {}

    const next: PluginRecord[] = [];
    const seenIds = new Set<string>();
    for (const e of entries) {
        if (!e.isDirectory || !e.name || e.name.startsWith(".")) continue;
        const dir = await join(root, e.name);
        const rec: PluginRecord = {
            id: e.name, dir, manifest: null, enabled: true,
            categoryTypes: [], slashItems: [], homeWidgets: [],
            shortcuts: [], homeScreens: [],
            cleanups: [], settingsCache: null,
        };
        try {
            const m = JSON.parse(await readTextFile(await join(dir, "manifest.json")));

            // Claude fix: validate apiVersion.
            if (m.apiVersion !== undefined && m.apiVersion !== 1) {
                throw new Error(`manifest apiVersion ${m.apiVersion} is not supported (expected 1)`);
            }

            const id = String(m.id || e.name);
            if (!ID_RE.test(id)) throw new Error("manifest id must be letters, numbers, - or _");
            rec.id = id;
            rec.manifest = {
                id,
                name: String(m.name || id),
                version: m.version ? String(m.version) : undefined,
                description: m.description ? String(m.description) : undefined,
                author: m.author ? String(m.author) : undefined,
                permissions: Array.isArray(m.permissions)
                    ? m.permissions.filter((p: any) => typeof p === "string")
                    : undefined,
            };
        } catch (err: any) {
            rec.error = err?.message?.startsWith("manifest id") || err?.message?.startsWith("manifest apiVersion")
                ? err.message
                : "Missing or invalid manifest.json";
        }

        // Claude fix: reject duplicates silently (first one wins).
        if (!rec.error && seenIds.has(rec.id)) {
            rec.error = `Duplicate manifest id "${rec.id}" — a plugin with this id is already loaded.`;
        } else if (!rec.error) {
            seenIds.add(rec.id);
        }

        rec.enabled = !disabled.includes(rec.id);
        if (rec.enabled && !rec.error) await runPlugin(vaultPath, rec);
        next.push(rec);
    }

    if (seq !== loadSeq) return;
    records = next;
    ready = true;
    emit();
}

export function clearPlugins() {
    loadSeq++;
    void runCleanups(records);
    records = [];
    ready = false;
    emit();
}

export async function setPluginEnabled(vaultPath: string, id: string, enabled: boolean) {
    const path = await join(vaultPath, ".vault_metadata.json");
    let meta: any = {};
    try { meta = JSON.parse(await readTextFile(path)); } catch {}
    const set = new Set<string>(Array.isArray(meta?.plugins?.disabled) ? meta.plugins.disabled : []);
    if (enabled) set.delete(id); else set.add(id);
    meta.plugins = { ...(meta.plugins || {}), disabled: Array.from(set) };
    await writeFileAtomic(path, JSON.stringify(meta, null, 2));
    await loadPlugins(vaultPath);
}

export async function removePlugin(vaultPath: string, id: string) {
    const rec = records.find((r) => r.id === id);
    if (!rec) return;
    try {
        await moveToTrash(rec.dir);
    } catch (e) {
        console.error(`[plugins] failed to move plugin folder to trash: ${rec.dir}`, e);
    }
    await loadPlugins(vaultPath);
}

export function getCategoryTypes(): RegisteredCategoryType[] {
    return records.filter((r) => r.enabled && !r.error).flatMap((r) => r.categoryTypes);
}

export function getHomeWidgets(): RegisteredHomeWidget[] {
    return records.filter((r) => r.enabled && !r.error).flatMap((r) => r.homeWidgets);
}

export function getPluginShortcuts(): RegisteredPluginShortcut[] {
    return records.filter((r) => r.enabled && !r.error).flatMap((r) => r.shortcuts);
}

export function getPluginHomeScreens(): RegisteredPluginHomeScreen[] {
    return records.filter((r) => r.enabled && !r.error).flatMap((r) => r.homeScreens);
}

export function pluginTypeFor(mode: string): RegisteredCategoryType | undefined {
    return getCategoryTypes().find((t) => t.mode === mode);
}

export function usePlugins() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const fn = () => setTick((n) => n + 1);
        window.addEventListener("plugins-changed", fn);
        return () => window.removeEventListener("plugins-changed", fn);
    }, []);
    return {
        plugins: records,
        ready,
        categoryTypes: getCategoryTypes(),
        homeWidgets: getHomeWidgets(),
        shortcuts: getPluginShortcuts(),
        homeScreens: getPluginHomeScreens(),
    };
}

/** Slash-menu entries contributed by plugins. */
export function getPluginSlashItems(
    editor: any,
    insert: (blocks: any[], refId?: string | null) => any[]
): any[] {
    const out: any[] = [];
    for (const rec of records) {
        if (!rec.enabled || rec.error) continue;
        for (const item of rec.slashItems) {
            out.push({
                title: item.title,
                subtext: item.subtext,
                aliases: item.aliases ?? [],
                group: "Plugins",
                icon: <span className="text-base">{item.icon || "🧩"}</span>,
                onItemClick: async () => {
                    let refId: string | null = null;
                    try { refId = editor.getTextCursorPosition?.().block?.id ?? null; } catch {}
                    try {
                        if (item.markdown) {
                            const md = typeof item.markdown === "function" ? item.markdown() : item.markdown;
                            const blocks = await editor.tryParseMarkdownToBlocks(md);
                            if (blocks?.length) insert(blocks, refId);
                        }
                        item.run?.(editor);
                    } catch (e) {
                        console.error("[plugins] slash item failed:", item.title, e);
                    }
                },
            });
        }
    }
    return out;
}
