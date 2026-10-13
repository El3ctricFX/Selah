#!/usr/bin/env bash
# Setup helper for Selah on Linux (especially NixOS).
#
# If a Selah_*_x86_64.flatpak bundle sits next to this script, running
# `install` will install it and then make Selah appear in your app
# launcher. Flatpak's .desktop export trigger is broken on NixOS, so
# the launcher entry has to be created by hand once.
#
# Works with both user-side and system-side Flatpak installs.
#
# Usage:
#   ./Selah-setup.sh install       # install .flatpak (if nearby) + launcher entry
#   ./Selah-setup.sh uninstall     # remove app, sandbox data, launcher entry, icon
#   ./Selah-setup.sh status        # show what's currently installed
#
# Add -y after uninstall to skip the confirmation prompt:
#   ./Selah-setup.sh uninstall -y
#
# With no argument, you get an interactive menu.

set -e

APP_ID="io.github.el3ctricfx.selah"
APP_NAME="Selah"

# Possible install roots — we search both.
USER_APP_ROOT="$HOME/.local/share/flatpak/app/$APP_ID"
SYSTEM_APP_ROOT="/var/lib/flatpak/app/$APP_ID"

USER_EXPORT_DIR="$HOME/.local/share/flatpak/exports/share/applications"
SYSTEM_EXPORT_DIR="/var/lib/flatpak/exports/share/applications"
USER_EXPORT_BIN="$HOME/.local/share/flatpak/exports/bin/$APP_ID"
SYSTEM_EXPORT_BIN="/var/lib/flatpak/exports/bin/$APP_ID"
USER_OVERRIDE="$HOME/.local/share/flatpak/overrides/$APP_ID"
SYSTEM_OVERRIDE="/var/lib/flatpak/overrides/$APP_ID"

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

