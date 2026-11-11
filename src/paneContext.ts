// src/paneContext.ts
import { createContext, useContext } from "react";

/** When true, every useNoteMode() under this provider reports "read". */
export const ForceReadContext = createContext(false);

/** Which pane currently has focus (global key handlers check this). */
export const PaneActiveContext = createContext(true);

export function usePaneActive(): boolean {
    return useContext(PaneActiveContext);
}
