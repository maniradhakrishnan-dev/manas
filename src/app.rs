use std::collections::HashSet;
use std::time::Instant;

use chrono::{Days, Local, NaiveDate};
use eframe::egui::{
    self, Frame, Margin, Panel, RichText, ScrollArea, Stroke,
};

use crate::model::DayEntry;
use crate::storage::Storage;
use crate::theme::ThemeMode;
use crate::widgets::{render_block_card, render_year_calendar_modal};

pub struct MrtApp {
    current_date: NaiveDate,
    current_entry: DayEntry,
    storage: Storage,
    active_dates: HashSet<NaiveDate>,
    theme_mode: ThemeMode,
    is_dirty: bool,
    last_saved: Instant,
    save_status: String,
    show_calendar_modal: bool,
    show_export_notification: Option<(String, Instant)>,
}

impl MrtApp {
    pub fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        let storage = Storage::new();
        let today = Local::now().date_naive();
        let entry = storage.load_day(today);
        let active_dates = storage.list_active_dates();

        Self {
            current_date: today,
            current_entry: entry,
            storage,
            active_dates,
            theme_mode: ThemeMode::ObsidianDark,
            is_dirty: false,
            last_saved: Instant::now(),
            save_status: "Ready".to_string(),
            show_calendar_modal: false,
            show_export_notification: None,
        }
    }

    fn change_date(&mut self, new_date: NaiveDate) {
        if self.is_dirty {
            self.save_current();
        }
        self.current_date = new_date;
        self.current_entry = self.storage.load_day(new_date);
        self.is_dirty = false;
        self.save_status = "Loaded".to_string();
    }

    fn save_current(&mut self) {
        if let Err(e) = self.storage.save_day(&self.current_entry) {
            self.save_status = format!("Save Error: {}", e);
        } else {
            self.is_dirty = false;
            self.last_saved = Instant::now();
            self.save_status = "Saved".to_string();
            if self.current_entry.has_content() {
                self.active_dates.insert(self.current_date);
            }
        }
    }

    fn export_markdown_file(&mut self) {
        let md = self.current_entry.to_markdown();
        let filename = format!("mrt_{}.md", self.current_date.format("%Y-%m-%d"));
        let export_path = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(&filename);

        if std::fs::write(&export_path, md).is_ok() {
            self.show_export_notification = Some((
                format!("Exported to {}", export_path.display()),
                Instant::now(),
            ));
        } else {
            self.show_export_notification =
                Some(("Failed to export markdown".to_string(), Instant::now()));
        }
    }
}

