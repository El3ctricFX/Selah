// src/PasswordModal.tsx
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Lock, Loader2, X } from "lucide-react";

export default function PasswordModal({
    title, description, requireConfirm = false, submitLabel = "OK",
    onSubmit, onClose, secondaryLabel, onSecondary,
}: {
    title: string;
    description?: string;
    requireConfirm?: boolean;
    submitLabel?: string;
    /** Return a string to show as a message (modal stays open). Return nothing on success. */
    onSubmit: (password: string) => Promise<string | void>;
    onClose: () => void;
    secondaryLabel?: string;
    onSecondary?: () => void;
}) {
    const [pw, setPw] = useState("");
    const [pw2, setPw2] = useState("");
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, [busy, onClose]);

    const go = async () => {
        if (busy) return;
        if (!pw) { setErr("Enter a password."); return; }
        if (requireConfirm && pw !== pw2) { setErr("Passwords don't match."); return; }
        setBusy(true);
        setErr(null);
        try {
            const msg = await onSubmit(pw);
            if (msg) { setErr(msg); setPw(""); setPw2(""); }
        } catch (e: any) {
            setErr(e?.message ?? String(e));
        } finally {
            setBusy(false);
        }
    };

    const input =
    "w-full bg-[#0f1315] border border-[#30363d] rounded px-3 py-2 text-sm text-gray-100 outline-none focus:ring-1 focus:ring-blue-500";

            return createPortal(
                <div
                className="fixed inset-0 z-[900] bg-black/70 flex items-center justify-center p-6"
                onClick={() => { if (!busy) onClose(); }}
                >
                <div
                data-opaque
                className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[400px] max-w-[92vw] overflow-hidden"
                onClick={(e) => e.stopPropagation()}
                >
                <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21]">
                <Lock size={14} className="text-blue-400" />
                <span className="text-sm font-medium text-gray-100">{title}</span>
                <button
                onClick={onClose}
                disabled={busy}
                className="ml-auto text-gray-500 hover:text-gray-300 p-0.5 disabled:opacity-40"
                >
                <X size={14} />
                </button>
                </div>

                <div className="p-4 space-y-3">
                {description && <p className="text-xs text-gray-400 leading-relaxed">{description}</p>}
                <input
                autoFocus
                type="password"
                value={pw}
                onChange={(e) => { setPw(e.target.value); setErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void go(); }}
                placeholder="Password"
                className={input}
                />
                {requireConfirm && (
                    <>
                    <input
                    type="password"
                    value={pw2}
                    onChange={(e) => { setPw2(e.target.value); setErr(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void go(); }}
                    placeholder="Confirm password"
                    className={input}
                    />
                    <p className="text-[10px] text-amber-300/90 leading-snug">
                    There is no recovery. If you forget this password, the note can't be opened.
                    </p>
                    </>
                )}
                {err && <p className="text-xs text-red-400 leading-snug">{err}</p>}

                <div className="flex items-center justify-end gap-2 pt-1">
                {secondaryLabel && onSecondary && (
                    <button
                    type="button"
                    onClick={onSecondary}
                    disabled={busy}
                    className="mr-auto px-2 py-1.5 text-[11px] text-gray-500 hover:text-gray-200 disabled:opacity-40"
                    >
                    {secondaryLabel}
                    </button>
                )}
                <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded disabled:opacity-40"
                >
                Cancel
                </button>
                <button
                type="button"
                onClick={() => void go()}
                disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white rounded font-medium"
                >
                {busy && <Loader2 size={11} className="animate-spin" />}
                {submitLabel}
                </button>
                </div>
                </div>
                </div>
                </div>,
                document.body
            );
}
