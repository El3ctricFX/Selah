// src-tauri/src/lib.rs
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use scraper::{Html, Selector};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};

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
    // Strip query string / fragment so "photo.png?token=abc" still matches.
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

/// Fetch a remote image through the native HTTP client (bypassing the
/// webview's CORS restrictions, which block html-to-image from inlining
/// cross-origin images during export) and return it as a `data:` URL.
///
/// Validates the response: non-2xx status or a non-image Content-Type is
/// reported as an error rather than silently wrapped in a broken data URL.
/// This is important because many image hosts return an HTML 404/challenge
/// page when the request looks bot-like, and a data URL containing HTML
/// bytes fails to decode in the browser — which (in the bookmark component)
/// triggers onError and removes the <img> from the DOM before capture.
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
        // Some servers serve images as octet-stream. Fall back to guessing.
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

#[cfg(target_os = "linux")]
fn setup_linux_webkit_env() {
    std::env::set_var("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1");
    std::env::set_var("WEBKIT_FORCE_SANDBOX", "0");
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
            ensure_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}