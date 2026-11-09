// src/notePorting.ts
import {
    readDir, readTextFile, readFile, writeFile, mkdir, exists, stat,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { zipSync, unzipSync, strToU8, strFromU8, type Zippable } from "fflate";
import { parseNoteFile, serializeNoteFile, type Frontmatter } from "./noteFormat";
import { writeFileAtomic } from "./safeWrite";
import { assetsDirForNote, saveFileToNoteAssets } from "./imageAssets";
import { getPluginBlockSpecs } from "./plugins";
import { flushAll } from "./flushRegistry";
import { fetchEnrichedMetadata } from "./linkMeta";

// ── tiny helpers ────────────────────────────────────────────────────────
const norm = (p: string) => p.replace(/\\/g, "/");
const baseOf = (p: string) => { const n = norm(p); return n.slice(n.lastIndexOf("/") + 1); };
const dirOf = (p: string) => { const n = norm(p); const i = n.lastIndexOf("/"); return i === -1 ? "" : n.slice(0, i); };
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const encSeg = (s: string) => s.replace(/ /g, "%20");
const escAttr = (s: string) =>
s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
const TEXT_RE = /\.(selah|md|json|txt|html?|css|js|svg|csv)$/i;

async function safeExists(p: string) { try { return await exists(p); } catch { return false; } }

function formatDateLabel(iso: string): string {
    if (!iso) return "";
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        const parts = [
            d.toLocaleDateString("en-US", { year: "numeric", month: "long",  day: "numeric" }),
            d.toLocaleDateString("en-GB", { year: "numeric", month: "long",  day: "numeric" }),
            d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
            d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }),
        ];
        // Strip commas so "October 17, 2026" and "oct 17 2026" both match
        return parts.join(" ").toLowerCase().replace(/[,\s]+/g, " ").trim();
    } catch { return ""; }
}

async function uniqueBase(dir: string, base: string, claimed: Set<string>): Promise<string> {
    let b = base;
    let i = 2;
    while (
        claimed.has(`${norm(dir)}/${b}`.toLowerCase()) ||
        (await safeExists(await join(dir, `${b}.selah`)))
    ) {
        b = `${base} (${i++})`;
    }
    claimed.add(`${norm(dir)}/${b}`.toLowerCase());
    return b;
}

