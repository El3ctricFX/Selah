// src-tauri/src/lib.rs
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use scraper::{Html, Selector};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncBufReadExt;

#[tauri::command]
fn move_to_trash(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    trash::delete(&p).map_err(|e| format!("Failed to move to trash: {}", e))
}

/// Recursively create a directory. Uses std::fs directly (not the fs plugin),
/// so it cannot fail silently the way the JS-side plugin wrapper apparently
/// does. Returns Ok(()) if the directory already exists or was created.
#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    std::fs::create_dir_all(&p)
        .map_err(|e| format!("create_dir_all({}) failed: {}", path, e))?;
    if !p.is_dir() {
        return Err(format!("Path exists but is not a directory: {}", path));
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub struct LinkMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub favicon: Option<String>,
}

#[tauri::command]
async fn fetch_link_metadata(url: String) -> Result<LinkMetadata, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; NoteWorkspace/1.0)")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let html = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let document = Html::parse_document(&html);
    let base = url::Url::parse(&url).ok();

    let resolve = |s: Option<String>| -> Option<String> {
        s.and_then(|v| {
            base.as_ref()
                .and_then(|b| b.join(&v).ok())
                .map(|u| u.to_string())
        })
    };

    let meta_prop = |prop: &str| -> Option<String> {
        let sel = Selector::parse(&format!("meta[property='{}']", prop)).ok()?;
        document
            .select(&sel)
            .next()
            .and_then(|e| e.value().attr("content"))
            .map(str::to_string)
    };
    let meta_name = |name: &str| -> Option<String> {
        let sel = Selector::parse(&format!("meta[name='{}']", name)).ok()?;
        document
            .select(&sel)
            .next()
            .and_then(|e| e.value().attr("content"))
            .map(str::to_string)
    };

    let title = meta_prop("og:title")
        .or_else(|| meta_name("twitter:title"))
        .or_else(|| {
            let sel = Selector::parse("title").ok()?;
            document
                .select(&sel)
                .next()
                .map(|e| e.text().collect::<String>().trim().to_string())
                .filter(|s| !s.is_empty())
        });

    let description = meta_prop("og:description")
        .or_else(|| meta_name("description"))
        .or_else(|| meta_name("twitter:description"));

    let image = resolve(
        meta_prop("og:image").or_else(|| meta_name("twitter:image")),
    );

    let favicon = {
        let mut found: Option<String> = None;
        for s in [
            "link[rel='icon']",
            "link[rel='shortcut icon']",
            "link[rel='apple-touch-icon']",
            "link[rel='apple-touch-icon-precomposed']",
        ] {
            if let Ok(sel) = Selector::parse(s) {
                if let Some(el) = document.select(&sel).next() {
                    if let Some(href) = el.value().attr("href") {
                        found = Some(href.to_string());
                        break;
                    }
                }
            }
        }
        resolve(found.or_else(|| Some("/favicon.ico".to_string())))
    };

    Ok(LinkMetadata {
        title,
        description,
        image,
        favicon,
    })
}

/// Best-effort MIME guess from a URL's file extension. Used as a fallback
/// when a remote server doesn't send a usable Content-Type header.
fn guess_mime_from_url(url: &str) -> &'static str {
    let path = url
        .split(|c| c == '?' || c == '#')
        .next()
        .unwrap_or(url)
        .to_lowercase();
    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".avif") {
        "image/avif"
    } else if path.ends_with(".bmp") {
        "image/bmp"
    } else {
        "image/png"
    }
}

#[tauri::command]
async fn fetch_image_data_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (compatible; NoteWorkspace/1.0)")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;

    let status = res.status();
    if !status.is_success() {
        return Err(format!("HTTP {} for {}", status.as_u16(), url));
    }

    let header_ct = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_lowercase());

    let content_type = match header_ct {
        Some(c) if c.starts_with("image/") => c,
        Some(c) if c == "application/octet-stream" => {
            guess_mime_from_url(&url).to_string()
        }
        Some(c) => {
            return Err(format!(
                "Non-image content-type '{}' for {}",
                c, url
            ));
        }
        None => guess_mime_from_url(&url).to_string(),
    };

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let b64 = B64.encode(&bytes);
    Ok(format!("data:{};base64,{}", content_type, b64))
}

