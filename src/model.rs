use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

/// Represents an individual content block with an editable title and text body
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockEntry {
    pub title: String,
    pub content: String,
}

impl BlockEntry {
    pub fn new(title: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            content: content.into(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.content.trim().is_empty()
    }

    /// Count markdown checklists like `- [ ]` and `- [x]`
    pub fn checklist_stats(&self) -> (usize, usize) {
        let mut total = 0;
        let mut completed = 0;
        for line in self.content.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("- [ ]") || trimmed.starts_with("* [ ]") {
                total += 1;
            } else if trimmed.starts_with("- [x]")
                || trimmed.starts_with("- [X]")
                || trimmed.starts_with("* [x]")
                || trimmed.starts_with("* [X]")
            {
                total += 1;
                completed += 1;
            }
        }
        (completed, total)
    }
}

/// The 4-split quadrant in Part 1 (2x2 grid)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Part1Quadrants {
    pub quad1: BlockEntry,
    pub quad2: BlockEntry,
    pub quad3: BlockEntry,
    pub quad4: BlockEntry,
}

impl Default for Part1Quadrants {
    fn default() -> Self {
        Self {
            quad1: BlockEntry::new("CS & SWE", ""),
            quad2: BlockEntry::new("Core AI", ""),
            quad3: BlockEntry::new("Applications", ""),
            quad4: BlockEntry::new("RSWE", ""),
        }
    }
}

/// Evening phase (6:00 PM - 11:00 PM): 6 boxes (2 rows of 3 columns)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EveningPhase {
    pub huro: BlockEntry,
    pub kana: BlockEntry,
    pub bana: BlockEntry,
    pub curio: BlockEntry,
    pub survivi: BlockEntry,
    pub random: BlockEntry,
}

impl Default for EveningPhase {
    fn default() -> Self {
        Self {
            huro: BlockEntry::new("Huro", ""),
            kana: BlockEntry::new("Kana", ""),
            bana: BlockEntry::new("Bana", ""),
            curio: BlockEntry::new("Curio", ""),
            survivi: BlockEntry::new("Survivo", ""),
            random: BlockEntry::new("Random", ""),
        }
    }
}

/// Complete daily entry for MRT 365-day diary
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayEntry {
    pub date: NaiveDate,
    pub part1: Part1Quadrants,
    pub part2: BlockEntry,
    pub productive: BlockEntry,
    pub admin: BlockEntry,
    pub evening: EveningPhase,
    pub updated_at: DateTime<Utc>,
}

impl DayEntry {
    pub fn empty_for(date: NaiveDate) -> Self {
        Self {
            date,
            part1: Part1Quadrants::default(),
            part2: BlockEntry::new("Breadth", ""),
            productive: BlockEntry::new("Productive (9:00 AM - 2:00 PM)", ""),
            admin: BlockEntry::new("Admin (2:00 PM - 6:00 PM)", ""),
            evening: EveningPhase::default(),
            updated_at: Utc::now(),
        }
    }

    /// Check if the day has any content entered
    pub fn has_content(&self) -> bool {
        !self.part1.quad1.is_empty()
            || !self.part1.quad2.is_empty()
            || !self.part1.quad3.is_empty()
            || !self.part1.quad4.is_empty()
            || !self.part2.is_empty()
            || !self.productive.is_empty()
            || !self.admin.is_empty()
            || !self.evening.huro.is_empty()
            || !self.evening.kana.is_empty()
            || !self.evening.bana.is_empty()
            || !self.evening.curio.is_empty()
            || !self.evening.survivi.is_empty()
            || !self.evening.random.is_empty()
    }

    /// Total completed and total checklist items across the entire day
    pub fn total_tasks(&self) -> (usize, usize) {
        let mut completed = 0;
        let mut total = 0;

        let blocks = [
            &self.part1.quad1,
            &self.part1.quad2,
            &self.part1.quad3,
            &self.part1.quad4,
            &self.part2,
            &self.productive,
            &self.admin,
            &self.evening.huro,
            &self.evening.kana,
            &self.evening.bana,
            &self.evening.curio,
            &self.evening.survivi,
            &self.evening.random,
        ];

        for b in blocks {
            let (c, t) = b.checklist_stats();
            completed += c;
            total += t;
        }

        (completed, total)
    }

    /// Export the day's notes cleanly to Markdown
    pub fn to_markdown(&self) -> String {
        let mut md = String::new();
        md.push_str(&format!("# MRT Daily Entry - {}\n\n", self.date.format("%A, %B %d, %Y")));

        md.push_str("## 🌅 Part 1 (Learning)\n\n");
        md.push_str(&format!("### {}\n{}\n\n", self.part1.quad1.title, self.part1.quad1.content));
        md.push_str(&format!("### {}\n{}\n\n", self.part1.quad2.title, self.part1.quad2.content));
        md.push_str(&format!("### {}\n{}\n\n", self.part1.quad3.title, self.part1.quad3.content));
        md.push_str(&format!("### {}\n{}\n\n", self.part1.quad4.title, self.part1.quad4.content));

        md.push_str(&format!("## ⚡ {}\n{}\n\n", self.part2.title, self.part2.content));
        md.push_str(&format!("## 🚀 {}\n{}\n\n", self.productive.title, self.productive.content));
        md.push_str(&format!("## 📋 {}\n{}\n\n", self.admin.title, self.admin.content));

        md.push_str("## 🌙 Evening Phase (6:00 PM - 11:00 PM)\n\n");
        md.push_str(&format!("### {}\n{}\n\n", self.evening.huro.title, self.evening.huro.content));
        md.push_str(&format!("### {}\n{}\n\n", self.evening.kana.title, self.evening.kana.content));
        md.push_str(&format!("### {}\n{}\n\n", self.evening.bana.title, self.evening.bana.content));
        md.push_str(&format!("### {}\n{}\n\n", self.evening.curio.title, self.evening.curio.content));
        md.push_str(&format!("### {}\n{}\n\n", self.evening.survivi.title, self.evening.survivi.content));
        md.push_str(&format!("### {}\n{}\n\n", self.evening.random.title, self.evening.random.content));

        md
    }
}
