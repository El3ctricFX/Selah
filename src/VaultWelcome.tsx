// src/VaultWelcome.tsx
import { useEffect, useState } from "react";
import { Folder, Plus, Trash2 } from "lucide-react";
import { type RecentVault, vaultStillExists } from "./useRecentVaults";

interface VaultWelcomeProps {
  recentVaults: RecentVault[];
  onOpenVault: () => void;
  onSelectVault: (path: string) => void;
  onRemoveVault: (path: string) => void;
}

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  try {
    return new Date(ts).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export default function VaultWelcome({
  recentVaults,
  onOpenVault,
  onSelectVault,
  onRemoveVault,
}: VaultWelcomeProps) {
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    vault: RecentVault;
  } | null>(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());

  // Check which paths no longer exist on disk (moved / renamed / deleted).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const gone = new Set<string>();
      for (const v of recentVaults) {
        if (!(await vaultStillExists(v.path))) gone.add(v.path);
      }
      if (!cancelled) setMissing(gone);
    })();
    return () => {
      cancelled = true;
    };
  }, [recentVaults]);

  // Close the context menu on outside click or Escape.
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  return (
    <div className="w-screen h-screen bg-[#0f1315] flex flex-col items-center justify-center text-gray-200 px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold mb-2">Selah</h1>
          <p className="text-gray-500 text-sm">
            Pick a vault to continue, or open a new one.
          </p>
        </div>

        {recentVaults.length > 0 && (
          <div className="mb-6">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2 px-1">
              Recent vaults
            </div>
            <div className="space-y-1.5">
              {recentVaults.map((v) => {
                const isMissing = missing.has(v.path);
                return (
                  <button
                    key={v.path}
                    type="button"
                    disabled={isMissing}
                    onClick={() => onSelectVault(v.path)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtxMenu({ x: e.clientX, y: e.clientY, vault: v });
                    }}
                    title={v.path}
                    className={`w-full text-left rounded-md border px-3 py-2.5 transition-colors flex items-center gap-3 group ${
                      isMissing
                        ? "border-[#2a3136] bg-[#161a1d] opacity-50 cursor-not-allowed"
                        : "border-[#2a3136] bg-[#161a1d] hover:border-[#3a4147] hover:bg-[#1a1e21] cursor-pointer"
                    }`}
                  >
                    <Folder
                      size={16}
                      className={
                        isMissing
                          ? "text-gray-600 flex-shrink-0"
                          : "text-amber-400 flex-shrink-0"
                      }
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-100 truncate">
                        {v.name}
                      </div>
                      <div className="text-[10px] text-gray-500 truncate font-mono mt-0.5">
                        {isMissing
                          ? "missing — right-click to remove"
                          : v.path}
                      </div>
                    </div>
                    <span className="text-[10px] text-gray-600 flex-shrink-0 ml-2">
                      {fmtRelative(v.lastOpened)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <button
          onClick={onOpenVault}
          className="w-full flex items-center justify-center gap-2 bg-[#1e2327] hover:bg-[#2a3136] border border-[#30363d] px-6 py-3 rounded text-sm font-medium transition-colors cursor-pointer"
        >
          <Plus size={14} />
          <span>{recentVaults.length > 0 ? "Open another vault…" : "Open Vault"}</span>
        </button>

        {recentVaults.length > 0 && (
          <p className="text-[10px] text-gray-600 text-center mt-3">
            Right-click a recent vault to remove it from the list.
          </p>
        )}
      </div>

      {ctxMenu && (
        <div
          className="fixed z-50 bg-[#1e2327] border border-[#2a3136] rounded-md shadow-xl py-1 w-52"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onRemoveVault(ctxMenu.vault.path);
              setCtxMenu(null);
            }}
            className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-[#2a3136] flex items-center gap-2"
          >
            <Trash2 size={13} />
            <span>Remove from list</span>
          </button>
        </div>
      )}
    </div>
  );
}