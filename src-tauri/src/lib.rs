use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

fn get_storage_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(custom) = std::env::var("MANAS_STORAGE_DIR") {
        let p = PathBuf::from(custom);
        let _ = fs::create_dir_all(&p);
        return p;
    }

    let base = if let Some(d) = dirs::data_dir() {
        let manas_dir = d.join("manas").join("entries");
        let legacy_mrt_dir = d.join("mrt").join("entries");
        let _ = fs::create_dir_all(&manas_dir);
        // Automatically migrate any legacy or dev files from mrt
        if legacy_mrt_dir.exists() {
            if let Ok(entries) = fs::read_dir(&legacy_mrt_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if let Some(fname) = p.file_name() {
                        let dest = manas_dir.join(fname);
                        if !dest.exists() {
                            let _ = fs::copy(&p, dest);
                        }
                    }
                }
            }
        }
        manas_dir
    } else if let Ok(app_dir) = app.path().app_data_dir() {
        app_dir.join("manas").join("entries")
    } else {
        PathBuf::from("./manas_data/entries")
    };
    let _ = fs::create_dir_all(&base);
    base
}

fn get_docs_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(custom) = std::env::var("MANAS_DOCS_DIR") {
        let p = PathBuf::from(custom);
        let _ = fs::create_dir_all(&p);
        return p;
    }

    let base = if let Some(d) = dirs::data_dir() {
        let manas_docs = d.join("manas").join("docs");
        let legacy_mrt_docs = d.join("mrt").join("docs");
        let _ = fs::create_dir_all(&manas_docs);
        if legacy_mrt_docs.exists() {
            if let Ok(entries) = fs::read_dir(&legacy_mrt_docs) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if let Some(fname) = p.file_name() {
                        let dest = manas_docs.join(fname);
                        if !dest.exists() {
                            let _ = fs::copy(&p, dest);
                        }
                    }
                }
            }
        }
        manas_docs
    } else if let Ok(app_dir) = app.path().app_data_dir() {
        app_dir.join("manas").join("docs")
    } else {
        PathBuf::from("./manas_data/docs")
    };
    let _ = fs::create_dir_all(&base);
    base
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DocItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<DocItem>,
    pub updated_at: u64,
}

fn traverse_docs(dir: &std::path::Path, base: &std::path::Path) -> Vec<DocItem> {
    let mut items = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "assets" {
                continue;
            }
            let is_dir = path.is_dir();
            if !is_dir && !name.ends_with(".md") && !name.ends_with(".markdown") && !name.ends_with(".txt") {
                continue;
            }
            let rel = path.strip_prefix(base).unwrap_or(&path).to_string_lossy().to_string();
            let updated_at = entry.metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);

            let children = if is_dir {
                traverse_docs(&path, base)
            } else {
                Vec::new()
            };

            items.push(DocItem {
                name,
                path: rel,
                is_dir,
                children,
                updated_at,
            });
        }
    }
    items.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    items
}