# ---------- locate a .flatpak bundle next to this script ----------
find_flatpak_file() {
  local here
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  local f
  for f in "$here"/Selah_*_x86_64.flatpak; do
    [ -f "$f" ] && { printf "%s" "$f"; return 0; }
  done
  for f in "$here"/*.flatpak; do
    [ -f "$f" ] && { printf "%s" "$f"; return 0; }
  done
  return 1
}

# ---------- install detection (user OR system) ----------
is_installed() {
  # `flatpak info` succeeds if the app is installed anywhere.
  flatpak info "$APP_ID" >/dev/null 2>&1
}

is_installed_user() {
  flatpak list --user --app 2>/dev/null | grep -qF "$APP_ID"
}

is_installed_system() {
  flatpak list --system --app 2>/dev/null | grep -qF "$APP_ID"
}

# Return the first existing app root, user or system.
find_app_root() {
  [ -d "$USER_APP_ROOT" ] && { printf "%s" "$USER_APP_ROOT"; return 0; }
  [ -d "$SYSTEM_APP_ROOT" ] && { printf "%s" "$SYSTEM_APP_ROOT"; return 0; }
  return 1
}

# Walk the app root looking for the .desktop file, regardless of
# arch / branch / commit-hash layout. Returns its absolute path.
find_installed_desktop() {
  local root
  root=$(find_app_root) || return 1
  local found
  found=$(find "$root" -maxdepth 5 -type f \
    \( -name "$APP_ID.desktop" -o -name "selah.desktop" \) \
    2>/dev/null | head -1)
  [ -n "$found" ] && { printf "%s" "$found"; return 0; }
  return 1
}

# Same, but for the 128x128 PNG icon.
find_installed_icon() {
  local root
  root=$(find_app_root) || return 1
  local found
  found=$(find "$root" -maxdepth 6 -type f \
    \( -name "$APP_ID.png" -o -name "selah.png" \) \
    -path "*hicolor/128x128*" \
    2>/dev/null | head -1)
  [ -n "$found" ] && { printf "%s" "$found"; return 0; }
  return 1
}

# ---------- refresh host caches ----------
refresh_caches() {
  update-desktop-database "$HOST_DESKTOP_DIR/" 2>/dev/null || true
  gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
  pkill -x rofi 2>/dev/null || true
  pkill -x rofi-wayland 2>/dev/null || true
  pkill -x wofi 2>/dev/null || true
  pkill -x fuzzel 2>/dev/null || true
}

# ---------- install ----------
do_install() {
  info "Setting up $APP_NAME..."

  # Step 1: install the flatpak if needed.
  if ! is_installed; then
    local bundle
    if bundle=$(find_flatpak_file); then
      echo "  $APP_NAME isn't installed yet."
      echo "  Found bundle next to this script:"
      echo "    $(basename "$bundle")"
      echo
      printf "  Install it now? [Y/n] "
      read -r ans
      case "$ans" in
        n|N|no|NO)
          echo
          echo "Skipping. To install manually:"
          echo "  flatpak install --user \"$bundle\""
          exit 1
          ;;
      esac
      echo
      info "Installing $APP_NAME from bundle..."
      if flatpak install --user -y "$bundle"; then
        ok "Installed Flatpak app (user)"
      else
        err "flatpak install failed."
        exit 1
      fi
    else
      err "$APP_ID is not installed, and no .flatpak bundle was found."
      echo
      echo "Download the Selah .flatpak from the release page, put it in"
      echo "the same directory as this script, then run this again."
      exit 1
    fi
  else
    if is_installed_user; then
      ok "$APP_NAME is installed (user)"
    elif is_installed_system; then
      ok "$APP_NAME is installed (system)"
    else
      ok "$APP_NAME is installed"
    fi
  fi

  # Step 2: copy .desktop and icon to the host user directory.
  info "Setting up launcher entry..."

  local desktop
  if ! desktop=$(find_installed_desktop); then
    err "No .desktop file found inside the app."
    local root
    root=$(find_app_root) || root="(app root not found)"
    echo "Searched under:"
    echo "  $root"
    echo
    echo "Run this to see what's there:"
    echo "  find \"$root\" -name '*.desktop'"
    exit 1
  fi
  mkdir -p "$HOST_DESKTOP_DIR"
  cp "$desktop" "$HOST_DESKTOP_FILE"
  sed -i "s|^Exec=.*|Exec=flatpak run $APP_ID|" "$HOST_DESKTOP_FILE"
  ok "Desktop entry → $HOST_DESKTOP_FILE"

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
  echo
  ok "Done. Search for \"$APP_NAME\" in your launcher."
  echo "If it doesn't appear, log out and back in."
}

# ---------- uninstall ----------
do_uninstall() {
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

  local removed_any=0

  if is_installed_user; then
    flatpak uninstall --user -y "$APP_ID" >/dev/null 2>&1 || \
      warn "user-side flatpak uninstall reported an error."
    ok "Uninstalled Flatpak app (user)"
    removed_any=1
  fi

  if is_installed_system; then
    if sudo -n true 2>/dev/null; then
      sudo flatpak uninstall --system -y "$APP_ID" >/dev/null 2>&1 || \
        warn "system-side flatpak uninstall reported an error."
      ok "Uninstalled Flatpak app (system)"
    else
      warn "App is installed system-wide. To remove it, run:"
      echo "  sudo flatpak uninstall --system -y $APP_ID"
    fi
    removed_any=1
  fi

  if [ "$removed_any" -eq 0 ]; then
    warn "Flatpak app not installed"
  fi

  if [ -d "$SANDBOX_DATA_DIR" ]; then
    rm -rf "$SANDBOX_DATA_DIR"
    ok "Removed sandbox data"
  fi

  # Overrides — check both locations.
  flatpak override --user --reset "$APP_ID" >/dev/null 2>&1 || true
  if [ -f "$USER_OVERRIDE" ]; then
    rm -f "$USER_OVERRIDE"
    ok "Removed user Flatpak overrides"
  fi
  if [ -f "$SYSTEM_OVERRIDE" ]; then
    if sudo -n true 2>/dev/null; then
      sudo rm -f "$SYSTEM_OVERRIDE"
      ok "Removed system Flatpak overrides"
    else
      warn "System overrides exist. Remove with:"
      echo "  sudo rm -f $SYSTEM_OVERRIDE"
    fi
  fi

  if [ -f "$HOST_DESKTOP_FILE" ]; then
    rm -f "$HOST_DESKTOP_FILE"
    ok "Removed host desktop entry"
  fi

  if [ -f "$HOST_ICON_FILE" ]; then
    rm -f "$HOST_ICON_FILE"
    ok "Removed host icon"
  fi

  # Stray exports from either installation.
  for d in "$USER_EXPORT_DIR" "$SYSTEM_EXPORT_DIR"; do
    if [ -f "$d/$APP_ID.desktop" ]; then
      if [ "$d" = "$SYSTEM_EXPORT_DIR" ]; then
        sudo rm -f "$d/$APP_ID.desktop" 2>/dev/null || true
      else
        rm -f "$d/$APP_ID.desktop"
      fi
    fi
  done
  for b in "$USER_EXPORT_BIN" "$SYSTEM_EXPORT_BIN"; do
    if [ -e "$b" ] || [ -L "$b" ]; then
      if [ "$b" = "$SYSTEM_EXPORT_BIN" ]; then
        sudo rm -f "$b" 2>/dev/null || true
      else
        rm -f "$b"
      fi
    fi
  done

  refresh_caches

  echo
  ok "Done. $APP_NAME should no longer appear in your launcher."
  echo "If it lingers, log out and back in."
}

# ---------- status ----------
do_status() {
  info "Status for $APP_ID"
  echo

  if is_installed_user; then
    ok "Flatpak app:       installed (user)"
  elif is_installed_system; then
    ok "Flatpak app:       installed (system)"
  else
    warn "Flatpak app:       NOT installed"
  fi

  local root
  if root=$(find_app_root); then
    ok "App root:          $root"
  fi

  # Launcher entry — host-side copy takes priority, otherwise report
  # whatever Flatpak's own exports provide (which is what most distros
  # actually use for the launcher).
  local host_entry=""
  [ -f "$HOST_DESKTOP_FILE" ] && host_entry="$HOST_DESKTOP_FILE"
  local user_export="$USER_EXPORT_DIR/$APP_ID.desktop"
  local system_export="$SYSTEM_EXPORT_DIR/$APP_ID.desktop"
  if [ -n "$host_entry" ]; then
    ok "Launcher entry:    $host_entry (host copy)"
  elif [ -f "$system_export" ]; then
    ok "Launcher entry:    managed by Flatpak (system)"
  elif [ -f "$user_export" ]; then
    ok "Launcher entry:    managed by Flatpak (user)"
  else
    warn "Launcher entry:    missing"
  fi

  # Same for the icon.
  if [ -f "$HOST_ICON_FILE" ]; then
    ok "Launcher icon:     $HOST_ICON_FILE (host copy)"
  elif [ -d "$USER_EXPORT_DIR" ] || [ -d "$SYSTEM_EXPORT_DIR" ]; then
    ok "Launcher icon:     managed by Flatpak"
  else
    warn "Launcher icon:     missing"
  fi

  if [ -d "$SANDBOX_DATA_DIR" ]; then
    local size
    size=$(du -sh "$SANDBOX_DATA_DIR" 2>/dev/null | awk '{print $1}')
    ok "Sandbox data:      $SANDBOX_DATA_DIR ($size)"
  else
    echo "  Sandbox data:      (none — Flatpak app hasn't been launched yet)"
  fi

  if [ -f "$USER_OVERRIDE" ]; then
    ok "User overrides:    $USER_OVERRIDE"
  fi
  if [ -f "$SYSTEM_OVERRIDE" ]; then
    ok "System overrides:  $SYSTEM_OVERRIDE"
  fi

  local bundle
  if bundle=$(find_flatpak_file); then
    ok "Bundle nearby:     $(basename "$bundle")"
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
    echo "  install               install the nearby .flatpak (if any) and set up"
    echo "                        the host launcher entry"
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