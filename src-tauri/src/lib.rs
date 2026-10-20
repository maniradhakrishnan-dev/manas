use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn get_storage_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(custom) = std::env::var("MANAS_STORAGE_DIR") {
        let p = PathBuf::from(custom);
        let _ = fs::create_dir_all(&p);
        return p;
    }

    // Isolate Development / Testing from Real Production User Space:
    // Debug builds / Dev tests strictly use ~/.local/share/mrt/entries
    // Release builds / Installed app strictly use ~/.local/share/manas/entries
    let subfolder = if cfg!(debug_assertions) {
        "mrt"
    } else {
        "manas"
    };

    let base = if let Some(d) = dirs::data_dir() {
        d.join(subfolder).join("entries")
    } else if let Ok(app_dir) = app.path().app_data_dir() {
        app_dir.join(subfolder).join("entries")
    } else {
        PathBuf::from(format!("./{}_data/entries", subfolder))
    };
    let _ = fs::create_dir_all(&base);
    base
}

#[tauri::command]
fn get_day(app: tauri::AppHandle, date: String) -> Option<serde_json::Value> {
    let dir = get_storage_dir(&app);
    let file = dir.join(format!("{}.json", date));
    if file.exists() {
        if let Ok(content) = fs::read_to_string(&file) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                return Some(val);
            }
        }
    }
    None
}

#[tauri::command]
fn save_day(app: tauri::AppHandle, entry: serde_json::Value) -> Result<(), String> {
    let date = entry
        .get("date")
        .and_then(|v| v.as_str())
        .ok_or("Missing date field")?;

    let dir = get_storage_dir(&app);
    let file = dir.join(format!("{}.json", date));
    let json_str = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    fs::write(file, json_str).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_active_dates(app: tauri::AppHandle) -> Vec<String> {
    let mut dates = Vec::new();
    let dir = get_storage_dir(&app);
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    dates.push(stem.to_string());
                }
            }
        }
    }
    dates
}

#[tauri::command]
fn get_data_folder_path(app: tauri::AppHandle) -> String {
    get_storage_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn open_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = get_storage_dir(&app);
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&dir).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    }
    Ok(())
}

#[tauri::command]
fn get_templates(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let dir = get_storage_dir(&app);
    let parent = dir.parent().unwrap_or(&dir);
    let file = parent.join("templates.json");
    if file.exists() {
        if let Ok(content) = fs::read_to_string(&file) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                return Some(val);
            }
        }
    }
    None
}

#[tauri::command]
fn save_templates(app: tauri::AppHandle, templates: serde_json::Value) -> Result<(), String> {
    let dir = get_storage_dir(&app);
    let parent = dir.parent().unwrap_or(&dir);
    let file = parent.join("templates.json");
    let json_str = serde_json::to_string_pretty(&templates).map_err(|e| e.to_string())?;
    fs::write(file, json_str).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .setup(|app| {
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                let icon_bytes = include_bytes!("../icons/icon.png");
                if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                    let _ = window.set_icon(icon);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_day,
            save_day,
            get_active_dates,
            get_data_folder_path,
            open_data_folder,
            get_templates,
            save_templates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
