// src/embeds.ts
export type EmbedInfo = {
  id: string;
  label: string;
  src: string;
  aspectRatio: number;
  height?: number;
  allow?: string;
  /**
   * True if the iframe is expected to actually render and play inside a Tauri
   * webview. YouTube and Twitch are false because their players require a
   * real HTTP Referer / specific parent host that Tauri's custom protocol
   * can't provide — the iframe loads but playback fails.
   */
  reliable: boolean;
};

type Provider = {
  id: string;
  label: string;
  match: RegExp;
  reliable: boolean;
  build: (
    m: RegExpMatchArray,
    raw: string
  ) => Omit<EmbedInfo, "id" | "label" | "reliable"> | null;
};

const PROVIDERS: Provider[] = [
  // YouTube: iframe loads but Error 153 in production. Bookmark card only.
  {
    id: "youtube",
    label: "YouTube",
    reliable: false,
    match:
      /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/,
    build: (m) => ({
      src: `https://www.youtube.com/embed/${m[1]}?rel=0`,
      aspectRatio: 16 / 9,
      allow:
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share",
    }),
  },
  // Twitch: parent-host restriction usually rejects Tauri's origin. Bookmark only.
  {
    id: "twitch",
    label: "Twitch",
    reliable: false,
    match: /twitch\.tv\/([A-Za-z0-9_]+)(?:\/.*)?$/,
    build: (m) => ({
      src: `https://player.twitch.tv/?channel=${m[1]}&parent=localhost`,
      aspectRatio: 16 / 9,
      allow: "autoplay; fullscreen",
    }),
  },
  {
    id: "vimeo",
    label: "Vimeo",
    reliable: true,
    match: /vimeo\.com\/(?:video\/)?(\d+)/,
    build: (m) => ({
      src: `https://player.vimeo.com/video/${m[1]}`,
      aspectRatio: 16 / 9,
      allow: "autoplay; fullscreen; picture-in-picture",
    }),
  },
  {
    id: "loom",
    label: "Loom",
    reliable: true,
    match: /loom\.com\/share\/([A-Za-z0-9]+)/,
    build: (m) => ({
      src: `https://www.loom.com/embed/${m[1]}`,
      aspectRatio: 16 / 9,
      allow: "fullscreen",
    }),
  },
  {
    id: "spotify",
    label: "Spotify",
    reliable: true,
    match:
      /open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/,
    build: (m) => ({
      src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`,
      aspectRatio: 0,
      height: m[1] === "track" || m[1] === "episode" ? 152 : 380,
      allow: "encrypted-media; clipboard-write",
    }),
  },
  {
    id: "soundcloud",
    label: "SoundCloud",
    reliable: true,
    match: /soundcloud\.com\/.+/,
    build: (_m, raw) => ({
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(
        raw
      )}&color=%23ff5500&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false`,
      aspectRatio: 0,
      height: 166,
      allow: "autoplay",
    }),
  },
  {
    id: "codepen",
    label: "CodePen",
    reliable: true,
    match: /codepen\.io\/([^/]+)\/pen\/([A-Za-z0-9]+)/,
    build: (m) => ({
      src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`,
      aspectRatio: 0,
      height: 420,
      allow: "fullscreen",
    }),
  },
  {
    id: "codesandbox",
    label: "CodeSandbox",
    reliable: true,
    match: /codesandbox\.io\/s\/([A-Za-z0-9-]+)/,
    build: (m) => ({
      src: `https://codesandbox.io/embed/${m[1]}?fontsize=14&hidenavigation=1&theme=dark`,
      aspectRatio: 0,
      height: 500,
      allow:
        "accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking",
    }),
  },
  {
    id: "stackblitz",
    label: "StackBlitz",
    reliable: true,
    match: /stackblitz\.com\/edit\/([A-Za-z0-9-]+)/,
    build: (m) => ({
      src: `https://stackblitz.com/edit/${m[1]}?embed=1`,
      aspectRatio: 0,
      height: 500,
    }),
  },
  {
    id: "gdocs",
    label: "Google Docs",
    reliable: true,
    match:
      /docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)/,
    build: (m) => ({
      src: `https://docs.google.com/${m[1]}/d/${m[2]}/preview`,
      aspectRatio: m[1] === "presentation" ? 16 / 9 : 4 / 3,
    }),
  },
  {
    id: "figma",
    label: "Figma",
    reliable: true,
    match: /figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/,
    build: (m) => ({
      src: `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(
        `https://www.figma.com/file/${m[1]}`
      )}`,
      aspectRatio: 16 / 9,
      allow: "fullscreen",
    }),
  },
  {
    id: "applemusic",
    label: "Apple Music",
    reliable: true,
    match: /music\.apple\.com\/.+\/(album|playlist|song)\/.+\/(\d+)/,
    build: (m) => ({
      src: `https://embed.music.apple.com/${m[1]}/${m[2]}`,
      aspectRatio: 0,
      height: 175,
    }),
  },
];

export function getEmbedInfo(url: string): EmbedInfo | null {
  if (!url) return null;
  for (const p of PROVIDERS) {
    const m = url.match(p.match);
    if (!m) continue;
    const partial = p.build(m, url);
    if (!partial) continue;
    return { id: p.id, label: p.label, reliable: p.reliable, ...partial };
  }
  return null;
}

/** Any provider we recognize — used to decide whether to offer the paste menu. */
export function isEmbeddable(url: string): boolean {
  return getEmbedInfo(url) !== null;
}

/** Only providers whose iframe actually plays in the Tauri webview. */
export function isReliablyEmbeddable(url: string): boolean {
  const info = getEmbedInfo(url);
  return !!info && info.reliable;
}