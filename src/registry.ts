// src/communityPlugins.ts
import { mkdir, readTextFile, exists } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { pluginsDir, loadPlugins } from "./plugins";
import { writeFileAtomic } from "./safeWrite";

// ⚠️ Change this to your registry repo.
export const REGISTRY_REPO = "El3ctricFX/selah-plugins";
export const REGISTRY_URL = `https://raw.githubusercontent.com/${REGISTRY_REPO}/registry/registry.json`;

const INSTALL_MARKER = ".selah-registry.json";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[a-zA-Z0-9_-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
// No segment may start with "." so ".." and hidden files are impossible.
const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export interface RegistryEntry {
    id: string;
    name: string;
    description: string;
    author: string;
    repo: string;
    commit: string;
    version: string;
    icon?: string;
    permissions?: string[];
    badge?: string; // e.g. "Affiliated", "Verified"
    files: Record<string, string>; // path -> sha256 hex
}

function validEntry(e: any): e is RegistryEntry {
    if (!e || typeof e !== "object") return false;
    if (!ID_RE.test(e.id || "")) return false;
    if (typeof e.name !== "string" || typeof e.description !== "string") return false;
    if (typeof e.author !== "string" || typeof e.version !== "string") return false;
    if (!REPO_RE.test(e.repo || "") || !SHA_RE.test(e.commit || "")) return false;
    if (e.badge !== undefined && typeof e.badge !== "string") return false;
    if (!e.files || typeof e.files !== "object") return false;
    const paths = Object.keys(e.files);
    // Allow manifest.json and index.js to be in a subfolder
    if (!paths.some(p => p.endsWith("manifest.json")) || !paths.some(p => p.endsWith("index.js"))) return false;
    return paths.every((p) => FILE_RE.test(p) && HASH_RE.test(e.files[p]));
}

export async function fetchRegistry(): Promise<RegistryEntry[]> {
    const res = await fetch(REGISTRY_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Registry unavailable (HTTP ${res.status})`);
    const data = await res.json();
    if (!data || !Array.isArray(data.plugins)) throw new Error("Registry format not recognised");
    return data.plugins.filter(validEntry);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as any);
    return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function entrySourceUrl(e: RegistryEntry): string {
    return `https://github.com/${e.repo}/tree/${e.commit}`;
}

export async function readInstallInfo(
    vaultPath: string,
    id: string
): Promise<{ commit: string; version: string } | null> {
    try {
        const p = await join(await pluginsDir(vaultPath), id, INSTALL_MARKER);
        const j = JSON.parse(await readTextFile(p));
        if (typeof j?.commit === "string") return { commit: j.commit, version: String(j.version ?? "") };
    } catch {}
    return null;
}

export async function installFromRegistry(vaultPath: string, entry: RegistryEntry): Promise<void> {
    if (!validEntry(entry)) throw new Error("Invalid registry entry");

    const root = await pluginsDir(vaultPath);
    const dir = await join(root, entry.id);

    // Never overwrite a plugin the user installed by hand.
    const marker = await readInstallInfo(vaultPath, entry.id);
    if (!marker && (await exists(dir))) {
        throw new Error(`A plugin folder named "${entry.id}" already exists and wasn't installed from the registry.`);
    }

    // 1. Download + verify EVERYTHING before touching disk.
    const downloaded: [string, Uint8Array][] = [];
    for (const [path, expected] of Object.entries(entry.files)) {
        const url = `https://raw.githubusercontent.com/${entry.repo}/${entry.commit}/${path}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Could not download ${path} (HTTP ${res.status})`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_FILE_BYTES) throw new Error(`${path} is too large`);
        if ((await sha256Hex(bytes)) !== expected) {
            throw new Error(`${path} does not match the approved hash. Install aborted.`);
        }
        downloaded.push([path, bytes]);
    }

    // 2. The manifest id must match the registry id.
    const manifestPath = Object.keys(entry.files).find(p => p.endsWith("manifest.json"))!;
    const manifestBytes = downloaded.find(([p]) => p === manifestPath)![1];
    let manifest: any;
    try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); }
    catch { throw new Error("manifest.json is not valid JSON"); }
    if (String(manifest?.id) !== entry.id) throw new Error("manifest.json id doesn't match the registry id");

    // 3. Write. (Strip the subfolder prefix so files land in the root of the plugin folder)
    const prefix = manifestPath.replace("manifest.json", "");
    await mkdir(dir, { recursive: true });
    for (const [path, bytes] of downloaded) {
        const relativePath = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
        const parts = relativePath.split("/");
        if (parts.length > 1) await mkdir(await join(dir, ...parts.slice(0, -1)), { recursive: true });
        await writeFileAtomic(await join(dir, ...parts), bytes);
    }
    await writeFileAtomic(
        await join(dir, INSTALL_MARKER),
                          JSON.stringify({ commit: entry.commit, version: entry.version, repo: entry.repo }, null, 2)
    );

    await loadPlugins(vaultPath);
}
