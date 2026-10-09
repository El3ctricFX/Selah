// src/NoteContext.tsx
import { createContext, useContext } from "react";

export interface NoteContextValue {
  /** Absolute path to the note file (.selah) */
  notePath: string;
  /** Absolute path to the note's parent directory */
  noteDir: string;
}

export const NoteContext = createContext<NoteContextValue | null>(null);

export function useNoteContext(): NoteContextValue | null {
  return useContext(NoteContext);
}