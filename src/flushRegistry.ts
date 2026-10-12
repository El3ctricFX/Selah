// src/flushRegistry.ts
type Flusher = () => Promise<void>;

const flushers = new Set<Flusher>();

export function registerFlusher(fn: Flusher): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

export async function flushAll(): Promise<void> {
  await Promise.allSettled(Array.from(flushers).map((fn) => fn()));
}