// src/AppearancePanel.tsx
import { useState } from "react";
import {
  Palette, Sun, Moon, Wand2, Copy, Check, Upload,
  Download, RotateCcw, X, AlertTriangle, Code2,
  Image as ImageIcon, Link as LinkIcon, Trash2, Sliders, Save, Bookmark,
} from "lucide-react";
import {
  useTheme,
  DARK_THEME,
  LIGHT_THEME,
  COLOR_LABELS,
  THEME_PRESETS,
  PRESET_CATEGORY,
  PRESET_CATEGORY_LABELS,
  themeToCSS,
  themeFromCSS,
  useCustomPresets,
  addCustomPreset,
  deleteCustomPreset,
  type ThemeMode,
  type ThemeColors,
  type ThemeBackground,
} from "./theme";

/** Emoji shown next to each category header in the preset picker. */
const PRESET_CATEGORY_EMOJI: Record<string, string> = {
  featured: "✨",
  dark: "🌙",
  light: "☀️",
  editor: "💻",
  terminal: "📟",
  nature: "🌿",
  faith: "🙏",
  holiday: "🎊",
  "retro-os": "💾",
  cultural: "🎨",
  playful: "🎈",
};

export default function AppearancePanel() {
  const { theme, setTheme } = useTheme();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorCopied, setEditorCopied] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const customPresets = useCustomPresets();
  const [presetName, setPresetName] = useState("");
  const [presetMsg, setPresetMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [cssMsg, setCssMsg] = useState<{ error?: boolean } | null>(null);

  const isPreset = theme.mode === "dark" || theme.mode === "light";

  const setMode = (mode: ThemeMode) => {
    if (mode === "dark") { setTheme({ ...DARK_THEME, background: theme.background }); return; }
    if (mode === "light") { setTheme({ ...LIGHT_THEME, background: theme.background }); return; }
    setTheme({ ...theme, mode: "custom" });
  };

  const setColor = (key: keyof ThemeColors, value: string) => {
    setTheme({ ...theme, mode: "custom", colors: { ...theme.colors, [key]: value } });
  };

  const setBackground = (patch: Partial<ThemeBackground>) => {
    setTheme({ ...theme, background: { ...theme.background, ...patch } });
  };

  // ── Image picking ────────────────────────────────────────────────────
  const pickImage = async () => {
    setImageBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const picked = await open({
        multiple: false,
        filters: [{
          name: "Image",
          extensions: ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif"],
        }],
      });
      if (!picked || typeof picked !== "string") return;
      const bytes = await readFile(picked);
      const dataUrl = await shrinkImageToDataUrl(bytes);
      if (dataUrl) setBackground({ image: dataUrl });
    } catch (e) {
      console.error("[theme] pick image failed:", e);
    } finally {
      setImageBusy(false);
    }
  };

  const applyUrl = () => {
    const v = urlDraft.trim();
    if (!v) return;
    setBackground({ image: v });
    setUrlDraft("");
  };

  const clearImage = () => setBackground({ image: "" });

  // ── CSS editor ───────────────────────────────────────────────────────
  const openEditor = () => {
    setEditorText(themeToCSS(theme));
    setEditorError(null);
    setEditorCopied(false);
    setEditorOpen(true);
  };

  const applyEditor = () => {
    const parsed = themeFromCSS(editorText);
    if (!parsed) {
      setEditorError(
        'No --c-* variables found. Expected lines like "--c-bg: #1a1a2e;".'
      );
      return;
    }
    setTheme(parsed);
    setEditorOpen(false);
  };

  const resetEditor = () => {
    setEditorText(themeToCSS(theme));
    setEditorError(null);
  };

  const copyEditor = async () => {
    try {
      await navigator.clipboard.writeText(editorText);
      setEditorCopied(true);
      setTimeout(() => setEditorCopied(false), 1500);
    } catch (e) {
      console.error("[theme] copy failed:", e);
    }
  };

  const downloadCSS = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const dest = await save({
        defaultPath: "selah-theme.css",
        filters: [{ name: "CSS", extensions: ["css"] }],
      });
      if (!dest) return;
      await writeTextFile(dest, themeToCSS(theme));
      setCssMsg({});
    } catch (e) {
      console.error("[theme] save css failed:", e);
      setCssMsg({ error: true });
    }
    setTimeout(() => setCssMsg(null), 2000);
  };

  const saveCurrentAsPreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const ok = addCustomPreset(name, theme);
    if (ok) {
      setPresetName("");
      setPresetMsg({ text: `Saved "${name}".` });
    } else {
      setPresetMsg({
        text: "Couldn't save (storage full?). Try removing the background image first.",
        error: true,
      });
    }
    setTimeout(() => setPresetMsg(null), 3000);
  };

  const pickCSSFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const picked = await open({
        multiple: false,
        filters: [{ name: "CSS", extensions: ["css", "txt"] }],
      });
      if (!picked || typeof picked !== "string") return;
      const raw = await readTextFile(picked);
      const parsed = themeFromCSS(raw);
      if (!parsed) {
        setEditorText(raw);
        setEditorError("No --c-* variables found in that file.");
        setEditorCopied(false);
        setEditorOpen(true);
        return;
      }
      setTheme(parsed);
    } catch (e: any) {
      console.error("[theme] file import failed:", e);
    }
  };

  const hasImage = !!theme.background.image;

  /** Apply a preset. Only the glassy preset ships (and needs) a
   *  background image — every other preset is a solid palette, so we
   *  clear any existing background image to leave a clean theme. */
  const applyPreset = (preset: typeof THEME_PRESETS[number]) => {
    const built = preset.build();
    const userImage = theme.background.image;
    const presetImage = built.background.image;

    if (!presetImage) {
      // Non-glassy preset: wipe any background image so the theme
      // presents as the solid palette it was designed to be. Other
      // background knobs (blur, overlay) get their defaults back.
      built.background = {
        ...built.background,
        image: "",
        blur: 0,
        opacity: 100,
        overlayOpacity: 0,
        panelOpacity: 75,
        sidebarOpacity: 75,
        separateTints: false,
        sidebarTint: "",
        contentTint: "",
      };
    } else if (userImage) {
      // Glassy preset + user already has their own photo: keep their
      // photo but take the glass effect's other values (blur, panel
      // opacities) so the frosted panels still work.
      built.background = { ...built.background, image: userImage };
    }
    // else: glassy preset and user has no background → use the preset's
    // built-in bokeh image.

    setTheme(built);
  };

  return (
    <div className="p-5 space-y-6">
      {/* ── Mode buttons ─────────────────────────────────────────────── */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
          <Palette size={10} /> Theme
        </div>

        <div className="grid grid-cols-3 gap-2">
          <ModeButton icon={Moon} label="Dark" active={theme.mode === "dark"} onClick={() => setMode("dark")} />
          <ModeButton icon={Sun}  label="Light" active={theme.mode === "light"} onClick={() => setMode("light")} />
          <ModeButton icon={Wand2} label="Custom" active={theme.mode === "custom"} onClick={() => setMode("custom")} />
        </div>

        <p className="text-[10px] text-gray-600 mt-2 leading-snug">
          {theme.mode === "dark" && "Selah's default dark palette."}
          {theme.mode === "light" && "A soft light palette for daytime reading."}
          {theme.mode === "custom" && "Pick colors below — changes apply instantly."}
        </p>
      </div>

      {/* ── Presets ──────────────────────────────────────────────────── */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3">
          Presets
        </div>
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-xs leading-none select-none">⭐</span>
            <span className="text-[10px] uppercase tracking-[0.15em] text-gray-500">
              My presets
            </span>
            <div className="flex-1 h-px bg-[#2a3136]/50" />
            <span className="text-[10px] text-gray-600 tabular-nums">
              {customPresets.length}
            </span>
          </div>

          <div className="flex gap-1.5 mb-2">
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveCurrentAsPreset(); }}
              placeholder="Name the current theme…"
              className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={saveCurrentAsPreset}
              disabled={!presetName.trim()}
              className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded flex-shrink-0"
            >
              <Save size={11} /> Save
            </button>
          </div>

          {presetMsg && (
            <p className={`text-[10px] mb-2 ${presetMsg.error ? "text-red-400" : "text-green-400"}`}>
              {presetMsg.text}
            </p>
          )}

          {customPresets.length === 0 ? (
            <p className="text-[10px] text-gray-600 leading-snug">
              Tweak colors or a background below, then save it here to reuse it in any vault.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {customPresets.map((p) => {
                const c = p.theme.colors;
                const isActive = (Object.keys(c) as (keyof ThemeColors)[])
                  .every((k) => c[k] === theme.colors[k]);
                return (
                  <div
                    key={p.id}
                    className={`group relative rounded-md border overflow-hidden transition-all ${
                      isActive
                        ? "border-blue-500/60 ring-1 ring-blue-500/40"
                        : "border-[#2a3136] hover:border-[#3a4147]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setTheme({ ...p.theme, mode: "custom" })}
                      className="w-full text-left cursor-pointer"
                    >
                      <div className="h-8 flex" style={{ backgroundColor: c.bg }}>
                        <div
                          className="w-1/4 flex flex-col justify-center gap-0.5 pl-1.5"
                          style={{ backgroundColor: c.surface }}
                        >
                          <div className="h-[3px] w-4/5 rounded-full" style={{ backgroundColor: c.textMuted }} />
                          <div className="h-[3px] w-3/5 rounded-full" style={{ backgroundColor: c.textMuted }} />
                        </div>
                        <div className="flex-1 flex flex-col justify-center gap-0.5 pl-1.5">
                          <div className="h-[3px] w-1/2 rounded-full" style={{ backgroundColor: c.text }} />
                          <div className="h-[3px] w-1/3 rounded-full" style={{ backgroundColor: c.accent }} />
                        </div>
                      </div>
                      <div className={`px-2.5 py-2 ${isActive ? "bg-blue-600/15" : "bg-[#131819]"}`}>
                        <div className={`text-xs font-medium truncate ${isActive ? "text-blue-200" : "text-gray-200"}`}>
                          {p.label}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          {p.theme.background.image ? "With background" : "Colors only"}
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteCustomPreset(p.id)}
                      className="absolute top-1 right-1 p-1 rounded bg-black/70 text-white opacity-0 group-hover:opacity-100 hover:bg-red-600 transition-opacity"
                      title="Delete preset"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {PRESET_CATEGORY_LABELS.map((cat) => {
          const presets = THEME_PRESETS.filter(
            (p) => (PRESET_CATEGORY[p.id] ?? "dark") === cat.id
          );
          if (presets.length === 0) return null;
          const emoji = PRESET_CATEGORY_EMOJI[cat.id] ?? "•";
          return (
            <div key={cat.id} className="mb-6 last:mb-0">
              <div className="flex items-center gap-2 mb-2.5">
                <span className="text-xs leading-none select-none">{emoji}</span>
                <span className="text-[10px] uppercase tracking-[0.15em] text-gray-500">
                  {cat.label}
                </span>
                <div className="flex-1 h-px bg-[#2a3136]/50" />
                <span className="text-[10px] text-gray-600 tabular-nums">
                  {presets.length}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {presets.map((preset) => {
                  const presetColors = preset.build().colors;
                  const isActive = (Object.keys(presetColors) as (keyof ThemeColors)[])
                    .every((k) => presetColors[k] === theme.colors[k]);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => { void applyPreset(preset); }}
                      className={`text-left rounded-md border overflow-hidden transition-all cursor-pointer ${
                        isActive
                          ? "border-blue-500/60 ring-1 ring-blue-500/40"
                          : "border-[#2a3136] hover:border-[#3a4147]"
                      }`}
                    >
                      {/* Mini theme preview — a tiny sidebar + content strip
                          rendered with the preset's own colors. */}
                      <div className="h-8 flex" style={{ backgroundColor: presetColors.bg }}>
                        <div
                          className="w-1/4 flex flex-col justify-center gap-0.5 pl-1.5"
                          style={{ backgroundColor: presetColors.surface }}
                        >
                          <div
                            className="h-[3px] w-4/5 rounded-full"
                            style={{ backgroundColor: presetColors.textMuted }}
                          />
                          <div
                            className="h-[3px] w-3/5 rounded-full"
                            style={{ backgroundColor: presetColors.textMuted }}
                          />
                        </div>
                        <div className="flex-1 flex flex-col justify-center gap-0.5 pl-1.5">
                          <div
                            className="h-[3px] w-1/2 rounded-full"
                            style={{ backgroundColor: presetColors.text }}
                          />
                          <div
                            className="h-[3px] w-1/3 rounded-full"
                            style={{ backgroundColor: presetColors.accent }}
                          />
                        </div>
                      </div>

                      <div className={`px-2.5 py-2 ${isActive ? "bg-blue-600/15" : "bg-[#131819]"}`}>
                        <div className={`text-xs font-medium truncate ${isActive ? "text-blue-200" : "text-gray-200"}`}>
                          {preset.label}
                        </div>
                        <div className="text-[10px] text-gray-500 leading-snug line-clamp-2 mt-0.5">
                          {preset.description}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Colors ───────────────────────────────────────────────────── */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3">
          Colors {isPreset && <span className="text-gray-700">· start editing to customize</span>}
        </div>

        <div className="space-y-2">
          {COLOR_LABELS.filter((c) => c.group === "essential").map(({ key, label, hint }) => (
            <ColorRow
              key={key}
              label={label}
              hint={hint}
              value={theme.colors[key]}
              onChange={(v) => setColor(key, v)}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="mt-3 w-full text-left text-[11px] text-gray-500 hover:text-gray-300 px-2 py-1.5 rounded hover:bg-[#2a3136] transition-colors flex items-center justify-between"
        >
          <span>{advancedOpen ? "Hide fine-tuning colors" : "Show fine-tuning colors…"}</span>
          <span className="text-gray-600">{advancedOpen ? "▲" : "▼"}</span>
        </button>

        {advancedOpen && (
          <div className="space-y-2 mt-2 pt-2 border-t border-[#2a3136]">
            {COLOR_LABELS.filter((c) => c.group === "advanced").map(({ key, label, hint }) => (
              <ColorRow
                key={key}
                label={label}
                hint={hint}
                value={theme.colors[key]}
                onChange={(v) => setColor(key, v)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Background image ─────────────────────────────────────────── */}
      <div className="border-t border-[#2a3136] pt-4">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
          <ImageIcon size={10} /> Background image
        </div>

        {!hasImage ? (
          <>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={pickImage}
                disabled={imageBusy}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-[#2a3136] hover:bg-[#30363d] disabled:opacity-40 border border-[#30363d] rounded text-gray-200 transition-colors"
              >
                <Upload size={12} />
                <span>{imageBusy ? "Loading…" : "Choose image…"}</span>
              </button>
            </div>
            <div className="flex gap-1.5 mt-2">
              <input
                type="text"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyUrl(); }}
                placeholder="…or paste an image URL"
                className="flex-1 min-w-0 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1.5 text-[11px] text-gray-200 outline-none focus:ring-1 focus:ring-blue-500 font-mono"
              />
              <button
                type="button"
                onClick={applyUrl}
                disabled={!urlDraft.trim()}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
              >
                <LinkIcon size={11} /> Apply
              </button>
            </div>
            <p className="text-[10px] text-gray-600 mt-2 leading-snug">
              Local images are downscaled to 1920&nbsp;px and stored on
              this machine so they never leave your computer.
            </p>
          </>
        ) : (
          <>
            {/* Preview */}
            <div className="h-32 rounded border border-[#30363d] overflow-hidden mb-3 bg-[#0f1315] relative">
              <img
                src={theme.background.image}
                alt=""
                className="w-full h-full object-cover"
                style={{
                  filter: theme.background.blur > 0
                    ? `blur(${theme.background.blur}px)`
                    : undefined,
                  opacity: theme.background.opacity / 100,
                }}
              />
              {theme.background.overlayOpacity > 0 && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    backgroundColor: theme.background.overlayColor,
                    opacity: theme.background.overlayOpacity / 100,
                  }}
                />
              )}
            </div>

            {/* Scope */}
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
                Where it shows
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ScopeButton
                  active={theme.background.scope === "app"}
                  label="Whole app"
                  hint="Image behind everything"
                  onClick={() => setBackground({ scope: "app" })}
                />
                <ScopeButton
                  active={theme.background.scope === "sidebar"}
                  label="Sidebar only"
                  hint="Image behind the sidebar"
                  onClick={() => setBackground({ scope: "sidebar" })}
                />
              </div>
            </div>

            {/* Sliders */}
            <div className="space-y-3">
              <SliderRow
                label="Blur" value={theme.background.blur}
                min={0} max={40} unit="px"
                onChange={(v) => setBackground({ blur: v })}
              />
              <SliderRow
                label="Image opacity" value={theme.background.opacity}
                min={0} max={100} unit="%"
                onChange={(v) => setBackground({ opacity: v })}
              />
              {!theme.background.separateTints && (
                <>
                  {theme.background.scope !== "sidebar" && (
                    <SliderRow
                      label="Content opacity"
                      value={theme.background.panelOpacity}
                      min={0} max={100} unit="%"
                      onChange={(v) => setBackground({ panelOpacity: v })}
                      hint="0 % — content panels invisible, 100 % — fully cover the image"
                    />
                  )}
                  <SliderRow
                    label="Sidebar opacity"
                    value={theme.background.sidebarOpacity}
                    min={0} max={100} unit="%"
                    onChange={(v) => setBackground({ sidebarOpacity: v })}
                    hint="Controls how much image shows through the sidebar column — works in both scopes"
                  />
                </>
              )}

              {theme.background.separateTints && (
                <>
                  <TintRow
                    label="Sidebar tint"
                    hint="The color the sidebar composites over the image"
                    value={theme.background.sidebarTint}
                    fallback={theme.colors.surface}
                    onChange={(v) => setBackground({ sidebarTint: v })}
                  />
                  <SliderRow
                    label="Sidebar tint intensity"
                    value={theme.background.sidebarTintIntensity}
                    min={0} max={100} unit="%"
                    onChange={(v) => setBackground({ sidebarTintIntensity: v })}
                    hint="0 % — sidebar uses the theme's surface color, 100 % — fully the tint"
                  />
                  <TintRow
                    label="Content tint"
                    hint="The color the content area composites over the image"
                    value={theme.background.contentTint}
                    fallback={theme.colors.bg}
                    onChange={(v) => setBackground({ contentTint: v })}
                  />
                  <SliderRow
                    label="Content tint intensity"
                    value={theme.background.contentTintIntensity}
                    min={0} max={100} unit="%"
                    onChange={(v) => setBackground({ contentTintIntensity: v })}
                    hint="0 % — content uses the theme's background color, 100 % — fully the tint"
                  />
                </>
              )}
            </div>

            <div className="mt-3">
              <SliderRow
                label="Menu opacity"
                value={theme.background.menuOpacity ?? 100}
                min={0} max={100} unit="%"
                onChange={(v) => setBackground({ menuOpacity: v })}
                hint="Dropdowns and right-click menus. Raise it if menu text is hard to read."
              />
            </div>

            {/* Toggle between one unified tint and per-area tints. */}
            <div className="mt-3">
              <button
                type="button"
                onClick={() => {
                  const next = !theme.background.separateTints;
                  setBackground(
                    next
                      ? { separateTints: true }
                      : { separateTints: false, sidebarTint: "", contentTint: "" }
                  );
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded border text-xs transition-colors cursor-pointer ${
                  theme.background.separateTints
                    ? "bg-blue-600/15 border-blue-500/60 text-blue-200"
                    : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200 hover:border-[#3a4147]"
                }`}
              >
                <span className="flex items-center gap-2">
                  <Sliders size={12} />
                  <span>Customize tints separately</span>
                </span>
                <span className="text-[10px] uppercase tracking-wider opacity-70">
                  {theme.background.separateTints ? "On" : "Off"}
                </span>
              </button>
              <p className="text-[10px] text-gray-600 mt-1.5 leading-snug">
                {theme.background.separateTints
                  ? "Sidebar and content have their own tint colors."
                  : "The unified overlay above controls the whole background. Turn this on to tint each area independently."}
              </p>
            </div>

            {/* Overlay — only shown in unified mode. When separate tints
                are on, the per-area tint sliders above take over. */}
            {!theme.background.separateTints && (
            <div className="mt-4 pt-4 border-t border-[#2a3136]">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
                Overlay tint
              </div>
              <div className="flex items-center gap-2 mb-3">
                <label className="relative flex-shrink-0 w-8 h-8 rounded border border-[#30363d] overflow-hidden cursor-pointer hover:border-[#3a4147] transition-colors">
                  <span
                    className="absolute inset-0"
                    style={{ backgroundColor: theme.background.overlayColor }}
                    aria-hidden="true"
                  />
                  <input
                    type="color"
                    value={theme.background.overlayColor}
                    onChange={(e) => setBackground({ overlayColor: e.target.value })}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                </label>
                <input
                  type="text"
                  value={theme.background.overlayColor}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (/^#?[0-9a-f]{0,6}$/i.test(v)) {
                      setBackground({ overlayColor: v.startsWith("#") ? v : `#${v}` });
                    }
                  }}
                  spellCheck={false}
                  className="flex-1 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-[11px] text-gray-200 outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                />
              </div>
              <SliderRow
                label="Overlay intensity" value={theme.background.overlayOpacity}
                min={0} max={100} unit="%"
                onChange={(v) => setBackground({ overlayOpacity: v })}
              />
              <p className="text-[10px] text-gray-600 mt-1.5 leading-snug">
                Use a dark tint to soften a bright image and keep text
                readable. A light tint works the same way in light mode.
              </p>
            </div>
            )}

            <button
              type="button"
              onClick={clearImage}
              className="mt-3 flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-500 hover:text-red-400 hover:bg-[#2a3136] rounded transition-colors"
            >
              <Trash2 size={11} /> Remove background image
            </button>
          </>
        )}
      </div>




      {/* ── Theme CSS ────────────────────────────────────────────────── */}
      <div className="border-t border-[#2a3136] pt-4">
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-3 flex items-center gap-1.5">
          <Code2 size={10} /> Theme CSS
        </div>

        <button
          type="button"
          onClick={openEditor}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 mb-2 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
        >
          <Code2 size={13} />
          <span>Edit theme CSS…</span>
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={downloadCSS}
            className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 transition-colors"
          >
            <Download size={12} />
            <span>{cssMsg ? (cssMsg.error ? "Failed (see console)" : "Saved ✓") : "Save .css"}</span>
          </button>
          <button
            type="button"
            onClick={pickCSSFile}
            className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs bg-[#2a3136] hover:bg-[#30363d] border border-[#30363d] rounded text-gray-200 transition-colors"
          >
            <Upload size={12} />
            <span>Import file…</span>
          </button>
        </div>

        <p className="text-[10px] text-gray-600 mt-2 leading-snug">
          <span className="text-gray-400">Edit</span> opens the theme as a{" "}
          <span className="font-mono">:root {"{ --c-*: …; }"}</span> block. Paste
          someone else's in there and hit Apply — no coding required.
        </p>
      </div>

      {/* ── Reset ────────────────────────────────────────────────────── */}
      <div className="border-t border-[#2a3136] pt-4">
        <button
          type="button"
          onClick={() => setTheme({ ...DARK_THEME, background: theme.background })}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-300 hover:bg-[#2a3136] rounded transition-colors"
        >
          <RotateCcw size={11} /> Reset colors to default dark
        </button>
      </div>

      {/* ── Raw CSS editor modal ─────────────────────────────────────── */}
      {editorOpen && (
        <div
          className="fixed inset-0 z-[900] bg-black/70 flex items-center justify-center p-6"
          onClick={() => setEditorOpen(false)}
        >
          <div
            className="bg-[#1e2327] border border-[#2a3136] rounded-lg shadow-2xl w-[760px] max-w-[94vw] h-[78vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
              <Code2 size={14} className="text-blue-400" />
              <span className="text-sm font-medium text-gray-100">Theme CSS</span>
              <span className="text-[10px] text-gray-500 ml-2">
                edit · paste · apply
              </span>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="ml-auto text-gray-500 hover:text-gray-300 p-0.5"
                title="Close (Esc)"
              >
                <X size={14} />
              </button>
            </div>

            <textarea
              value={editorText}
              onChange={(e) => {
                setEditorText(e.target.value);
                if (editorError) setEditorError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditorOpen(false);
                }
              }}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={`:root {\n  --c-bg: #1a1a2e;\n  --c-surface: #16213e;\n  --c-accent: #e94560;\n  …\n}`}
              className="flex-1 w-full bg-[#0f1315] text-xs text-gray-200 font-mono leading-relaxed outline-none resize-none border-0 p-4"
              style={{ tabSize: 2 }}
            />

            {editorError && (
              <div className="flex items-start gap-2 px-4 py-2 bg-red-500/10 border-t border-red-500/30 text-[11px] text-red-300 flex-shrink-0">
                <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                <span>{editorError}</span>
              </div>
            )}

            <div className="flex items-center gap-2 px-4 py-3 border-t border-[#2a3136] bg-[#1a1e21] flex-shrink-0">
              <button
                type="button"
                onClick={copyEditor}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] rounded transition-colors"
              >
                {editorCopied ? (
                  <Check size={12} className="text-green-400" />
                ) : (
                  <Copy size={12} />
                )}
                <span>{editorCopied ? "Copied!" : "Copy"}</span>
              </button>

              <button
                type="button"
                onClick={resetEditor}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-100 hover:bg-[#2a3136] rounded transition-colors"
                title="Discard edits and reload the current theme"
              >
                <RotateCcw size={12} />
                <span>Reset</span>
              </button>

              <div className="flex-1" />

              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2a3136] rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyEditor}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors font-medium"
              >
                <Check size={12} />
                <span>Apply</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────── */

function ModeButton({
  icon: Icon, label, active, onClick,
}: { icon: any; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1.5 px-3 py-3 rounded-md border transition-colors cursor-pointer ${
        active
          ? "bg-blue-600/15 border-blue-500/60 text-blue-200"
          : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200 hover:border-[#3a4147]"
      }`}
    >
      <Icon size={16} />
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

function ScopeButton({
  active, label, hint, onClick,
}: { active: boolean; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left px-3 py-2 rounded border transition-colors cursor-pointer ${
        active
          ? "bg-blue-600/15 border-blue-500/60 text-blue-200"
          : "bg-[#131819] border-[#2a3136] text-gray-400 hover:text-gray-200 hover:border-[#3a4147]"
      }`}
    >
      <div className="text-xs font-medium truncate">{label}</div>
      <div className="text-[10px] opacity-70 truncate">{hint}</div>
    </button>
  );
}

function ColorRow({
  label, hint, value, onChange,
}: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const safeHex = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";

  return (
    <div className="flex items-center gap-2.5 group">
      <label
        className="relative flex-shrink-0 w-8 h-8 rounded border border-[#30363d] overflow-hidden cursor-pointer hover:border-[#3a4147] transition-colors"
        title="Open color picker"
      >
        <span className="absolute inset-0" style={{ backgroundColor: safeHex }} aria-hidden="true" />
        <input
          type="color"
          value={safeHex}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer"
        />
      </label>

      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-200 truncate">{label}</div>
        <div className="text-[10px] text-gray-600 truncate">{hint}</div>
      </div>

      <input
        type="text"
        value={value}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (/^#?[0-9a-f]{0,6}$/i.test(v)) {
            const next = v.startsWith("#") ? v : `#${v}`;
            onChange(next);
          }
        }}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (!/^#[0-9a-f]{6}$/i.test(v)) onChange(safeHex);
        }}
        spellCheck={false}
        className="w-24 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-[11px] text-gray-200 outline-none focus:ring-1 focus:ring-blue-500 font-mono flex-shrink-0"
      />
    </div>
  );
}

function TintRow({
  label, hint, value, fallback, onChange,
}: {
  label: string;
  hint: string;
  /** Empty string = follow the theme palette. Any hex = fixed tint. */
  value: string;
  /** The theme color to display when `value` is empty. */
  fallback: string;
  onChange: (v: string) => void;
}) {
  const isAuto = !value;
  const shown = value || fallback;
  const safeHex = /^#[0-9a-f]{6}$/i.test(shown) ? shown : "#000000";

  return (
    <div className="flex items-center gap-2.5">
    <label
    className="relative flex-shrink-0 w-8 h-8 rounded border border-[#30363d] overflow-hidden cursor-pointer hover:border-[#3a4147] transition-colors"
    title="Pick a tint color"
    >
    <span
    className="absolute inset-0"
    style={{ backgroundColor: safeHex }}
    aria-hidden="true"
    />
    <input
    type="color"
    value={safeHex}
    onChange={(e) => onChange(e.target.value)}
    className="absolute inset-0 opacity-0 cursor-pointer"
    />
    </label>

    <div className="flex-1 min-w-0">
    <div className="text-xs text-gray-200 truncate flex items-center gap-1.5">
    {label}
    {isAuto && (
      <span
      className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-[#2a3136] text-gray-500"
      title="Following the theme palette"
      >
      auto
      </span>
    )}
    </div>
    <div className="text-[10px] text-gray-600 truncate">{hint}</div>
    </div>

    <input
    type="text"
    value={shown}
    onChange={(e) => {
      const v = e.target.value.trim();
      if (/^#?[0-9a-f]{0,6}$/i.test(v)) {
        onChange(v.startsWith("#") ? v : `#${v}`);
      }
    }}
    onBlur={(e) => {
      const v = e.target.value.trim();
      if (!/^#[0-9a-f]{6}$/i.test(v)) onChange(value);
    }}
    spellCheck={false}
    className="w-24 bg-[#0f1315] border border-[#30363d] rounded px-2 py-1 text-[11px] text-gray-200 outline-none focus:ring-1 focus:ring-blue-500 font-mono flex-shrink-0"
    />

    {!isAuto && (
      <button
      type="button"
      onClick={() => onChange("")}
      className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded hover:bg-[#2a3136] flex-shrink-0"
      title="Reset to the theme's palette color"
      >
      Auto
      </button>
    )}
    </div>
  );
}

function SliderRow({
  label, value, min, max, unit, onChange, hint,
}: {
  label: string; value: number; min: number; max: number;
  unit: string; onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div>
      <label className="flex justify-between text-[10px] uppercase tracking-wider text-gray-500 mb-1">
        <span>{label}</span>
        <span className="text-gray-400 normal-case tabular-nums">
          {value}{unit}
        </span>
      </label>
      <input
        type="range"
        min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-500"
      />
      {hint && (
        <p className="text-[10px] text-gray-600 mt-1 leading-snug">{hint}</p>
      )}
    </div>
  );
}

/* ── Image helpers ───────────────────────────────────────────────────── */

/**
 * Decode the given bytes, downscale so the longest edge is <= 1920 px,
 * and re-encode as JPEG at 85 % quality. Returns a `data:image/jpeg`
 * URL, or null on failure. Keeps localStorage happy — a full-resolution
 * PNG would blow past the ~5 MB quota almost immediately.
 */
async function shrinkImageToDataUrl(
  bytes: Uint8Array,
  maxDim = 1920,
): Promise<string | null> {
  try {
    const blob = new Blob([bytes as any]);
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      const out = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.85,
      });
      const buf = await out.arrayBuffer();
      return `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
    } finally {
      bitmap.close();
    }
  } catch (e) {
    console.error("[theme] shrink failed:", e);
    return null;
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}
