// src/CommunityPlugins.tsx
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Store, RefreshCw, Download, Check, ExternalLink, AlertTriangle, Loader2 } from "lucide-react";
import { usePlugins } from "./plugins";
import { useModal } from "./Modal";
import {
    fetchRegistry, installFromRegistry, readInstallInfo, entrySourceUrl, REGISTRY_REPO,
    type RegistryEntry,
} from "./registry";

export default function CommunityPlugins({ vaultPath }: { vaultPath: string }) {
    const { plugins } = usePlugins();
    const { modal, confirmAsync } = useModal();
    const [entries, setEntries] = useState<RegistryEntry[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [installed, setInstalled] = useState<Record<string, string>>({}); // id -> commit
    const [query, setQuery] = useState("");

    const refresh = async () => {
        setLoading(true);
        setError(null);
        try { setEntries(await fetchRegistry()); }
        catch (e: any) { setError(e?.message ?? String(e)); }
        finally { setLoading(false); }
    };

    // Auto-fetch when the modal opens
    useEffect(() => {
        refresh();
    }, []);

    useEffect(() => {
        if (!entries) return;
        let cancelled = false;
        (async () => {
            const map: Record<string, string> = {};
            for (const e of entries) {
                const info = await readInstallInfo(vaultPath, e.id);
                if (info) map[e.id] = info.commit;
            }
            if (!cancelled) setInstalled(map);
        })();
            return () => { cancelled = true; };
    }, [entries, plugins, vaultPath]);

    const install = async (e: RegistryEntry, isUpdate: boolean) => {
        // Check if this plugin belongs to the registry maintainer
        const isMaintainer = e.repo.split('/')[0].toLowerCase() === REGISTRY_REPO.split('/')[0].toLowerCase();

        // Only show the confirmation dialog for non-maintainer plugins
        if (!isMaintainer) {
            const ok = await confirmAsync(
                `${isUpdate ? "Update" : "Install"} "${e.name}" v${e.version} by ${e.author}?\n\n` +
                `Plugins are code that runs inside Selah and can read and write your vault. ` +
                `This one was reviewed for the community registry, but you can inspect it first via the source link.`
            );
            if (!ok) return;
        }

        setBusyId(e.id);
        setError(null);
        try { await installFromRegistry(vaultPath, e); }
        catch (err: any) { setError(err?.message ?? String(err)); }
        finally { setBusyId(null); }
    };

    const q = query.trim().toLowerCase();
    const shown = (entries || []).filter(
        (e) => !q || `${e.name} ${e.description} ${e.author}`.toLowerCase().includes(q)
    );

    return (
        <div className="flex flex-col h-full min-h-0">
        {modal}
        <div className="flex items-center gap-2 mb-2 flex-shrink-0">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 flex items-center gap-1.5">
        <Store size={10} /> Community plugins
        </div>
        <button
        type="button"
        onClick={refresh}
        disabled={loading}
        className="ml-auto flex items-center gap-1.5 px-2.5 py-1 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 cursor-pointer"
        >
        <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        Refresh
        </button>
        </div>

        {error && (
            <div className="mb-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-300 flex-shrink-0">
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            <span className="break-words">{error}</span>
            </div>
        )}

        {!entries && loading && (
            <div className="flex items-center justify-center py-10 text-gray-500">
            <Loader2 size={24} className="animate-spin" />
            </div>
        )}

        {!entries && !loading && !error && (
            <p className="text-xs text-gray-500 flex-shrink-0">
            Every plugin here was reviewed and pinned to an exact version in{" "}
            <span className="font-mono">{REGISTRY_REPO}</span>.
            </p>
        )}

        {entries && (
            <div className="flex flex-col h-full min-h-0">
            <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search community plugins…"
            className="w-full mb-2 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500 flex-shrink-0"
            />
            {shown.length === 0 ? (
                <p className="text-xs text-gray-500 italic flex-shrink-0">No plugins found.</p>
            ) : (
                <div className="space-y-1.5 overflow-y-auto pr-2 pb-4">
                {shown.map((e) => {
                    const have = installed[e.id];
                    const upToDate = have === e.commit;
                    const manual = !have && plugins.some((p) => p.id === e.id);

                    // Badge logic: Official if authored by the registry maintainer, or custom badge
                    const isMaintainer = e.repo.split('/')[0].toLowerCase() === REGISTRY_REPO.split('/')[0].toLowerCase();
                    const badgeText = isMaintainer ? "Official" : e.badge;
                    const badgeColor = isMaintainer
                    ? "bg-blue-500/20 text-blue-300 border-blue-500/30"
                    : "bg-purple-500/20 text-purple-300 border-purple-500/30";

                    return (
                        <div key={e.id} className="rounded-md border border-[#2a3136] bg-[#131819] px-3 py-2.5">
                        <div className="flex items-center gap-2">
                        <span className="text-base leading-none w-6 text-center flex-shrink-0">{e.icon || "🧩"}</span>
                        <div className="flex-1 min-w-0">
                        <div className="text-xs text-gray-100 flex items-center gap-2 truncate">
                        <span className="truncate">{e.name}</span>
                        {badgeText && (
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${badgeColor}`}>
                            {badgeText}
                            </span>
                        )}
                        <span className="text-[10px] text-gray-500 font-mono">v{e.version}</span>
                        <span className="text-[10px] text-gray-500">by {e.author}</span>
                        </div>
                        <div className="text-[10px] text-gray-500 truncate">{e.description}</div>
                        </div>
                        <button
                        type="button"
                        onClick={() => openUrl(entrySourceUrl(e)).catch(() => {})}
                        className="p-1 text-gray-500 hover:text-gray-200"
                        title="View source (pinned commit)"
                        >
                        <ExternalLink size={12} />
                        </button>
                        {busyId === e.id ? (
                            <Loader2 size={14} className="animate-spin text-blue-400" />
                        ) : upToDate ? (
                            <span className="flex items-center gap-1 text-[11px] text-green-400"><Check size={12} /> Installed</span>
                        ) : manual ? (
                            <span className="text-[10px] text-gray-500">Installed manually</span>
                        ) : (
                            <button
                            type="button"
                            onClick={() => install(e, !!have)}
                            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded cursor-pointer"
                            >
                            <Download size={11} /> {have ? "Update" : "Install"}
                            </button>
                        )}
                        </div>
                        {e.permissions && e.permissions.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                            {e.permissions.map((p: string) => (
                                <span key={p} className="text-[9px] px-1.5 py-0.5 rounded border border-[#30363d] bg-[#0f1315] text-gray-500 font-mono">{p}</span>
                            ))}
                            </div>
                        )}
                        </div>
                    );
                })}
                </div>
            )}
            </div>
        )}
        </div>
    );
}
