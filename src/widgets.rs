use chrono::{Datelike, NaiveDate};
use eframe::egui::{
    self, Color32, CornerRadius, Frame, Margin, RichText, Sense, Stroke, TextEdit, Ui,
};

use crate::model::BlockEntry;
use crate::theme::ThemeColors;

/// Render an interactive notebook block card
pub fn render_block_card(
    ui: &mut Ui,
    block: &mut BlockEntry,
    colors: &ThemeColors,
    height_hint: f32,
    allow_title_edit: bool,
) -> bool {
    let mut changed = false;

    Frame::NONE
        .fill(colors.card_bg)
        .stroke(Stroke::new(1.0, colors.card_border))
        .corner_radius(CornerRadius::same(6))
        .inner_margin(Margin::same(10))
        .show(ui, |ui| {
            // Header bar
            Frame::NONE
                .fill(colors.card_header_bg)
                .corner_radius(CornerRadius::same(4))
                .inner_margin(Margin::symmetric(8, 4))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        if allow_title_edit {
                            let mut title_buf = block.title.clone();
                            let response = ui.add(
                                TextEdit::singleline(&mut title_buf)
                                    .frame(Frame::NONE)
                                    .font(egui::TextStyle::Heading)
                                    .text_color(colors.accent),
                            );
                            if response.changed() {
                                block.title = title_buf;
                                changed = true;
                            }
                        } else {
                            ui.label(
                                RichText::new(&block.title)
                                    .strong()
                                    .size(13.5)
                                    .color(colors.accent),
                            );
                        }

                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            // Task completion pill if any checkboxes exist
                            let (completed, total) = block.checklist_stats();
                            if total > 0 {
                                let tag_color = if completed == total {
                                    colors.success
                                } else {
                                    colors.text_muted
                                };
                                ui.label(
                                    RichText::new(format!("✓ {}/{}", completed, total))
                                        .size(11.0)
                                        .color(tag_color),
                                );
                            }

                            // Quick insert checkbox button
                            if ui
                                .small_button("☐")
                                .on_hover_text("Insert checkbox - [ ]")
                                .clicked()
                            {
                                if !block.content.is_empty() && !block.content.ends_with('\n') {
                                    block.content.push('\n');
                                }
                                block.content.push_str("- [ ] ");
                                changed = true;
                            }

                            // Quick insert bullet button
                            if ui
                                .small_button("•")
                                .on_hover_text("Insert bullet point")
                                .clicked()
                            {
                                if !block.content.is_empty() && !block.content.ends_with('\n') {
                                    block.content.push('\n');
                                }
                                block.content.push_str("- ");
                                changed = true;
                            }
                        });
                    });
                });

            ui.add_space(4.0);

            // Subtle divider under header
            ui.painter().line_segment(
                [
                    ui.cursor().min,
                    egui::pos2(ui.cursor().min.x + ui.available_width(), ui.cursor().min.y),
                ],
                Stroke::new(1.0, colors.divider_line),
            );
            ui.add_space(4.0);

            // Multiline editor
            let available_height = (ui.available_height() - 4.0).max(height_hint);
            let text_edit = TextEdit::multiline(&mut block.content)
                .frame(Frame::NONE)
                .desired_width(f32::INFINITY)
                .desired_rows(6)
                .min_size(egui::vec2(ui.available_width(), available_height))
                .font(egui::TextStyle::Body)
                .text_color(colors.text_primary);

            let res = ui.add(text_edit);
            if res.changed() {
                changed = true;
            }
        });

    changed
}

