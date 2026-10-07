// src/Bookmark.tsx
import { createReactBlockSpec } from "@blocknote/react";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Bookmark as BookmarkIcon,
  ExternalLink,
  Play as PlayIcon,
} from "lucide-react";
import { getEmbedInfo } from "./embeds";

export const createBookmark = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: {
      url: { default: "" },
      title: { default: "" },
      description: { default: "" },
      icon: { default: "" },
      image: { default: "" },
      mode: { default: "bookmark" },
    },
    content: "none",
  },
  {
    render: (props) => {
      const live = props.editor.getBlock(props.block.id) ?? props.block;
      const url = (live.props.url as string) || "";
      const title = (live.props.title as string) || url;
      const description = (live.props.description as string) || "";
      const icon = (live.props.icon as string) || "";
      const image = (live.props.image as string) || "";
      const mode = ((live.props.mode as string) || "bookmark") as
        | "bookmark"
        | "embed";

      const [iconError, setIconError] = useState(false);
      const [imageError, setImageError] = useState(false);

      const embed = getEmbedInfo(url);
      const canReliablyEmbed = !!embed && embed.reliable;
      // Only render the iframe if the provider is actually reliable. If a
      // note was saved with mode="embed" on a YouTube link, we fall back to
      // the bookmark card instead of showing a broken player.
      const showingEmbed = mode === "embed" && canReliablyEmbed;

      let hostname = "";
      try {
        hostname = new URL(url).hostname.replace(/^www\./, "");
      } catch {}

      const setMode = (next: "bookmark" | "embed") => {
        try {
          props.editor.updateBlock(props.block.id, { props: { mode: next } });
        } catch (e) {
          console.error("[bookmark] setMode failed:", e);
        }
      };

      const openExternal = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (url) openUrl(url).catch(console.error);
      };

      // ---------- EMBED MODE ----------
      if (showingEmbed && embed) {
        const bodyStyle: React.CSSProperties = embed.height
          ? { height: `${embed.height}px` }
          : { aspectRatio: `${embed.aspectRatio}` };

        return (
          <div
            className="my-2 w-full"
            contentEditable={false}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="rounded-md overflow-hidden border border-[#2a3136] bg-[#0f1315] group">
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-[#161a1d] border-b border-[#2a3136]">
                {icon && !iconError && (
                  <img
                    src={icon}
                    alt=""
                    className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                    onError={() => setIconError(true)}
                  />
                )}
                <span className="text-xs text-gray-300 truncate flex-1 min-w-0">
                  {title || hostname || url}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-gray-500 flex-shrink-0">
                  {embed.label}
                </span>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMode("bookmark");
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 p-0.5 transition-opacity"
                  title="Show as bookmark card"
                >
                  <BookmarkIcon size={12} />
                </button>
                <button
                  onClick={openExternal}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 p-0.5 transition-opacity"
                  title="Open in browser"
                >
                  <ExternalLink size={12} />
                </button>
              </div>

              <div className="w-full bg-black" style={bodyStyle}>
                <iframe
                  src={embed.src}
                  className="w-full h-full border-0 block"
                  allow={embed.allow}
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
            </div>
          </div>
        );
      }

      // ---------- BOOKMARK MODE ----------
      return (
        <div
          className="my-2 w-full flex group"
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            onClick={openExternal}
            className="flex-1 flex border border-[#2a3136] rounded-md overflow-hidden bg-[#161a1d] hover:bg-[#1a1e21] cursor-pointer transition-colors"
            title={url}
          >
            <div className="flex-1 p-3 min-w-0 flex flex-col justify-center">
              <div className="text-sm text-gray-100 font-medium truncate">
                {title || url || "Untitled link"}
              </div>
              {description && (
                <div className="text-xs text-gray-400 mt-1 leading-relaxed line-clamp-3">
                  {description}
                </div>
              )}
              <div className="flex items-center gap-1.5 mt-2 text-[11px] text-gray-500 min-w-0">
                {icon && !iconError && (
                  <img
                    src={icon}
                    alt=""
                    className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
                    onError={() => setIconError(true)}
                  />
                )}
                <span className="truncate">{hostname || url}</span>
              </div>
            </div>

            {image && !imageError && (
              <div className="w-40 flex-shrink-0 bg-[#0f1315]">
                <img
                  src={image}
                  alt=""
                  className="w-full h-full object-cover"
                  onError={() => setImageError(true)}
                />
              </div>
            )}
          </div>

          {canReliablyEmbed && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMode("embed");
              }}
              className="ml-1 opacity-0 group-hover:opacity-100 self-stretch px-2 rounded-md bg-[#1e2327] border border-[#2a3136] text-gray-400 hover:text-gray-100 transition-all flex items-center gap-1 text-[11px]"
              title={`Embed with ${embed?.label}`}
            >
              <PlayIcon size={11} />
              <span>Embed</span>
            </button>
          )}
        </div>
      );
    },
  }
);