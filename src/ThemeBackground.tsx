// src/ThemeBackground.tsx
import { useTheme } from "./theme";

/**
 * Renders the themed background image and its overlay as fixed-position
 * layers behind the entire app. Mounted once, inside the app shell.
 *
 * The blur is applied directly to the image layer (not to any ancestor),
 * so text and UI on top stay crisp. The overlay sits between the image
 * and the panels, tinting whatever shows through.
 */
export default function ThemeBackground() {
  const { theme } = useTheme();
  const bg = theme.background;
  if (!bg.image) return null;

  // Overshoot is needed only when blur is on (blur softens the edges and
  // would otherwise expose the layer's own boundary). Without blur the
  // layer sits flush with the viewport, so nothing can peek through in
  // the corners.
  const overshoot = bg.blur > 0 ? Math.max(16, bg.blur * 2) : 0;

  return (
    <>
      <div
        className="theme-bg-layer"
        aria-hidden="true"
        style={{
          inset: overshoot ? -overshoot : 0,
          backgroundImage: `url("${bg.image}")`,
          filter: bg.blur > 0 ? `blur(${bg.blur}px)` : undefined,
          opacity: bg.opacity / 100,
          // Explicitly paint the background color underneath so any
          // sub-pixel gap between the layer and the viewport edge shows
          // the theme's own bg, not the OS default.
          backgroundColor: theme.colors.bg,
        }}
      />
      {bg.overlayOpacity > 0 && !bg.separateTints && (
        <div
          className="theme-bg-overlay"
          aria-hidden="true"
          style={{
            backgroundColor: bg.overlayColor,
            opacity: bg.overlayOpacity / 100,
          }}
        />
      )}
    </>
  );
}