impl eframe::App for MrtApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();

        // Apply current visual theme
        self.theme_mode.apply(&ctx);
        let colors = self.theme_mode.colors();

        // Keyboard navigation shortcuts
        if ctx.input(|i| i.key_pressed(egui::Key::ArrowLeft) && i.modifiers.alt)
            || ctx.input(|i| i.key_pressed(egui::Key::OpenBracket))
        {
            if let Some(prev) = self.current_date.checked_sub_days(Days::new(1)) {
                self.change_date(prev);
            }
        }
        if ctx.input(|i| i.key_pressed(egui::Key::ArrowRight) && i.modifiers.alt)
            || ctx.input(|i| i.key_pressed(egui::Key::CloseBracket))
        {
            if let Some(next) = self.current_date.checked_add_days(Days::new(1)) {
                self.change_date(next);
            }
        }

        // Top Navigation & Control Bar
        Panel::top("top_panel")
            .frame(
                Frame::NONE
                    .fill(colors.card_bg)
                    .inner_margin(Margin::symmetric(14, 10))
                    .stroke(Stroke::new(1.0, colors.divider_line)),
            )
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    // App Logo & Branding
                    ui.label(
                        RichText::new("MANAS")
                            .strong()
                            .size(19.0)
                            .color(colors.accent),
                    );
                    ui.label(
                        RichText::new("— Daily Planner & Thinking Space")
                            .size(13.0)
                            .color(colors.text_muted),
                    );

                    ui.add_space(16.0);

                    // Date Navigation
                    if ui.button("◀ Prev").on_hover_text("Shortcut: [ or Alt+Left").clicked() {
                        if let Some(prev) = self.current_date.checked_sub_days(Days::new(1)) {
                            self.change_date(prev);
                        }
                    }

                    let today = Local::now().date_naive();
                    let is_today = self.current_date == today;
                    let today_btn = ui.selectable_label(is_today, "Today");
                    if today_btn.clicked() {
                        self.change_date(today);
                    }

                    if ui.button("Next ▶").on_hover_text("Shortcut: ] or Alt+Right").clicked() {
                        if let Some(next) = self.current_date.checked_add_days(Days::new(1)) {
                            self.change_date(next);
                        }
                    }

                    // Formatted Current Date Label
                    ui.add_space(8.0);
                    let date_str = self.current_date.format("%A, %d %B %Y").to_string();
                    ui.label(
                        RichText::new(date_str)
                            .strong()
                            .size(15.0)
                            .color(colors.text_primary),
                    );

                    // 365 Diary Navigator Modal Button
                    if ui.button("📅 365 Calendar").on_hover_text("Open 365-day year overview").clicked() {
                        self.show_calendar_modal = true;
                    }

                    // Right-aligned status and controls
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        // Theme Switcher Cycle
                        let theme_label = match self.theme_mode {
                            ThemeMode::PaperWarm => "🎨 Paper Warm",
                            ThemeMode::ObsidianDark => "🎨 Obsidian Dark",
                            ThemeMode::ForestSage => "🎨 Forest Sage",
                        };
                        if ui.button(theme_label).on_hover_text("Switch theme").clicked() {
                            self.theme_mode = match self.theme_mode {
                                ThemeMode::PaperWarm => ThemeMode::ObsidianDark,
                                ThemeMode::ObsidianDark => ThemeMode::ForestSage,
                                ThemeMode::ForestSage => ThemeMode::PaperWarm,
                            };
                        }

                        // Export Markdown
                        if ui.button("📥 Export MD").on_hover_text("Export day as Markdown").clicked() {
                            self.export_markdown_file();
                        }

                        // Save status indicator
                        if self.is_dirty {
                            ui.label(
                                RichText::new("● Auto-saving...")
                                    .size(11.0)
                                    .color(colors.accent),
                            );
                        } else {
                            ui.label(
                                RichText::new(format!("✓ {}", self.save_status))
                                    .size(11.0)
                                    .color(colors.success),
                            );
                        }

                        // Total Task Stats
                        let (completed, total) = self.current_entry.total_tasks();
                        if total > 0 {
                            let pct = (completed as f32 / total as f32 * 100.0) as usize;
                            ui.label(
                                RichText::new(format!("Tasks: {}/{} ({}%)", completed, total, pct))
                                    .size(12.0)
                                    .color(colors.text_muted),
                            );
                        }
                    });
                });
            });

        // Bottom Status Bar
        Panel::bottom("bottom_bar")
            .frame(
                Frame::NONE
                    .fill(colors.card_bg)
                    .inner_margin(Margin::symmetric(14, 6))
                    .stroke(Stroke::new(1.0, colors.divider_line)),
            )
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new("Shortcuts: [ / ] = Prev/Next Day | Alt+Left/Right = Day Jump")
                            .size(11.0)
                            .color(colors.text_muted),
                    );

                    if let Some((msg, since)) = &self.show_export_notification {
                        if since.elapsed().as_secs() < 4 {
                            ui.label(RichText::new(msg).size(11.0).color(colors.success));
                        }
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(
                            RichText::new(format!("Stored: {}", self.storage.entries_path().display()))
                                .size(10.0)
                                .color(colors.text_muted),
                        );
                    });
                });
            });

        // 365-Day Calendar Navigator Modal
        if self.show_calendar_modal {
            let mut date_to_load = self.current_date;
            if render_year_calendar_modal(
                &ctx,
                &mut date_to_load,
                &self.active_dates,
                &colors,
                &mut self.show_calendar_modal,
            ) {
                self.change_date(date_to_load);
            }
        }

        // Central Daily Layout Grid
        Frame::NONE
            .fill(colors.bg)
            .inner_margin(Margin::same(12))
            .show(ui, |ui| {
                ScrollArea::vertical().show(ui, |ui| {
                    let total_width = ui.available_width();
                    let col_width = (total_width - 16.0) / 2.0;

                    // -------------------------------------------------------------
                    // TOP HALF: LEFT COLUMN (Part 1 + Part 2) & RIGHT COLUMN (Productive + Admin)
                    // -------------------------------------------------------------
                    ui.horizontal_top(|ui| {
                        // ==================== LEFT COLUMN ====================
                        ui.allocate_ui_with_layout(
                            egui::vec2(col_width, 0.0),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                ui.label(
                                    RichText::new("PART - 1 (LEARNING & CORE TRACKS)")
                                        .strong()
                                        .size(13.0)
                                        .color(colors.accent),
                                );
                                ui.add_space(4.0);

                                // Part 1: 4 Sub-Quadrants (2x2 Grid)
                                let quad_w = (ui.available_width() - 8.0) / 2.0;
                                let quad_h = 130.0;

                                // Row 1 of Part 1 (Quad 1 & Quad 2)
                                ui.horizontal(|ui| {
                                    ui.allocate_ui_with_layout(
                                        egui::vec2(quad_w, quad_h),
                                        egui::Layout::top_down(egui::Align::Min),
                                        |ui| {
                                            if render_block_card(
                                                ui,
                                                &mut self.current_entry.part1.quad1,
                                                &colors,
                                                quad_h,
                                                true,
                                            ) {
                                                self.is_dirty = true;
                                            }
                                        },
                                    );

                                    ui.allocate_ui_with_layout(
                                        egui::vec2(quad_w, quad_h),
                                        egui::Layout::top_down(egui::Align::Min),
                                        |ui| {
                                            if render_block_card(
                                                ui,
                                                &mut self.current_entry.part1.quad2,
                                                &colors,
                                                quad_h,
                                                true,
                                            ) {
                                                self.is_dirty = true;
                                            }
                                        },
                                    );
                                });

                                ui.add_space(6.0);

                                // Row 2 of Part 1 (Quad 3 & Quad 4)
                                ui.horizontal(|ui| {
                                    ui.allocate_ui_with_layout(
                                        egui::vec2(quad_w, quad_h),
                                        egui::Layout::top_down(egui::Align::Min),
                                        |ui| {
                                            if render_block_card(
                                                ui,
                                                &mut self.current_entry.part1.quad3,
                                                &colors,
                                                quad_h,
                                                true,
                                            ) {
                                                self.is_dirty = true;
                                            }
                                        },
                                    );

                                    ui.allocate_ui_with_layout(
                                        egui::vec2(quad_w, quad_h),
                                        egui::Layout::top_down(egui::Align::Min),
                                        |ui| {
                                            if render_block_card(
                                                ui,
                                                &mut self.current_entry.part1.quad4,
                                                &colors,
                                                quad_h,
                                                true,
                                            ) {
                                                self.is_dirty = true;
                                            }
                                        },
                                    );
                                });

                                ui.add_space(8.0);

                                // Split line between Part 1 and Part 2
                                ui.painter().line_segment(
                                    [
                                        ui.cursor().min,
                                        egui::pos2(ui.cursor().min.x + ui.available_width(), ui.cursor().min.y),
                                    ],
                                    Stroke::new(1.5, colors.divider_line),
                                );
                                ui.add_space(8.0);

                                // Part 2 Section
                                ui.label(
                                    RichText::new("PART - 2 (HARDWARE / SECONDARY FOCUS)")
                                        .strong()
                                        .size(13.0)
                                        .color(colors.accent),
                                );
                                ui.add_space(4.0);

                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.part2,
                                    &colors,
                                    140.0,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }
                            },
                        );

                        // Vertical divider between Left Column and Right Column
                        let min_y = ui.cursor().min.y;
                        let max_y = min_y + 460.0;
                        let mid_x = ui.cursor().min.x + 8.0;
                        ui.painter().line_segment(
                            [egui::pos2(mid_x, min_y), egui::pos2(mid_x, max_y)],
                            Stroke::new(1.5, colors.divider_line),
                        );
                        ui.add_space(16.0);

                        // ==================== RIGHT COLUMN ====================
                        ui.allocate_ui_with_layout(
                            egui::vec2(col_width, 0.0),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                // Productive (9:00 AM - 2:00 PM)
                                ui.label(
                                    RichText::new("PRODUCTIVE (9:00 AM - 2:00 PM)")
                                        .strong()
                                        .size(13.0)
                                        .color(colors.accent),
                                );
                                ui.add_space(4.0);

                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.productive,
                                    &colors,
                                    185.0,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }

                                ui.add_space(12.0);

                                // Split line between Productive and Admin
                                ui.painter().line_segment(
                                    [
                                        ui.cursor().min,
                                        egui::pos2(ui.cursor().min.x + ui.available_width(), ui.cursor().min.y),
                                    ],
                                    Stroke::new(1.5, colors.divider_line),
                                );
                                ui.add_space(12.0);

                                // Admin (2:00 PM - 6:00 PM)
                                ui.label(
                                    RichText::new("ADMIN & CHORES (2:00 PM - 6:00 PM)")
                                        .strong()
                                        .size(13.0)
                                        .color(colors.accent),
                                );
                                ui.add_space(4.0);

                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.admin,
                                    &colors,
                                    160.0,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }
                            },
                        );
                    });

                    ui.add_space(18.0);

                    // -------------------------------------------------------------
                    // PROMINENT DOUBLE DIVIDER LINE (Notebook Fold / Phase Split)
                    // -------------------------------------------------------------
                    let cursor_y = ui.cursor().min.y;
                    let width = ui.available_width();
                    ui.painter().line_segment(
                        [egui::pos2(ui.cursor().min.x, cursor_y), egui::pos2(ui.cursor().min.x + width, cursor_y)],
                        Stroke::new(2.0, colors.accent),
                    );
                    ui.painter().line_segment(
                        [egui::pos2(ui.cursor().min.x, cursor_y + 4.0), egui::pos2(ui.cursor().min.x + width, cursor_y + 4.0)],
                        Stroke::new(1.0, colors.divider_line),
                    );
                    ui.add_space(14.0);

                    // -------------------------------------------------------------
                    // BOTTOM HALF: EVENING PHASE (6:00 PM - 11:00 PM)
                    // 6 Boxes: (Top 3: Huro, Kana, Bana) & (Bottom 3: Curio, Survivi, Random)
                    // -------------------------------------------------------------
                    ui.label(
                        RichText::new("EVENING PHASE (6:00 PM - 11:00 PM) — CREATIVE, PROJECTS, EXPLORATION & LIFE")
                            .strong()
                            .size(13.0)
                            .color(colors.accent),
                    );
                    ui.add_space(6.0);

                    let evening_col_w = (ui.available_width() - 16.0) / 3.0;
                    let evening_h = 160.0;

                    // Row 1: Huro, Kana, Bana
                    ui.horizontal(|ui| {
                        ui.allocate_ui_with_layout(
                            egui::vec2(evening_col_w, evening_h),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.evening.huro,
                                    &colors,
                                    evening_h,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }
                            },
                        );

                        ui.allocate_ui_with_layout(
                            egui::vec2(evening_col_w, evening_h),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.evening.kana,
                                    &colors,
                                    evening_h,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }
                            },
                        );

                        ui.allocate_ui_with_layout(
                            egui::vec2(evening_col_w, evening_h),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.evening.bana,
                                    &colors,
                                    evening_h,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }
                            },
                        );
                    });

                    ui.add_space(8.0);

                    // Row 2: Curio, Survivi, Random
                    ui.horizontal(|ui| {
                        ui.allocate_ui_with_layout(
                            egui::vec2(evening_col_w, evening_h),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.evening.curio,
                                    &colors,
                                    evening_h,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }
                            },
                        );

                        ui.allocate_ui_with_layout(
                            egui::vec2(evening_col_w, evening_h),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.evening.survivi,
                                    &colors,
                                    evening_h,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }
                            },
                        );

                        ui.allocate_ui_with_layout(
                            egui::vec2(evening_col_w, evening_h),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                if render_block_card(
                                    ui,
                                    &mut self.current_entry.evening.random,
                                    &colors,
                                    evening_h,
                                    true,
                                ) {
                                    self.is_dirty = true;
                                }
                            },
                        );
                    });

                    ui.add_space(16.0);
                });
            });

        // Debounced auto-save every 1 second when modified
        if self.is_dirty && self.last_saved.elapsed().as_millis() > 800 {
            self.save_current();
        }
    }
}
