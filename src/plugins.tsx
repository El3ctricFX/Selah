// src/plugins.tsx
import React, { useEffect, useState } from "react";
import * as ReactDOM from "react-dom/client";
import { readDir, readTextFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";
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
}

/** File access limited to one folder. ".." is rejected. */
export interface PluginFs {
    readText(rel: string): Promise<string | null>;
    writeText(rel: string, content: string): Promise<void>;
    exists(rel: string): Promise<boolean>;
    list(rel?: string): Promise<string[]>;
    mkdir(rel: string): Promise<void>;
    remove(rel: string): Promise<void>; // moves to system trash
    saveDialog(options?: any): Promise<string | null>;
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

export interface PluginCategoryTypeDef {
    id: string;
    label: string;
    icon?: string;
    description?: string;
    /**
     * "default" = shows Selah's sidebar tree next to the plugin.
     * "full"    = hides Selah's sidebar entirely and gives the plugin the whole window.
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
    configure?: () => void;
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

let records: PluginRecord[] = [];
let ready = false;
let loadSeq = 0;
const emit = () => window.dispatchEvent(new Event("plugins-changed"));

export async function pluginsDir(vaultPath: string): Promise<string> {
    return await join(vaultPath, ".plugins");
}

function scopedFs(root: string): PluginFs {
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
            // If the root folder was deleted (e.g. category removed), abort safely
            if (!(await exists(root))) return;
            const parent = p.length > 1 ? await join(root, ...p.slice(0, -1)) : root;
            await mkdir(parent, { recursive: true });
            await writeFileAtomic(await join(root, ...p), content);
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

async function runPlugin(vaultPath: string, rec: PluginRecord) {
    try {
        const code = await readTextFile(await join(rec.dir, "index.js"));
        const dataDir = await join(rec.dir, "data");
        const api = {
            apiVersion: 1,
            vaultPath,
            manifest: rec.manifest,
            /** Private storage for the plugin: <plugin>/data/ */
            fs: scopedFs(dataDir),
            registerCategoryType(def: PluginCategoryTypeDef) {
                if (!def || !ID_RE.test(def.id || "")) throw new Error("registerCategoryType: id must be letters, numbers, - or _");
                if (!def.label) throw new Error("registerCategoryType: label is required");
                if (typeof def.render !== "function") throw new Error("registerCategoryType: render(container, ctx) is required");
                rec.categoryTypes.push({ ...def, pluginId: rec.id, mode: `plugin:${rec.id}:${def.id}` });
            },
            registerSlashItem(def: PluginSlashItemDef) {
                if (!def || !def.title) throw new Error("registerSlashItem: title is required");
                if (!def.markdown && typeof def.run !== "function") throw new Error("registerSlashItem: provide markdown or run()");
                rec.slashItems.push(def);
            },
            registerConfiguration(cb: () => void) {
                if (typeof cb === "function") rec.configure = cb;
            },
        };
        // We pass React and ReactDOM into the execution context here!
        const fn = new Function("selah", "React", "ReactDOM", `"use strict"; return (async () => {\n${code}\n})();`);
        await fn(api, React, ReactDOM);
    } catch (e: any) {
        rec.error = e?.message ?? String(e);
        rec.categoryTypes = [];
        rec.slashItems = [];
        console.error(`[plugins] ${rec.id} failed:`, e);
    }
}

export async function loadPlugins(vaultPath: string): Promise<void> {
    if (!pluginFeatureEnabled()) {
        clearPlugins();
        return;
    }
    const seq = ++loadSeq;
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
    for (const e of entries) {
        if (!e.isDirectory || !e.name || e.name.startsWith(".")) continue;
        const dir = await join(root, e.name);
        const rec: PluginRecord = {
            id: e.name, dir, manifest: null, enabled: true, categoryTypes: [], slashItems: [],
        };
        try {
            const m = JSON.parse(await readTextFile(await join(dir, "manifest.json")));
            const id = String(m.id || e.name);
            if (!ID_RE.test(id)) throw new Error("manifest id must be letters, numbers, - or _");
            rec.id = id;
            rec.manifest = {
                id,
                name: String(m.name || id),
                version: m.version ? String(m.version) : undefined,
                description: m.description ? String(m.description) : undefined,
                author: m.author ? String(m.author) : undefined,
            };
        } catch (err: any) {
            rec.error = err?.message?.startsWith("manifest id")
            ? err.message
            : "Missing or invalid manifest.json";
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
    return { plugins: records, ready, categoryTypes: getCategoryTypes() };
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