/// Render the 365-day year calendar overview popup/modal
pub fn render_year_calendar_modal(
    ctx: &egui::Context,
    current_date: &mut NaiveDate,
    active_dates: &std::collections::HashSet<NaiveDate>,
    colors: &ThemeColors,
    is_open: &mut bool,
) -> bool {
    let mut date_selected = false;

    egui::Window::new(RichText::new("📅 365-Day Diary Navigator").strong().color(colors.accent))
        .open(is_open)
        .resizable(true)
        .default_size(egui::vec2(680.0, 520.0))
        .anchor(egui::Align2::CENTER_CENTER, egui::vec2(0.0, 0.0))
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label(
                    RichText::new(format!("Year {}", current_date.year()))
                        .size(18.0)
                        .strong()
                        .color(colors.text_primary),
                );

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Today").clicked() {
                        *current_date = chrono::Local::now().date_naive();
                        date_selected = true;
                    }
                });
            });

            ui.add_space(8.0);
            ui.separator();
            ui.add_space(8.0);

            // 12 Months Grid (3 columns of 4 months each)
            egui::ScrollArea::vertical().show(ui, |ui| {
                let months = [
                    "January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December",
                ];

                egui::Grid::new("year_calendar_grid")
                    .num_columns(3)
                    .spacing(egui::vec2(16.0, 16.0))
                    .show(ui, |ui| {
                        for (idx, month_name) in months.iter().enumerate() {
                            let month_num = (idx + 1) as u32;
                            Frame::NONE
                                .fill(colors.card_bg)
                                .stroke(Stroke::new(1.0, colors.card_border))
                                .corner_radius(CornerRadius::same(4))
                                .inner_margin(Margin::same(8))
                                .show(ui, |ui| {
                                    ui.set_width(190.0);
                                    ui.label(
                                        RichText::new(*month_name)
                                            .strong()
                                            .size(13.0)
                                            .color(colors.accent),
                                    );
                                    ui.add_space(4.0);

                                    // Weekday labels
                                    ui.horizontal(|ui| {
                                        for d in ["M", "T", "W", "T", "F", "S", "S"] {
                                            ui.label(
                                                RichText::new(d)
                                                    .size(9.0)
                                                    .color(colors.text_muted),
                                            );
                                        }
                                    });

                                    // Render day buttons for this month
                                    let year = current_date.year();
                                    if let Some(first_day) = NaiveDate::from_ymd_opt(year, month_num, 1) {
                                        let days_in_month = if month_num == 12 {
                                            31
                                        } else {
                                            NaiveDate::from_ymd_opt(year, month_num + 1, 1)
                                                .and_then(|d| d.pred_opt())
                                                .map(|d| d.day())
                                                .unwrap_or(30)
                                        };

                                        let start_weekday = first_day.weekday().number_from_monday(); // 1 to 7

                                        let mut current_col = 1;
                                        ui.horizontal_wrapped(|ui| {
                                            // Empty placeholders for alignment
                                            for _ in 1..start_weekday {
                                                ui.label(RichText::new("  ").size(10.0));
                                                current_col += 1;
                                            }

                                            for day in 1..=days_in_month {
                                                if let Some(d) = NaiveDate::from_ymd_opt(year, month_num, day) {
                                                    let is_active = active_dates.contains(&d);
                                                    let is_current = d == *current_date;

                                                    let text = format!("{:2}", day);
                                                    let mut rich = RichText::new(text).size(10.0);

                                                    if is_current {
                                                        rich = rich.color(Color32::WHITE).background_color(colors.accent);
                                                    } else if is_active {
                                                        rich = rich.color(colors.success).strong();
                                                    } else {
                                                        rich = rich.color(colors.text_primary);
                                                    }

                                                    let btn = ui.add(egui::Label::new(rich).sense(Sense::click()));
                                                    if btn.clicked() {
                                                        *current_date = d;
                                                        date_selected = true;
                                                    }
                                                    if btn.hovered() && is_active {
                                                        btn.on_hover_text("Has journal entries");
                                                    }

                                                    current_col += 1;
                                                    if current_col > 7 {
                                                        current_col = 1;
                                                    }
                                                }
                                            }
                                        });
                                    }
                                });

                            if (idx + 1) % 3 == 0 {
                                ui.end_row();
                            }
                        }
                    });
            });
        });

    date_selected
}
