use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;

use crate::model::DayEntry;

pub struct Storage {
    data_dir: PathBuf,
}

impl Storage {
    pub fn new() -> Self {
        // Try user data directory first: ~/.local/share/mrt on Linux, then fallback to ./mrt_data
        let base_dir = if let Some(proj_dirs) = dirs::data_dir() {
            proj_dirs.join("mrt")
        } else {
            PathBuf::from("./mrt_data")
        };

        let entries_dir = base_dir.join("entries");
        let _ = fs::create_dir_all(&entries_dir);

        Self { data_dir: entries_dir }
    }

    pub fn entries_path(&self) -> &Path {
        &self.data_dir
    }

    fn file_for_date(&self, date: NaiveDate) -> PathBuf {
        self.data_dir.join(format!("{}.json", date.format("%Y-%m-%d")))
    }

    /// Load an entry for a specific date, or return an empty template
    pub fn load_day(&self, date: NaiveDate) -> DayEntry {
        let file_path = self.file_for_date(date);
        if file_path.exists() {
            if let Ok(content) = fs::read_to_string(&file_path) {
                if let Ok(entry) = serde_json::from_str::<DayEntry>(&content) {
                    return entry;
                }
            }
        }
        DayEntry::empty_for(date)
    }

    /// Save an entry for a specific date
    pub fn save_day(&self, entry: &DayEntry) -> Result<(), String> {
        let file_path = self.file_for_date(entry.date);
        let json_str = serde_json::to_string_pretty(entry)
            .map_err(|e| format!("Failed to serialize entry: {}", e))?;
        fs::write(file_path, json_str)
            .map_err(|e| format!("Failed to write entry to disk: {}", e))?;
        Ok(())
    }

    /// Return a set of all dates that currently have recorded entries
    pub fn list_active_dates(&self) -> HashSet<NaiveDate> {
        let mut dates = HashSet::new();
        if let Ok(entries) = fs::read_dir(&self.data_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if let Ok(date) = NaiveDate::parse_from_str(stem, "%Y-%m-%d") {
                            dates.insert(date);
                        }
                    }
                }
            }
        }
        dates
    }
}
