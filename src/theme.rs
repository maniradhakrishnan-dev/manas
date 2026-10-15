use eframe::egui::{Color32, Stroke, Visuals};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThemeMode {
    PaperWarm,
    ObsidianDark,
    ForestSage,
}

#[derive(Debug, Clone)]
pub struct ThemeColors {
    pub bg: Color32,
    pub card_bg: Color32,
    pub card_header_bg: Color32,
    pub card_border: Color32,
    pub text_primary: Color32,
    pub text_muted: Color32,
    pub accent: Color32,
    pub divider_line: Color32,
    pub success: Color32,
}

impl ThemeMode {
    pub fn colors(&self) -> ThemeColors {
        match self {
            ThemeMode::PaperWarm => ThemeColors {
                bg: Color32::from_rgb(247, 244, 238),
                card_bg: Color32::from_rgb(255, 255, 255),
                card_header_bg: Color32::from_rgb(242, 238, 230),
                card_border: Color32::from_rgb(222, 215, 201),
                text_primary: Color32::from_rgb(41, 37, 36),
                text_muted: Color32::from_rgb(120, 113, 108),
                accent: Color32::from_rgb(180, 83, 9),
                divider_line: Color32::from_rgb(214, 206, 190),
                success: Color32::from_rgb(22, 101, 52),
            },
            ThemeMode::ObsidianDark => ThemeColors {
                bg: Color32::from_rgb(17, 18, 22),
                card_bg: Color32::from_rgb(24, 25, 30),
                card_header_bg: Color32::from_rgb(32, 34, 42),
                card_border: Color32::from_rgb(45, 48, 58),
                text_primary: Color32::from_rgb(243, 244, 246),
                text_muted: Color32::from_rgb(156, 163, 175),
                accent: Color32::from_rgb(96, 165, 250),
                divider_line: Color32::from_rgb(38, 41, 51),
                success: Color32::from_rgb(74, 222, 128),
            },
            ThemeMode::ForestSage => ThemeColors {
                bg: Color32::from_rgb(20, 26, 23),
                card_bg: Color32::from_rgb(27, 36, 32),
                card_header_bg: Color32::from_rgb(36, 48, 42),
                card_border: Color32::from_rgb(42, 56, 49),
                text_primary: Color32::from_rgb(235, 242, 238),
                text_muted: Color32::from_rgb(141, 163, 153),
                accent: Color32::from_rgb(74, 222, 128),
                divider_line: Color32::from_rgb(45, 60, 52),
                success: Color32::from_rgb(52, 211, 153),
            },
        }
    }

    pub fn apply(&self, ctx: &eframe::egui::Context) {
        let colors = self.colors();
        let mut visuals = match self {
            ThemeMode::PaperWarm => Visuals::light(),
            _ => Visuals::dark(),
        };

        visuals.panel_fill = colors.bg;
        visuals.window_fill = colors.card_bg;
        visuals.window_stroke = Stroke::new(1.0, colors.card_border);
        visuals.override_text_color = Some(colors.text_primary);

        ctx.set_visuals(visuals);
    }
}