fn seed_starter_docs(docs_dir: &std::path::Path) {
    if let Ok(mut entries) = fs::read_dir(docs_dir) {
        if entries.next().is_none() {
            let ai_dir = docs_dir.join("AI Research");
            let _ = fs::create_dir_all(&ai_dir);
            let _ = fs::write(
                ai_dir.join("Foundation Models & Latents.md"),
                "# Foundation Models & Latent Spaces\n\n## 🎯 Core Research Question\nHow do compressed latent representations maintain semantic fidelity across modalities?\n\n## 📐 Mathematical Formulation\n$$\\mathcal{L}_{\\text{total}} = \\mathcal{L}_{\\text{recon}} + \\beta D_{\\text{KL}}(q_\\phi(z|x) \\parallel p(z))$$\n\n## 🔬 Actionable Experiments (Push to Daily Planner)\n- [ ] Profile token latency on RTX 4090 with FP16 vs INT4\n- [ ] Compare attention heatmaps on multi-turn context windows\n- [ ] Benchmark KV-cache memory pressure at 32k context\n\n## 📝 Reflection & Findings\n*Document experiment outputs and insights here.*\n"
            );

            let elec_dir = docs_dir.join("Electronics");
            let _ = fs::create_dir_all(&elec_dir);
            let _ = fs::write(
                elec_dir.join("ESP32 & Power Architecture.md"),
                "# ESP32 & System Power Architecture\n\n## ⚡ Power Budget & Voltage Regulators\n- Operating Voltage: 3.3V\n- Active RF Burst Current: ~240mA\n- Deep Sleep Current: ~10µA\n\n## 📐 Ohms Law & Thermal Dissipation\n$$P = I^2 R = V \\times I$$\n$$\\Delta T = P \\times R_{\\theta JA}$$\n\n## 🔌 Pinout & Bus Mapping\n| Pin | Function | Notes |\n| :--- | :--- | :--- |\n| GPIO 21 | I2C SDA | 4.7kΩ Pull-up required |\n| GPIO 22 | I2C SCL | 4.7kΩ Pull-up required |\n| GPIO 34 | ADC1_CH6 | Input only (Sensor feedback) |\n\n## 📋 Next Hardware Validation Tasks\n- [ ] Probe 3.3V rail ripple under WiFi transmission pulse\n- [ ] Verify buck converter efficiency at 50mA nominal load\n"
            );

            let mech_dir = docs_dir.join("Machine Design");
            let _ = fs::create_dir_all(&mech_dir);
            let _ = fs::write(
                mech_dir.join("Torque & Gear Ratio Sizing.md"),
                "# Torque & Gear Ratio Sizing\n\n## ⚙️ Dynamics & Load Torque\n$$\\tau_{\\text{motor}} = \\frac{\\tau_{\\text{load}}}{N \\cdot \\eta} + J_{\\text{reflected}} \\cdot \\alpha$$\n\nWhere:\n- $N$ = Gear ratio\n- $\\eta$ = Transmission efficiency (~85% for planetary gearbox)\n- $J_{\\text{reflected}} = \\frac{J_{\\text{load}}}{N^2}$\n\n## 🔩 Mechanical Design Checklist\n- [ ] Verify radial load ratings on output shaft bearings\n- [ ] Calculate lead screw pitch for 150mm/s linear velocity\n- [ ] CAD check motor mount clearance against chassis ribs\n"
            );
        }
    }
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
    // Fallback: check legacy mrt directory if present
    if let Some(d) = dirs::data_dir() {
        let legacy_file = d.join("mrt").join("entries").join(format!("{}.json", date));
        if legacy_file.exists() && legacy_file != file {
            if let Ok(content) = fs::read_to_string(&legacy_file) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    let _ = fs::write(&file, &content);
                    return Some(val);
                }
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

    // Create automatic safety backup if file already exists
    if file.exists() {
        let bak = dir.join(format!("{}.json.bak", date));
        let _ = fs::copy(&file, bak);
    }

    let json_str = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    fs::write(&file, &json_str).map_err(|e| e.to_string())?;

    // Also mirror to legacy mrt directory if present
    if let Some(d) = dirs::data_dir() {
        let legacy_file = d.join("mrt").join("entries").join(format!("{}.json", date));
        if legacy_file != file && legacy_file.parent().map(|p| p.exists()).unwrap_or(false) {
            let _ = fs::write(legacy_file, &json_str);
        }
    }

    Ok(())
}

#[tauri::command]
fn get_active_dates(app: tauri::AppHandle) -> Vec<String> {
    let mut dates = Vec::new();
    let dir = get_storage_dir(&app);
    if let Ok(entries) = fs::read_dir(&dir) {
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
fn open_data_folder(app: tauri::AppHandle) -> Result<String, String> {
    let dir = get_storage_dir(&app);
    let path_str = dir.to_string_lossy().to_string();
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
    Ok(path_str)
}

#[tauri::command]
fn get_templates(app: tauri::AppHandle) -> Option<serde_json::Value> {
    let dir = get_storage_dir(&app);
    let parent = dir.parent().unwrap_or(&dir);
    let file = parent.join("templates.json");
    let mut primary_templates: Vec<serde_json::Value> = Vec::new();

    if file.exists() {
        if let Ok(content) = fs::read_to_string(&file) {
            if let Ok(val) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                primary_templates = val;
            }
        }
    }

    // Merge any unique templates from legacy mrt directory
    if let Some(d) = dirs::data_dir() {
        let legacy_file = d.join("mrt").join("templates.json");
        if legacy_file.exists() && legacy_file != file {
            if let Ok(content) = fs::read_to_string(&legacy_file) {
                if let Ok(legacy_list) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                    let mut updated = false;
                    for item in legacy_list {
                        let id = item.get("id").and_then(|v| v.as_str());
                        if let Some(id_str) = id {
                            if !primary_templates.iter().any(|p| p.get("id").and_then(|v| v.as_str()) == Some(id_str)) {
                                primary_templates.push(item);
                                updated = true;
                            }
                        }
                    }
                    if updated {
                        if let Ok(merged_str) = serde_json::to_string_pretty(&primary_templates) {
                            let _ = fs::write(&file, merged_str);
                        }
                    }
                }
            }
        }
    }

    if !primary_templates.is_empty() {
        return serde_json::to_value(&primary_templates).ok();
    }
    None
}

#[tauri::command]
fn save_templates(app: tauri::AppHandle, templates: serde_json::Value) -> Result<(), String> {
    let dir = get_storage_dir(&app);
    let parent = dir.parent().unwrap_or(&dir);
    let file = parent.join("templates.json");
    let json_str = serde_json::to_string_pretty(&templates).map_err(|e| e.to_string())?;
    fs::write(&file, &json_str).map_err(|e| e.to_string())?;

    // Mirror to legacy mrt templates.json if present
    if let Some(d) = dirs::data_dir() {
        let legacy_file = d.join("mrt").join("templates.json");
        if legacy_file != file && legacy_file.parent().map(|p| p.exists()).unwrap_or(false) {
            let _ = fs::write(legacy_file, &json_str);
        }
    }

    Ok(())
}

#[tauri::command]
fn get_docs_path(app: tauri::AppHandle) -> String {
    get_docs_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn list_docs(app: tauri::AppHandle) -> Vec<DocItem> {
    let dir = get_docs_dir(&app);
    seed_starter_docs(&dir);
    traverse_docs(&dir, &dir)
}

#[tauri::command]
fn read_doc(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let dir = get_docs_dir(&app);
    let target = dir.join(&path);
    if !target.exists() {
        return Err(format!("Document '{}' not found", path));
    }
    fs::read_to_string(&target).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_doc(app: tauri::AppHandle, path: String, content: String) -> Result<bool, String> {
    let dir = get_docs_dir(&app);
    let target = dir.join(&path);
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn create_doc(app: tauri::AppHandle, path: String, content: Option<String>) -> Result<bool, String> {
    let dir = get_docs_dir(&app);
    let mut target = dir.join(&path);
    if target.extension().is_none() {
        target.set_extension("md");
    }
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let body = content.unwrap_or_else(|| {
        let stem = target.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled");
        format!("# {}\n\nStart writing your thinking notes here...\n", stem)
    });
    fs::write(&target, body).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn create_folder(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let dir = get_docs_dir(&app);
    let target = dir.join(&path);
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn delete_doc(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let dir = get_docs_dir(&app);
    let target = dir.join(&path);
    if !target.exists() {
        return Ok(true);
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&target).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

#[tauri::command]
fn rename_doc(app: tauri::AppHandle, old_path: String, new_path: String) -> Result<bool, String> {
    let dir = get_docs_dir(&app);
    let src = dir.join(&old_path);
    let dst = dir.join(&new_path);
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn append_to_doc(app: tauri::AppHandle, path: String, content: String) -> Result<bool, String> {
    let dir = get_docs_dir(&app);
    let target = dir.join(&path);
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn open_docs_folder(app: tauri::AppHandle) -> Result<String, String> {
    let dir = get_docs_dir(&app);
    let path_str = dir.to_string_lossy().to_string();
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
    Ok(path_str)
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for &b in input.as_bytes() {
        if b == b'=' || b.is_ascii_whitespace() { continue; }
        let val = match TABLE.iter().position(|&x| x == b) {
            Some(p) => p as u32,
            None => return Err(format!("Invalid base64 character: {}", b as char)),
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut val = 0u32;
    let mut valb = -6;
    for &b in data {
        val = (val << 8) + b as u32;
        valb += 8;
        while valb >= 0 {
            out.push(TABLE[((val >> valb) & 0x3F) as usize] as char);
            valb -= 6;
        }
    }
    if valb > -6 {
        out.push(TABLE[((val << 8) >> (valb + 8)) as usize & 0x3F] as char);
    }
    while out.len() % 4 != 0 {
        out.push('=');
    }
    out
}

#[tauri::command]
fn save_doc_asset(app: tauri::AppHandle, folder: String, filename: String, base64_data: String) -> Result<String, String> {
    let dir = get_docs_dir(&app);
    let target_folder = if folder.is_empty() {
        dir.join("assets")
    } else {
        dir.join(&folder).join("assets")
    };
    let _ = fs::create_dir_all(&target_folder);
    let target_file = target_folder.join(&filename);

    let clean = if let Some(idx) = base64_data.find(",") {
        &base64_data[idx + 1..]
    } else {
        &base64_data
    };

    let bytes = base64_decode(clean)?;
    fs::write(&target_file, bytes).map_err(|e| e.to_string())?;

    Ok(format!("assets/{}", filename))
}

#[tauri::command]
fn read_doc_asset(app: tauri::AppHandle, folder: String, filename: String) -> Result<String, String> {
    let dir = get_docs_dir(&app);
    let target_file = if folder.is_empty() {
        dir.join("assets").join(&filename)
    } else {
        dir.join(&folder).join("assets").join(&filename)
    };

    if !target_file.exists() {
        return Err(format!("Asset '{}' not found", filename));
    }

    let bytes = fs::read(&target_file).map_err(|e| e.to_string())?;
    let ext = target_file.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let mime = match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => "image/png",
    };
    let enc = base64_encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, enc))
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
            get_docs_path,
            list_docs,
            read_doc,
            save_doc,
            create_doc,
            create_folder,
            delete_doc,
            rename_doc,
            append_to_doc,
            open_docs_folder,
            save_doc_asset,
            read_doc_asset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_base64_roundtrip() {
        let sample_data = b"Hello, Manas Dual-Space Thinking Studio! \x00\x01\x02\xFF\xFE";
        let encoded = base64_encode(sample_data);
        let decoded = base64_decode(&encoded).expect("base64 decoding failed");
        assert_eq!(decoded, sample_data);
    }

    #[test]
    fn test_base64_empty() {
        let encoded = base64_encode(b"");
        assert_eq!(encoded, "");
        let decoded = base64_decode("").expect("empty decode failed");
        assert_eq!(decoded, Vec::<u8>::new());
    }

    #[test]
    fn test_traverse_docs_structure() {
        let path = std::path::PathBuf::from("/home/mani_radhakrishnan/.local/share/mrt/docs");
        if path.exists() {
            let items = traverse_docs(&path, &path);
            assert!(!items.is_empty(), "Items should not be empty");
        }
    }
}
