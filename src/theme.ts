// src/theme.ts
import { useCallback, useEffect, useState } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { writeFileAtomic } from "./safeWrite";

export interface ThemeColors {
  bg: string;
  surface: string;
  surfaceAlt: string;
  elevated: string;
  border: string;
  borderLight: string;
  borderLighter: string;
  text: string;
  textStrong: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentHover: string;
  accentText: string;
  /** Red — delete buttons, errors, destructive actions. */
  danger: string;
  /** Amber — warnings, caution banners, "unsaved" indicators. */
  warning: string;
  /** Green — success messages, checkmarks, "saved" confirmations. */
  success: string;
  /** Scrim color behind modals and lightboxes. */
  overlay: string;
}

export interface ThemeBackground {
  /** data: URL, http(s) URL, or "" for none. */
  image: string;
  /** 0–40 px blur applied to the image layer only. */
  blur: number;
  /** 0–100 % — opacity of the image layer itself. */
  opacity: number;
  /** hex — the overlay painted on top of the image. */
  overlayColor: string;
  /** 0–100 % — opacity of that overlay. */
  overlayOpacity: number;
  /**
   * 0–100 % — how opaque the app's panels stay on top of the image.
   * 100 = panels fully opaque (image visible only at the edges),
   *   0 = panels fully transparent (image fully visible behind them).
   */
  panelOpacity: number;
  /**
   * 0–100 % — how opaque the sidebar stays on top of the image.
   * Independent of `panelOpacity`, so the two areas can be tuned
   * separately in "whole app" scope.
   */
  sidebarOpacity: number;
  /**
   * Optional fixed tint for the sidebar. Empty string = use the theme's
   * surface color. Any hex = the sidebar always composites that exact
   * color over the image, independent of the surface palette.
   */
  sidebarTint: string;
  /**
   * Same for the content area. Empty = use the theme's bg / surface.
   */
  contentTint: string;
  /**
   * 0–100 %. How strongly the sidebar tint replaces the theme's surface
   * color. Only used when `separateTints` is on.
   */
  sidebarTintIntensity: number;
  /**
   * 0–100 %. Same, for the content area's tint.
   */
  contentTintIntensity: number;
  /**
   * Hex color for dialogs (Settings, cleanup, etc.). Empty = follow the
   * theme's `elevated` color. Never affected by the tints.
   */
  modalColor: string;
  /**
   * 0–100 %. Opacity of the modal background.
   */
  modalOpacity: number;
  /**
   * When false (default), the sidebar and content tint rows are hidden and
   * the unified overlay controls the whole background. Turn this on to
   * fine-tune each area independently.
   */
  separateTints: boolean;
  /** "app" = whole UI, "sidebar" = sidebar shell only. */
  scope: "app" | "sidebar";
}

export type ThemeMode = "dark" | "light" | "custom";

export interface Theme {
  mode: ThemeMode;
  colors: ThemeColors;
  background: ThemeBackground;
}

export const DEFAULT_BACKGROUND: ThemeBackground = {
  image: "",
  blur: 0,
  opacity: 100,
  overlayColor: "#000000",
  overlayOpacity: 0,
  panelOpacity: 75,
  sidebarOpacity: 75,
  sidebarTint: "",
  contentTint: "",
  sidebarTintIntensity: 100,
  contentTintIntensity: 100,
  modalColor: "",
  modalOpacity: 100,
  separateTints: false,
  scope: "app",
};

export const DARK_THEME: Theme = {
  mode: "dark",
  colors: {
    bg: "#0f1315",
    surface: "#161a1d",
    surfaceAlt: "#1a1e21",
    elevated: "#1e2327",
    border: "#2a3136",
    borderLight: "#30363d",
    borderLighter: "#3a4147",
    text: "#d1d5db",
    textStrong: "#f3f4f6",
    textMuted: "#9ca3af",
    textDim: "#6b7280",
    accent: "#3b82f6",
    accentHover: "#60a5fa",
    accentText: "#93c5fd",
    danger: "#ef4444",
    warning: "#f59e0b",
    success: "#22c55e",
    overlay: "#000000",
  },
  background: { ...DEFAULT_BACKGROUND },
};

export const LIGHT_THEME: Theme = {
  mode: "light",
  colors: {
    bg: "#ffffff",
    surface: "#f8fafc",
    surfaceAlt: "#f1f5f9",
    elevated: "#e9eef3",
    border: "#e2e8f0",
    borderLight: "#cbd5e1",
    borderLighter: "#94a3b8",
    text: "#1f2937",
    textStrong: "#030712",
    textMuted: "#4b5563",
    textDim: "#6b7280",
    accent: "#2563eb",
    accentHover: "#3b82f6",
    accentText: "#1d4ed8",
    danger: "#dc2626",
    warning: "#d97706",
    success: "#16a34a",
    overlay: "#000000",
  },
  background: { ...DEFAULT_BACKGROUND },
};

const STORAGE_KEY = "selah-theme-v1";

export const COLOR_LABELS: {
  key: keyof ThemeColors;
  label: string;
  hint: string;
  group: "essential" | "advanced";
}[] = [
  { key: "bg",         label: "App background",   hint: "The main canvas behind everything",  group: "essential" },
  { key: "surface",    label: "Panels",           hint: "Cards, notes, sidebars",             group: "essential" },
  { key: "elevated",   label: "Menus",            hint: "Popovers and dropdowns",             group: "essential" },
  { key: "text",       label: "Body text",        hint: "Paragraphs and normal labels",       group: "essential" },
  { key: "textStrong", label: "Headings",         hint: "Titles and emphasized text",         group: "essential" },
  { key: "accent",     label: "Accent color",     hint: "Buttons, links, and highlights",     group: "essential" },
  { key: "danger",     label: "Delete / error",   hint: "Red — trash icons, error messages",  group: "essential" },
  { key: "warning",    label: "Warnings",         hint: "Amber — caution banners, alerts",    group: "essential" },
  { key: "success",    label: "Success",          hint: "Green — checkmarks, saved state",    group: "essential" },
  { key: "overlay",    label: "Modal background", hint: "The dark scrim behind dialogs",      group: "essential" },

  { key: "surfaceAlt",    label: "Panel alt",         hint: "Slightly different panels",          group: "advanced" },
  { key: "border",        label: "Borders",           hint: "Standard dividers",                  group: "advanced" },
  { key: "borderLight",   label: "Borders (soft)",    hint: "Subtler dividers",                   group: "advanced" },
  { key: "borderLighter", label: "Borders (hover)",   hint: "Highlighted borders",                group: "advanced" },
  { key: "textMuted",     label: "Text (muted)",      hint: "Secondary text",                     group: "advanced" },
  { key: "textDim",       label: "Text (dim)",        hint: "Least prominent text",               group: "advanced" },
  { key: "accentHover",   label: "Accent (hover)",    hint: "Accent color on hover",              group: "advanced" },
  { key: "accentText",    label: "Accent text",       hint: "Text drawn in the accent color",     group: "advanced" },
];

/**
 * Default background shipped with the "Glassy" preset — a soft bokeh
 * gradient of blue, violet, cyan, and pink on a cream base. It's a
 * self-contained SVG data URL, so there's nothing to load from disk and
 * nothing for the user to pick. Tuned so the frosted-glass panels have
 * real color to refract.
 */
export const GLASSY_DEFAULT_BG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="a" cx="20%" cy="20%" r="55%">
      <stop offset="0%" stop-color="#3b6cf5" stop-opacity="0.9"/>
      <stop offset="60%" stop-color="#3b6cf5" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#3b6cf5" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="b" cx="80%" cy="28%" r="60%">
      <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.85"/>
      <stop offset="60%" stop-color="#8b5cf6" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="c" cx="52%" cy="88%" r="65%">
      <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.85"/>
      <stop offset="60%" stop-color="#22d3ee" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="d" cx="8%" cy="82%" r="50%">
      <stop offset="0%" stop-color="#f472b6" stop-opacity="0.7"/>
      <stop offset="60%" stop-color="#f472b6" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#f472b6" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="e" cx="92%" cy="88%" r="55%">
      <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.75"/>
      <stop offset="60%" stop-color="#a78bfa" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1600" height="1000" fill="#e8eef8"/>
  <rect width="1600" height="1000" fill="url(#a)"/>
  <rect width="1600" height="1000" fill="url(#b)"/>
  <rect width="1600" height="1000" fill="url(#c)"/>
  <rect width="1600" height="1000" fill="url(#d)"/>
  <rect width="1600" height="1000" fill="url(#e)"/>
</svg>`
)}`;

/**
 * One-click starting points. Picking one replaces every palette color at
 * once so non-technical users don't have to think about hex codes.
 */
export type PresetCategory =
  | "featured"
  | "dark"
  | "light"
  | "editor"
  | "terminal"
  | "nature"
  | "faith"
  | "holiday"
  | "retro-os"
  | "cultural"
  | "playful";

/** Display order and human labels for the preset picker's categories. */
export const PRESET_CATEGORY_LABELS: { id: PresetCategory; label: string }[] = [
  { id: "featured", label: "Featured" },
  { id: "dark",     label: "Dark" },
  { id: "light",    label: "Light" },
  { id: "editor",   label: "Editor classics" },
  { id: "terminal", label: "Terminal & Retro" },
  { id: "nature",   label: "Nature" },
  { id: "faith",    label: "Faith" },
  { id: "holiday",  label: "Holidays" },
  { id: "retro-os", label: "Retro OS" },
  { id: "cultural", label: "Cultural" },
  { id: "playful",  label: "Playful" },
];

/** Which category each preset belongs to, keyed by preset id. Presets
 *  missing from this map fall back to "dark" when grouped. Adding a new
 *  preset only requires one more line here. */
