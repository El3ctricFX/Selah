#!/usr/bin/env bash
# Setup helper for Selah on NixOS.
#
# Flatpak's .desktop export trigger is broken on NixOS, so after
# installing the bundle you need to run this once to make Selah appear
# in your app launcher (Rofi, wofi, fuzzel, GNOME Activities, etc.).
#
# Usage:
#   ./setup.sh install     # copy .desktop + icon, refresh launcher caches
#   ./setup.sh uninstall   # remove app, sandbox data, launcher entry, icon
#   ./setup.sh status      # show what's currently installed
#
# Add -y after uninstall to skip the confirmation prompt:
#   ./setup.sh uninstall -y
#
# With no argument, you'll get an interactive menu.

set -e

APP_ID="io.github.el3ctricfx.selah"
APP_NAME="Selah"

# Locations
FLATPAK_APP_BASE="$HOME/.local/share/flatpak/app/$APP_ID/x86_64/master"
FLATPAK_EXPORT_DIR="$HOME/.local/share/flatpak/exports/share/applications"
FLATPAK_EXPORT_BIN="$HOME/.local/share/flatpak/exports/bin/$APP_ID"
FLATPAK_OVERRIDE="$HOME/.local/share/flatpak/overrides/$APP_ID"
HOST_DESKTOP_DIR="$HOME/.local/share/applications"
HOST_DESKTOP_FILE="$HOST_DESKTOP_DIR/$APP_ID.desktop"
HOST_ICON_DIR="$HOME/.local/share/icons/hicolor/128x128/apps"
HOST_ICON_FILE="$HOST_ICON_DIR/$APP_ID.png"
SANDBOX_DATA_DIR="$HOME/.var/app/$APP_ID"

# ---------- colors ----------
if [ -t 1 ]; then
  BOLD=$(tput bold 2>/dev/null || echo "")
  RED=$(tput setaf 1 2>/dev/null || echo "")
  GREEN=$(tput setaf 2 2>/dev/null || echo "")
  YELLOW=$(tput setaf 3 2>/dev/null || echo "")
  BLUE=$(tput setaf 4 2>/dev/null || echo "")
  RESET=$(tput sgr0 2>/dev/null || echo "")
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

