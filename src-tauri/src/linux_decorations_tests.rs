// SPDX-License-Identifier: MPL-2.0
use gtk::prelude::*;

fn settle() {
    let until = std::time::Instant::now() + std::time::Duration::from_millis(150);
    while std::time::Instant::now() < until {
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
}

fn descendants(widget: &gtk::Widget) -> Vec<gtk::Widget> {
    let mut found = vec![widget.clone()];
    if let Some(container) = widget.downcast_ref::<gtk::Container>() {
        container.forall(|child| found.extend(descendants(child)));
    }
    found
}

fn background(widget: &impl IsA<gtk::Widget>) -> gtk::gdk::RGBA {
    let context = widget.style_context();
    context
        .style_property_for_state("background-color", context.state())
        .get()
        .unwrap()
}

fn snapshot(header: &gtk::Widget, name: &str) {
    let Ok(directory) = std::env::var("SC_DECORATION_SNAPSHOTS") else {
        return;
    };
    std::fs::create_dir_all(&directory).unwrap();
    let width = header.allocated_width();
    let height = header.allocated_height();
    assert!(width > 0 && height > 0);
    let surface =
        gtk::cairo::ImageSurface::create(gtk::cairo::Format::ARgb32, width, height).unwrap();
    let context = gtk::cairo::Context::new(&surface).unwrap();
    header.draw(&context);
    gtk::gdk::pixbuf_get_from_surface(&surface, 0, 0, width, height)
        .unwrap()
        .savev(
            std::path::Path::new(&directory).join(format!("{name}.png")),
            "png",
            &[],
        )
        .unwrap();
}

#[test]
#[ignore = "requires a Wayland compositor, XDG_CURRENT_DESKTOP=GNOME and no GTK_THEME"]
fn native_frame_tracks_settings_and_keeps_native_controls() {
    gtk::init().unwrap();
    let settings = gtk::Settings::default().unwrap();
    settings.set_gtk_theme_name(Some("Adwaita"));
    settings.set_gtk_application_prefer_dark_theme(false);
    settings.set_gtk_enable_animations(false);
    settings.set_gtk_decoration_layout(Some(":close"));
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title("ShellCanvas");
    window.set_default_size(800, 180);
    window.add(&gtk::Label::new(Some(
        "Native Wayland decoration regression",
    )));
    window.show_all();
    settle();
    assert_eq!(window.display().type_().name(), "GdkWaylandDisplay");
    let header = descendants(window.upcast_ref())
        .into_iter()
        .find(|widget| widget.is::<gtk::HeaderBar>())
        .expect("GTK must create its own header bar");
    let original_background = background(&header);
    let original_titlebar = window.titlebar();
    snapshot(&header, "before-light");

    super::install(&window).unwrap();
    settle();
    assert!(window.style_context().has_class("sc-gnome-frame"));
    assert_eq!(window.titlebar(), original_titlebar);
    assert!(background(&header).red() > 0.95);
    assert!(background(&header).green() > 0.95);
    assert_ne!(background(&header), original_background);
    snapshot(&header, "after-light");

    settings.set_gtk_application_prefer_dark_theme(true);
    settle();
    assert!(window.style_context().has_class("sc-gnome-frame-dark"));
    assert!(background(&header).red() < 0.25);
    snapshot(&header, "after-dark");

    settings.set_gtk_theme_name(Some("HighContrast"));
    settle();
    assert!(!window.style_context().has_class("sc-gnome-frame"));
    assert!(!window.style_context().has_class("sc-gnome-frame-dark"));

    settings.set_gtk_theme_name(Some("Adwaita"));
    settings.set_gtk_application_prefer_dark_theme(false);
    settings.set_gtk_decoration_layout(Some(":minimize,maximize,close"));
    settle();
    for class in ["minimize", "maximize", "close"] {
        assert!(
            descendants(&header).iter().any(|widget| {
                widget.is::<gtk::Button>() && widget.style_context().has_class(class)
            }),
            "native {class} button must respect GTK's configured layout"
        );
    }
    let close = descendants(&header)
        .into_iter()
        .find(|widget| widget.is::<gtk::Button>() && widget.style_context().has_class("close"))
        .unwrap()
        .downcast::<gtk::Button>()
        .unwrap();
    let closed = std::rc::Rc::new(std::cell::Cell::new(false));
    let requested = closed.clone();
    window.connect_delete_event(move |_, _| {
        requested.set(true);
        gtk::glib::Propagation::Stop
    });
    close.emit_clicked();
    settle();
    assert!(
        closed.get(),
        "native close must still reach the application's close guard"
    );
    window.close();
}
