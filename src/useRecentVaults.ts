// src/useRecentVaults.ts
import { useCallback, useEffect, useState } from "react";
import { exists } from "@tauri-apps/plugin-fs";

export interface RecentVault {
  path: string;
  name: string;
  lastOpened: number;
}

const KEY = "selah-recent-vaults";
const MAX = 20;

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function load(): RecentVault[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (v): v is RecentVault =>
        v &&
        typeof v.path === "string" &&
        typeof v.name === "string" &&
        typeof v.lastOpened === "number"
    );
  } catch {
    return [];
  }
}

function save(list: RecentVault[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {}
}

export function useRecentVaults() {
  const [vaults, setVaults] = useState<RecentVault[]>(() => load());

  useEffect(() => {
    save(vaults);
  }, [vaults]);

  const add = useCallback((path: string) => {
    setVaults((prev) => {
      const filtered = prev.filter((v) => v.path !== path);
      const next: RecentVault[] = [
        { path, name: basename(path), lastOpened: Date.now() },
        ...filtered,
      ];
      return next.slice(0, MAX);
    });
  }, []);

  const remove = useCallback((path: string) => {
    setVaults((prev) => prev.filter((v) => v.path !== path));
  }, []);

  return { vaults, add, remove };
}

/** Async check used by the welcome screen to grey out missing entries. */
export async function vaultStillExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch {
    return false;
  }
}