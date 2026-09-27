// SPDX-License-Identifier: MPL-2.0
//! GNOME uses libadwaita for its X11 frames, but our Wayland frame is GTK 3.
//! Restyle only stock Adwaita's native title bar; GTK still owns all controls,
//! button layout, dragging, close requests and window state transitions.

fn use_gnome_frame(wayland: bool, desktop: &str, theme: &str, theme_override: bool) -> bool {
    wayland
        && desktop
            .split(':')
            .any(|part| part.eq_ignore_ascii_case("GNOME"))
        && matches!(theme, "Adwaita" | "Adwaita-dark")
        && !theme_override
}

#[cfg(target_os = "linux")]
pub fn install(window: &gtk::Window) -> Result<(), gtk::glib::Error> {
    use gtk::prelude::*;

    let wayland = window.display().type_().name() == "GdkWaylandDisplay";
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let theme_override = std::env::var_os("GTK_THEME").is_some_and(|value| !value.is_empty());
    if !wayland
        || !desktop
            .split(':')
            .any(|part| part.eq_ignore_ascii_case("GNOME"))
    {
        return Ok(());
    }
    let Some(settings) = window.settings() else {
        return Ok(());
    };
    let Some(screen) = gtk::prelude::GtkWindowExt::screen(window) else {
        return Ok(());
    };
    let provider = gtk::CssProvider::new();
    provider.load_from_data(include_bytes!("linux_decorations.css"))?;
    gtk::StyleContext::add_provider_for_screen(
        &screen,
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    let weak_window = window.downgrade();
    let update = move |settings: &gtk::Settings| {
        let Some(window) = weak_window.upgrade() else {
            return;
        };
        let theme = settings.gtk_theme_name().unwrap_or_default();
        let context = window.style_context();
        for class in ["sc-gnome-frame", "sc-gnome-frame-dark"] {
            context.remove_class(class);
        }
        if use_gnome_frame(wayland, &desktop, &theme, theme_override) {
            context.add_class("sc-gnome-frame");
            if settings.is_gtk_application_prefer_dark_theme() || theme == "Adwaita-dark" {
                context.add_class("sc-gnome-frame-dark");
            }
        }
    };
    update(&settings);
    let update_theme = update.clone();
    let theme_handler =
        settings.connect_gtk_theme_name_notify(move |settings| update_theme(settings));
    let dark_handler = settings.connect_gtk_application_prefer_dark_theme_notify(update);
    // Disconnect Settings' callbacks and remove the screen provider with the window.
    // The callbacks hold only a weak window reference.
    let handlers = std::cell::RefCell::new(Some((theme_handler, dark_handler)));
    window.connect_destroy(move |_| {
        if let Some((theme_handler, dark_handler)) = handlers.take() {
            settings.disconnect(theme_handler);
            settings.disconnect(dark_handler);
            gtk::StyleContext::remove_provider_for_screen(&screen, &provider);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_preserves_other_backends_desktops_and_user_themes() {
        assert!(use_gnome_frame(true, "GNOME", "Adwaita", false));
        assert!(use_gnome_frame(true, "ubuntu:GNOME", "Adwaita-dark", false));
        assert!(!use_gnome_frame(false, "GNOME", "Adwaita", false));
        assert!(!use_gnome_frame(true, "KDE", "Adwaita", false));
        assert!(!use_gnome_frame(true, "GNOME-Classic", "Adwaita", false));
        for theme in [
            "HighContrast",
            "HighContrastInverse",
            "adw-gtk3",
            "Yaru",
            "",
        ] {
            assert!(!use_gnome_frame(true, "GNOME", theme, false));
        }
        assert!(!use_gnome_frame(true, "GNOME", "Adwaita", true));
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "linux_decorations_tests.rs"]
mod native_tests;