export const PRESET_CATEGORY: Record<string, PresetCategory> = {
  // Featured — the picker's front page
  midnight: "featured",
  paper: "featured",
  glassy: "featured",
  "glassy-dark": "featured",
  dracula: "featured",
  "solarized-dark": "featured",
  nord: "featured",
  "rose-pine": "featured",

  // Dark — clean, non-flavored dark palettes
  "black-orange": "dark",
  slate: "dark",
  amber: "dark",
  "base2tone-sea": "dark",
  "coffee-house": "dark",
  "soft-dark": "dark",
  "high-contrast": "dark",

  // Light — clean, non-flavored light palettes
  sepia: "light",
  "heavens-light": "light",
  blueprint: "light",
  tundra: "light",
  sakura: "light",
  chrome: "light",

  // Editor classics — themes from the dev-tools world
  "tokyo-night": "editor",
  "catppuccin-mocha": "editor",
  gruvbox: "editor",
  everforest: "editor",
  "solarized-light": "editor",
  monokai: "editor",
  kanagawa: "editor",

  // Terminal & Retro — CRT, hacker, and neon-tech
  "cyberpunk-icy": "terminal",
  "emerald-synth": "terminal",
  "green-phosphor": "terminal",
  "hax0r-blue": "terminal",
  "terminal-green-1999": "terminal",

  // Nature — flora, ocean, weather, moods
  forest: "nature",
  ocean: "nature",
  matcha: "nature",
  aurora: "nature",
  "deep-sea": "nature",
  "desert-night": "nature",
  volcano: "nature",
  autumn: "nature",
  winter: "nature",
  kodama: "nature",

  // Faith — devotional and scriptural moods
  parchment: "faith",
  psalter: "faith",
  sanctuary: "faith",
  "garden-of-eden": "faith",
  "burning-bush": "faith",
  "upper-room": "faith",
  "jerusalem-stone": "faith",
  dove: "faith",
  wilderness: "faith",
  "olive-branch": "faith",
  "vintage-paper": "faith",

  // Holidays — festive palettes for specific times of year
  easter: "holiday",
  halloween: "holiday",
  christmas: "holiday",
  thanksgiving: "holiday",
  valentines: "holiday",
  "st-patricks": "holiday",
  "fourth-of-july": "holiday",
  "new-years-eve": "holiday",
  hanukkah: "holiday",
  diwali: "holiday",
  "lunar-new-year": "holiday",
  "dia-de-muertos": "holiday",

  // Retro OS — old desktop environments
  "windows-95": "retro-os",
  "commodore-64": "retro-os",
  "amiga-workbench": "retro-os",
  "mac-system-7": "retro-os",
  "windows-xp": "retro-os",

  // Cultural — art movements and non-computing references
  bauhaus: "cultural",
  "art-deco": "cultural",
  "ukiyo-e": "cultural",
  kintsugi: "cultural",
  mondrian: "cultural",

  // Playful — bright, fun, expressive
  "rainbow-joy": "playful",
  rose: "playful",
  vaporwave: "playful",
  "sunset-drive": "playful",
  rgb: "playful",
  "neon-miami": "playful",
  bubblegum: "playful",
  "cotton-candy": "playful",
};

