// src/useNoteMode.ts
import { useEffect, useState } from "react";

const MODE_KEY = "note-mode";
const MODE_EVENT = "note-mode-changed";

export type NoteMode = "edit" | "read";

// Shared edit/read mode. Persisted to localStorage, broadcast across
// components so every toggle button and every NoteBody stays in sync.
export function useNoteMode() {
  const [mode, setModeState] = useState<NoteMode>(
    () => (localStorage.getItem(MODE_KEY) as NoteMode) || "edit"
  );

  useEffect(() => {
    const handler = () => {
      setModeState((localStorage.getItem(MODE_KEY) as NoteMode) || "edit");
    };
    window.addEventListener(MODE_EVENT, handler);
    return () => window.removeEventListener(MODE_EVENT, handler);
  }, []);

  const setMode = (next: NoteMode) => {
    localStorage.setItem(MODE_KEY, next);
    window.dispatchEvent(new Event(MODE_EVENT));
  };

  const toggle = () => setMode(mode === "edit" ? "read" : "edit");

  return { mode, setMode, toggle };
}