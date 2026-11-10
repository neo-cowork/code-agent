use crate::quit_guard::QuitPrompt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuitDialogLanguage {
    Zh,
    En,
}

impl QuitDialogLanguage {
    pub(crate) fn from_wire(value: &str) -> Option<Self> {
        match value {
            "zh" => Some(Self::Zh),
            "en" => Some(Self::En),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct QuitDialogCopy {
    pub(crate) title: &'static str,
    pub(crate) cancel_button: &'static str,
    pub(crate) background_button: &'static str,
    pub(crate) quit_button: &'static str,
}

pub(crate) fn dialog_copy(language: QuitDialogLanguage) -> QuitDialogCopy {
    match language {
        QuitDialogLanguage::Zh => QuitDialogCopy {
            title: "确定要退出 Agent Neo 吗？",
            cancel_button: "取消",
            background_button: "后台继续",
            quit_button: "停止并退出",
        },
        QuitDialogLanguage::En => QuitDialogCopy {
            title: "Quit Agent Neo?",
            cancel_button: "Cancel",
            background_button: "Keep Running in Background",
            quit_button: "Stop and Quit",
        },
    }
}

pub(crate) fn prompt_text(
    prompt: QuitPrompt,
    offers_background_continue: bool,
    language: QuitDialogLanguage,
) -> &'static str {
    match (language, offers_background_continue, prompt) {
        (QuitDialogLanguage::Zh, true, QuitPrompt::RunningTasks) => {
            "有任务正在运行。\n后台继续：关闭窗口，任务和定时任务照常运行\n停止并退出：停止全部任务（含定时任务）并退出"
        }
        (QuitDialogLanguage::Zh, true, QuitPrompt::ScheduledTasks) => {
            "当前只有定时任务。停止后这些任务将不再运行。\n后台继续：关闭窗口，任务和定时任务照常运行\n停止并退出：停止全部任务（含定时任务）并退出"
        }
        (QuitDialogLanguage::Zh, true, QuitPrompt::Both) => {
            "有任务正在运行，也有定时任务。\n后台继续：关闭窗口，任务和定时任务照常运行\n停止并退出：停止全部任务（含定时任务）并退出"
        }
        (QuitDialogLanguage::Zh, true, QuitPrompt::Unverified) => {
            "无法确认是否有任务在运行。\n后台继续：关闭窗口，任务和定时任务照常运行\n停止并退出：停止全部任务（含定时任务）并退出"
        }
        (QuitDialogLanguage::Zh, false, QuitPrompt::RunningTasks) => {
            "有任务正在运行。退出将停止这些任务。"
        }
        (QuitDialogLanguage::Zh, false, QuitPrompt::ScheduledTasks) => {
            "当前只有定时任务。退出将停止这些定时任务，停止后不再运行。"
        }
        (QuitDialogLanguage::Zh, false, QuitPrompt::Both) => {
            "有任务正在运行，也有定时任务。退出将停止运行中的任务和定时任务。"
        }
        (QuitDialogLanguage::Zh, false, QuitPrompt::Unverified) => {
            "无法确认是否有任务在运行。退出将停止运行中的任务和定时任务。"
        }
        (QuitDialogLanguage::En, true, QuitPrompt::RunningTasks) => {
            "Tasks are currently running.\nKeep Running in Background: Close the window; tasks and scheduled tasks will continue running\nStop and Quit: Stop all tasks (including scheduled tasks) and quit"
        }
        (QuitDialogLanguage::En, true, QuitPrompt::ScheduledTasks) => {
            "There are only scheduled tasks. Stopping will prevent them from running.\nKeep Running in Background: Close the window; tasks and scheduled tasks will continue running\nStop and Quit: Stop all tasks (including scheduled tasks) and quit"
        }
        (QuitDialogLanguage::En, true, QuitPrompt::Both) => {
            "Tasks are currently running, and there are scheduled tasks.\nKeep Running in Background: Close the window; tasks and scheduled tasks will continue running\nStop and Quit: Stop all tasks (including scheduled tasks) and quit"
        }
        (QuitDialogLanguage::En, true, QuitPrompt::Unverified) => {
            "Unable to confirm whether tasks are running.\nKeep Running in Background: Close the window; tasks and scheduled tasks will continue running\nStop and Quit: Stop all tasks (including scheduled tasks) and quit"
        }
        (QuitDialogLanguage::En, false, QuitPrompt::RunningTasks) => {
            "Tasks are currently running. Quitting will stop these tasks."
        }
        (QuitDialogLanguage::En, false, QuitPrompt::ScheduledTasks) => {
            "There are only scheduled tasks. Quitting will stop these scheduled tasks, and they will not run again."
        }
        (QuitDialogLanguage::En, false, QuitPrompt::Both) => {
            "Tasks are currently running, and there are scheduled tasks. Quitting will stop the running tasks and scheduled tasks."
        }
        (QuitDialogLanguage::En, false, QuitPrompt::Unverified) => {
            "Unable to confirm whether tasks are running. Quitting will stop the running tasks and scheduled tasks."
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quit_guard::{dialog_answer_action, quit_prompt_text, QuitAnswerAction, QuitPrompt};

    #[test]
    fn dialog_answer_action_maps_all_three_labels_for_both_languages() {
        let zh = dialog_copy(QuitDialogLanguage::Zh);
        for language in [QuitDialogLanguage::Zh, QuitDialogLanguage::En] {
            let copy = dialog_copy(language);
            assert_eq!(
                dialog_answer_action(Some(copy.cancel_button), language),
                QuitAnswerAction::StayRunning
            );
            assert_eq!(
                dialog_answer_action(Some(copy.background_button), language),
                QuitAnswerAction::BackgroundContinue
            );
            assert_eq!(
                dialog_answer_action(Some(copy.quit_button), language),
                QuitAnswerAction::Quit
            );
            assert_eq!(
                dialog_answer_action(None, language),
                QuitAnswerAction::StayRunning
            );
            assert_eq!(
                dialog_answer_action(Some("unknown label"), language),
                QuitAnswerAction::StayRunning
            );
            assert_eq!(
                dialog_answer_action(Some(copy.cancel_button), language),
                dialog_answer_action(Some(zh.cancel_button), QuitDialogLanguage::Zh)
            );
            assert_eq!(
                dialog_answer_action(Some(copy.background_button), language),
                dialog_answer_action(Some(zh.background_button), QuitDialogLanguage::Zh)
            );
            assert_eq!(
                dialog_answer_action(Some(copy.quit_button), language),
                dialog_answer_action(Some(zh.quit_button), QuitDialogLanguage::Zh)
            );
        }
    }

    #[test]
    fn localized_copy_covers_all_prompts_and_button_sets() {
        let prompts = [
            QuitPrompt::RunningTasks,
            QuitPrompt::ScheduledTasks,
            QuitPrompt::Both,
            QuitPrompt::Unverified,
        ];
        for language in [QuitDialogLanguage::Zh, QuitDialogLanguage::En] {
            let copy = dialog_copy(language);
            for offers_background_continue in [true, false] {
                for (index, left) in prompts.iter().enumerate() {
                    for right in prompts.iter().skip(index + 1) {
                        assert_ne!(
                            quit_prompt_text(*left, offers_background_continue, language),
                            quit_prompt_text(*right, offers_background_continue, language)
                        );
                    }
                }
            }
            for prompt in prompts {
                let three = quit_prompt_text(prompt, true, language);
                let two = quit_prompt_text(prompt, false, language);
                assert!(!three.is_empty() && !two.is_empty());
                assert_ne!(three, two);
                assert!(three.contains(copy.background_button));
                assert!(three.contains(copy.quit_button));
                assert!(!two.contains(copy.background_button));
            }
        }
    }

    #[test]
    fn english_dialog_labels_are_pinned_and_cancel_is_safe() {
        let copy = dialog_copy(QuitDialogLanguage::En);
        assert_eq!(copy.cancel_button, "Cancel");
        assert_eq!(copy.background_button, "Keep Running in Background");
        assert_eq!(copy.quit_button, "Stop and Quit");
        assert_eq!(
            dialog_answer_action(Some(copy.cancel_button), QuitDialogLanguage::En),
            QuitAnswerAction::StayRunning
        );
    }
}