export const THEME_PRESETS: {
  id: string;
  label: string;
  description: string;
  swatches: string[];
  build: () => Theme;
}[] = [
  {
    id: "midnight",
    label: "Midnight",
    description: "Cool dark blue with a crisp blue accent",
    swatches: ["#0f1315", "#161a1d", "#3b82f6"],
    build: () => ({ ...DARK_THEME, colors: { ...DARK_THEME.colors } }),
  },
  {
    id: "paper",
    label: "Paper",
    description: "Clean white with a bright blue accent",
    swatches: ["#ffffff", "#f8fafc", "#2563eb"],
    build: () => ({ ...LIGHT_THEME, colors: { ...LIGHT_THEME.colors } }),
  },
  {
    id: "sepia",
    label: "Sepia",
    description: "Warm cream paper with a soft amber accent",
    swatches: ["#f5ecd9", "#efe3c9", "#a86a2c"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5ecd9", surface: "#efe3c9", surfaceAlt: "#e8d9b8", elevated: "#faf3e5",
        border: "#d4c4a0", borderLight: "#c4b48c", borderLighter: "#a89878",
        text: "#4a3a24", textStrong: "#2b1e0f", textMuted: "#6b5a3e", textDim: "#8a7856",
        accent: "#a86a2c", accentHover: "#c07e3c", accentText: "#8a5424",
        danger: "#b91c1c", warning: "#b45309", success: "#4d7c0f", overlay: "#3a2e1a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "forest",
    label: "Forest",
    description: "Deep evergreen with a sage accent",
    swatches: ["#0f1a14", "#16241b", "#4ade80"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0f1a14", surface: "#16241b", surfaceAlt: "#1a2a20", elevated: "#1e2e24",
        border: "#2a3d30", borderLight: "#34483c", borderLighter: "#425448",
        text: "#c8d8cc", textStrong: "#e8f2ec", textMuted: "#8fa492", textDim: "#5c7260",
        accent: "#4ade80", accentHover: "#6ee7a0", accentText: "#86efac",
        danger: "#ef4444", warning: "#fbbf24", success: "#4ade80", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep navy with a bright cyan accent",
    swatches: ["#0a1628", "#0f1e33", "#22d3ee"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0a1628", surface: "#0f1e33", surfaceAlt: "#13253c", elevated: "#172b44",
        border: "#1f3a5a", borderLight: "#284a70", borderLighter: "#345a82",
        text: "#c4d5e8", textStrong: "#e6f0fb", textMuted: "#8fa8c2", textDim: "#5c7290",
        accent: "#22d3ee", accentHover: "#67e8f9", accentText: "#a5f3fc",
        danger: "#f87171", warning: "#fbbf24", success: "#34d399", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "rose",
    label: "Rose",
    description: "Soft pink with a warm rose accent",
    swatches: ["#fdf2f8", "#fce7f3", "#db2777"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#fdf2f8", surface: "#fce7f3", surfaceAlt: "#fbcfe8", elevated: "#fff5fa",
        border: "#f0c8de", borderLight: "#e5aecd", borderLighter: "#d18eb0",
        text: "#6b2040", textStrong: "#4a1330", textMuted: "#8a4460", textDim: "#a86f88",
        accent: "#db2777", accentHover: "#ec4899", accentText: "#be185d",
        danger: "#dc2626", warning: "#d97706", success: "#16a34a", overlay: "#4a1330",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "slate",
    label: "Slate",
    description: "Muted cool gray with a subtle blue accent",
    swatches: ["#1a1f26", "#222831", "#60a5fa"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a1f26", surface: "#222831", surfaceAlt: "#262d38", elevated: "#2c333f",
        border: "#363e4c", borderLight: "#424a5a", borderLighter: "#4f5768",
        text: "#c8d0dc", textStrong: "#eef2f7", textMuted: "#8a94a3", textDim: "#5c6575",
        accent: "#60a5fa", accentHover: "#93c5fd", accentText: "#bfdbfe",
        danger: "#f87171", warning: "#fbbf24", success: "#34d399", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "amber",
    label: "Amber",
    description: "Warm dark with a honey-gold accent",
    swatches: ["#1c1410", "#241a14", "#f59e0b"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1c1410", surface: "#241a14", surfaceAlt: "#2c2018", elevated: "#32261c",
        border: "#423226", borderLight: "#523e2f", borderLighter: "#624b3a",
        text: "#d8c4b0", textStrong: "#f2e4d4", textMuted: "#a89078", textDim: "#725b46",
        accent: "#f59e0b", accentHover: "#fbbf24", accentText: "#fcd34d",
        danger: "#ef4444", warning: "#fbbf24", success: "#84cc16", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    description: "Deep navy with vivid blue and purple",
    swatches: ["#1a1b26", "#1f2335", "#7aa2f7"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a1b26", surface: "#1f2335", surfaceAlt: "#24283b", elevated: "#292e42",
        border: "#3b4261", borderLight: "#414868", borderLighter: "#545c7e",
        text: "#c0caf5", textStrong: "#ffffff", textMuted: "#a9b1d6", textDim: "#737aa2",
        accent: "#7aa2f7", accentHover: "#9ab8ff", accentText: "#b4c6ff",
        danger: "#f7768e", warning: "#e0af68", success: "#9ece6a", overlay: "#16161e",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    description: "Soft pastel dark with mauve and pink",
    swatches: ["#1e1e2e", "#313244", "#cba6f7"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1e1e2e", surface: "#181825", surfaceAlt: "#232334", elevated: "#313244",
        border: "#45475a", borderLight: "#585b70", borderLighter: "#6c7086",
        text: "#cdd6f4", textStrong: "#ffffff", textMuted: "#a6adc8", textDim: "#7f849c",
        accent: "#cba6f7", accentHover: "#dabeff", accentText: "#e5d4ff",
        danger: "#f38ba8", warning: "#f9e2af", success: "#a6e3a1", overlay: "#11111b",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "nord",
    label: "Nord",
    description: "Cool arctic blue with muted frost tones",
    swatches: ["#2e3440", "#3b4252", "#88c0d0"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#2e3440", surface: "#3b4252", surfaceAlt: "#434c5e", elevated: "#4c566a",
        border: "#5d6979", borderLight: "#6e7d8f", borderLighter: "#7b8ba0",
        text: "#d8dee9", textStrong: "#eceff4", textMuted: "#a5b1c2", textDim: "#7b8ba0",
        accent: "#88c0d0", accentHover: "#a3d4e3", accentText: "#b8e0e8",
        danger: "#bf616a", warning: "#ebcb8b", success: "#a3be8c", overlay: "#242933",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    description: "Warm retro browns with mustard and orange",
    swatches: ["#282828", "#3c3836", "#fabd2f"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#282828", surface: "#3c3836", surfaceAlt: "#32302f", elevated: "#504945",
        border: "#665c54", borderLight: "#7c6f64", borderLighter: "#928374",
        text: "#ebdbb2", textStrong: "#fbf1c7", textMuted: "#bdae93", textDim: "#a89984",
        accent: "#fabd2f", accentHover: "#fcc84a", accentText: "#fdd868",
        danger: "#fb4934", warning: "#fe8019", success: "#b8bb26", overlay: "#1d2021",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "everforest",
    label: "Everforest",
    description: "Forest greens with a warm paper-tone text",
    swatches: ["#2d353b", "#343f44", "#a7c080"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#2d353b", surface: "#343f44", surfaceAlt: "#3d484d", elevated: "#475258",
        border: "#4f585e", borderLight: "#56635f", borderLighter: "#627277",
        text: "#d3c6aa", textStrong: "#f0e5c9", textMuted: "#9da9a0", textDim: "#7a8478",
        accent: "#a7c080", accentHover: "#b8d19a", accentText: "#c3d9a5",
        danger: "#e67e80", warning: "#dbbc7f", success: "#a7c080", overlay: "#1e2429",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "base2tone-sea",
    label: "Base2Tone Sea",
    description: "Deep teal-black with a cool sea-green accent",
    swatches: ["#1a2530", "#22303a", "#5dd3a8"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a2530", surface: "#22303a", surfaceAlt: "#26353f", elevated: "#2b3c47",
        border: "#3a4d5a", borderLight: "#445866", borderLighter: "#506576",
        text: "#c0d0d8", textStrong: "#e8f0f4", textMuted: "#8ba1ad", textDim: "#5e7481",
        accent: "#5dd3a8", accentHover: "#7fddb9", accentText: "#a2e8cf",
        danger: "#ff6b6b", warning: "#ffd580", success: "#7ee787", overlay: "#0d151c",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "cyberpunk-icy",
    label: "Cyberpunk Icy",
    description: "Frozen blue on near-black with cyan neon",
    swatches: ["#0a1420", "#18283c", "#00e5ff"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0a1420", surface: "#0f1a2b", surfaceAlt: "#132233", elevated: "#18283c",
        border: "#213850", borderLight: "#2a4661", borderLighter: "#375573",
        text: "#b0d4e8", textStrong: "#e8f5ff", textMuted: "#7fa8c4", textDim: "#4d7495",
        accent: "#00e5ff", accentHover: "#55f0ff", accentText: "#88f5ff",
        danger: "#ff2e63", warning: "#fbcb6a", success: "#4ade80", overlay: "#040810",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "emerald-synth",
    label: "Emerald Synth",
    description: "Synthwave darkness with an electric emerald glow",
    swatches: ["#0a1f1a", "#173b30", "#00ff9f"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0a1f1a", surface: "#0f2a22", surfaceAlt: "#123028", elevated: "#173b30",
        border: "#1f4d3e", borderLight: "#285b4a", borderLighter: "#346b58",
        text: "#c8e6d8", textStrong: "#eafff2", textMuted: "#84b8a0", textDim: "#527a68",
        accent: "#00ff9f", accentHover: "#55ffbb", accentText: "#99ffd2",
        danger: "#ff3366", warning: "#ffcc33", success: "#00ff9f", overlay: "#050f0c",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "green-phosphor",
    label: "Green Phosphor CRT",
    description: "Retro terminal — glowing phosphor green on black",
    swatches: ["#0a1208", "#162418", "#33ff33"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0a1208", surface: "#0e1810", surfaceAlt: "#121e14", elevated: "#162418",
        border: "#1e3320", borderLight: "#284028", borderLighter: "#335233",
        text: "#7fe07f", textStrong: "#b8ffb8", textMuted: "#4a9a4a", textDim: "#2d6a2d",
        accent: "#33ff33", accentHover: "#66ff66", accentText: "#99ff99",
        danger: "#ff4444", warning: "#ffcc00", success: "#33ff33", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "hax0r-blue",
    label: "HaX0R Blue",
    description: "Bright cyan-blue terminal for the aspiring hacker",
    swatches: ["#000810", "#00243d", "#00aaff"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#000810", surface: "#001020", surfaceAlt: "#001a2e", elevated: "#00243d",
        border: "#003050", borderLight: "#003d66", borderLighter: "#004d80",
        text: "#80c8ff", textStrong: "#c0e0ff", textMuted: "#4a88b8", textDim: "#285a80",
        accent: "#00aaff", accentHover: "#55c8ff", accentText: "#88ddff",
        danger: "#ff3366", warning: "#ffaa00", success: "#00ffaa", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "terminal-green-1999",
    label: "Terminal Green 1999",
    description: "Classic green-on-black terminal, straight from the Y2K era",
    swatches: ["#000000", "#161616", "#00cc00"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#000000", surface: "#0a0a0a", surfaceAlt: "#101010", elevated: "#161616",
        border: "#1e1e1e", borderLight: "#2a2a2a", borderLighter: "#383838",
        text: "#33cc33", textStrong: "#66ff66", textMuted: "#229922", textDim: "#155515",
        accent: "#00cc00", accentHover: "#33dd33", accentText: "#66ee66",
        danger: "#cc3333", warning: "#cccc00", success: "#33cc33", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "rainbow-joy",
    label: "Rainbow Joy",
    description: "Every layer its own hue — red through violet stacked up",
    swatches: ["#ffe4d6", "#c8e6c9", "#b8a8e0"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#fff5eb", surface: "#ffe4d6", surfaceAlt: "#ffedcc", elevated: "#f5f5d0",
        border: "#c8e6c9", borderLight: "#a8d8f0", borderLighter: "#b8a8e0",
        text: "#3a1a5a", textStrong: "#1a0a2a", textMuted: "#7a5a9a", textDim: "#a890c8",
        accent: "#e63a3a", accentHover: "#ff5a3a", accentText: "#b81a1a",
        danger: "#d61a1a", warning: "#e68a00", success: "#22aa55", overlay: "#3a1a5a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "heavens-light",
    label: "Heaven's Light",
    description: "Warm ivory and gold — bright, angelic, and radiant",
    swatches: ["#fffdf0", "#fff8e0", "#ffaa00"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#fffdf0", surface: "#fff8e0", surfaceAlt: "#fff2c8", elevated: "#ffebaa",
        border: "#f0d68a", borderLight: "#f5e0a8", borderLighter: "#d8b860",
        text: "#5a4a1a", textStrong: "#2d2408", textMuted: "#8a7a3a", textDim: "#b8a860",
        accent: "#ffaa00", accentHover: "#ffbb33", accentText: "#cc8800",
        danger: "#e63a3a", warning: "#e68a00", success: "#5ac878", overlay: "#6a5a2a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "glassy-dark",
    label: "Glassy Dark",
    description: "Cool frosted glass in dark mode — pairs with a background image",
    swatches: ["#0e1620", "#1c2a3a", "#7dd3fc"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0e1620", surface: "#17212e", surfaceAlt: "#1c2a3a", elevated: "#243244",
        border: "#3a4d63", borderLight: "#4a5f78", borderLighter: "#5f7a94",
        text: "#c8d8e8", textStrong: "#eaf4ff", textMuted: "#8ca3bb", textDim: "#5f7891",
        accent: "#7dd3fc", accentHover: "#a3e0ff", accentText: "#bae6fd",
        danger: "#f87d7d", warning: "#fcd34d", success: "#86efac", overlay: "#060b12",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "glassy",
    label: "Glassy",
    description: "Bright frosted glass with a built-in soft bokeh background",
    swatches: ["#eef4fc", "#d2e0f0", "#3a3a9f"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#eef4fc", surface: "#e6eefa", surfaceAlt: "#dce8f5", elevated: "#d2e0f0",
        border: "#aabed6", borderLight: "#c0d0e2", borderLighter: "#8fa8c4",
        text: "#1e2942", textStrong: "#0a1226", textMuted: "#54648a", textDim: "#8898b8",
        accent: "#3a3a9f", accentHover: "#5555c8", accentText: "#23238a",
        danger: "#d63a3a", warning: "#d68a00", success: "#1e9c54", overlay: "#1a2540",
      },
      background: {
        ...DEFAULT_BACKGROUND,
        image: GLASSY_DEFAULT_BG,
        scope: "app",
        blur: 4,
        opacity: 100,
        panelOpacity: 55,
        sidebarOpacity: 65,
      },
    }),
  },
  {
    id: "dracula",
    label: "Dracula",
    description: "The classic vampire theme — purple, pink, and cyan on deep navy",
    swatches: ["#282a36", "#44475a", "#bd93f9"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#282a36", surface: "#21222c", surfaceAlt: "#2d2f3d", elevated: "#343746",
        border: "#44475a", borderLight: "#4d5066", borderLighter: "#6272a4",
        text: "#f8f8f2", textStrong: "#ffffff", textMuted: "#b8b8c8", textDim: "#6272a4",
        accent: "#bd93f9", accentHover: "#caa9fa", accentText: "#d7bcff",
        danger: "#ff5555", warning: "#ffb86c", success: "#50fa7b", overlay: "#191a21",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    description: "Ethan Schoonover's classic — muted teal and amber",
    swatches: ["#002b36", "#073642", "#268bd2"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#002b36", surface: "#073642", surfaceAlt: "#0a3a47", elevated: "#11414f",
        border: "#1a4d5c", borderLight: "#245a6c", borderLighter: "#586e75",
        text: "#93a1a1", textStrong: "#eee8d5", textMuted: "#839496", textDim: "#586e75",
        accent: "#268bd2", accentHover: "#4ba3e0", accentText: "#6cb6e8",
        danger: "#dc322f", warning: "#b58900", success: "#859900", overlay: "#00212b",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    description: "The same Solarized palette on warm cream paper",
    swatches: ["#fdf6e3", "#eee8d5", "#268bd2"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#fdf6e3", surface: "#eee8d5", surfaceAlt: "#e6dfc8", elevated: "#ded8c4",
        border: "#d3cbb4", borderLight: "#b8b19a", borderLighter: "#93a1a1",
        text: "#586e75", textStrong: "#002b36", textMuted: "#657b83", textDim: "#839496",
        accent: "#268bd2", accentHover: "#1a6fa8", accentText: "#2076b3",
        danger: "#dc322f", warning: "#b58900", success: "#859900", overlay: "#002b36",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    description: "Moody violet-rose on deep ink — quiet and literary",
    swatches: ["#191724", "#26233a", "#c4a7e7"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#191724", surface: "#1f1d2e", surfaceAlt: "#26233a", elevated: "#2a273f",
        border: "#393552", borderLight: "#44415a", borderLighter: "#524f67",
        text: "#e0def4", textStrong: "#ffffff", textMuted: "#908caa", textDim: "#6e6a86",
        accent: "#c4a7e7", accentHover: "#d0b8ee", accentText: "#dcc9f4",
        danger: "#eb6f92", warning: "#f6c177", success: "#9ccfd8", overlay: "#0f0d17",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "sakura",
    label: "Sakura",
    description: "Cherry blossom — soft pinks on cream paper",
    swatches: ["#fdf2f5", "#fce4ec", "#c2185b"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#fdf2f5", surface: "#fce4ec", surfaceAlt: "#f9d8e3", elevated: "#f5cdd9",
        border: "#f0c4d0", borderLight: "#e8b0be", borderLighter: "#d99aab",
        text: "#4a2638", textStrong: "#2d1220", textMuted: "#7a4a5c", textDim: "#a87888",
        accent: "#c2185b", accentHover: "#e91e63", accentText: "#ad1457",
        danger: "#d32f2f", warning: "#e68a00", success: "#2e7d32", overlay: "#4a2638",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "vaporwave",
    label: "Vaporwave",
    description: "80s mall neon — hot pink and cyan on deep violet",
    swatches: ["#1a0b2e", "#240a3f", "#ff00aa"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a0b2e", surface: "#240a3f", surfaceAlt: "#2d1250", elevated: "#3b1a66",
        border: "#4f2889", borderLight: "#6136a0", borderLighter: "#7a4bb8",
        text: "#f0e0ff", textStrong: "#ffffff", textMuted: "#c8a8e8", textDim: "#8a68b0",
        accent: "#ff00aa", accentHover: "#ff33bb", accentText: "#ff66cc",
        danger: "#ff3355", warning: "#ffcc00", success: "#00ffcc", overlay: "#0f0518",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "sunset-drive",
    label: "Sunset Drive",
    description: "Warm orange to deep violet, like a synthwave album cover",
    swatches: ["#1a0f2e", "#2a1544", "#ff6b35"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a0f2e", surface: "#2a1544", surfaceAlt: "#351b56", elevated: "#422268",
        border: "#553081", borderLight: "#6a3e9a", borderLighter: "#8555b5",
        text: "#f0d8e8", textStrong: "#ffffff", textMuted: "#d0a8c0", textDim: "#a07898",
        accent: "#ff6b35", accentHover: "#ff8a55", accentText: "#ffaa80",
        danger: "#ff2d55", warning: "#ffcc44", success: "#66ffaa", overlay: "#0f0818",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "monokai",
    label: "Monokai",
    description: "The iconic programmer palette — hot pink, green, and orange",
    swatches: ["#272822", "#3a3b32", "#f92672"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#272822", surface: "#1e1f1c", surfaceAlt: "#2f3028", elevated: "#3a3b32",
        border: "#4a4b42", borderLight: "#5c5d52", borderLighter: "#757575",
        text: "#f8f8f2", textStrong: "#ffffff", textMuted: "#cfcfc2", textDim: "#75715e",
        accent: "#f92672", accentHover: "#fb5c8e", accentText: "#fc8fab",
        danger: "#f92672", warning: "#fd971f", success: "#a6e22e", overlay: "#1c1d18",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "kanagawa",
    label: "Kanagawa",
    description: "Ink-brush woodblock — warm browns and muted violet",
    swatches: ["#1f1f28", "#363646", "#7e9cd8"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1f1f28", surface: "#2a2a37", surfaceAlt: "#363646", elevated: "#42425a",
        border: "#54546d", borderLight: "#636380", borderLighter: "#7a7a9a",
        text: "#dcd7ba", textStrong: "#f5f0d0", textMuted: "#c8c093", textDim: "#957fb8",
        accent: "#7e9cd8", accentHover: "#a3bce0", accentText: "#c0d4ee",
        danger: "#c34043", warning: "#e6c384", success: "#76946a", overlay: "#16161d",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "matcha",
    label: "Matcha",
    description: "Green tea — gentle greens on warm off-white",
    swatches: ["#f3f7ea", "#dfeac4", "#4a7c2e"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f3f7ea", surface: "#e8f0d5", surfaceAlt: "#dfeac4", elevated: "#d4e2b0",
        border: "#b8cd94", borderLight: "#a8bd80", borderLighter: "#8ca868",
        text: "#2d3a1f", textStrong: "#1a2410", textMuted: "#526b3a", textDim: "#7a8f60",
        accent: "#4a7c2e", accentHover: "#5d9138", accentText: "#3a6622",
        danger: "#b91c1c", warning: "#b45309", success: "#4a7c2e", overlay: "#3a4a2a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "blueprint",
    label: "Blueprint",
    description: "Engineering navy lines on cream drafting paper",
    swatches: ["#f5f0e0", "#e0d9c0", "#1e3a5f"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5f0e0", surface: "#ebe5d0", surfaceAlt: "#e0d9c0", elevated: "#d4ccb0",
        border: "#b8b098", borderLight: "#a8a088", borderLighter: "#8a8270",
        text: "#1a2a40", textStrong: "#0a1528", textMuted: "#4a5a78", textDim: "#7080a0",
        accent: "#1e3a5f", accentHover: "#2d4a7a", accentText: "#152a48",
        danger: "#a01818", warning: "#a06818", success: "#2a6828", overlay: "#1a2a40",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "vintage-paper",
    label: "Vintage Paper",
    description: "Aged manuscript — saddle brown on warm parchment",
    swatches: ["#f5ead5", "#e5d2ab", "#8b4513"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5ead5", surface: "#ecdcc0", surfaceAlt: "#e5d2ab", elevated: "#dcc698",
        border: "#c8ac78", borderLight: "#b89c68", borderLighter: "#a08a58",
        text: "#3a2810", textStrong: "#201508", textMuted: "#6b4f30", textDim: "#947854",
        accent: "#8b4513", accentHover: "#a85620", accentText: "#6b350f",
        danger: "#a01818", warning: "#a06a18", success: "#4a6828", overlay: "#3a2810",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "coffee-house",
    label: "Coffee House",
    description: "Deep espresso browns with a warm caramel accent",
    swatches: ["#201510", "#38261c", "#c19a6b"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#201510", surface: "#2c1e16", surfaceAlt: "#38261c", elevated: "#463024",
        border: "#5c422e", borderLight: "#72543c", borderLighter: "#8c6a4c",
        text: "#e8d8c0", textStrong: "#fff5e0", textMuted: "#c0a888", textDim: "#8a7660",
        accent: "#c19a6b", accentHover: "#d4af80", accentText: "#e5c495",
        danger: "#c83030", warning: "#d49030", success: "#6d9c50", overlay: "#140d08",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "soft-dark",
    label: "Soft Dark",
    description: "Low-contrast dark for long late-night reading",
    swatches: ["#1a1c20", "#2a2e33", "#7aa2cc"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a1c20", surface: "#232629", surfaceAlt: "#2a2e33", elevated: "#32373d",
        border: "#3f454d", borderLight: "#4c535c", borderLighter: "#5e666f",
        text: "#c8ccd4", textStrong: "#e8ecf0", textMuted: "#9aa0aa", textDim: "#707680",
        accent: "#7aa2cc", accentHover: "#95b8dd", accentText: "#aacbe8",
        danger: "#cc7a7a", warning: "#ccaa66", success: "#7aac8a", overlay: "#0e1013",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "high-contrast",
    label: "High Contrast",
    description: "Pure black with a bright yellow accent — maximum legibility",
    swatches: ["#000000", "#1f1f1f", "#ffff00"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#000000", surface: "#0a0a0a", surfaceAlt: "#151515", elevated: "#1f1f1f",
        border: "#ffffff", borderLight: "#cccccc", borderLighter: "#999999",
        text: "#ffffff", textStrong: "#ffffff", textMuted: "#e0e0e0", textDim: "#a0a0a0",
        accent: "#ffff00", accentHover: "#ffff55", accentText: "#ffff88",
        danger: "#ff0000", warning: "#ffaa00", success: "#00ff00", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "parchment",
    label: "Parchment",
    description: "Aged scroll — tan paper, brown ink, and a deep red accent",
    swatches: ["#f5e8cc", "#e5d2a8", "#8a2410"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5e8cc", surface: "#ecdcb8", surfaceAlt: "#e5d2a8", elevated: "#dcc798",
        border: "#c8ae7c", borderLight: "#b89c68", borderLighter: "#a68854",
        text: "#3a2410", textStrong: "#1e1208", textMuted: "#6b4f30", textDim: "#947854",
        accent: "#8a2410", accentHover: "#a83018", accentText: "#6b1c0c",
        danger: "#a61b1b", warning: "#a05a00", success: "#4a6b1e", overlay: "#3a2410",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "psalter",
    label: "Psalter",
    description: "Illuminated manuscript — vellum cream, rubric red, and gold",
    swatches: ["#f5ebd0", "#e5d5aa", "#8b1a1a"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5ebd0", surface: "#ecdfbc", surfaceAlt: "#e5d5aa", elevated: "#dcc998",
        border: "#c8b080", borderLight: "#b8a06c", borderLighter: "#a08a5a",
        text: "#2e1e0f", textStrong: "#1a1008", textMuted: "#5c4428", textDim: "#8a7048",
        accent: "#8b1a1a", accentHover: "#a83030", accentText: "#6b1414",
        danger: "#8b1a1a", warning: "#b8860b", success: "#4a6b1e", overlay: "#2e1e0f",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "sanctuary",
    label: "Sanctuary",
    description: "Reverent deep purple and gold — cathedral stained glass",
    swatches: ["#1e1433", "#3d2c60", "#d4a017"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1e1433", surface: "#281c42", surfaceAlt: "#322451", elevated: "#3d2c60",
        border: "#4e3a78", borderLight: "#5f4a8c", borderLighter: "#755fa5",
        text: "#e0d5f0", textStrong: "#ffffff", textMuted: "#b8a8d0", textDim: "#8a78a8",
        accent: "#d4a017", accentHover: "#e5b435", accentText: "#f0c855",
        danger: "#c93a3a", warning: "#d4952c", success: "#6da84b", overlay: "#0f0a1c",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "windows-95",
    label: "Windows 95",
    description: "Gray 3D bevels and teal desktop — pure 1995 nostalgia",
    swatches: ["#008080", "#c0c0c0", "#000080"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#008080", surface: "#c0c0c0", surfaceAlt: "#d4d0c8", elevated: "#dfdbd3",
        border: "#808080", borderLight: "#a0a0a0", borderLighter: "#ffffff",
        text: "#000000", textStrong: "#000000", textMuted: "#404040", textDim: "#808080",
        accent: "#000080", accentHover: "#0000c0", accentText: "#0000a0",
        danger: "#800000", warning: "#808000", success: "#008000", overlay: "#004040",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "commodore-64",
    label: "Commodore 64",
    description: "Blue border, black screen, light-blue text",
    swatches: ["#352879", "#1a1a4d", "#6c5fc7"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a1a4d", surface: "#221a5c", surfaceAlt: "#2a226b", elevated: "#352879",
        border: "#4a3a94", borderLight: "#5c4aab", borderLighter: "#6c5fc7",
        text: "#6c5fc7", textStrong: "#8a7fd9", textMuted: "#5a4fa8", textDim: "#3d3478",
        accent: "#6c5fc7", accentHover: "#8a7fd9", accentText: "#a89ee8",
        danger: "#aa3322", warning: "#aa8822", success: "#33aa33", overlay: "#0a0a2a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "amiga-workbench",
    label: "Amiga Workbench",
    description: "Gray, blue, and orange — the classic Amiga OS",
    swatches: ["#0055aa", "#aaaaaa", "#ff8800"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0055aa", surface: "#a0a0a0", surfaceAlt: "#b8b8b8", elevated: "#c8c8c8",
        border: "#707070", borderLight: "#888888", borderLighter: "#404040",
        text: "#000000", textStrong: "#000000", textMuted: "#303030", textDim: "#505050",
        accent: "#ff8800", accentHover: "#ffaa33", accentText: "#cc6600",
        danger: "#aa0000", warning: "#aa5500", success: "#008800", overlay: "#003366",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "mac-system-7",
    label: "Mac System 7",
    description: "High-contrast black, white, and grey — classic Macintosh",
    swatches: ["#ffffff", "#000000", "#6666cc"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#dddddd", surface: "#ffffff", surfaceAlt: "#eeeeee", elevated: "#f5f5f5",
        border: "#000000", borderLight: "#666666", borderLighter: "#999999",
        text: "#000000", textStrong: "#000000", textMuted: "#333333", textDim: "#666666",
        accent: "#6666cc", accentHover: "#7777dd", accentText: "#4444aa",
        danger: "#cc0000", warning: "#cc6600", success: "#008800", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "windows-xp",
    label: "Windows XP",
    description: "Blue Luna taskbar and green start button — pure 2001 nostalgia",
    swatches: ["#235adb", "#ece9d8", "#3c8a3c"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#ece9d8", surface: "#f5f3e8", surfaceAlt: "#e5e2d0", elevated: "#d4d0c0",
        border: "#a8a494", borderLight: "#c0bcac", borderLighter: "#88857a",
        text: "#000000", textStrong: "#000000", textMuted: "#3a3a3a", textDim: "#707070",
        accent: "#235adb", accentHover: "#2d6fed", accentText: "#1a48b0",
        danger: "#c82020", warning: "#d48000", success: "#3c8a3c", overlay: "#1a3a80",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "aurora",
    label: "Aurora",
    description: "Midnight sky with green-violet ribbons",
    swatches: ["#0a1a1f", "#142b33", "#4ade80"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0a1a1f", surface: "#102830", surfaceAlt: "#143238", elevated: "#1a3e46",
        border: "#255058", borderLight: "#2f626c", borderLighter: "#3d7a86",
        text: "#c8e5e8", textStrong: "#eaffff", textMuted: "#8ab8c0", textDim: "#5a8892",
        accent: "#4ade80", accentHover: "#6ee7a0", accentText: "#86efac",
        danger: "#f87171", warning: "#fbbf24", success: "#4ade80", overlay: "#051015",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "deep-sea",
    label: "Deep Sea",
    description: "Near-black navy with bioluminescent cyan",
    swatches: ["#051220", "#0a1f33", "#22d3ee"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#051220", surface: "#0a1f33", surfaceAlt: "#0d2740", elevated: "#123050",
        border: "#1a4068", borderLight: "#235080", borderLighter: "#2f6098",
        text: "#a8c8dc", textStrong: "#e0f0ff", textMuted: "#6a9ab8", textDim: "#3d6a88",
        accent: "#22d3ee", accentHover: "#67e8f9", accentText: "#a5f3fc",
        danger: "#f87171", warning: "#fbbf24", success: "#34d399", overlay: "#000810",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "desert-night",
    label: "Desert Night",
    description: "Cold slate blue with a warm sand-amber accent",
    swatches: ["#1a1f2e", "#2a3145", "#e0a850"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a1f2e", surface: "#232a3d", surfaceAlt: "#2a3145", elevated: "#343d52",
        border: "#3f4a63", borderLight: "#4e5a75", borderLighter: "#5e6d88",
        text: "#c8d0dd", textStrong: "#f0f4fa", textMuted: "#8a95a8", textDim: "#5c6578",
        accent: "#e0a850", accentHover: "#f0bb6a", accentText: "#f5cc8a",
        danger: "#e07878", warning: "#e0b050", success: "#7ab88a", overlay: "#0f1420",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "volcano",
    label: "Volcano",
    description: "Charcoal stone with molten orange-red",
    swatches: ["#1a1410", "#2e2018", "#ff5500"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a1410", surface: "#241a14", surfaceAlt: "#2e2018", elevated: "#3d2a1f",
        border: "#503828", borderLight: "#634838", borderLighter: "#7a5848",
        text: "#e0c8b0", textStrong: "#fff0e0", textMuted: "#b09070", textDim: "#806a50",
        accent: "#ff5500", accentHover: "#ff7733", accentText: "#ff9955",
        danger: "#ff2020", warning: "#ffaa00", success: "#88aa44", overlay: "#0a0806",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "tundra",
    label: "Tundra",
    description: "Pale ice blues and cold greys",
    swatches: ["#eef4fa", "#d5e2ee", "#3a6a9a"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#eef4fa", surface: "#e0eaf5", surfaceAlt: "#d5e2ee", elevated: "#c5d5e5",
        border: "#a8bcd0", borderLight: "#bccadb", borderLighter: "#8aa0b8",
        text: "#1a2a3a", textStrong: "#0a1a2a", textMuted: "#4a5c70", textDim: "#7888a0",
        accent: "#3a6a9a", accentHover: "#4d7dad", accentText: "#2a5578",
        danger: "#b84444", warning: "#b88a3a", success: "#3a8a5a", overlay: "#1a2a3a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "autumn",
    label: "Autumn",
    description: "Warm rust, amber, and brown — October light",
    swatches: ["#f5e6d0", "#e5c8a0", "#a84818"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5e6d0", surface: "#ecd8b8", surfaceAlt: "#e5c8a0", elevated: "#d8b888",
        border: "#c0a070", borderLight: "#a88858", borderLighter: "#907048",
        text: "#3d2810", textStrong: "#201508", textMuted: "#6b4a28", textDim: "#947048",
        accent: "#a84818", accentHover: "#c05820", accentText: "#883810",
        danger: "#a82828", warning: "#a87818", success: "#5a7830", overlay: "#3d2810",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "winter",
    label: "Winter",
    description: "Pale blue-white with frost accents",
    swatches: ["#f0f5fa", "#d8e5f0", "#5a8aaa"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f0f5fa", surface: "#e5eef5", surfaceAlt: "#d8e5f0", elevated: "#c8d8e8",
        border: "#a8c0d5", borderLight: "#bcd0e2", borderLighter: "#8aa8c0",
        text: "#1a3045", textStrong: "#0a1a2a", textMuted: "#486480", textDim: "#7895b0",
        accent: "#5a8aaa", accentHover: "#6da0c0", accentText: "#48708a",
        danger: "#b84848", warning: "#b08830", success: "#408868", overlay: "#1a3045",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "garden-of-eden",
    label: "Garden of Eden",
    description: "Lush greens with warm golden light",
    swatches: ["#0f1f12", "#1c3320", "#f0c020"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0f1f12", surface: "#1a2e1e", surfaceAlt: "#1c3320", elevated: "#254228",
        border: "#365a38", borderLight: "#457248", borderLighter: "#558a58",
        text: "#c8e0c0", textStrong: "#eeffdd", textMuted: "#8aa880", textDim: "#5c7858",
        accent: "#f0c020", accentHover: "#f5d050", accentText: "#f8dd80",
        danger: "#e05858", warning: "#f0a830", success: "#7ac060", overlay: "#080f0a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "burning-bush",
    label: "Burning Bush",
    description: "Deep red-orange fire on near-black",
    swatches: ["#150808", "#2a1010", "#ff5500"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#150808", surface: "#221010", surfaceAlt: "#2a1010", elevated: "#3d1a1a",
        border: "#582020", borderLight: "#702828", borderLighter: "#8a3838",
        text: "#e8c0b0", textStrong: "#ffe8d8", textMuted: "#c08878", textDim: "#8a5a50",
        accent: "#ff5500", accentHover: "#ff7733", accentText: "#ff9955",
        danger: "#ff3333", warning: "#ffaa33", success: "#88aa44", overlay: "#080404",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "upper-room",
    label: "Upper Room",
    description: "Candlelight warm gold on dark brown stone",
    swatches: ["#1a1208", "#2e2018", "#e0a840"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a1208", surface: "#271c10", surfaceAlt: "#2e2018", elevated: "#3d2a20",
        border: "#503a28", borderLight: "#634a38", borderLighter: "#7a6048",
        text: "#e5d0a8", textStrong: "#fff5d8", textMuted: "#b89870", textDim: "#8a7050",
        accent: "#e0a840", accentHover: "#f0bb60", accentText: "#f5cc80",
        danger: "#d04848", warning: "#e0a030", success: "#88a848", overlay: "#0a0806",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "jerusalem-stone",
    label: "Jerusalem Stone",
    description: "Golden limestone with cool shadow blues",
    swatches: ["#ede0c8", "#d4c0a0", "#3a5878"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#ede0c8", surface: "#e0d0b0", surfaceAlt: "#d4c0a0", elevated: "#c5b090",
        border: "#a89070", borderLight: "#bda888", borderLighter: "#95805e",
        text: "#2a2014", textStrong: "#150f08", textMuted: "#5c4a30", textDim: "#8a7858",
        accent: "#3a5878", accentHover: "#4a6a90", accentText: "#2a4560",
        danger: "#9a2828", warning: "#a87818", success: "#5a7a30", overlay: "#2a2014",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "dove",
    label: "Dove",
    description: "Soft white and gentle sky blue — peaceful",
    swatches: ["#f8fafc", "#e5edf5", "#5a8ac8"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f8fafc", surface: "#eef4fa", surfaceAlt: "#e5edf5", elevated: "#d5e0ee",
        border: "#b8c8dc", borderLight: "#cad6e5", borderLighter: "#98aec8",
        text: "#283848", textStrong: "#0a1828", textMuted: "#5a6e88", textDim: "#8a9cb0",
        accent: "#5a8ac8", accentHover: "#6da0dc", accentText: "#4872a8",
        danger: "#b84848", warning: "#b08830", success: "#488868", overlay: "#283848",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "wilderness",
    label: "Wilderness",
    description: "Sand and stone — muted, quiet, and long",
    swatches: ["#e8dfc8", "#c8b898", "#8a6840"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#e8dfc8", surface: "#ddd0b5", surfaceAlt: "#c8b898", elevated: "#b8a680",
        border: "#98886a", borderLight: "#a89878", borderLighter: "#7a6a50",
        text: "#302618", textStrong: "#1a1408", textMuted: "#60503a", textDim: "#8a7860",
        accent: "#8a6840", accentHover: "#a07850", accentText: "#6a4e2e",
        danger: "#9a3828", warning: "#a87818", success: "#5a7838", overlay: "#302618",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "olive-branch",
    label: "Olive Branch",
    description: "Muted olive green and warm cream",
    swatches: ["#f0eedd", "#d8d5b0", "#5a6b28"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f0eedd", surface: "#e5e2c8", surfaceAlt: "#d8d5b0", elevated: "#c8c498",
        border: "#a8a478", borderLight: "#b8b488", borderLighter: "#8a8858",
        text: "#2a3018", textStrong: "#151a08", textMuted: "#585c30", textDim: "#7a7d50",
        accent: "#5a6b28", accentHover: "#6d8030", accentText: "#445220",
        danger: "#9a3828", warning: "#a87818", success: "#5a7838", overlay: "#2a3018",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "bauhaus",
    label: "Bauhaus",
    description: "Cream paper with red, blue, and yellow primaries",
    swatches: ["#f5f0e5", "#e0d8c5", "#e01818"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5f0e5", surface: "#ebe5d5", surfaceAlt: "#e0d8c5", elevated: "#d0c8b0",
        border: "#a8a090", borderLight: "#b8b0a0", borderLighter: "#8a8478",
        text: "#0a0a0a", textStrong: "#000000", textMuted: "#3a3a3a", textDim: "#707070",
        accent: "#e01818", accentHover: "#f03333", accentText: "#b81818",
        danger: "#e01818", warning: "#e0a018", success: "#1858b8", overlay: "#0a0a0a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "art-deco",
    label: "Art Deco",
    description: "Black, gold, and cream — Great Gatsby",
    swatches: ["#0f0d0a", "#221c10", "#d4a830"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0f0d0a", surface: "#1a1610", surfaceAlt: "#221c10", elevated: "#2e2618",
        border: "#453a20", borderLight: "#5a4a28", borderLighter: "#705a30",
        text: "#e5d8b8", textStrong: "#faf0d0", textMuted: "#b8a878", textDim: "#8a7c50",
        accent: "#d4a830", accentHover: "#e5bb50", accentText: "#f0cc70",
        danger: "#c04040", warning: "#d4a830", success: "#a0a840", overlay: "#080604",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "ukiyo-e",
    label: "Ukiyo-e",
    description: "Japanese woodblock — muted blues, reds, and creams",
    swatches: ["#ede5d0", "#c8c0a8", "#2a5888"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#ede5d0", surface: "#e0d8c0", surfaceAlt: "#c8c0a8", elevated: "#b8b098",
        border: "#988e78", borderLight: "#a89e88", borderLighter: "#7a7058",
        text: "#1e2838", textStrong: "#0a1020", textMuted: "#4a5468", textDim: "#7a8494",
        accent: "#2a5888", accentHover: "#3a6ca0", accentText: "#1c4266",
        danger: "#a83028", warning: "#a86828", success: "#4a7038", overlay: "#1e2838",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "kintsugi",
    label: "Kintsugi",
    description: "Charcoal with gold veins — beauty in broken things",
    swatches: ["#1a1612", "#2a251e", "#d4a830"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a1612", surface: "#24201a", surfaceAlt: "#2a251e", elevated: "#38322a",
        border: "#4e463a", borderLight: "#635848", borderLighter: "#7a6c58",
        text: "#d8ccb8", textStrong: "#f0e6d0", textMuted: "#a89880", textDim: "#7a6c58",
        accent: "#d4a830", accentHover: "#e5bb50", accentText: "#f0cc70",
        danger: "#c04848", warning: "#d4a830", success: "#8a9c58", overlay: "#0d0b08",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "mondrian",
    label: "Mondrian",
    description: "White base with red, yellow, and blue blocks",
    swatches: ["#ffffff", "#000000", "#e01818"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f8f8f8", surface: "#ffffff", surfaceAlt: "#f0f0f0", elevated: "#e8e8e8",
        border: "#000000", borderLight: "#333333", borderLighter: "#666666",
        text: "#000000", textStrong: "#000000", textMuted: "#333333", textDim: "#666666",
        accent: "#e01818", accentHover: "#f03030", accentText: "#b81818",
        danger: "#e01818", warning: "#e0a018", success: "#1858b8", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "neon-miami",
    label: "Neon Miami",
    description: "Hot pink and cyan on dark — Vice City",
    swatches: ["#0d0a1f", "#1f1438", "#ff2d95"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0d0a1f", surface: "#170f30", surfaceAlt: "#1f1438", elevated: "#2d1c50",
        border: "#452c6a", borderLight: "#5a3c88", borderLighter: "#704ea8",
        text: "#e0c8f0", textStrong: "#ffffff", textMuted: "#b090d0", textDim: "#7a5c9a",
        accent: "#ff2d95", accentHover: "#ff55aa", accentText: "#ff80c0",
        danger: "#ff2d55", warning: "#ffbb00", success: "#22ddcc", overlay: "#05030f",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "chrome",
    label: "Chrome",
    description: "Silver greys and cold blues — futuristic",
    swatches: ["#e8ecf0", "#c8d0d8", "#3a5a88"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#e8ecf0", surface: "#d8dee5", surfaceAlt: "#c8d0d8", elevated: "#b8c0c8",
        border: "#98a0a8", borderLight: "#a8b0b8", borderLighter: "#7a8288",
        text: "#1a2028", textStrong: "#080c10", textMuted: "#485058", textDim: "#788088",
        accent: "#3a5a88", accentHover: "#4a6ea0", accentText: "#2a4468",
        danger: "#b84848", warning: "#b08830", success: "#3a8868", overlay: "#1a2028",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "bubblegum",
    label: "Bubblegum",
    description: "Bright pink and mint — playful and bubbly",
    swatches: ["#ffe8f0", "#ffc8dd", "#e83888"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#ffe8f0", surface: "#ffd8e8", surfaceAlt: "#ffc8dd", elevated: "#ffb0cc",
        border: "#e898b8", borderLight: "#f0a8c4", borderLighter: "#d880a0",
        text: "#5a1840", textStrong: "#3a0828", textMuted: "#a04878", textDim: "#c87898",
        accent: "#e83888", accentHover: "#f05098", accentText: "#c02068",
        danger: "#e03838", warning: "#e08820", success: "#40b088", overlay: "#5a1840",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "cotton-candy",
    label: "Cotton Candy",
    description: "Pastel pink and blue gradient mood",
    swatches: ["#f5f0fc", "#e8ddf5", "#8a78d8"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5f0fc", surface: "#ece2f8", surfaceAlt: "#e8ddf5", elevated: "#d8c8ee",
        border: "#b8a8d8", borderLight: "#c8b8e2", borderLighter: "#9888bc",
        text: "#3a2a58", textStrong: "#1e1040", textMuted: "#6858a0", textDim: "#9878c0",
        accent: "#8a78d8", accentHover: "#9c8ae5", accentText: "#6a58b8",
        danger: "#c84888", warning: "#c89848", success: "#58a888", overlay: "#3a2a58",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "kodama",
    label: "Kodama",
    description: "Forest spirit — soft greens and mossy browns",
    swatches: ["#1a2018", "#2a3028", "#8ab87a"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a2018", surface: "#222a20", surfaceAlt: "#2a3028", elevated: "#384038",
        border: "#4c5848", borderLight: "#5e6c58", borderLighter: "#72806c",
        text: "#c8d4c0", textStrong: "#e8f0e0", textMuted: "#90a088", textDim: "#657058",
        accent: "#8ab87a", accentHover: "#a0c890", accentText: "#b8d8a8",
        danger: "#c87868", warning: "#d4b060", success: "#8ab87a", overlay: "#0d100a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "easter",
    label: "Easter",
    description: "Pastel lavender and spring green — resurrection morning",
    swatches: ["#fdf8fc", "#f0e4f0", "#c88ee0"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#fdf8fc", surface: "#f8ecf5", surfaceAlt: "#f0e4f0", elevated: "#e8d8e8",
        border: "#d0c0d5", borderLight: "#dccce0", borderLighter: "#b8a8c0",
        text: "#3a2040", textStrong: "#1a0a20", textMuted: "#6a4a70", textDim: "#9888a0",
        accent: "#c88ee0", accentHover: "#d8a8e8", accentText: "#a868c0",
        danger: "#c84848", warning: "#e8b848", success: "#68a868", overlay: "#3a2040",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "halloween",
    label: "Halloween",
    description: "Pumpkin orange, acid green, and deep purple",
    swatches: ["#0f0a18", "#2a1438", "#ff6b1a"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0f0a18", surface: "#1a0f28", surfaceAlt: "#220f30", elevated: "#2a1438",
        border: "#3d2050", borderLight: "#4e2a60", borderLighter: "#5e3a70",
        text: "#d8c8e8", textStrong: "#f0e0ff", textMuted: "#a890c0", textDim: "#705888",
        accent: "#ff6b1a", accentHover: "#ff8a3a", accentText: "#ffaa66",
        danger: "#e83838", warning: "#88d828", success: "#88d828", overlay: "#050208",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "christmas",
    label: "Christmas",
    description: "Evergreen and crimson with a warm gold accent",
    swatches: ["#0a1a10", "#1c3c28", "#d62828"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0a1a10", surface: "#10281a", surfaceAlt: "#143020", elevated: "#1c3c28",
        border: "#2a5038", borderLight: "#356040", borderLighter: "#3f7050",
        text: "#d8e8d8", textStrong: "#f0fff0", textMuted: "#a0c0a8", textDim: "#6a8a72",
        accent: "#d62828", accentHover: "#e83838", accentText: "#f05050",
        danger: "#d62828", warning: "#e0a820", success: "#68b858", overlay: "#050a08",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "thanksgiving",
    label: "Thanksgiving",
    description: "Warm cream, rust, and pumpkin — a long table with candles",
    swatches: ["#f5e8d0", "#e5c8a0", "#a84018"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f5e8d0", surface: "#ecd8b8", surfaceAlt: "#e5c8a0", elevated: "#dcb888",
        border: "#c0a070", borderLight: "#d0b088", borderLighter: "#a88858",
        text: "#3d2010", textStrong: "#200f08", textMuted: "#6b4428", textDim: "#947048",
        accent: "#a84018", accentHover: "#c05020", accentText: "#883010",
        danger: "#a82828", warning: "#a87818", success: "#5a7830", overlay: "#3d2010",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "valentines",
    label: "Valentine's Day",
    description: "Soft pinks and deep red — a heart-shaped everything",
    swatches: ["#fff0f5", "#ffd0e0", "#e80050"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#fff0f5", surface: "#ffe0ea", surfaceAlt: "#ffd0e0", elevated: "#ffb8d0",
        border: "#f098b8", borderLight: "#f8b0c8", borderLighter: "#e078a0",
        text: "#5a1840", textStrong: "#3a0828", textMuted: "#a04878", textDim: "#c87898",
        accent: "#e80050", accentHover: "#f02068", accentText: "#c00040",
        danger: "#e83848", warning: "#e08820", success: "#40b088", overlay: "#5a1840",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "st-patricks",
    label: "St. Patrick's Day",
    description: "Vivid shamrock green with a lucky gold accent",
    swatches: ["#0a1a14", "#1c4030", "#00d060"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0a1a14", surface: "#0f2818", surfaceAlt: "#143020", elevated: "#1c4030",
        border: "#2a5840", borderLight: "#346848", borderLighter: "#407858",
        text: "#c8e8d0", textStrong: "#e8fff0", textMuted: "#88b898", textDim: "#588868",
        accent: "#00d060", accentHover: "#22e080", accentText: "#55e8a0",
        danger: "#e03838", warning: "#e8b820", success: "#00d060", overlay: "#040a08",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "fourth-of-july",
    label: "4th of July",
    description: "Flag red, white, and deep navy blue",
    swatches: ["#f0f5fa", "#c8d8ea", "#c8102e"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#f0f5fa", surface: "#e5eef8", surfaceAlt: "#dae5f0", elevated: "#c8d8ea",
        border: "#a8b8d0", borderLight: "#bcc8dc", borderLighter: "#8a98b8",
        text: "#0a1a3a", textStrong: "#000820", textMuted: "#4a5a80", textDim: "#7888a8",
        accent: "#c8102e", accentHover: "#e02040", accentText: "#a00820",
        danger: "#c8102e", warning: "#d8a020", success: "#2a7858", overlay: "#0a1a3a",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "new-years-eve",
    label: "New Year's Eve",
    description: "Champagne gold on black — midnight with the ball dropping",
    swatches: ["#08080c", "#242036", "#e8c850"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#08080c", surface: "#12101c", surfaceAlt: "#1a1828", elevated: "#242036",
        border: "#383048", borderLight: "#4a4060", borderLighter: "#5c5078",
        text: "#d8d0e8", textStrong: "#f0e8ff", textMuted: "#a098b8", textDim: "#706888",
        accent: "#e8c850", accentHover: "#f5d870", accentText: "#f8e088",
        danger: "#e05858", warning: "#e8c850", success: "#80c080", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "hanukkah",
    label: "Hanukkah",
    description: "Deep blue and warm gold — eight nights of light",
    swatches: ["#0a1238", "#1e3880", "#e8d070"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#0a1238", surface: "#102050", surfaceAlt: "#142868", elevated: "#1e3880",
        border: "#3050a0", borderLight: "#4060b0", borderLighter: "#5070c0",
        text: "#d8e0f0", textStrong: "#f0f5ff", textMuted: "#98a8d0", textDim: "#6878a0",
        accent: "#e8d070", accentHover: "#f5e090", accentText: "#f0e8a0",
        danger: "#d04040", warning: "#e8d070", success: "#68b868", overlay: "#050818",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "diwali",
    label: "Diwali",
    description: "Rich gold, marigold, and deep magenta — the festival of lights",
    swatches: ["#1a0820", "#402048", "#ffaa00"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a0820", surface: "#281030", surfaceAlt: "#331838", elevated: "#402048",
        border: "#582858", borderLight: "#6a3870", borderLighter: "#7a4888",
        text: "#f0d8e8", textStrong: "#fff0f8", textMuted: "#c0a0c0", textDim: "#8870a0",
        accent: "#ffaa00", accentHover: "#ffc040", accentText: "#ffd070",
        danger: "#ff3344", warning: "#ff8800", success: "#88c848", overlay: "#0a0410",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "lunar-new-year",
    label: "Lunar New Year",
    description: "Imperial red and gold — luck, prosperity, and family",
    swatches: ["#1a0808", "#4a2020", "#e8a020"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a0808", surface: "#2a1010", surfaceAlt: "#3a1818", elevated: "#4a2020",
        border: "#682828", borderLight: "#7a3838", borderLighter: "#8a4848",
        text: "#f8d8c0", textStrong: "#fff0e0", textMuted: "#d0a898", textDim: "#a07868",
        accent: "#e8a020", accentHover: "#f5b840", accentText: "#f8c860",
        danger: "#e83030", warning: "#e8a020", success: "#68a848", overlay: "#0a0404",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "dia-de-muertos",
    label: "Día de los Muertos",
    description: "Vivid pink, marigold, and turquoise — celebration, not mourning",
    swatches: ["#1a0a18", "#452438", "#ff2d95"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#1a0a18", surface: "#281428", surfaceAlt: "#351c30", elevated: "#452438",
        border: "#602e50", borderLight: "#7a3a68", borderLighter: "#8a4880",
        text: "#f0d0e8", textStrong: "#ffe8f8", textMuted: "#c098b8", textDim: "#886888",
        accent: "#ff2d95", accentHover: "#ff55aa", accentText: "#ff88c0",
        danger: "#ff3344", warning: "#ff8800", success: "#00c8a8", overlay: "#080410",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "black-orange",
    label: "Black & Orange",
    description: "Pure black canvas with a bold burnt-orange accent",
    swatches: ["#000000", "#1a1a1a", "#ff6a00"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#000000", surface: "#0d0d0d", surfaceAlt: "#161616", elevated: "#1f1f1f",
        border: "#2e2e2e", borderLight: "#3a3a3a", borderLighter: "#4a4a4a",
        text: "#e8e0d5", textStrong: "#ffffff", textMuted: "#a89888", textDim: "#706050",
        accent: "#ff6a00", accentHover: "#ff8a2a", accentText: "#ffaa66",
        danger: "#ff3030", warning: "#ffaa00", success: "#66c866", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
  {
    id: "rgb",
    label: "RGB",
    description: "Pure black with red, green, and blue neon — the gamer aesthetic",
    swatches: ["#000000", "#1a1a1a", "#00ff88"],
    build: () => ({
      mode: "custom" as ThemeMode,
      colors: {
        bg: "#000000", surface: "#0a0a0a", surfaceAlt: "#141414", elevated: "#1f1f1f",
        border: "#00d0ff", borderLight: "#00ff88", borderLighter: "#ff0044",
        text: "#e0e0e0", textStrong: "#ffffff", textMuted: "#a0a0a0", textDim: "#606060",
        accent: "#00ff88", accentHover: "#55ffaa", accentText: "#88ffbb",
        danger: "#ff0044", warning: "#ffcc00", success: "#00ff88", overlay: "#000000",
      },
      background: { ...DEFAULT_BACKGROUND },
    }),
  },
];

const CSS_VAR_MAP: Record<keyof ThemeColors, string> = {
  bg: "--c-bg",
  surface: "--c-surface",
  surfaceAlt: "--c-surface-alt",
  elevated: "--c-elevated",
  border: "--c-border",
  borderLight: "--c-border-light",
  borderLighter: "--c-border-lighter",
  text: "--c-text",
  textStrong: "--c-text-strong",
  textMuted: "--c-text-muted",
  textDim: "--c-text-dim",
  accent: "--c-accent",
  accentHover: "--c-accent-hover",
  accentText: "--c-accent-text",
  danger: "--c-danger",
  warning: "--c-warning",
  success: "--c-success",
  overlay: "--c-overlay",
};

// ── Vault-aware theme storage ──────────────────────────────────────────
// Themes live inside each vault's .vault_metadata.json, so switching
// vaults switches themes. localStorage is kept only as a seed for
// brand-new vaults and for migrating the old global behavior.

let currentVaultPath: string | null = null;
// Initialize from localStorage so the very first paint (welcome screen,
// or the app before setThemeVaultPath runs) shows the last-used theme
// instead of snapping to dark. readLegacyLocalTheme is a hoisted
// function declaration, and DARK_THEME/LIGHT_THEME/DEFAULT_BACKGROUND/
// STORAGE_KEY are all declared earlier in the file — so this runs safely.
let cachedTheme: Theme = readLegacyLocalTheme() ?? DARK_THEME;
let saveQueue: Promise<void> = Promise.resolve();

/** Sync read of the currently-active theme (used by useTheme). */
export function getCurrentTheme(): Theme {
  return cachedTheme;
}

function parseTheme(raw: any): Theme {
  const base = raw?.mode === "light" ? LIGHT_THEME : DARK_THEME;
  return {
    mode: raw?.mode ?? "dark",
    colors: { ...base.colors, ...(raw?.colors || {}) },
    background: { ...DEFAULT_BACKGROUND, ...(raw?.background || {}) },
  };
}

function readLegacyLocalTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return parseTheme(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readVaultMeta(vaultPath: string): Promise<any> {
  try {
    const raw = await readTextFile(await join(vaultPath, ".vault_metadata.json"));
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeVaultMeta(vaultPath: string, meta: any): Promise<void> {
  const path = await join(vaultPath, ".vault_metadata.json");
  await writeFileAtomic(path, JSON.stringify(meta, null, 2));
}

/**
 * Tell the theme system which vault is currently open. Loads that vault's
 * theme from disk (falling back to a seed for new vaults) and broadcasts
 * the change so every useTheme() hook re-renders.
 *
 * Call this from App.tsx whenever `vaultPath` changes.
 */
export async function setThemeVaultPath(vaultPath: string | null): Promise<void> {
  if (currentVaultPath === vaultPath) return;
  currentVaultPath = vaultPath;

  if (!vaultPath) {
    // Welcome screen: show the last-used theme from localStorage, not dark.
    cachedTheme = readLegacyLocalTheme() ?? DARK_THEME;
    window.dispatchEvent(new Event("theme-changed"));
    return;
  }

  try {
    const meta = await readVaultMeta(vaultPath);
    if (meta.theme) {
      // Vault already has a theme — use it.
      cachedTheme = parseTheme(meta.theme);
    } else {
      // New vault: seed from localStorage (the user's last-used theme)
      // or fall back to dark, then persist so this vault owns its copy.
      cachedTheme = readLegacyLocalTheme() || DARK_THEME;
      meta.theme = cachedTheme;
      try {
        await writeVaultMeta(vaultPath, meta);
      } catch (e) {
        console.error("[theme] could not seed vault theme:", e);
      }
    }
    // Mirror to localStorage so the NEXT new vault inherits this theme.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedTheme));
    } catch {}
  } catch (e) {
    console.error("[theme] failed to load theme for vault:", e);
    cachedTheme = DARK_THEME;
  }

  window.dispatchEvent(new Event("theme-changed"));
}

export function loadTheme(): Theme {
  return cachedTheme;
}

export async function saveTheme(theme: Theme): Promise<void> {
  cachedTheme = theme;
  window.dispatchEvent(new Event("theme-changed"));

  // Mirror to localStorage so new vaults default to this theme.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
  } catch {}

  if (!currentVaultPath) return;

  // Serialize saves so rapid theme tweaks don't clobber each other.
  const vaultPath = currentVaultPath;
  saveQueue = saveQueue.then(async () => {
    try {
      const meta = await readVaultMeta(vaultPath);
      meta.theme = theme;
      await writeVaultMeta(vaultPath, meta);
    } catch (e) {
      console.error("[theme] failed to save theme:", e);
    }
  });
  return saveQueue;
}

/** Perceptual luminance check (Rec. 601). Returns true when a hex color
 *  reads as "light enough that dark text works better than light text." */
function isLightHex(hex: string): boolean {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.colors) as [keyof ThemeColors, string][]) {
    root.style.setProperty(CSS_VAR_MAP[k], v);
  }
  root.setAttribute("data-theme", theme.mode);
  root.style.colorScheme = theme.mode === "light" ? "light" : "dark";

  // Background-image plumbing. The CSS uses these body classes to decide
  // which panels should become translucent.
  const bg = theme.background;
  const body = document.body;
  body.classList.toggle("theme-has-bg", !!bg.image);
  body.classList.toggle("theme-scope-app", bg.scope === "app");
  body.classList.toggle("theme-scope-sidebar", bg.scope === "sidebar");
  body.classList.toggle("theme-separate-tints", !!bg.separateTints);
  root.style.setProperty("--c-panel-opacity", `${bg.panelOpacity}%`);
  root.style.setProperty("--c-sidebar-opacity", `${bg.sidebarOpacity}%`);
  // Fall back to the theme palette when the user hasn't set a tint.
  root.style.setProperty(
    "--c-sidebar-tint",
    bg.sidebarTint || "var(--c-surface)"
  );
  root.style.setProperty(
    "--c-content-tint",
    bg.contentTint || "var(--c-bg)"
  );
  // Expose the overlay values as CSS variables so the panel background
  // rules can mix them in. This is what makes the overlay tint affect
  // even fully-opaque panels — without it, the overlay only shows in
  // the gaps between panels.
  root.style.setProperty("--c-overlay-tint", bg.overlayColor || "transparent");
  root.style.setProperty("--c-overlay-intensity", `${bg.overlayOpacity}%`);
  root.style.setProperty(
    "--c-sidebar-tint-intensity",
    `${bg.sidebarTintIntensity ?? 100}%`
  );
  root.style.setProperty(
    "--c-content-tint-intensity",
    `${bg.contentTintIntensity ?? 100}%`
  );
  // Fraction form (0–1) for `opacity:` — `calc(100% / 100)` evaluates to
  // 1%, not 1, because CSS percentages aren't unitless. Keeping both
  // forms saves every caller from having to remember that.
  root.style.setProperty("--c-overlay-alpha", String(bg.overlayOpacity / 100));
  root.style.setProperty(
    "--c-modal-color",
    bg.modalColor || "var(--c-elevated)"
  );
  root.style.setProperty("--c-modal-opacity", `${bg.modalOpacity ?? 100}%`);

  // Toggle a body class based on the *theme's own* background brightness.
  // Folder label colors, icon contrast, and other luminance-sensitive
  // rules key off this instead of `data-theme`, so custom themes get the
  // right treatment regardless of their mode string.
  const isLightSurface = isLightHex(theme.colors.bg);
  document.body.classList.toggle("theme-light-surface", isLightSurface);
}

export function themeToCSS(theme: Theme): string {
  const bg = theme.background;
  const lines = [`/* Selah theme — ${theme.mode} */`, `:root {`];

  // ── Palette ─────────────────────────────────────────────────────────
  for (const [k, v] of Object.entries(theme.colors) as [keyof ThemeColors, string][]) {
    lines.push(`  ${CSS_VAR_MAP[k]}: ${v};`);
  }

  // ── Background + tint layer ─────────────────────────────────────────
  // Everything a user can tune in the Appearance panel is exported here
  // so it round-trips cleanly through Save / Import.
  lines.push(`  /* Background image settings */`);
  lines.push(`  --c-image-blur: ${bg.blur};`);
  lines.push(`  --c-image-opacity: ${bg.opacity}%;`);

  lines.push(`  /* Unified-mode opacities */`);
  lines.push(`  --c-panel-opacity: ${bg.panelOpacity}%;`);
  lines.push(`  --c-sidebar-opacity: ${bg.sidebarOpacity}%;`);

  lines.push(`  /* Overlay tint (unified mode) */`);
  lines.push(`  --c-overlay-tint: ${bg.overlayColor};`);
  lines.push(`  --c-overlay-intensity: ${bg.overlayOpacity}%;`);

  lines.push(`  /* Separate-tints mode */`);
  lines.push(`  --c-sidebar-tint: ${bg.sidebarTint || "var(--c-surface)"};`);
  lines.push(`  --c-content-tint: ${bg.contentTint || "var(--c-bg)"};`);
  lines.push(`  --c-sidebar-tint-intensity: ${bg.sidebarTintIntensity}%;`);
  lines.push(`  --c-content-tint-intensity: ${bg.contentTintIntensity}%;`);

  lines.push(`  /* Settings dialogs */`);
  lines.push(`  --c-modal-color: ${bg.modalColor || "var(--c-elevated)"};`);
  lines.push(`  --c-modal-opacity: ${bg.modalOpacity}%;`);

  lines.push(`}`);
  return lines.join("\n");
}

export function themeFromCSS(css: string): Theme | null {
  const reverse: Record<string, keyof ThemeColors> = {};
  for (const [k, v] of Object.entries(CSS_VAR_MAP) as [keyof ThemeColors, string][]) {
    reverse[v] = k;
  }
  const colors: Partial<ThemeColors> = {};
  const re = /(--c-[a-z-]+)\s*:\s*([^;]+?)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const key = reverse[m[1]];
    if (key) colors[key] = m[2].trim();
  }
  if (Object.keys(colors).length === 0) return null;

  // ── Background settings ─────────────────────────────────────────────
  // Parses every var themeToCSS writes. Anything the CSS doesn't mention
  // falls through to the machine's current value — this keeps the user's
  // background image safe when they import a colors-only theme from
  // someone else.
  const current = loadTheme();
  const bg = { ...current.background };

  const readVar = (name: string, def = ""): string => {
    const r = new RegExp(`${name}\\s*:\\s*([^;]+?)\\s*;`);
    const match = css.match(r);
    return match ? match[1].trim() : def;
  };
  const readNum = (name: string, def: number): number => {
    const raw = readVar(name, "");
    if (!raw) return def;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : def;
  };
  const readTint = (name: string, def: string): string => {
    const raw = readVar(name, "");
    // `var(--c-…)` means "follow the theme" — normalize to "" so the
    // runtime fallback works the same way.
    if (!raw || raw.startsWith("var(")) return def;
    return raw;
  };

  bg.blur = readNum("--c-image-blur", bg.blur);
  bg.opacity = readNum("--c-image-opacity", bg.opacity);

  bg.panelOpacity = readNum("--c-panel-opacity", bg.panelOpacity);
  bg.sidebarOpacity = readNum("--c-sidebar-opacity", bg.sidebarOpacity);

  bg.overlayColor = readTint("--c-overlay-tint", bg.overlayColor);
  bg.overlayOpacity = readNum("--c-overlay-intensity", bg.overlayOpacity);

  bg.sidebarTint = readTint("--c-sidebar-tint", "");
  bg.contentTint = readTint("--c-content-tint", "");
  bg.sidebarTintIntensity = readNum("--c-sidebar-tint-intensity", bg.sidebarTintIntensity);
  bg.contentTintIntensity = readNum("--c-content-tint-intensity", bg.contentTintIntensity);

  bg.modalColor = readTint("--c-modal-color", "");
  bg.modalOpacity = readNum("--c-modal-opacity", bg.modalOpacity);

  // If both tints are set, the imported theme clearly wants separate
  // tints — flip the toggle on. If neither is set, leave it as-is.
  if (bg.sidebarTint || bg.contentTint) {
    bg.separateTints = true;
  }

  return {
    mode: "custom",
    colors: { ...DARK_THEME.colors, ...colors },
    background: bg,
  };
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getCurrentTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const handler = () => setThemeState(getCurrentTheme());
    window.addEventListener("theme-changed", handler);
    return () => window.removeEventListener("theme-changed", handler);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    void saveTheme(next);
  }, []);

  return { theme, setTheme };
}