info() { printf "%s%s%s\n" "$BLUE" "$1" "$RESET"; }
ok()   { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
warn() { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$1"; }
err()  { printf "%s✗%s %s\n" "$RED" "$RESET" "$1" >&2; }

# ---------- refresh host caches ----------
refresh_caches() {
  update-desktop-database "$HOST_DESKTOP_DIR/" 2>/dev/null || true
  gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
  # Nudge any running launcher to rebuild its list.
  pkill -x rofi 2>/dev/null || true
  pkill -x rofi-wayland 2>/dev/null || true
  pkill -x wofi 2>/dev/null || true
  pkill -x fuzzel 2>/dev/null || true
}

# ---------- find the .desktop inside the installed app ----------
find_installed_desktop() {
  [ -d "$FLATPAK_APP_BASE" ] || return 1
  local hash
  hash=$(ls "$FLATPAK_APP_BASE" 2>/dev/null | head -1)
  [ -n "$hash" ] || return 1
  local base="$FLATPAK_APP_BASE/$hash/files"
  for candidate in \
    "$base/share/applications/$APP_ID.desktop" \
    "$base/share/applications/selah.desktop" \
    "$base/usr/share/applications/$APP_ID.desktop" \
    "$base/usr/share/applications/selah.desktop"; do
    if [ -f "$candidate" ]; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

# ---------- find an icon inside the installed app ----------
find_installed_icon() {
  [ -d "$FLATPAK_APP_BASE" ] || return 1
  local hash
  hash=$(ls "$FLATPAK_APP_BASE" 2>/dev/null | head -1)
  [ -n "$hash" ] || return 1
  local base="$FLATPAK_APP_BASE/$hash/files"
  for icon_dir in \
    "$base/share/icons/hicolor/128x128/apps" \
    "$base/usr/share/icons/hicolor/128x128/apps"; do
    for icon_name in "$APP_ID.png" "selah.png"; do
      if [ -f "$icon_dir/$icon_name" ]; then
        printf "%s" "$icon_dir/$icon_name"
        return 0
      fi
    done
  done
  return 1
}

# ---------- install (post-Flatpak setup) ----------
do_install() {
  info "Setting up $APP_NAME for your launcher..."

  if [ ! -d "$FLATPAK_APP_BASE" ]; then
    err "$APP_ID is not installed."
    echo "Run this first:"
    echo "  flatpak install --user selah.flatpak"
    exit 1
  fi

  # ---- desktop file ----
  local desktop
  if ! desktop=$(find_installed_desktop); then
    err "No .desktop file found inside the app."
    echo "Searched inside:"
    echo "  $FLATPAK_APP_BASE/<hash>/files/share/applications/"
    echo "  $FLATPAK_APP_BASE/<hash>/files/usr/share/applications/"
    echo
    echo "Run this to see what's there:"
    echo "  find \"$FLATPAK_APP_BASE\" -name '*.desktop'"
    exit 1
  fi
  mkdir -p "$HOST_DESKTOP_DIR"
  cp "$desktop" "$HOST_DESKTOP_FILE"
  # Force the host-side Exec= to use the flatpak wrapper.
  sed -i "s|^Exec=.*|Exec=flatpak run $APP_ID|" "$HOST_DESKTOP_FILE"
  ok "Desktop entry → $HOST_DESKTOP_FILE"

  # ---- icon ----
  mkdir -p "$HOST_ICON_DIR"
  local icon
  if icon=$(find_installed_icon); then
    cp "$icon" "$HOST_ICON_FILE"
    ok "Icon → $HOST_ICON_FILE"
  elif [ -f "src-tauri/icons/128x128.png" ]; then
    cp "src-tauri/icons/128x128.png" "$HOST_ICON_FILE"
    ok "Icon (from source) → $HOST_ICON_FILE"
  else
    warn "No icon found. Skipping."
  fi

  refresh_caches
  ok "Done. Search for \"$APP_NAME\" in your launcher."
  echo "If it doesn't appear, log out and back in."
}

# ---------- uninstall (full removal) ----------
do_uninstall() {
  # Confirmation unless -y was passed.
  if [ "${SKIP_CONFIRM:-0}" != "1" ]; then
    printf "%sRemove %s and all of its data?%s [y/N] " "$YELLOW" "$APP_NAME" "$RESET"
    read -r ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) echo "Cancelled."; exit 0 ;;
    esac
  fi

  echo
  info "Removing $APP_NAME..."

  # 1. Flatpak app itself
  if flatpak list --user --app 2>/dev/null | grep -q "$APP_ID"; then
    flatpak uninstall --user -y "$APP_ID" >/dev/null 2>&1 || \
      warn "flatpak uninstall reported an error."
    ok "Uninstalled Flatpak app"
  else
    warn "Flatpak app not installed"
  fi

  # 2. Sandbox user data
  if [ -d "$SANDBOX_DATA_DIR" ]; then
    rm -rf "$SANDBOX_DATA_DIR"
    ok "Removed sandbox data"
  fi

  # 3. Overrides
  flatpak override --user --reset "$APP_ID" >/dev/null 2>&1 || true
  if [ -f "$FLATPAK_OVERRIDE" ]; then
    rm -f "$FLATPAK_OVERRIDE"
    ok "Removed Flatpak overrides"
  fi

  # 4. Host desktop entry
  if [ -f "$HOST_DESKTOP_FILE" ]; then
    rm -f "$HOST_DESKTOP_FILE"
    ok "Removed host desktop entry"
  fi

  # 5. Host icon
  if [ -f "$HOST_ICON_FILE" ]; then
    rm -f "$HOST_ICON_FILE"
    ok "Removed host icon"
  fi

  # 6. Any stray exports Flatpak might have written
  if [ -f "$FLATPAK_EXPORT_DIR/$APP_ID.desktop" ]; then
    rm -f "$FLATPAK_EXPORT_DIR/$APP_ID.desktop"
    ok "Removed Flatpak export"
  fi
  if [ -e "$FLATPAK_EXPORT_BIN" ] || [ -L "$FLATPAK_EXPORT_BIN" ]; then
    rm -f "$FLATPAK_EXPORT_BIN"
    ok "Removed Flatpak bin export"
  fi

  # 7. Refresh caches
  refresh_caches

  echo
  ok "Done. $APP_NAME should no longer appear in your launcher."
  echo "If it lingers, log out and back in."
}

# ---------- status ----------
do_status() {
  info "Status for $APP_ID"
  echo

  if flatpak list --user --app 2>/dev/null | grep -q "$APP_ID"; then
    ok "Flatpak app:       installed"
  else
    warn "Flatpak app:       NOT installed"
  fi

  if [ -f "$HOST_DESKTOP_FILE" ]; then
    ok "Launcher entry:    $HOST_DESKTOP_FILE"
  else
    warn "Launcher entry:    missing"
  fi

  if [ -f "$HOST_ICON_FILE" ]; then
    ok "Launcher icon:     $HOST_ICON_FILE"
  else
    warn "Launcher icon:     missing"
  fi

  if [ -d "$SANDBOX_DATA_DIR" ]; then
    local size
    size=$(du -sh "$SANDBOX_DATA_DIR" 2>/dev/null | awk '{print $1}')
    ok "Sandbox data:      $SANDBOX_DATA_DIR ($size)"
  else
    echo "  Sandbox data:      (none)"
  fi

  if [ -f "$FLATPAK_OVERRIDE" ]; then
    ok "Flatpak overrides: $FLATPAK_OVERRIDE"
  else
    echo "  Flatpak overrides: (none)"
  fi
}

# ---------- menu ----------
show_menu() {
  echo
  printf "%s%s%s setup\n" "$BOLD" "$APP_NAME" "$RESET"
  echo "  1) Install / repair launcher entry"
  echo "  2) Uninstall (remove app, data, launcher entry)"
  echo "  3) Show status"
  echo "  4) Quit"
  echo
  printf "Choose [1-4]: "
  read -r choice
  case "$choice" in
    1) do_install ;;
    2) do_uninstall ;;
    3) do_status ;;
    4|q|Q) exit 0 ;;
    *) err "Invalid choice"; exit 1 ;;
  esac
}

# ---------- dispatch ----------
case "${1:-}" in
  install|i)
    do_install
    ;;
  uninstall|u|remove|r)
    if [ "${2:-}" = "-y" ] || [ "${2:-}" = "--yes" ]; then
      SKIP_CONFIRM=1
    fi
    do_uninstall
    ;;
  status|s)
    do_status
    ;;
  ""|menu)
    show_menu
    ;;
  -h|--help|help)
    echo "Usage: $(basename "$0") [install|uninstall|status] [options]"
    echo
    echo "  install               copy .desktop + icon, refresh launcher caches"
    echo "  uninstall [-y]        remove the Flatpak app, its data, and launcher entry"
    echo "  status                show what's currently installed"
    echo
    echo "With no argument, you'll get an interactive menu."
    ;;
  *)
    err "Unknown command: $1"
    echo "Try: $(basename "$0") --help"
    exit 1
    ;;
esac