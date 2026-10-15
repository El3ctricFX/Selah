// src/ProxyToggleHost.tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { Loader2, Check, AlertTriangle, Zap } from "lucide-react";
import { auditSingleNote, auditVault, basename } from "./mediaVault";
import {
    buildProxiesForNote, buildThumbsForNote, removeProxiesForNote, fixAllBrokenRefsForNote,
} from "./mediaFix";
import { parseNoteFile, serializeNoteFile } from "./noteFormat";
import { writeFileAtomic } from "./safeWrite";
import { flushAll } from "./flushRegistry";
import { setProxyPref } from "./imageAssets";

type Req = { path: string; next: boolean; vaultPath?: string; writeFlag?: () => Promise<void> | void };
type Line = { text: string; error?: boolean };
type Push = (text: string, error?: boolean) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (p: string) => p.replace(/\\/g, "/");
const sameNote = (a: string, b: string) => norm(a) === norm(b);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Make sure the on/off setting really is on disk, even if the editor skipped it.
async function ensureFlag(path: string, next: boolean) {
    const raw = await readTextFile(path);
    const { frontmatter, body } = parseNoteFile(raw);
    const isOn = frontmatter.proxies === true;
    if (isOn === next) return;
    if (next) (frontmatter as any).proxies = true;
    else delete (frontmatter as any).proxies;
    await writeFileAtomic(path, serializeNoteFile(frontmatter, body));
}

async function execute(req: Req, push: Push) {
    const { path, next } = req;
    setProxyPref(path, next);

    push(next ? "Turning proxies on…" : "Turning proxies off…");
    try { await req.writeFlag?.(); } catch (e) { console.warn("[proxy toggle] flag write:", e); }
    await ensureFlag(path, next);
    await flushAll();

    push("Checking this note's images…");
    let report = await auditSingleNote(path);

    if (next) {
        const mp = report.missingProxies.find((m) => sameNote(m.notePath, path));
        const mt = report.missingThumbs.find((m) => sameNote(m.notePath, path));
        if (mp) {
            push(`Found ${plural(mp.sources.length, "image")} to optimize`);
            push("Generating proxies…");
            const r = await buildProxiesForNote(mp, push);
            push(r.generated > 0 ? `Created ${plural(r.generated, "proxy")}` : "Proxies already existed");
            push(r.rewritten ? "Note now uses the proxies" : "References were already up to date");
        } else if (mt) {
            push("Building thumbnails…");
            const r = await buildThumbsForNote(mt);
            push(`Built ${plural(r.generated, "thumbnail")}`);
        } else {
            push("Proxies were already built, so refreshing the note…");
        }
    } else {
        const off = report.proxiesOff.find((m) => sameNote(m.notePath, path));
        if (off) {
            push("Removing proxies…");
            const r = await removeProxiesForNote(off, push);
            push(`Removed ${plural(r.removed, "proxy/thumbnail file")}`);
        } else {
            push("No proxy files to remove");
        }

        push("Fixing references…");
        report = await auditSingleNote(path);
        const refs = report.brokenRefs.filter(
            (b) => sameNote(b.notePath, path) && b.fix.kind === "downgrade"
        );
        if (refs.length > 0) {
            const r = await fixAllBrokenRefsForNote(path, refs);
            push(`Pointed ${plural(r.applied, "reference")} back at the originals`);
        } else {
            push("References already point at the originals");
        }
    }

    await sleep(500); // let the editor finish reloading
    window.dispatchEvent(new Event("thumbs-changed"));
  // Always reload the open note so its gallery re-reads the new setting.
  window.dispatchEvent(new CustomEvent("note-rewritten", { detail: { path } }));
    window.dispatchEvent(new CustomEvent("file-changed", { detail: { path } }));
    push("Complete");
}

