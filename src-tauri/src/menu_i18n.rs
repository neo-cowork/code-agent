use std::{fs, io, path::Path};
use tauri::{
    menu::{Menu, MenuItemKind},
    AppHandle, Manager, Runtime,
};
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, PredefinedMenuItem};

const LANGUAGE_FILE: &str = "shell-language";
pub const TRAY_ID: &str = "main-tray";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Zh,
    En,
}

impl Language {
    fn parse(value: &str) -> Self {
        if value == "en" {
            Self::En
        } else {
            Self::Zh
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Zh => "zh",
        }
    }

    pub fn labels(self, product: &str) -> Labels {
        match self {
            Self::En => Labels {
                about: format!("About {product}"),
                services: "Services".into(),
                hide: format!("Hide {product}"),
                hide_others: "Hide Others".into(),
                settings: "Settings…".into(),
                reload: "Reload".into(),
                quit: format!("Quit {product}"),
                full_quit: "Quit Completely".into(),
                quick_ask: "Quick Ask".into(),
                new_chat: "New Chat".into(),
                paste_context: "Paste as Context".into(),
            },
            Self::Zh => Labels {
                about: format!("关于 {product}"),
                services: "服务".into(),
                hide: format!("隐藏 {product}"),
                hide_others: "隐藏其他".into(),
                settings: "设置…".into(),
                reload: "重新载入".into(),
                quit: format!("退出 {product}"),
                full_quit: "完全退出".into(),
                quick_ask: "快速提问".into(),
                new_chat: "新建对话".into(),
                paste_context: "粘贴为上下文".into(),
            },
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Labels {
    pub about: String,
    pub services: String,
    pub hide: String,
    pub hide_others: String,
    pub settings: String,
    pub reload: String,
    pub full_quit: String,
    pub quit: String,
    pub quick_ask: String,
    pub new_chat: String,
    pub paste_context: String,
}

/// The one product-name source for every native menu string (title, About/Hide/Quit, tray tooltip).
pub fn product_name<R: Runtime, M: Manager<R>>(manager: &M) -> String {
    manager.package_info().name.clone()
}

pub fn read_language(data_dir: Option<&Path>) -> Language {
    data_dir
        .and_then(|dir| fs::read_to_string(dir.join(LANGUAGE_FILE)).ok())
        .map(|value| Language::parse(&value))
        .unwrap_or(Language::Zh)
}

fn write_language(data_dir: &Path, language: Language) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    let pending = data_dir.join(format!("{LANGUAGE_FILE}.tmp"));
    fs::write(&pending, language.code())?;
    fs::rename(pending, data_dir.join(LANGUAGE_FILE))
}

// Keep the installed menu alive and update its items without replacing event handlers.
pub struct TrayMenu(pub Menu<tauri::Wry>);

/// Predefined items carry no id, so the app menu keeps handles to relabel them on language change.
#[cfg(target_os = "macos")]
pub struct AppPredefinedItems<R: Runtime> {
    pub about: PredefinedMenuItem<R>,
    pub services: PredefinedMenuItem<R>,
    pub hide: PredefinedMenuItem<R>,
    pub hide_others: PredefinedMenuItem<R>,
}

#[cfg(target_os = "macos")]
impl<R: Runtime> AppPredefinedItems<R> {
    pub fn build(
        handle: &AppHandle<R>,
        labels: &Labels,
        about_metadata: AboutMetadata,
    ) -> tauri::Result<Self> {
        Ok(Self {
            about: PredefinedMenuItem::about(handle, Some(&labels.about), Some(about_metadata))?,
            services: PredefinedMenuItem::services(handle, Some(&labels.services))?,
            hide: PredefinedMenuItem::hide(handle, Some(&labels.hide))?,
            hide_others: PredefinedMenuItem::hide_others(handle, Some(&labels.hide_others))?,
        })
    }

    fn relabel(&self, labels: &Labels) -> tauri::Result<()> {
        self.about.set_text(&labels.about)?;
        self.services.set_text(&labels.services)?;
        self.hide.set_text(&labels.hide)?;
        self.hide_others.set_text(&labels.hide_others)
    }
}

#[cfg(target_os = "macos")]
fn relabel_app_predefined<R: Runtime>(app: &AppHandle<R>, labels: &Labels) -> tauri::Result<()> {
    match app.try_state::<AppPredefinedItems<R>>() {
        Some(items) => items.relabel(labels),
        None => Ok(()),
    }
}

fn update_items(items: Vec<MenuItemKind<tauri::Wry>>, labels: &Labels) -> tauri::Result<()> {
    for item in items {
        match item {
            MenuItemKind::MenuItem(item) => {
                let text = match item.id().as_ref() {
                    "open_settings" => labels.settings.as_str(),
                    "reload_window" => labels.reload.as_str(),
                    "quit_app" => labels.quit.as_str(),
                    "full_quit" => labels.full_quit.as_str(),
                    "quick_ask" => labels.quick_ask.as_str(),
                    "new_chat" => labels.new_chat.as_str(),
                    "paste_context" => labels.paste_context.as_str(),
                    _ => continue,
                };
                item.set_text(text)?;
            }
            MenuItemKind::Submenu(submenu) => update_items(submenu.items()?, labels)?,
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_shell_language(app: AppHandle, lang: String) -> Result<(), String> {
    let language = Language::parse(&lang);
    let labels = language.labels(&product_name(&app));
    #[cfg(target_os = "macos")]
    {
        if let Some(menu) = app.menu() {
            update_items(menu.items().map_err(|error| error.to_string())?, &labels)
                .map_err(|error| error.to_string())?;
        }
        relabel_app_predefined(&app, &labels).map_err(|error| error.to_string())?;
    }
    if let Some(menu) = app.try_state::<TrayMenu>() {
        update_items(menu.0.items().map_err(|error| error.to_string())?, &labels)
            .map_err(|error| error.to_string())?;
    }
    let data_dir = crate::real_data_dir().ok_or("shell language data directory unavailable")?;
    write_language(&data_dir, language).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("neo-menu-i18n-{}-{unique}", std::process::id()))
    }

    fn all(l: &Labels) -> [&str; 11] {
        [
            &l.about, &l.services, &l.hide, &l.hide_others, &l.settings, &l.reload, &l.quit,
            &l.full_quit, &l.quick_ask, &l.new_chat, &l.paste_context,
        ]
    }

    #[test]
    fn english_labels() {
        assert_eq!(
            all(&Language::En.labels("Agent Neo")),
            [
                "About Agent Neo", "Services", "Hide Agent Neo", "Hide Others", "Settings…",
                "Reload", "Quit Agent Neo", "Quit Completely", "Quick Ask", "New Chat",
                "Paste as Context",
            ]
        );
        let dev = Language::En.labels("Agent Neo Dev");
        assert_eq!(dev.quit, "Quit Agent Neo Dev");
        assert_eq!(dev.about, "About Agent Neo Dev");
        assert_eq!(dev.hide, "Hide Agent Neo Dev");
    }

    #[test]
    fn chinese_labels_preserve_existing_bytes() {
        // Escapes are the original UTF-8 copy, independent of the label table.
        assert_eq!(
            all(&Language::Zh.labels("Agent Neo")),
            [
                "\u{5173}\u{4e8e} Agent Neo",
                "\u{670d}\u{52a1}",
                "\u{9690}\u{85cf} Agent Neo",
                "\u{9690}\u{85cf}\u{5176}\u{4ed6}",
                "\u{8bbe}\u{7f6e}…",
                "\u{91cd}\u{65b0}\u{8f7d}\u{5165}",
                "\u{9000}\u{51fa} Agent Neo",
                "完全退出",
                "\u{5feb}\u{901f}\u{63d0}\u{95ee}",
                "\u{65b0}\u{5efa}\u{5bf9}\u{8bdd}",
                "\u{7c98}\u{8d34}\u{4e3a}\u{4e0a}\u{4e0b}\u{6587}",
            ]
        );
        let dev = Language::Zh.labels("Agent Neo Dev");
        assert_eq!(dev.about, "\u{5173}\u{4e8e} Agent Neo Dev");
        assert_eq!(dev.hide, "\u{9690}\u{85cf} Agent Neo Dev");
        assert_eq!(dev.quit, "\u{9000}\u{51fa} Agent Neo Dev");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn language_switch_relabels_the_four_predefined_items() {
        let app = tauri::test::mock_app();
        let handle = app.handle();
        let product = product_name(handle);
        let items = AppPredefinedItems::build(
            handle,
            &Language::Zh.labels(&product),
            AboutMetadata::default(),
        )
        .unwrap();
        app.manage(items);
        let read = || {
            let items = handle.state::<AppPredefinedItems<tauri::test::MockRuntime>>();
            [
                items.about.text().unwrap(),
                items.services.text().unwrap(),
                items.hide.text().unwrap(),
                items.hide_others.text().unwrap(),
            ]
        };
        assert_eq!(read()[1], "\u{670d}\u{52a1}");
        for language in [Language::En, Language::Zh] {
            let labels = language.labels(&product);
            relabel_app_predefined(handle, &labels).unwrap();
            assert_eq!(read(), [labels.about, labels.services, labels.hide, labels.hide_others]);
        }
        relabel_app_predefined(handle, &Language::En.labels(&product)).unwrap();
        assert_eq!(read()[1], "Services");
    }

    #[test]
    fn language_file_round_trip() {
        let dir = temp_dir();
        for language in [Language::En, Language::Zh, Language::En] {
            write_language(&dir, language).unwrap();
            assert_eq!(read_language(Some(&dir)), language);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn missing_and_garbled_files_fall_back_to_zh() {
        let dir = temp_dir();
        assert_eq!(read_language(None), Language::Zh);
        assert_eq!(read_language(Some(&dir)), Language::Zh);
        fs::create_dir_all(&dir).unwrap();
        for bytes in [b"".as_slice(), b"garbled", b"EN", b"en\n", &[0xff]] {
            fs::write(dir.join(LANGUAGE_FILE), bytes).unwrap();
            assert_eq!(read_language(Some(&dir)), Language::Zh);
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
