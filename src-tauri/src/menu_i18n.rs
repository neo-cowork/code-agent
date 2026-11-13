use std::{fs, io, path::Path};
use tauri::{
    menu::{Menu, MenuItemKind},
    AppHandle, Manager,
};

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

    pub fn labels(self) -> Labels {
        match self {
            Self::En => Labels {
                settings: "Settings…",
                quit: "Quit Agent Neo",
                quick_ask: "Quick Ask",
                new_chat: "New Chat",
                paste_context: "Paste as Context",
            },
            Self::Zh => Labels {
                settings: "设置…",
                quit: "退出 Agent Neo",
                quick_ask: "快速提问",
                new_chat: "新建对话",
                paste_context: "粘贴为上下文",
            },
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Labels {
    pub settings: &'static str,
    pub quit: &'static str,
    pub quick_ask: &'static str,
    pub new_chat: &'static str,
    pub paste_context: &'static str,
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

fn update_items(items: Vec<MenuItemKind<tauri::Wry>>, labels: &Labels) -> tauri::Result<()> {
    for item in items {
        match item {
            MenuItemKind::MenuItem(item) => {
                let text = match item.id().as_ref() {
                    "open_settings" => labels.settings,
                    "quit_app" => labels.quit,
                    "quick_ask" => labels.quick_ask,
                    "new_chat" => labels.new_chat,
                    "paste_context" => labels.paste_context,
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
    let labels = language.labels();
    #[cfg(target_os = "macos")]
    if let Some(menu) = app.menu() {
        update_items(menu.items().map_err(|error| error.to_string())?, &labels)
            .map_err(|error| error.to_string())?;
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

    #[test]
    fn english_labels() {
        assert_eq!(
            Language::En.labels(),
            Labels {
                settings: "Settings…",
                quit: "Quit Agent Neo",
                quick_ask: "Quick Ask",
                new_chat: "New Chat",
                paste_context: "Paste as Context",
            }
        );
    }

    #[test]
    fn chinese_labels_preserve_existing_bytes() {
        // Escapes are the original UTF-8 copy, independent of the label table.
        assert_eq!(
            Language::Zh.labels(),
            Labels {
                settings: "\u{8bbe}\u{7f6e}…",
                quit: "\u{9000}\u{51fa} Agent Neo",
                quick_ask: "\u{5feb}\u{901f}\u{63d0}\u{95ee}",
                new_chat: "\u{65b0}\u{5efa}\u{5bf9}\u{8bdd}",
                paste_context: "\u{7c98}\u{8d34}\u{4e3a}\u{4e0a}\u{4e0b}\u{6587}",
            }
        );
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
