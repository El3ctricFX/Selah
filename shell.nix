let
  pkgs = import <nixpkgs> { };
in
pkgs.mkShell {
  nativeBuildInputs = with pkgs; [
    pkg-config
    cargo
    cargo-tauri
    rustc
    nodejs
  ];

  buildInputs = with pkgs; [
    openssl
    glib
    glib-networking
    gtk3
    libsoup_3
    webkitgtk_4_1
    librsvg
    gst_all_1.gstreamer
    gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good
    gst_all_1.gst-plugins-bad
    gst_all_1.gst-libav
    pulseaudio
    pipewire
    alsa-lib
    mpv
    ffmpeg
    flatpak-builder
    neovim
  ];

  shellHook = ''
    export LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath (with pkgs; [
      webkitgtk_4_1
      gtk3
      glib
      glib-networking
      openssl
      pulseaudio
      pipewire
      alsa-lib
      mpv
      # ── GStreamer — previously missing ──────────────────────────────
      gst_all_1.gstreamer
      gst_all_1.gst-plugins-base
      gst_all_1.gst-plugins-good
      gst_all_1.gst-plugins-bad
      gst_all_1.gst-libav
    ])}:$LD_LIBRARY_PATH

    export XDG_DATA_DIRS=${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS

    export GIO_EXTRA_MODULES=${pkgs.glib-networking}/lib/gio/modules

    # System plugins — where gst looks for its .so files
    export GST_PLUGIN_SYSTEM_PATH_1_0="${pkgs.lib.makeSearchPath "lib/gstreamer-1.0" (with pkgs.gst_all_1; [
      gstreamer.out
      gst-plugins-base
      gst-plugins-good
      gst-plugins-bad
      gst-libav
    ])}"

    # User plugins — some WebKit builds check this first
    export GST_PLUGIN_PATH_1_0="$GST_PLUGIN_SYSTEM_PATH_1_0"

    # Explicit scanner — WebKit's child proc doesn't always find it
    export GST_PLUGIN_SCANNER="${pkgs.gst_all_1.gstreamer}/libexec/gstreamer-1.0/gst-plugin-scanner"

    # WebKit sandbox doesn't survive nix store paths
    export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
    export WEBKIT_DISABLE_DMABUF_RENDERER=1
  '';
}