/// Payload emitted on the `proxy-progress` event during transcoding.
#[derive(Clone, Serialize)]
struct ProxyProgress {
    output: String,
    percent: f64,
    eta_sec: i64,
}

/// Run ffprobe and return the duration of `input` in milliseconds.
/// Returns None if ffprobe isn't available or can't parse the file.
async fn probe_duration_ms(input: &str) -> Option<i64> {
    let out = tokio::process::Command::new("ffprobe")
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            input,
        ])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let secs: f64 = s.trim().parse().ok()?;
    Some((secs * 1000.0) as i64)
}

/// Transcode a video to WebM (VP9 + Opus) for in-app playback on systems
/// whose webview can't decode the original format.
///
/// Writes to `<output>.tmp` and renames on success, so a partial file never
/// appears at the final path. Emits `proxy-progress` events throughout.
#[tauri::command]
async fn convert_to_webm(
    app: AppHandle,
    input: String,
    output: String,
) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&output).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all({:?}) failed: {}", parent, e))?;
    }

    let tmp_output = format!("{}.tmp", output);

    let total_ms = probe_duration_ms(&input).await.unwrap_or(0);

    let mut child = tokio::process::Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-loglevel", "error",
            "-progress", "pipe:1",
            "-i", &input,
            "-c:v", "libvpx-vp9",
            "-crf", "32",
            "-b:v", "0",
            "-speed", "4",
            "-row-mt", "1",
            "-c:a", "libopus",
            "-b:a", "128k",
            // Force the container format. Without this, ffmpeg can't infer
            // the format from the `.tmp` extension and refuses to start.
            "-f", "webm",
            "-y",
            &tmp_output,
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg failed to start: {}", e))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Collect stderr in the background so we can surface it if ffmpeg fails.
    let stderr_handle = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut reader = tokio::io::BufReader::new(stderr);
        use tokio::io::AsyncReadExt;
        let _ = reader.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });

    let mut reader = tokio::io::BufReader::new(stdout).lines();
    let start = std::time::Instant::now();

    while let Ok(Some(line)) = reader.next_line().await {
        let val = match line.strip_prefix("out_time_ms=") {
            Some(v) => v.trim(),
            None => continue,
        };
        let ms: i64 = match val.parse() {
            Ok(m) => m,
            Err(_) => continue,
        };

        let percent = if total_ms > 0 {
            (ms as f64 / total_ms as f64 * 100.0).min(100.0)
        } else {
            0.0
        };

        let elapsed = start.elapsed().as_secs_f64();
        // libvpx's lookahead buffer means `out_time_ms` races ahead of
        // actual encoding, so early percentages are meaningless. Only
        // compute an ETA once we have enough real data to trust it.
        let eta_sec = if percent > 10.0 && elapsed > 15.0 {
            let total_est = elapsed / (percent / 100.0);
            ((total_est - elapsed).max(0.0)) as i64
        } else {
            -1
        };

        let _ = app.emit(
            "proxy-progress",
            ProxyProgress {
                output: output.clone(),
                percent,
                eta_sec,
            },
        );
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr_text = stderr_handle.await.unwrap_or_default();

    if !status.success() {
        let _ = std::fs::remove_file(&tmp_output);
        let trimmed = stderr_text.trim();
        return Err(if trimmed.is_empty() {
            format!("ffmpeg exited with status {:?}", status.code())
        } else {
            // Keep it short — ffmpeg can be extremely verbose.
            let snippet = if trimmed.len() > 500 {
                &trimmed[trimmed.len() - 500..]
            } else {
                trimmed
            };
            format!("ffmpeg: {}", snippet)
        });
    }

    std::fs::rename(&tmp_output, &output)
        .map_err(|e| format!("rename failed: {}", e))?;

    let _ = app.emit(
        "proxy-progress",
        ProxyProgress {
            output: output.clone(),
            percent: 100.0,
            eta_sec: 0,
        },
    );

    Ok(())
}

#[cfg(target_os = "linux")]
fn setup_linux_webkit_env() {
    std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    setup_linux_webkit_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .invoke_handler(tauri::generate_handler![
            move_to_trash,
            fetch_link_metadata,
            fetch_image_data_url,
            ensure_dir,
            convert_to_webm
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}