async function executeVault(vaultPath: string, push: Push) {
  push("Turning proxies off for the whole vault…");
  await flushAll();

  push("Scanning your notes…");
  const report = await auditVault(vaultPath);
  const items = report.proxiesOff;

  if (items.length === 0) {
    push("No proxy files to remove");
  } else {
    push(`Found proxies in ${plural(items.length, "note")}`);
    let removed = 0;
    for (let i = 0; i < items.length; i++) {
      push(`Removing proxies… ${basename(items[i].notePath)} (${i + 1} of ${items.length})`);
      const r = await removeProxiesForNote(items[i]);
      removed += r.removed;
    }
    push(`Removed ${plural(removed, "proxy/thumbnail file")}`);
  }

  push("Fixing references…");
  const after = await auditVault(vaultPath);
  const byNote = new Map<string, typeof after.brokenRefs>();
  for (const b of after.brokenRefs) {
    if (b.fix.kind !== "downgrade") continue;
    const list = byNote.get(b.notePath) ?? [];
    list.push(b);
    byNote.set(b.notePath, list);
  }
  let fixed = 0;
  for (const [notePath, refs] of byNote) {
    const r = await fixAllBrokenRefsForNote(notePath, refs);
    fixed += r.applied;
  }
  push(
    fixed > 0
      ? `Pointed ${plural(fixed, "reference")} back at the originals`
      : "References already point at the originals"
  );

  await sleep(500);
  window.dispatchEvent(new Event("thumbs-changed"));
  push("Complete");
}

export default function ProxyToggleHost() {
    const [req, setReq] = useState<Req | null>(null);
    const [lines, setLines] = useState<Line[]>([]);
    const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
    const busy = useRef(false);

    // Progress lines like "Generating proxies… 5 of 68" replace the previous
    // line instead of piling up 68 rows.
    const push: Push = (text, error = false) => {
        setLines((prev) => {
            const last = prev[prev.length - 1];
            if (
                !error && last && !last.error &&
                text.includes("…") && last.text.includes("…") &&
                text.split("…")[0] === last.text.split("…")[0]
            ) {
                return [...prev.slice(0, -1), { text }];
            }
            return [...prev, { text, error }];
        });
    };

    useEffect(() => {
        const onReq = async (e: Event) => {
            const d = (e as CustomEvent).detail as Req | undefined;
            if ((!d?.path && !d?.vaultPath) || busy.current) return;
            busy.current = true;
            setReq(d);
            setLines([]);
            setStatus("running");
            try {
                await (d.vaultPath ? executeVault(d.vaultPath, push) : execute(d, push));
                setStatus("done");
            } catch (err: any) {
                console.error("[proxy toggle]", err);
                push(`Something went wrong: ${err?.message ?? err}`, true);
                setStatus("error");
            } finally {
                busy.current = false;
            }
        };
        window.addEventListener("proxy-toggle-request", onReq);
        return () => window.removeEventListener("proxy-toggle-request", onReq);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!req) return null;
    const running = status === "running";

    return createPortal(
        <div className="fixed inset-0 z-[800] bg-black/60 flex items-center justify-center p-6">
        <div className="w-[420px] max-w-full bg-[#161a1d] border border-[#2a3136] rounded-lg shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136]">
        <Zap size={15} className="text-blue-400" />
        <div className="text-sm text-gray-100 flex-1">
        {req.next ? "Turning proxies on" : "Turning proxies off"}
        </div>
        {running && <Loader2 size={16} className="animate-spin text-blue-400" />}
        {status === "done" && <Check size={16} className="text-green-400" />}
        {status === "error" && <AlertTriangle size={16} className="text-red-400" />}
        </div>

        <div className="px-4 py-3 space-y-1.5 max-h-64 overflow-y-auto">
        {lines.map((l, i) => {
            const isLast = i === lines.length - 1;
            return (
                <div key={i} className={`flex items-start gap-2 text-xs ${l.error ? "text-red-400" : "text-gray-300"}`}>
                <span className="mt-0.5 flex-shrink-0">
                {l.error ? <AlertTriangle size={12} />
                : isLast && running ? <Loader2 size={12} className="animate-spin text-blue-400" />
                : <Check size={12} className="text-green-400" />}
                </span>
                <span>{l.text}</span>
                </div>
            );
        })}
        </div>

        <div className="px-4 py-3 border-t border-[#2a3136] flex items-center justify-between">
        <div className="text-[10px] text-gray-500">
        {running ? "Please don't edit this note until it finishes." : ""}
        </div>
        {!running && (
            <button
            onClick={() => { setReq(null); setStatus("idle"); }}
            className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer"
            >
            Close
            </button>
        )}
        </div>
        </div>
        </div>,
        document.body
    );
}
