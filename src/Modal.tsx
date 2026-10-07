// src/Modal.tsx
import { useCallback, useState } from "react";

type ModalState =
  | { type: "prompt"; message: string; resolve: (v: string | null) => void }
  | { type: "confirm"; message: string; resolve: (v: boolean) => void }
  | null;

// Tauri's webview often doesn't implement window.prompt/confirm (they can
// silently resolve to null/false with no dialog shown at all), which is why
// "add" and "remove" actions built on them can look like they do nothing.
// This hook provides an equivalent in-app modal that always works.
//
// Concurrency: if a second prompt/confirm fires while one is still open
// (e.g. a double-click), the previous promise is resolved with its cancel
// value — otherwise its awaiting caller would hang forever.
export function useModal() {
  const [state, setState] = useState<ModalState>(null);
  const [inputValue, setInputValue] = useState("");

  const promptAsync = useCallback((message: string, defaultValue = "") => {
    return new Promise<string | null>((resolve) => {
      setInputValue(defaultValue);
      setState((prev) => {
        if (prev) {
          if (prev.type === "prompt") prev.resolve(null);
          else prev.resolve(false);
        }
        return { type: "prompt", message, resolve };
      });
    });
  }, []);

  const confirmAsync = useCallback((message: string) => {
    return new Promise<boolean>((resolve) => {
      setState((prev) => {
        if (prev) {
          if (prev.type === "prompt") prev.resolve(null);
          else prev.resolve(false);
        }
        return { type: "confirm", message, resolve };
      });
    });
  }, []);

  const close = (result: any) => {
    if (state) {
      if (state.type === "prompt") state.resolve(result as string | null);
      else state.resolve(result as boolean);
    }
    setState(null);
  };

  const modal =
    state === null ? null : (
      <div
        className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200]"
        onClick={() => close(state.type === "prompt" ? null : false)}
      >
        <div
          className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-80 p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-sm text-gray-200 mb-3">{state.message}</p>
          {state.type === "prompt" && (
            <input
              autoFocus
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") close(inputValue.trim());
                if (e.key === "Escape") close(null);
              }}
              className="w-full bg-[#0f1315] border border-[#30363d] rounded px-3 py-2 text-sm text-gray-100 outline-none focus:ring-1 focus:ring-blue-500 mb-1"
            />
          )}
          <div className="flex justify-end space-x-2 mt-4">
            <button
              onClick={() => close(state.type === "prompt" ? null : false)}
              className="text-xs px-3 py-1.5 rounded text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] cursor-pointer transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => close(state.type === "prompt" ? inputValue.trim() : true)}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white cursor-pointer transition-colors"
            >
              {state.type === "prompt" ? "OK" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    );

  return { modal, promptAsync, confirmAsync };
}