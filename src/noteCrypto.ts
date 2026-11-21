// src/noteCrypto.ts
import { useEffect, useState } from "react";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { parseNoteFile, serializeNoteFile, type Frontmatter } from "./noteFormat";
import { writeFileAtomic } from "./safeWrite";

// ── Feature flag (Settings → General) ───────────────────────────────────
const KEY = "encryption-feature-enabled";

export function encryptionFeatureEnabled(): boolean {
    try { return localStorage.getItem(KEY) === "true"; } catch { return false; }
}
export function setEncryptionFeatureEnabled(on: boolean): void {
    try { localStorage.setItem(KEY, String(on)); } catch {}
    window.dispatchEvent(new Event("encryption-feature-changed"));
}
export function useEncryptionFeature(): boolean {
    const [on, setOn] = useState(encryptionFeatureEnabled);
    useEffect(() => {
        const fn = () => setOn(encryptionFeatureEnabled());
        window.addEventListener("encryption-feature-changed", fn);
        return () => window.removeEventListener("encryption-feature-changed", fn);
    }, []);
    return on;
}

// ── Crypto primitives ───────────────────────────────────────────────────
const ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
    }
    return btoa(s);
}
function fromB64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export async function deriveKey(password: string, saltB64: string): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey(
        "raw", enc.encode(password) as any, "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: fromB64(saltB64) as any, iterations: ITERATIONS, hash: "SHA-256" },
                                   base,
                                   { name: "AES-GCM", length: 256 },
                                   false,
                                   ["encrypt", "decrypt"]
    );
}

export async function encryptText(key: CryptoKey, text: string): Promise<{ iv: string; cipher: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as any }, key, enc.encode(text) as any)
    );
    return { iv: toB64(iv), cipher: toB64(ct) };
}

/** Throws if the key is wrong or the data was tampered with. */
export async function decryptText(key: CryptoKey, ivB64: string, cipherB64: string): Promise<string> {
    const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(ivB64) as any }, key, fromB64(cipherB64) as any
    );
    return dec.decode(pt);
}

// ── Unlocked keys, kept in memory only, keyed by the note's salt ─────────
// (Keyed by salt, not path, so renaming/moving a note doesn't re-lock it.)
const sessionKeys = new Map<string, CryptoKey>();
export const getSessionKey = (salt: string) => sessionKeys.get(salt);
export const setSessionKey = (salt: string, key: CryptoKey) => { sessionKeys.set(salt, key); };
export const clearSessionKey = (salt: string) => { sessionKeys.delete(salt); };

export function isEncryptedFm(fm: Frontmatter): boolean {
    return (
        fm.encrypted === true &&
        typeof fm.encSalt === "string" &&
        typeof fm.encIv === "string" &&
        typeof fm.cipher === "string"
    );
}

// ── File operations ─────────────────────────────────────────────────────
export async function encryptNoteFile(path: string, password: string): Promise<void> {
    const raw = await readTextFile(path); // throws if the note was never saved
    const { frontmatter, body } = parseNoteFile(raw);
    if (isEncryptedFm(frontmatter)) throw new Error("This note is already encrypted.");

    const salt = toB64(crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveKey(password, salt);
    const { iv, cipher } = await encryptText(key, body);

    // Verify the round trip BEFORE touching the file.
    if ((await decryptText(key, iv, cipher)) !== body) throw new Error("Encryption self-check failed.");

    await writeFileAtomic(
        path,
        serializeNoteFile({ ...frontmatter, encrypted: true, encSalt: salt, encIv: iv, cipher }, "")
    );
    setSessionKey(salt, key);
}

export async function decryptNoteFile(path: string, password: string): Promise<void> {
    const raw = await readTextFile(path);
    const { frontmatter } = parseNoteFile(raw);
    if (!isEncryptedFm(frontmatter)) throw new Error("This note isn't encrypted.");

    const salt = frontmatter.encSalt as string;
    const key = await deriveKey(password, salt);
    let body: string;
    try {
        body = await decryptText(key, frontmatter.encIv as string, frontmatter.cipher as string);
    } catch {
        throw new Error("Wrong password.");
    }
    const { encrypted: _e, encSalt: _s, encIv: _i, cipher: _c, ...rest } = frontmatter;
    await writeFileAtomic(path, serializeNoteFile(rest, body));
    clearSessionKey(salt);
}

export async function decryptNoteFileSafe(path: string, password: string): Promise<boolean> {
    try { await decryptNoteFile(path, password); return true; } catch { return false; }
}

/** Every encrypted note in the vault. */
export async function scanEncryptedNotes(vaultPath: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
        if (depth > 8) return;
        let entries: any[] = [];
        try { entries = await readDir(dir); } catch { return; }
        for (const e of entries) {
            if (!e.name || e.name.startsWith(".") || e.name === "assets" || e.name === "_attachments") continue;
            const full = await join(dir, e.name);
            if (e.isDirectory) { await walk(full, depth + 1); continue; }
            if (!e.name.endsWith(".selah")) continue;
            try {
                const { frontmatter } = parseNoteFile(await readTextFile(full));
                if (isEncryptedFm(frontmatter)) out.push(full);
            } catch {}
        }
    };
    await walk(vaultPath, 0);
    return out;
}
