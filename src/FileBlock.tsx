// src/FileBlock.tsx
import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useState } from "react";
import { stat } from "@tauri-apps/plugin-fs";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    FileArchive, FileCode, FileText, File as FileIcon,
    ExternalLink, FolderOpen, Paperclip, AlertTriangle,
} from "lucide-react";
import { useNoteMode } from "./useNoteMode";
import { useNoteContext } from "./NoteContext";
import { assetUrlToAbsolutePath } from "./imageAssets";

function resolveToAbsolute(src: string, noteDir: string): string {
    if (!src) return "";
    const fromAsset = assetUrlToAbsolutePath(src);
    if (fromAsset) return fromAsset;
    if (/^([a-zA-Z]:[\\/]|\/)/.test(src)) return src;
    if (noteDir) {
        const sep = noteDir.includes("\\") ? "\\" : "/";
        return noteDir.replace(/[\\/]+$/, "") + sep + src;
    }
    return src;
}

function fmtBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
}

function iconFor(name: string) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(ext)) return FileArchive;
    if (/^(html?|js|ts|css|json|xml|py|rs)$/.test(ext)) return FileCode;
    if (/^(pdf|txt|md|rtf|docx?|odt)$/.test(ext)) return FileText;
    return FileIcon;
}

export const createAttachment = createReactBlockSpec(
    {
        type: "attachment",
        propSchema: {
            src: { default: "" },
            caption: { default: "" },
            fileName: { default: "" },
        },
        content: "none",
    },
    {
        render: (props) => {
            const live = props.editor.getBlock(props.block.id) ?? props.block;
            const src = (live.props.src as string) || "";
            const caption = (live.props.caption as string) || "";
            const fileName = (live.props.fileName as string) || "";

            const { mode } = useNoteMode();
            const isRead = mode === "read";
            const noteCtx = useNoteContext();
            const noteDir = noteCtx?.noteDir || "";
            const abs = src ? resolveToAbsolute(src, noteDir) : "";

            const [bytes, setBytes] = useState<number | null>(null);
            const [missing, setMissing] = useState(false);

            useEffect(() => {
                if (!abs) return;
                let cancelled = false;
                setMissing(false);
                stat(abs)
                .then((s) => { if (!cancelled) setBytes(s.size ?? 0); })
                .catch(() => { if (!cancelled) setMissing(true); });
                return () => { cancelled = true; };
            }, [abs]);

            const update = (patch: Record<string, any>) => {
                try { props.editor.updateBlock(props.block.id, { props: patch }); }
                catch (e) { console.error("[attachment] updateBlock failed:", e); }
            };
            const stopRight = (e: React.MouseEvent) => {
                if (e.button === 2) { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }
            };
            const open = () => {
                if (abs) openPath(abs).catch((e) => console.error("[attachment] open failed:", e));
            };
                const reveal = () => {
                    if (abs) revealItemInDir(abs).catch((e) => console.error("[attachment] reveal failed:", e));
                };

                    if (!src) {
                        return (
                            <div
                            className="my-2 w-full rounded-md border border-dashed border-[#30363d] bg-[#0f1315] py-6 flex flex-col items-center gap-2 text-gray-500 text-xs"
                            contentEditable={false}
                            onMouseDown={stopRight}
                            >
                            <Paperclip size={20} className="opacity-50" />
                            <span>Empty file block — use / → Upload file</span>
                            </div>
                        );
                    }

                    const Icon = iconFor(fileName || src);
                    const showFooter = !isRead || !!caption;

                    return (
                        <div
                        className="my-2 w-full rounded-md border border-[#2a3136] bg-[#161a1d] overflow-hidden"
                        contentEditable={false}
                        onMouseDown={stopRight}
                        >
                        <div className="flex items-center gap-3 p-3">
                        <div className="w-10 h-10 rounded-md bg-[#1e2327] flex items-center justify-center flex-shrink-0">
                        {missing
                            ? <AlertTriangle size={18} className="text-amber-400" />
                            : <Icon size={18} className="text-blue-400" />}
                            </div>

                            <button
                            type="button"
                            onClick={open}
                            disabled={missing}
                            className="flex-1 min-w-0 text-left disabled:cursor-not-allowed"
                            title={missing ? "File not found" : "Open with default app"}
                            >
                            <div className="text-sm text-gray-100 truncate">{fileName || src}</div>
                            <div className="text-[11px] text-gray-500 mt-0.5">
                            {missing ? "File not found on disk" : bytes !== null ? fmtBytes(bytes) : "…"}
                            </div>
                            </button>

                            <button
                            type="button"
                            onClick={open}
                            disabled={missing}
                            className="p-1.5 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136] transition-colors disabled:opacity-40"
                            title="Open"
                            >
                            <ExternalLink size={13} />
                            </button>
                            <button
                            type="button"
                            onClick={reveal}
                            disabled={missing}
                            className="p-1.5 rounded text-gray-500 hover:text-gray-100 hover:bg-[#2a3136] transition-colors disabled:opacity-40"
                            title="Show in folder"
                            >
                            <FolderOpen size={13} />
                            </button>

                            </div>

                            {showFooter && (
                                <div className="px-3 py-1.5 border-t border-[#2a3136] bg-[#1a1e21]">
                                {isRead ? (
                                    <div className="text-xs text-gray-300">{caption}</div>
                                ) : (
                                    <input
                                    type="text"
                                    value={caption}
                                    onChange={(e) => update({ caption: e.target.value })}
                                    placeholder="Caption (optional)…"
                                    className="w-full bg-transparent border-none outline-none text-xs text-gray-200 placeholder-gray-600"
                                    />
                                )}
                                </div>
                            )}
                            </div>
                    );
        },
    }
);
