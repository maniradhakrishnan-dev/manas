mod app;
mod model;
mod storage;
mod theme;
mod widgets;

use app::MrtApp;
use eframe::egui;

fn main() -> eframe::Result<()> {
    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Manas — Daily Planner & Thinking Space")
            .with_inner_size([1240.0, 960.0])
            .with_min_inner_size([900.0, 650.0])
            .with_app_id("com.manas.app"),
        ..Default::default()
    };

    eframe::run_native(
        "Manas — Daily Planner & Thinking Space",
        native_options,
        Box::new(|cc| Ok(Box::new(MrtApp::new(cc)))),
    )
}
