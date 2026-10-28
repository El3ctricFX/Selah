// src/CleanupPanel.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { proxyFeatureEnabled, useProxyFeature } from "./proxyFeature";
import { flushAll } from "./flushRegistry";
import {
  AlertTriangle, Check, Loader2, Sparkles, X, Trash2,
  Wrench, FolderOpen, ShieldOff, RefreshCw, ArrowRight, HelpCircle,
} from "lucide-react";
import { auditVault, type VaultReport, type BrokenRef, type MissingProxiesForNote, type MissingThumbForNote, type ProxiesOffNote } from "./mediaVault";
import { fixBrokenRef, fixAllBrokenRefsForNote, deleteUnusedFile, keepUnusedFile, fixOldLayout, buildProxiesForNote, buildThumbsForNote, removeProxiesForNote, removeBrokenRefFromNote } from "./mediaFix";
import { basename } from "./mediaVault";

type Phase = "scanning" | "results" | "working" | "done" | "error";

interface Props {
  open: boolean;
  onClose: () => void;
  vaultPath: string;
  categories?: any[];
}

export default function CleanupPanel({ open, onClose, vaultPath }: Props) {
  const [phase, setPhase] = useState<Phase>("scanning");
  const proxyOn = useProxyFeature();
  const [report, setReport] = useState<VaultReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const scanSeq = useRef(0);

  const scan = async (silent = false) => {
    const id = ++scanSeq.current;
    if (!silent) setPhase("scanning");
    setError(null);
    try {
      await flushAll();
      const r = await auditVault(vaultPath);
      if (id !== scanSeq.current) return;
            // Optimize already builds thumbnails, so don't list the same note twice.
      r.missingThumbs = r.missingThumbs.filter(
        (t) => !r.missingProxies.some((p) => p.notePath === t.notePath)
      );
      if (!proxyFeatureEnabled()) { r.missingProxies = []; r.missingThumbs = []; r.proxiesOff = []; }
      setReport(r);
      if (!silent) setSelected(new Set());
      setPhase("results");
    } catch (e: any) {
      if (id !== scanSeq.current) return;
      setError(e?.message ?? String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    if (!open) return;
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vaultPath]);


  useEffect(() => {
    if (!open) return;
    let timer: number | undefined;
    const refresh = () => {
      if (working !== null) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void scan(true), 700);
    };
    const events = ["file-changed", "note-rewritten", "thumbs-changed", "folder-changed"];
    events.forEach((ev) => window.addEventListener(ev, refresh));
    return () => {
      window.clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, refresh));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vaultPath, working]);

  const summary = useMemo(() => {
    if (!report) return null;
    return {
      broken: report.brokenRefs.length,
      unused: report.unusedFiles.length,
      oldLayout: report.oldLayout.length,
      pending: report.missingProxies.length,
      proxiesOff: report.proxiesOff.length,
      total:
        report.brokenRefs.length +
        report.unusedFiles.length +
        report.oldLayout.length +
        report.missingProxies.length +
        report.missingThumbs.length +
        report.proxiesOff.length,
    };
  }, [report]);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const selectAllOf = (keys: string[]) => {
    setSelected(new Set(keys));
  };

  const run = async (label: string, fn: () => Promise<void>) => {
    setWorking(label);
    try { await fn(); await scan(); }
    catch (e) { console.error("[cleanup]", label, e); }
    finally { setWorking(null); }
  };

  const fixAllBroken = () =>
    run("Repairing note references", async () => {
      if (!report) return;

      // Group by note so each file is read once and written once. This is
      // what keeps the repair atomic against the open editor: without
      // batching, each write remounts NoteBody, whose unmount flush lands
      // in the middle of the next read and writes back the pre-fix body.
      const byNote = new Map<string, typeof report.brokenRefs>();
      for (const b of report.brokenRefs) {
        if (b.fix.kind === "unfixable") continue;
        const list = byNote.get(b.notePath) ?? [];
        list.push(b);
        byNote.set(b.notePath, list);
      }

      let totalApplied = 0;
      let totalSkipped = 0;
      let notesTouched = 0;
      for (const [notePath, refs] of byNote) {
        try {
          const { applied, skipped } = await fixAllBrokenRefsForNote(notePath, refs);
          totalApplied += applied;
          totalSkipped += skipped;
          if (applied > 0) notesTouched++;
          console.log(
            `[cleanup] ${notePath.split(/[/\\]/).pop()}: ` +
            `${applied}/${refs.length} applied, ${skipped} skipped`,
          );
        } catch (e) {
          console.error("[cleanup] batch fix failed:", notePath, e);
        }
      }
      console.log(
        `[cleanup] done: ${totalApplied} applied, ${totalSkipped} skipped, ` +
        `${notesTouched}/${byNote.size} notes touched`,
      );
    });

  const fixSelectedBroken = () =>
    run("Repairing selected references", async () => {
      if (!report) return;
      const items = report.brokenRefs.filter((b) => selected.has(`b:${b.notePath}:${b.raw}`));
      for (const b of items) {
        if (b.fix.kind === "unfixable") continue;
        await fixBrokenRef(b);
      }
    });

  const removeSelectedBroken = () =>
    run("Removing broken references", async () => {
      if (!report) return;
      const items = report.brokenRefs.filter((b) => selected.has(`b:${b.notePath}:${b.raw}`));
      for (const b of items) {
        await removeBrokenRefFromNote(b.notePath, b.raw);
      }
    });

  const trashSelectedUnused = () =>
    run("Moving files to system trash", async () => {
      if (!report) return;
      const items = report.unusedFiles.filter((u) => selected.has(`u:${u.absPath}`));
      for (const u of items) await deleteUnusedFile(u);
    });

  const keepSelectedUnused = () =>
    run("Marking files as keep", async () => {
      if (!report) return;
      const items = report.unusedFiles.filter((u) => selected.has(`u:${u.absPath}`));
      for (const u of items) await keepUnusedFile(u);
    });

  const fixAllOldLayout = () =>
    run("Migrating folders to new layout", async () => {
      if (!report) return;
      for (const o of report.oldLayout) await fixOldLayout(o);
    });

  const removeProxies = (items: ProxiesOffNote[]) =>
    run("Removing proxies", async () => {
      for (let i = 0; i < items.length; i++) {
        setWorking(`Removing proxies: ${basename(items[i].notePath)} (${i + 1}/${items.length})`);
        await removeProxiesForNote(items[i]);
      }
      // Safety net: anything still pointing at a removed proxy gets
      // re-pointed at its original photo automatically.
      setWorking("Repairing leftover references…");
      await new Promise((r) => setTimeout(r, 400));
      const fresh = await auditVault(vaultPath);
      const touched = new Set(items.map((i) => i.notePath));
      const byNote = new Map<string, BrokenRef[]>();
      for (const b of fresh.brokenRefs) {
        if (!touched.has(b.notePath)) continue;
        if (b.fix.kind !== "downgrade") continue;
        const list = byNote.get(b.notePath) ?? [];
        list.push(b);
        byNote.set(b.notePath, list);
      }
      for (const [notePath, refs] of byNote) {
        await fixAllBrokenRefsForNote(notePath, refs);
      }
    });

  const optimizeItems = (items: MissingProxiesForNote[]) =>
    run("Building WebP proxies", async () => {
      for (let i = 0; i < items.length; i++) {
        setWorking(`Optimizing ${basename(items[i].notePath)} (${i + 1}/${items.length})`);
        await buildProxiesForNote(items[i]);
        window.dispatchEvent(new Event("thumbs-changed"));
      }
    });

    const buildThumbItems = (items: MissingThumbForNote[]) =>
    run("Building 640px thumbnails", async () => {
      for (let i = 0; i < items.length; i++) {
        setWorking(`Thumbnails: ${basename(items[i].notePath)} (${i + 1}/${items.length})`);
        const { generated, failed } = await buildThumbsForNote(items[i]);
        if (failed > 0) {
          console.warn(
            `[cleanup] ${basename(items[i].notePath)}: ${generated} thumbs built, ${failed} failed`,
          );
        }
      }
    });

    const buildAllThumbs = () => report && buildThumbItems(report.missingThumbs);

    const buildSelectedThumbs = () =>
    report &&
    buildThumbItems(report.missingThumbs.filter((m) => selected.has(`t:${m.notePath}`)));


  const optimizeAllImages = () => report && optimizeItems(report.missingProxies);

  const optimizeSelectedImages = () =>
    report &&
    optimizeItems(report.missingProxies.filter((m) => selected.has(`m:${m.notePath}`)));

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[250] bg-black/70 flex items-center justify-center p-6"
      onClick={() => { if (working === null) onClose(); }}
    >
      <div
        data-opaque className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[860px] max-w-[94vw] max-h-[88vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
          <Sparkles size={14} className="text-blue-400" />
          <span className="text-sm font-medium text-gray-100">Vault media</span>
          <button
            onClick={() => { void scan(); }}
            disabled={phase === "scanning" || working !== null}
            className="ml-3 text-gray-500 hover:text-gray-200 p-1 disabled:opacity-40"
            title="Rescan the vault"
          >
            <RefreshCw size={13} className={phase === "scanning" ? "animate-spin" : ""} />
          </button>
          <button
            onClick={onClose}
            disabled={working !== null}
            className="ml-auto text-gray-500 hover:text-gray-300 p-0.5 disabled:opacity-40"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {phase === "scanning" && (
            <div className="flex items-center gap-3 py-12 justify-center text-sm text-gray-400">
              <Loader2 size={16} className="animate-spin" />
              <span>Scanning every note and asset folder…</span>
            </div>
          )}

          {phase === "error" && (
            <div className="flex items-start gap-3">
              <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm text-red-300 font-medium">Scan failed.</p>
                <p className="text-xs text-red-400/70 mt-1 break-words">{error}</p>
              </div>
            </div>
          )}

          {phase !== "scanning" && phase !== "error" && report && summary && (
            <>
              <div className="mb-5 flex items-center gap-4 text-xs text-gray-500">
                <span>{report.totalNotes} notes</span>
                <span>·</span>
                <span>{report.totalAssets} asset files</span>
                <span>·</span>
                <span>{fmtBytes(report.totalBytes)} on disk</span>
              </div>

              {/* Always-visible optimization status, so an empty list is
                  explained rather than silent. */}
              {proxyOn && report.imageStats.total > 0 && (
                <div className="mb-4 rounded-md border border-[#2a3136] bg-[#0f1315] px-3 py-2.5 text-[11px] text-gray-400">
                  <div className="flex items-center gap-2 text-xs text-gray-200">
                    <Wrench size={13} className="text-emerald-400" />
                    Image optimization
                    <span className="ml-auto text-gray-500">
                      {report.imageStats.optimized} of {report.imageStats.total} use a WebP proxy ·{" "}
                      {report.imageStats.withThumb} have a thumbnail
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 rounded bg-[#1a1e21] overflow-hidden">
                    <div
                      className="h-full bg-emerald-500/80"
                      style={{ width: `${(report.imageStats.optimized / report.imageStats.total) * 100}%` }}
                    />
                  </div>
                  <div className="mt-1.5 text-[10px] text-gray-500">
                    Originals {fmtBytes(report.imageStats.originalBytes)} · proxies{" "}
                    {fmtBytes(report.imageStats.proxyBytes)}. Only images in .jpg / .png / .avif / .bmp / .tiff
                    are converted; .gif, .svg, and .webp are left as they are.
                  </div>
                </div>
              )}
              {proxyOn && report.imageStats.total === 0 && report.totalNotes > 0 && (
                <div className="mb-4 text-[11px] text-gray-600">
                  No convertible images are referenced by any note yet, so there is nothing to optimize.
                </div>
              )}

              {summary.total === 0 && (
                <div className="text-center py-14">
                  <Check size={28} className="text-emerald-400 mx-auto mb-3" />
                  <p className="text-sm text-gray-200">Everything's in order.</p>
                  <p className="text-xs text-gray-500 mt-1">
                    No leftover folders, no broken references, no unused files.
                  </p>
                </div>
              )}

              {/* ── Old layout ─────────────────────────────────────────── */}
              {report.oldLayout.length > 0 && (
                <Section
                  title={
                    report.oldLayout.length === 1
                      ? "1 folder uses an old naming scheme"
                      : `${report.oldLayout.length} folders use an old naming scheme`
                  }
                  subtitle={
                    <>
                      The app used to store generated files in subfolders called{" "}
                      <code className="px-1 rounded bg-black/40 font-mono">originals/</code>,{" "}
                      <code className="px-1 rounded bg-black/40 font-mono">previews/</code>, and{" "}
                      <code className="px-1 rounded bg-black/40 font-mono">proxy videos/</code>.
                      It now uses a single folder called{" "}
                      <code className="px-1 rounded bg-black/40 font-mono">proxy/</code>. Migrating
                      renames the folder and moves the files inside — your notes are updated to
                      point at the new locations, and nothing is deleted.
                    </>
                  }
                  icon={<FolderOpen size={13} className="text-blue-400" />}
                  onSelectAll={() => selectAllOf(report.oldLayout.map((o) => `o:${o.absPath}`))}
                  onFixAll={fixAllOldLayout}
                  fixAllLabel={
                    report.oldLayout.length === 1
                      ? "Migrate this folder"
                      : `Migrate all ${report.oldLayout.length}`
                  }
                  working={working}
                >
                  {report.oldLayout.map((o) => {
                    const key = `o:${o.absPath}`;
                    return (
                      <Row key={key} checked={selected.has(key)} onToggle={() => toggle(key)}>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-gray-200 truncate" title={o.notePath}>
                            {basename(o.notePath)}
                          </div>
                          <div className="mt-1 space-y-0.5">
                            {o.subfolders.map((sub) => (
                              <div key={sub} className="flex items-center gap-1.5 text-[10px] font-mono">
                                <span className="text-amber-300/90">{sub}/</span>
                                <ArrowRight size={9} className="text-gray-600" />
                                <span className="text-emerald-300/90">
                                  {sub === "proxy videos" ? "proxy/" : "flattened into assets/"}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </Row>
                    );
                  })}
                </Section>
              )}

              {/* ── Proxies switched off ───────────────────────────────── */}
              {report.proxiesOff.length > 0 && (
                <Section
                  title={
                    report.proxiesOff.length === 1
                      ? "1 note has proxies turned off but still has proxy files"
                      : `${report.proxiesOff.length} notes have proxies turned off but still have proxy files`
                  }
                  subtitle={
                    <>
                      You turned image proxies off for these notes, so the extra WebP copies are
                      only taking up space ({fmtBytes(report.proxiesOff.reduce((n, p) => n + p.bytes, 0))} total).
                      Removing re-points each note at its original photos, then moves the WebP
                      proxies and thumbnails to your system trash. Your original photos are not touched.
                    </>
                  }
                  icon={<FolderOpen size={13} className="text-amber-400" />}
                  onSelectAll={() => selectAllOf(report.proxiesOff.map((p) => `p:${p.notePath}`))}
                  onFixAll={() => removeProxies(report.proxiesOff)}
                  fixAllLabel={
                    report.proxiesOff.length === 1 ? "Remove proxies" : `Remove from all ${report.proxiesOff.length}`
                  }
                  extraActions={
                    <button
                      onClick={() => removeProxies(report.proxiesOff.filter((p) => selected.has(`p:${p.notePath}`)))}
                      disabled={working !== null || !report.proxiesOff.some((p) => selected.has(`p:${p.notePath}`))}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded"
                    >
                      <Wrench size={11} /> Remove selected
                    </button>
                  }
                  working={working}
                >
                  {report.proxiesOff.map((p) => {
                    const key = `p:${p.notePath}`;
                    return (
                      <Row key={key} checked={selected.has(key)} onToggle={() => toggle(key)}>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-gray-200 truncate" title={p.notePath}>
                            {basename(p.notePath)}
                          </div>
                          <div className="text-[10px] text-gray-500 mt-0.5">
                            {p.files} proxy/thumbnail files · {fmtBytes(p.bytes)}
                          </div>
                        </div>
                      </Row>
                    );
                  })}
                </Section>
              )}

              {/* ── Missing proxies ────────────────────────────────────── */}
              {report.missingProxies.length > 0 && (
                <Section
                title={
                  report.missingProxies.length === 1
                  ? "1 note has images that need optimizing"
                  : `${report.missingProxies.length} notes have images that need optimizing`
                }
                subtitle={
                  <>
                  A proxy is a 1600px WebP copy (used for full-size viewing) and a thumbnail
                  is a 640px WebP copy (used for gallery tiles and the timeline). The app loads
                  these instead of the original — same picture, far less memory, so
                  scrolling stops stuttering. The original file is <strong>not</strong>{" "}
                  touched or deleted. This will:
                  <ol className="mt-1.5 ml-4 list-decimal space-y-0.5">
                  <li>Encode each image to WebP into the note's <code className="px-1 rounded bg-black/40 font-mono">proxy/</code> folder, plus a small copy in <code className="px-1 rounded bg-black/40 font-mono">proxy/thumb/</code>.</li>
                  <li>Rewrite any references that still point at the original so they use the proxy.</li>
                  </ol>
                  </>
                }
                icon={<Wrench size={13} className="text-emerald-400" />}
                onSelectAll={() => {
                  // Include every note that has missing proxies.
                  const keys = report.missingProxies.map((m) => `m:${m.notePath}`);
                  setSelected(new Set(keys));
                }}
                onFixAll={optimizeAllImages}
                fixAllLabel={
                  report.missingProxies.length === 1
                  ? "Optimize 1 note"
                  : `Optimize all ${report.missingProxies.length}`
                }
                extraActions={
                  <button
                    onClick={optimizeSelectedImages}
                    disabled={working !== null || !report.missingProxies.some((m) => selected.has(`m:${m.notePath}`))}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded"
                  >
                    <Wrench size={11} /> Optimize selected
                  </button>
                }
                working={working}
                >
                {report.missingProxies.map((item) => {
                  const key = `m:${item.notePath}`;
                  const totalBytes = item.sources.reduce((sum, s) => sum + s.size, 0);
                  return (
                    <Row key={key} checked={selected.has(key)} onToggle={() => toggle(key)}>
                    <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-200 truncate" title={item.notePath}>
                    {basename(item.notePath)}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                    {item.sources.length} image{item.sources.length === 1 ? "" : "s"} ·{" "}
                    {fmtBytes(totalBytes)} total ·{" "}
                    {item.sources.filter((s) => !s.hasProxy).length} need a proxy ·{" "}
                    {item.sources.filter((s) => !s.hasThumb).length} need a thumbnail ·{" "}
                    {item.sources.filter((s) => s.refsOriginal).length} still load the full-size original
                    </div>
                    <div className="text-[10px] text-gray-600 mt-0.5 font-mono truncate">
                    {item.sources.slice(0, 3).map((s) => s.name).join(", ")}
                    {item.sources.length > 3 ? `, +${item.sources.length - 3} more` : ""}
                    </div>
                    </div>
                    </Row>
                  );
                })}
                </Section>
              )}

              {/* ── Missing thumbnails ─────────────────────────────────── */}
              {report.missingThumbs.length > 0 && (
                <Section
                title={
                  report.missingThumbs.length === 1
                  ? "1 note has images without a thumbnail"
                  : `${report.missingThumbs.length} notes have images without a thumbnail`
                }
                subtitle={
                  <>
                  Gallery tiles and the journal timeline load a 640px
                  thumbnail for every image. When that file isn't on disk,
                  every tile fires a 404 in the developer console — even
                  when the image itself displays correctly via its
                  full-size original. Rebuilding encodes the thumbnail
                  from the original (or, if the original is gone, from
                  the note's WebP proxy) and writes it to{" "}
                  <code className="px-1 rounded bg-black/40 font-mono">assets/…/proxy/thumb/</code>.
                  The image files themselves are not touched.
                  </>
                }
                icon={<Wrench size={13} className="text-blue-400" />}
                onSelectAll={() =>
                  setSelected(new Set(report.missingThumbs.map((m) => `t:${m.notePath}`)))
                }
                onFixAll={buildAllThumbs}
                fixAllLabel={
                  report.missingThumbs.length === 1
                  ? "Build 1 note's thumbnails"
                  : `Build all ${report.missingThumbs.length}`
                }
                extraActions={
                  <button
                  onClick={buildSelectedThumbs}
                  disabled={
                    working !== null ||
                    !report.missingThumbs.some((m) => selected.has(`t:${m.notePath}`))
                  }
                  className="flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded"
                  >
                  <Wrench size={11} /> Build selected
                  </button>
                }
                working={working}
                >
                {report.missingThumbs.map((item) => {
                  const key = `t:${item.notePath}`;
                  const totalBytes = 0;
                  return (
                    <Row key={key} checked={selected.has(key)} onToggle={() => toggle(key)}>
                    <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-200 truncate" title={item.notePath}>
                    {basename(item.notePath)}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                    {item.sources.length} image
                    {item.sources.length === 1 ? "" : "s"} need a thumbnail
                    {totalBytes > 0 ? ` · ${fmtBytes(totalBytes)}` : ""}
                    </div>
                    <div className="text-[10px] text-gray-600 mt-0.5 font-mono truncate">
                    {item.sources.slice(0, 3).map((s) => s.name).join(", ")}
                    {item.sources.length > 3
                      ? `, +${item.sources.length - 3} more`
                      : ""}
                      </div>
                      </div>
                      </Row>
                  );
                })}
                </Section>
              )}


              {/* ── Broken references ──────────────────────────────────── */}
              {report.brokenRefs.length > 0 && (
                <Section
                  title={
                    report.brokenRefs.length === 1
                      ? "1 note points at a file that isn't where it expects"
                      : `${report.brokenRefs.length} notes point at files that aren't where they expect`
                  }
                  subtitle={
                    <>
                      These notes reference a file (an image, video, or cover) whose path no longer
                      exists. Repair will look for the file in the old locations and either move it
                      back or rebuild it from the original source. If the file is truly gone, the
                      row is marked "cannot fix" and repair is skipped.
                    </>
                  }
                  icon={<AlertTriangle size={13} className="text-amber-400" />}
                  onSelectAll={() => selectAllOf(report.brokenRefs.map((b) => `b:${b.notePath}:${b.raw}`))}
                  onFixAll={fixAllBroken}
                  fixAllLabel="Repair all fixable"
                  extraActions={
                    <>
                      <button
                        onClick={fixSelectedBroken}
                        disabled={working !== null || selected.size === 0}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded"
                      >
                        <Wrench size={11} /> Repair selected
                      </button>
                      <button
                        onClick={removeSelectedBroken}
                        disabled={working !== null || selected.size === 0}
                        className="flex items-center gap-1 px-2.5 py-1 text-xs bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded"
                      >
                        <Trash2 size={11} /> Remove selected
                      </button>
                    </>
                  }
                  working={working}
                >
                  {report.brokenRefs.map((b) => {
                    const key = `b:${b.notePath}:${b.raw}`;
                    return (
                      <Row key={key} checked={selected.has(key)} onToggle={() => toggle(key)}>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-gray-200 truncate" title={b.notePath}>
                            {basename(b.notePath)}
                          </div>
                          <div className="text-[10px] text-gray-500 font-mono break-all mt-0.5">
                            note says: {b.raw}
                          </div>
                          <div className="text-[10px] text-gray-400 font-mono break-all mt-0.5">
                            resolves to: {b.absPath}
                          </div>
                          <div className="mt-1">
                            <FixBadge fix={b.fix} />
                          </div>
                        </div>
                      </Row>
                    );
                  })}
                </Section>
              )}

              {/* ── Unused files ───────────────────────────────────────── */}
              {report.unusedFiles.length > 0 && (
                <Section
                  title={
                    report.unusedFiles.length === 1
                      ? "1 file isn't used by any note"
                      : `${report.unusedFiles.length} files aren't used by any note`
                  }
                  subtitle={
                    <>
                      Nothing in your notes references these files. <strong>Trash</strong> moves
                      them to your system's trash — you can restore them from there if you change
                      your mind. <strong>Keep</strong> writes the filename to a{" "}
                      <code className="px-1 rounded bg-black/40 font-mono">keep.json</code> file in
                      the same folder, so future scans will ignore it.
                    </>
                  }
                  icon={<Trash2 size={13} className="text-red-400" />}
                  onSelectAll={() => selectAllOf(report.unusedFiles.map((u) => `u:${u.absPath}`))}
                  extraActions={
                    <>
                      <button
                        onClick={keepSelectedUnused}
                        disabled={working !== null || selected.size === 0}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200"
                        title="Add these filenames to keep.json so they stop showing up here"
                      >
                        <ShieldOff size={12} /> Keep selected
                      </button>
                      <button
                        onClick={trashSelectedUnused}
                        disabled={working !== null || selected.size === 0}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-red-600/90 hover:bg-red-500 disabled:opacity-40 text-white rounded"
                        title="Move these files to your system trash (recoverable)"
                      >
                        <Trash2 size={12} /> Trash selected
                      </button>
                    </>
                  }
                  working={working}
                >
                  {report.unusedFiles.map((u) => (
                    <Row key={`u:${u.absPath}`} checked={selected.has(`u:${u.absPath}`)} onToggle={() => toggle(`u:${u.absPath}`)}>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-200 truncate font-mono" title={u.absPath}>
                          {basename(u.absPath)}
                        </div>
                        <div className="text-[10px] text-gray-500 font-mono truncate mt-0.5" title={u.absPath}>
                          {u.absPath}
                        </div>
                      </div>
                      <span className="text-[10px] text-gray-500 tabular-nums flex-shrink-0">
                        {(u.size / 1024).toFixed(0)} KB
                      </span>
                    </Row>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>

        {working !== null && (
          <div className="border-t border-[#2a3136] bg-[#1a1e21] px-4 py-3 flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={12} className="animate-spin" />
            <span>{working}…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

/** Small badge that describes what the repair operation will do. */
function FixBadge({ fix }: { fix: BrokenRef["fix"] }) {
  if (fix.kind === "unfixable") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-300">
        <HelpCircle size={9} /> Cannot fix — file not found anywhere. You can remove it.
      </span>
    );
  }
  if (fix.kind === "move") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
        <Wrench size={9} /> Move file from {basename(fix.from)} → expected location
      </span>
    );
  }
  if (fix.kind === "downgrade") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-blue-500/40 bg-blue-500/10 text-blue-300">
        <Wrench size={9} /> Restore original: {basename(fix.original)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
      <Wrench size={9} /> Rebuild from source: {basename(fix.source)}
    </span>
  );
}

function Section({
  title, subtitle, icon, children, onSelectAll, onFixAll, fixAllLabel,
  extraActions, working,
}: {
  title: string;
  subtitle?: React.ReactNode;
  icon: React.ReactNode;
  children: React.ReactNode;
  onSelectAll: () => void;
  onFixAll?: () => void;
  fixAllLabel?: string;
  extraActions?: React.ReactNode;
  working: string | null;
}) {
  return (
    <div className="mb-4 rounded-md border border-[#2a3136] bg-[#0f1315] overflow-hidden">
      <div className="px-3 py-2 border-b border-[#2a3136] flex items-center gap-2 flex-wrap">
        {icon}
        <span className="text-xs font-medium text-gray-200">{title}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onSelectAll}
            className="text-[11px] text-gray-500 hover:text-gray-200 px-2 py-0.5"
          >
            Select all
          </button>
          {onFixAll && (
            <button
              onClick={onFixAll}
              disabled={working !== null}
              className="flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded"
            >
              <Wrench size={11} /> {fixAllLabel}
            </button>
          )}
          {extraActions}
        </div>
      </div>
      {subtitle && (
        <div className="px-3 py-2 text-[11px] text-gray-400 leading-relaxed border-b border-[#1a1e21]">
          {subtitle}
        </div>
      )}
      <div className="max-h-80 overflow-y-auto divide-y divide-[#1a1e21]">
        {children}
      </div>
    </div>
  );
}

function Row({
  checked, onToggle, children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 px-3 py-2 hover:bg-[#141819] cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-blue-500 flex-shrink-0 mt-0.5"
      />
      {children}
    </label>
  );
}