// ── plugin block detection ──────────────────────────────────────────────
export function pluginTypesIn(body: string): string[] {
    const out = new Set<string>();
    const re = /<!--\s*selah-plugin:\s*(\{[\s\S]*?)\s*-->/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
            try {
                const t = JSON.parse(m[1])?.type;
                if (typeof t === "string" && t) out.add(t);
            } catch {}
        }
        return Array.from(out);
    }

    // ── listing notes ───────────────────────────────────────────────────────
    export interface VaultNote {
        path: string; base: string; title: string; icon: string; folder: string;
        created: string; modified: string; snippet: string; dateLabel: string;
    }

    export async function listVaultNotes(vaultPath: string): Promise<VaultNote[]> {
    const out: VaultNote[] = [];
    const root = norm(vaultPath).replace(/\/+$/, "");
    const walk = async (dir: string, depth: number) => {
        if (depth > 8) return;
        let entries: any[] = [];
        try { entries = await readDir(dir); } catch { return; }
        for (const e of entries) {
            if (!e.name || e.name.startsWith(".") || e.name === "assets" || e.name === "_attachments") continue;
            const full = await join(dir, e.name);
            if (e.isDirectory) { await walk(full, depth + 1); continue; }
            if (!e.name.endsWith(".selah")) continue;
            const base = e.name.replace(/\.selah$/, "");
            let title = "", icon = "", created = "", modified = "", snippet = "";
            try {
                const { frontmatter, body } = parseNoteFile(await readTextFile(full));
                title    = (frontmatter.title    as string) || "";
                icon     = (frontmatter.icon     as string) || "";
                created  = (frontmatter.date as string) || (frontmatter.created  as string) || "";
                modified = (frontmatter.modified as string) || "";
                snippet  = (body || "").replace(/\s+/g, " ").trim().slice(0, 500);
            } catch {}
            const n = norm(full);
            const rel = n.startsWith(root + "/") ? n.slice(root.length + 1) : n;
            const i = rel.lastIndexOf("/");
            const dateLabel = [formatDateLabel(created), formatDateLabel(modified)]
                .filter(Boolean).join(" ");
            out.push({
                path: full, base, title: title || base, icon,
                folder: i > 0 ? rel.slice(0, i) : "",
                created, modified, snippet, dateLabel,
            });
        }
    };
    await walk(vaultPath, 0);
    out.sort((a, b) => (a.folder + a.title).localeCompare(b.folder + b.title));
    return out;
}

    // ── EXPORT ──────────────────────────────────────────────────────────────
    export interface PackManifest {
        format: "selah-pack";
        version: 1;
        exportedAt: string;
        notes: { dir: string; file: string; title: string }[];
        pluginBlocks: string[];
    }

    export async function inspectForExport(paths: string[]) {
        await flushAll();
        const types = new Set<string>();
        const byNote: { title: string; types: string[] }[] = [];
        for (const p of paths) {
            try {
                const { frontmatter, body } = parseNoteFile(await readTextFile(p));
                const t = pluginTypesIn(body);
                t.forEach((x) => types.add(x));
                if (t.length) byNote.push({ title: (frontmatter.title as string) || baseOf(p).replace(/\.selah$/, ""), types: t });
            } catch {}
        }
        return { types: Array.from(types), byNote };
    }

    async function collectDir(abs: string, prefix: string, out: Zippable): Promise<number> {
        let n = 0;
        let entries: any[] = [];
        try { entries = await readDir(abs); } catch { return 0; }
        for (const e of entries) {
            if (!e.name) continue;
            const p = await join(abs, e.name);
            if (e.isDirectory) { n += await collectDir(p, `${prefix}/${e.name}`, out); continue; }
            try {
                const bytes = await readFile(p);
                out[`${prefix}/${e.name}`] = [bytes, { level: (TEXT_RE.test(e.name) ? 6 : 0) as 0 | 6 }];
                n++;
            } catch (err) { console.warn("[export] could not read", p, err); }
        }
        return n;
    }

    export async function exportPack(
        paths: string[], dest: string, onProgress?: (m: string) => void
    ): Promise<{ notes: number; files: number }> {
        await flushAll();
        const files: Zippable = {};
        const entries: PackManifest["notes"] = [];
        const types = new Set<string>();
        let count = 0;

        for (let i = 0; i < paths.length; i++) {
            const p = paths[i];
            const file = baseOf(p);
            const base = file.replace(/\.selah$/i, "");
            onProgress?.(`Packing "${base}" (${i + 1} of ${paths.length})…`);
            const text = await readTextFile(p);
            const parsed = parseNoteFile(text);
            pluginTypesIn(parsed.body).forEach((t) => types.add(t));
            files[`notes/${i}/${file}`] = [strToU8(text), { level: 6 }];
            count += await collectDir(await assetsDirForNote(p), `notes/${i}/assets/${base}`, files);
            entries.push({ dir: String(i), file, title: (parsed.frontmatter.title as string) || base });
        }

        const manifest: PackManifest = {
            format: "selah-pack", version: 1, exportedAt: new Date().toISOString(),
                notes: entries, pluginBlocks: Array.from(types),
        };
        files["selah-pack.json"] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];

        onProgress?.("Writing file…");
        await writeFile(dest, zipSync(files));
        return { notes: paths.length, files: count };
    }

    // ── IMPORT: .selahpack ──────────────────────────────────────────────────
    export interface LoadedPack {
        manifest: PackManifest;
        files: Record<string, Uint8Array>;
        missingPluginTypes: string[];
    }

    export async function loadPack(path: string): Promise<LoadedPack> {
        const raw = unzipSync(await readFile(path));
        const files: Record<string, Uint8Array> = {};
        for (const [k, v] of Object.entries(raw)) {
            const key = k.replace(/\\/g, "/");
            if (key.startsWith("/") || key.split("/").includes("..") || key.endsWith("/")) continue;
            files[key] = v;
        }
        const m = files["selah-pack.json"];
        if (!m) throw new Error("This isn't a Selah note pack (selah-pack.json is missing).");
        const manifest = JSON.parse(strFromU8(m)) as PackManifest;
        if (manifest?.format !== "selah-pack" || !Array.isArray(manifest.notes)) {
            throw new Error("Unrecognised pack format.");
        }
        manifest.notes = manifest.notes.filter(
            (n) =>
            /^\d+$/.test(n.dir) && typeof n.file === "string" &&
            !/[\\/]/.test(n.file) && /\.selah$/i.test(n.file) &&
            !!files[`notes/${n.dir}/${n.file}`]
        );
        const installed = new Set(Object.keys(getPluginBlockSpecs()));
        const missing = new Set<string>();
        for (const n of manifest.notes) {
            const body = parseNoteFile(strFromU8(files[`notes/${n.dir}/${n.file}`])).body;
            for (const t of pluginTypesIn(body)) if (!installed.has(t)) missing.add(t);
        }
        return { manifest, files, missingPluginTypes: Array.from(missing) };
    }

    function rewriteAssetBase(text: string, oldBase: string, newBase: string): string {
        const pairs: [string, string][] = [
            [oldBase, newBase],
            [oldBase.replace(/ /g, "%20"), newBase.replace(/ /g, "%20")],
            [encSeg(oldBase), encSeg(newBase)],
        ];
        const seen = new Set<string>();
        let out = text;
        for (const [from, to] of pairs) {
            if (seen.has(from)) continue;
            seen.add(from);
            out = out.split(`assets/${from}/`).join(`assets/${to}/`);
        }
        return out;
    }

    export async function importPack(
        pack: LoadedPack, destDir: string, onProgress?: (m: string) => void
    ): Promise<{ imported: string[] }> {
        await mkdir(destDir, { recursive: true });
        const claimed = new Set<string>();
        const imported: string[] = [];
        const list = pack.manifest.notes;

        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            const oldBase = e.file.replace(/\.selah$/i, "");
            onProgress?.(`Importing "${oldBase}" (${i + 1} of ${list.length})…`);
            const newBase = await uniqueBase(destDir, oldBase, claimed);
            let text = strFromU8(pack.files[`notes/${e.dir}/${e.file}`]);
            if (newBase !== oldBase) text = rewriteAssetBase(text, oldBase, newBase);

            const notePath = await join(destDir, `${newBase}.selah`);
            await writeFileAtomic(notePath, text);

            const prefix = `notes/${e.dir}/assets/${oldBase}/`;
            const assetsDir = await assetsDirForNote(notePath);
            for (const [k, v] of Object.entries(pack.files)) {
                if (!k.startsWith(prefix)) continue;
                const rel = k.slice(prefix.length).split("/");
                const parent = rel.length > 1 ? await join(assetsDir, ...rel.slice(0, -1)) : assetsDir;
                await mkdir(parent, { recursive: true });
                await writeFile(await join(assetsDir, ...rel), v);
            }
            imported.push(notePath);
        }
        window.dispatchEvent(new CustomEvent("folder-changed", { detail: { path: destDir } }));
        return { imported };
    }

    // ── IMPORT: Markdown (Notion / Obsidian / anything) ─────────────────────
    export interface PlannedRef {
        token: string;
        kind: "image" | "file";
        alt: string;
        name: string;            // file name shown to the user
        raw: string;             // path as written in the markdown (decoded)
        resolved: string | null; // absolute path on disk
        candidates: string[];    // best guesses when it couldn't be found
        decision: "auto" | "accepted" | "skipped" | "pending";
    }
    export interface PlannedNote {
        id: string;
        srcPath: string;
        base: string;
        dir: string;
        notePath: string;
        frontmatter: Frontmatter;
        body: string;
        refs: PlannedRef[];
        extractedDate?: string;
    }
    export interface ImportPlan { notes: PlannedNote[]; }

    const IMG_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|tiff?)$/i;
    const MD_RE = /\.(md|markdown)$/i;
    const FILE_EXT_RE =
    /\.(png|jpe?g|gif|webp|avif|bmp|svg|tiff?|pdf|mp3|wav|ogg|m4a|flac|mp4|webm|mov|mkv|zip|docx?|xlsx?|pptx?|txt|csv|html?)$/i;

    const stripHash = (s: string) => s.replace(/\s[0-9a-f]{32}$/i, "");
    const normName = (s: string) => {
        const last = safeDecode(s).replace(/\\/g, "/").split("/").pop() || "";
        return stripHash(last.replace(MD_RE, "").trim()).toLowerCase();
    };
    const cleanName = (s: string) =>
    stripHash(s.trim()).replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() || "Untitled";

    function mapOutsideCode(text: string, fn: (s: string) => string): string {
        return text.split(/(```[\s\S]*?```)/g).map((p, i) => (i % 2 === 1 ? p : fn(p))).join("");
    }

    function extractDateFromName(name: string, frontmatter: any): string {
        const tryParse = (str: string) => {
            if (!str) return "";
            const parsed = Date.parse(str);
            if (isNaN(parsed)) return "";
            const d = new Date(parsed);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        };

        let rawDate = "";
        if (typeof frontmatter.date === "string" && frontmatter.date) rawDate = frontmatter.date;
        else if (typeof frontmatter.created === "string" && frontmatter.created) rawDate = frontmatter.created;

        const d1 = tryParse(rawDate);
        if (d1) return d1;

        const cleanName = name.replace(/\.md$/i, "");
        const d2 = tryParse(cleanName);
        if (d2) return d2;

        const match = cleanName.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
        if (match) return `${match[1]}-${match[2]}-${match[3]}`;

        return ""; // Return empty on failure instead of defaulting to today's date
    }

    async function isFile(p: string): Promise<boolean> {
        try { return !!(await stat(p)).isFile; } catch { return false; }
    }

    async function buildIndex(root: string): Promise<Map<string, string[]>> {
        const idx = new Map<string, string[]>();
        const walk = async (dir: string, depth: number) => {
            if (depth > 10) return;
            let es: any[] = [];
            try { es = await readDir(dir); } catch { return; }
            for (const e of es) {
                if (!e.name || e.name.startsWith(".") || e.name === "node_modules") continue;
                const p = await join(dir, e.name);
                if (e.isDirectory) { await walk(p, depth + 1); continue; }
                const k = e.name.toLowerCase();
                const l = idx.get(k);
                if (l) l.push(p); else idx.set(k, [p]);
            }
        };
        await walk(root, 0);
        return idx;
    }

    export async function analyzeMarkdown(
        sources: { absPath: string; rootDir: string | null }[],
        destRoot: string,
        isJournal: boolean = false
    ): Promise<ImportPlan> {
        const indexes = new Map<string, Map<string, string[]>>();
        for (const s of sources) {
            if (s.rootDir && !indexes.has(s.rootDir)) indexes.set(s.rootDir, await buildIndex(s.rootDir));
        }

        // Pass 1: decide every note's final location + name, so links can point at them.
        const claimed = new Set<string>();
        const nameMap = new Map<string, string>();
        const prep: { src: typeof sources[number]; dir: string; base: string; notePath: string }[] = [];
        for (const src of sources) {
            const rawBase = baseOf(src.absPath).replace(MD_RE, "");

            // Read frontmatter early so we know the real date before creating folders
            let earlyFm: any = {};
            try {
                const txt = await readTextFile(src.absPath);
                earlyFm = parseNoteFile(txt).frontmatter;
            } catch {}

            let parts: string[] = [];
            if (src.rootDir) {
                const r = norm(src.rootDir).replace(/\/+$/, "");
                const d = dirOf(src.absPath);
                const rel = d.startsWith(r) ? d.slice(r.length).replace(/^\/+/, "") : "";
                parts = rel ? rel.split("/").map(cleanName) : [];
            }
            let dir = parts.length ? await join(destRoot, ...parts) : destRoot;

            // If it's a journal, calculate the Year/Month subfolder NOW
            // We force the directory to be destRoot/YYYY/MM and ignore the imported folder structure
            if (isJournal) {
                const dateStr = extractDateFromName(rawBase, earlyFm);
                if (dateStr && dateStr.includes("-")) {
                    const [y, m] = dateStr.split("-");
                    if (y && m) {
                        dir = await join(destRoot, y, m);
                    }
                }
            }

            const base = await uniqueBase(dir, cleanName(rawBase), claimed);
            const key = normName(rawBase);
            if (!nameMap.has(key)) nameMap.set(key, base);
            prep.push({ src, dir, base, notePath: await join(dir, `${base}.selah`) });
        }

        // Pass 2: convert each file.
        const notes: PlannedNote[] = [];
        for (let ni = 0; ni < prep.length; ni++) {
            const { src, dir, base, notePath } = prep[ni];
            const text = await readTextFile(src.absPath);
            const { frontmatter, body } = parseNoteFile(text);
            const refs: PlannedRef[] = [];

            // Pre-fetch YouTube metadata for iframes using the app's native CORS-safe fetcher
            const iframeMatches = Array.from(body.matchAll(/<iframe[^>]*src="([^"]+)"[^>]*>/gi));
            const ytMeta = new Map<string, { title: string, image: string, description: string, icon: string }>();
            for (const m of iframeMatches) {
                const src = m[1];
                const ytMatch = src.match(/youtube\.com\/embed\/([^?]+)/);
                if (ytMatch) {
                    const vid = ytMatch[1];
                    try {
                        const url = `https://www.youtube.com/watch?v=${vid}`;
                        const meta = await fetchEnrichedMetadata(url);
                        ytMeta.set(src, {
                            title: meta.title || "YouTube Video",
                            image: meta.image || `https://img.youtube.com/vi/${vid}/maxresdefault.jpg`,
                            description: meta.description || "",
                            icon: meta.icon || "https://www.youtube.com/favicon.ico"
                        });
                    } catch {
                        ytMeta.set(src, {
                            title: "YouTube Video",
                            image: `https://img.youtube.com/vi/${vid}/maxresdefault.jpg`,
                            description: "",
                            icon: "https://www.youtube.com/favicon.ico"
                        });
                    }
                }
            }

            const addRef = (kind: "image" | "file", alt: string, rawTarget: string): string => {
                const raw = safeDecode(rawTarget).replace(/^<|>$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
                const token = `@@SELAHREF${ni}_${refs.length}@@`;
                refs.push({ token, kind, alt, name: raw.split("/").pop() || raw, raw, resolved: null, candidates: [], decision: "pending" });
                return token;
            };
            const linkTarget = (name: string) => nameMap.get(normName(name)) ?? (name.split("/").pop() || name);

            // 0. Pre-process Obsidian image-grid and gallery blocks so mapOutsideCode doesn't ignore them
            let bodyWithGrids = body.replace(/```\s*(?:image-grid|gallery)\s*\n([\s\S]*?)```/gi, (_match, content: string) => {
                // Look for "Columns: X" inside the block
                const colMatch = content.match(/(?:Columns|columns):\s*(\d+)/i);
                let numCols = colMatch ? parseInt(colMatch[1], 10) : 3;

                // Sanity check: keep columns between 1 and 6
                if (isNaN(numCols) || numCols < 1 || numCols > 6) numCols = 3;

                const images: string[] = [];
                const regex = /!\s*\[\[([^\]]+)\]\]/g;
                let m;
                while ((m = regex.exec(content)) !== null) {
                    images.push(m[1]);
                }
                if (images.length === 0) return _match;

                // Fix: If there's only 1 image, just output a standard image instead of a broken 1-item gallery
                if (images.length === 1) {
                    const raw = safeDecode(images[0]).replace(/^<|>$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
                    const token = addRef("image", "image", raw);
                    return `\n\n${token}\n\n`;
                }

                const tokens = images.map(img => {
                    const raw = safeDecode(img).replace(/^<|>$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
                    const token = `@@SELAHGALLERY${ni}_${refs.length}@@`;
                    refs.push({ token, kind: "image", alt: "", name: raw.split("/").pop() || raw, raw, resolved: null, candidates: [], decision: "pending" });
                    return token;
                });

                // Chunk into rows of numCols
                const gridItems = tokens.map(t => ({ src: t, caption: "", fit: "cover" }));
                const chunked = [];
                for (let i = 0; i < gridItems.length; i += numCols) {
                    chunked.push(gridItems.slice(i, i + numCols));
                }
                const gridJson = JSON.stringify(chunked).replace(/"/g, '&quot;');
                const colWidths = JSON.stringify(Array(numCols).fill(1)).replace(/"/g, '&quot;');

                return `\n\n::: imagegallery grid="${gridJson}" gap="8" colWidths="${colWidths}" rowHeights="[220]"\n\n`;
            });

            // 0.1 Pre-process Embed blocks BEFORE mapOutsideCode so they don't crash the editor
            let bodyWithEmbeds = bodyWithGrids.replace(/```\s*(?:embed|bookmark|link)\s*\n([\s\S]*?)```/gi, (match, block: string) => {
                if (block.includes('title:') && block.includes('url:')) {
                    const titleM = block.match(/title:\s*"([^"]*)"/);
                    const urlM = block.match(/url:\s*"([^"]*)"/);
                    const descM = block.match(/description:\s*"([^"]*)"/);
                    const imgM = block.match(/image:\s*"([^"]*)"/);
                    const iconM = block.match(/favicon:\s*"([^"]*)"/);

                    if (urlM) {
                        const title = titleM ? titleM[1] : "";
                        const url = urlM[1];
                        const description = descM ? descM[1].replace(/\n/g, " ") : "";
                        const image = imgM ? imgM[1] : "";
                        const icon = iconM ? iconM[1] : "";

                        // Escape quotes so the ::: block doesn't break
                        const safeTitle = title.replace(/"/g, "&quot;");
                        const safeDesc = description.replace(/"/g, "&quot;");
                        const safeUrl = url.replace(/"/g, "&quot;");
                        const safeImg = image.replace(/"/g, "&quot;");
                        const safeIcon = icon.replace(/"/g, "&quot;");

                        return `\n\n::: bookmark mode="bookmark" url="${safeUrl}" title="${safeTitle}" description="${safeDesc}" icon="${safeIcon}" image="${safeImg}"\n\n`;
                    }
                }
                return match;
            });

            const converted = mapOutsideCode(bodyWithEmbeds, (t) => {
                // 0.3 Convert raw HTML color spans into Selah safe text markers
                t = t.replace(/<span\s+([^>]*)style="[^"]*color:\s*rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\s*\)[^"]*"([^>]*)>([\s\S]*?)<\/span>/gi, (_match, _attr1, r, g, b, _attr2, innerText) => {
                    const hex = "#" + ((1 << 24) + (parseInt(r) << 16) + (parseInt(g) << 8) + parseInt(b)).toString(16).slice(1);
                    return `{{c=${hex}}}${innerText}{{/}}`;
                });
                t = t.replace(/<span\s+([^>]*)style="[^"]*color:\s*(#[0-9a-fA-F]{3,6})[^"]*"([^>]*)>([\s\S]*?)<\/span>/gi, (_match, _attr1, hex, _attr2, innerText) => {
                    return `{{c=${hex}}}${innerText}{{/}}`;
                });

                // 0.35 Convert standard HTML links (<a>) to Markdown links
                t = t.replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_match, href, text) => {
                    return `[${text}](${href})`;
                });

                // 0.36 Convert HTML iframes (like YouTube embeds) to Selah Embeds
                t = t.replace(/<iframe([^>]*)src="([^"]+)"([^>]*)>(?:<\/iframe>)?/gi, (_match, _attr1, src, _attr2) => {
                    let url = src;
                    let image = "";
                    let title = "YouTube Video";
                    let description = "";
                    let icon = "";
                    let metaLabel = "";

                    const ytMatch = url.match(/youtube\.com\/embed\/([^?]+)/);
                    if (ytMatch) {
                        url = `https://www.youtube.com/watch?v=${ytMatch[1]}`;
                        metaLabel = "YouTube";
                        icon = "https://www.youtube.com/favicon.ico";
                        const meta = ytMeta.get(src);
                        if (meta) {
                            title = meta.title;
                            image = meta.image;
                            description = meta.description;
                            if (meta.icon) icon = meta.icon;
                        } else {
                            image = `https://img.youtube.com/vi/${ytMatch[1]}/maxresdefault.jpg`;
                        }
                    }
                    // Escape quotes so the ::: block doesn't break
                    const safeTitle = title.replace(/"/g, "&quot;");
                    const safeDesc = description.replace(/"/g, "&quot;").replace(/\n/g, " ");
                    const safeIcon = icon.replace(/"/g, "&quot;");
                    return `\n\n::: bookmark mode="embed" url="${url}" title="${safeTitle}" description="${safeDesc}" icon="${safeIcon}" image="${image}" meta="${metaLabel}"\n\n`;
                });

                // 0.37 Convert HTML <hr> tags to Markdown dividers to prevent empty list items
                t = t.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

                // 0.4 Convert Bible Callouts into Selah Scripture blocks
                // Fixed regex to capture all blockquote lines regardless of Windows \r\n line endings
                t = t.replace(/^>\s*\[!bible\]\s*(?:\[([^\]]+)\])?(?:\([^)]+\))?[^\n]*\r?\n((?:>.*(?:\r?\n|$))+)/gmi, (_match, title, content) => {
                    let ref = (title || "").split(" - ")[0].trim();
                    if (!ref) ref = "Scripture";

                    // Split on both \r\n and \n, remove the > prefix, and trim
                    let text = content.split(/\r?\n/)
                        .map((line: string) => line.replace(/^>\s*/, '').trim())
                        .join('\n');

                    text = text.replace(/<br\s*\/?>/gi, '\n');
                    text = text.replace(/^(\d+)\.\s+/gm, '$1 ');
                    text = text.replace(/"/g, '&quot;');
                    text = text.replace(/\n/g, '&#10;');

                    return `\n\n::: scripture reference="${ref}" text="${text}" collapsed="false"\n\n`;
                });

                // 0.5 Convert DMS Callouts into Selah DmArchive blocks
                t = t.replace(/(?:^|\n)>\s*\[!(NOTE|INFO|DMS|ARCHIVE|MESSAGE)\]\s*(?:DMS|Archive|Messages|.*)?[^\n]*\n([\s\S]*?)(?=\n[^>]|$)/gi, (_match, type, content) => {
                    const imageRegex = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
                    const images: string[] = [];
                    let m;
                    while ((m = imageRegex.exec(content)) !== null) {
                        images.push(m[1] || m[2]);
                    }

                    if (images.length === 0) {
                        // No images? Just format as a clean blockquote.
                        const cleanContent = content.split('\n').map((l: string) => l.replace(/^>\s*/, '')).join('\n');
                        return `> **${type}**\n> ${cleanContent.replace(/\n/g, '\n> ')}`;
                    }

                    const tokens = images.map(img => {
                        const raw = safeDecode(img).replace(/^<|>$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
                        const token = `@@SELAHARCHIVE${ni}_${refs.length}@@`;
                        refs.push({ token, kind: "image", alt: "", name: raw.split("/").pop() || raw, raw, resolved: null, candidates: [], decision: "pending" });
                        return token;
                    });

                    const srcsStr = tokens.join("\u001E");
                    return `\n\n::: dmarchive platform="discord" who="DMS" link="" date="${frontmatter.date || ''}" caption="" collapsed="true" srcs="${srcsStr}"\n\n`;
                });

                // 0.6 Convert multiple images in a row into a Gallery block
                t = t.replace(/(?:^|\n)((?:!\[\[[^\]]+\]\]\s*){2,})/g, (match) => {
                    const imageRegex = /!\[\[([^\]]+)\]\]/g;
                    const images: string[] = [];
                    let m;
                    while ((m = imageRegex.exec(match)) !== null) {
                        images.push(m[1]);
                    }
                    const tokens = images.map(img => {
                        const raw = safeDecode(img).replace(/^<|>$/g, "").replace(/\\/g, "/").replace(/^\.\//, "");
                        const token = `@@SELAHGALLERY${ni}_${refs.length}@@`;
                        refs.push({ token, kind: "image", alt: "", name: raw.split("/").pop() || raw, raw, resolved: null, candidates: [], decision: "pending" });
                        return token;
                    });
                    const gridItems = tokens.map(t => ({ src: t, caption: "", fit: "cover" }));
                    const numCols = 3;
                    const chunked = [];
                    for (let i = 0; i < gridItems.length; i += numCols) {
                        chunked.push(gridItems.slice(i, i + numCols));
                    }
                    const gridJson = JSON.stringify(chunked).replace(/"/g, '&quot;');
                    const colWidths = JSON.stringify(Array(numCols).fill(1)).replace(/"/g, '&quot;');

                    return `\n::: imagegallery grid="${gridJson}" gap="8" colWidths="${colWidths}" rowHeights="[220]"\n`;
                });

                // 1. Obsidian embeds  ![[file.png]]  /  ! [[Note]]
                t = t.replace(/!\s*\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
                    const target = inner.split("|")[0].trim();
                    const name = target.split("#")[0].split("^")[0].trim();
                    if (!name) return "";
                    if (FILE_EXT_RE.test(name)) return `\n\n${addRef(IMG_RE.test(name) ? "image" : "file", "image", name)}\n\n`;
                    return `[[${linkTarget(name)}]]`;
                });
                // 2. Markdown images + links
                t = t.replace(/(!?)\[([^\]]*)\]\(((?:[^()]|\([^)]*\))+)\)/g, (m, bang: string, label: string, target0: string) => {
                    let target = target0.trim();
                    const tm = target.match(/^(<[^>]+>|\S+)(?:\s+"[^"]*")?$/);
                    if (tm) target = tm[1];
                    target = target.replace(/^<|>$/g, "");

                    if (/^(https?:|mailto:|tel:|data:|blob:|#|\/\/)/i.test(target)) {
                        return bang === "!" ? `![${label}](${target})` : `[${label}](${target})`;
                    }

                    const dec = safeDecode(target);
                    const noFrag = dec.split("#")[0];
                    if (MD_RE.test(noFrag)) {
                        const f = nameMap.get(normName(noFrag));
                        if (f) return label && label !== f ? `[[${f}|${label}]]` : `[[${f}]]`;
                        return label || m; // linked note wasn't part of this import: keep the text
                    }
                    if (FILE_EXT_RE.test(dec)) return `\n\n${addRef(IMG_RE.test(dec) ? "image" : "file", "image", dec)}\n\n`;
                    return m;
                });
            // 3. Wiki links  [[Note#Heading|Text]]  → [[Note|Text]]
            t = t.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, (_m, target: string, disp?: string) => {
                const name = target.split("#")[0].split("^")[0].trim().split("/").pop() || "";
                if (!name) return disp || target.replace(/^#/, "");
                const f = nameMap.get(normName(name)) ?? name;
                return disp ? `[[${f}|${disp}]]` : `[[${f}]]`;
            });
            return t;
            });

            // Resolve what we can on disk.
            const srcDir = dirOf(src.absPath);
            const index = src.rootDir ? indexes.get(src.rootDir) : undefined;
            for (const r of refs) {
                const parts = r.raw.split("/").filter(Boolean);
                const tries: string[] = [];
                if (/^([a-zA-Z]:\/|\/)/.test(r.raw)) tries.push(r.raw);
                else {
                    tries.push(await join(srcDir, ...parts));
                    if (src.rootDir) tries.push(await join(src.rootDir, ...parts));
                }
                for (const t of tries) {
                    if (await isFile(t)) { r.resolved = t; r.decision = "auto"; break; }
                }
                if (r.resolved) continue;
                // Look up the image by name in the imported folder index
                const cands = index?.get(r.name.toLowerCase()) ?? [];
                if (cands.length === 1) {
                    // If there's exactly 1 match anywhere in the folder, use it automatically!
                    r.resolved = cands[0]; r.decision = "auto";
                } else if (cands.length > 1) {
                    r.candidates = cands.slice(0, 6);
                    r.decision = "pending";
                } else {
                    r.decision = "pending";
                }
            }

            const fm: Frontmatter = { ...frontmatter };
            notes.push({
                id: `n${ni}`, srcPath: src.absPath, base, dir, notePath,
                frontmatter: fm, body: converted, refs,
                extractedDate: extractDateFromName(base, frontmatter),
            });
        }
        return { notes };
    }

    export async function commitMarkdownImport(
        plan: ImportPlan, onProgress?: (m: string) => void
    ): Promise<{ notes: number; copied: number; skipped: number }> {
        let copied = 0, skipped = 0;
        const dirs = new Set<string>();

        for (let i = 0; i < plan.notes.length; i++) {
            const n = plan.notes[i];

            onProgress?.(`Importing "${n.base}" (${i + 1} of ${plan.notes.length})…`);
            await mkdir(n.dir, { recursive: true });
            const cache = new Map<string, string>();
            let body = n.body;

            for (const r of n.refs) {
                let rep: string;
                if (!r.resolved || r.decision === "skipped" || r.decision === "pending") {
                    rep = `*(missing: ${r.name})*`;
                    skipped++;
                } else {
                    try {
                        let dest = cache.get(r.resolved);
                        if (!dest) {
                            dest = await saveFileToNoteAssets(n.notePath, r.resolved);
                            cache.set(r.resolved, dest);
                            copied++;
                        }
                        const fileName = baseOf(dest);
                        const rel = `assets/${n.base}/${fileName}`;
                        // URL-encode for the ::: blocks so they don't break on spaces/commas
                        const safePluginRel = `assets/${encSeg(n.base)}/${encSeg(fileName)}`;

                        if (r.kind === "image") {
                            if (r.token.startsWith("@@SELAHARCHIVE") || r.token.startsWith("@@SELAHGALLERY")) {
                                rep = safePluginRel;
                            } else {
                                // Wrap in newlines to force a standalone block, and use the "image" alt text
                                rep = `\n\n![image](${safePluginRel})\n\n`;
                            }
                        } else {
                            rep = `\n\n::: attachment src="${escAttr(rel)}" caption="" fileName="${escAttr(r.name)}"\n\n`;
                        }
                    } catch (e) {
                        console.warn("[import] copy failed:", r.resolved, e);
                        rep = `*(missing: ${r.name})*`;
                        skipped++;
                    }
                }
                body = body.split(r.token).join(rep);
            }

            const now = new Date().toISOString();
            const fm: Frontmatter = { ...n.frontmatter };

            // Aggressively filter out invalid YAML keys (like emojis) that crash the parser
            const cleanFm: Frontmatter = {};
            for (const key of Object.keys(fm)) {
                if (/^[a-zA-Z0-9_-]+$/.test(key)) {
                    cleanFm[key] = fm[key];
                }
            }

            if (typeof cleanFm.created !== "string" || !cleanFm.created) cleanFm.created = now;
            cleanFm.modified = now;
            if (n.extractedDate) {
                cleanFm.date = n.extractedDate;
            }

            await writeFileAtomic(n.notePath, serializeNoteFile(cleanFm, body));
            dirs.add(n.dir);
        }
        for (const d of dirs) {
            window.dispatchEvent(new CustomEvent("folder-changed", { detail: { path: d } }));
        }
        return { notes: plan.notes.length, copied, skipped };
    }

    export async function collectMarkdownInFolder(root: string): Promise<string[]> {
        const out: string[] = [];
        const walk = async (dir: string, depth: number) => {
            if (depth > 10) return;
            let es: any[] = [];
            try { es = await readDir(dir); } catch { return; }
            for (const e of es) {
                if (!e.name || e.name.startsWith(".")) continue;
                const p = await join(dir, e.name);
                if (e.isDirectory) await walk(p, depth + 1);
                else if (MD_RE.test(e.name)) out.push(p);
            }
        };
        await walk(root, 0);
        return out;
    }

    export async function findMissingFilesInFolder(folder: string, filenames: string[]): Promise<Map<string, string>> {
        const results = new Map<string, string>();
        const targets = new Set(filenames.map(f => f.toLowerCase()));

        const walk = async (dir: string, depth: number) => {
            if (depth > 10) return;
            try {
                const entries = await readDir(dir);
                for (const e of entries) {
                    if (!e.name || e.name.startsWith(".") || e.name === "node_modules") continue;
                    const full = await join(dir, e.name);
                    if (e.isDirectory) {
                        await walk(full, depth + 1);
                    } else if (targets.has(e.name.toLowerCase())) {
                        results.set(e.name.toLowerCase(), full);
                    }
                }
            } catch {}
        };

        await walk(folder, 0);
        return results;
    }
