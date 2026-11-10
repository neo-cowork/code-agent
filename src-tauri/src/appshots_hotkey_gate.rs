// Appshots 左右 Cmd 热键的「装 / 不装」决策 —— 纯函数，不碰 FFI（FFI 在 appshots.rs 的
// dual_command_hotkey 里）。为什么要有这道门（FB-457）：启动直接 CGEventTapCreate 会在
// 未授权时弹系统「Keystroke Receiving」框，且每个新 Dev 槽（新 bundle id）都会再弹一遍。
// 决策：启动只 preflight（静默）；未授权不装不问；Dev 通道启动一律不装；只有设置页的
// 「开启快捷键」按钮（explicit_request=true）才允许触发系统询问。

use std::time::Duration;

/// `decide_hotkey_install` 的输出；调用方（appshots.rs）按分支落日志 / 装 tap。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyInstallDecision {
    /// 已授权（或显式请求后已授权）→ 现在（幂等）安装 tap。
    Install,
    /// 未授权且非显式请求 → 不装 tap、不弹框，只打一行可区分日志。
    SkipNoPermission,
    /// Dev 通道（`.dev[N]` bundle id）启动路径 → 一律不装（自动化反复启动不打扰）。
    SkipDevChannel,
    /// 显式请求但尚未授权 → 先 CGRequestListenEventAccess（每进程至多一次），授权了再装。
    RequestThenInstallIfGranted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListenEventAccessRequestOutcome {
    SymbolMissing,
    ReturnedFalse,
    ReturnedTrue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListenEventAccessRequestReport {
    pub outcome: ListenEventAccessRequestOutcome,
    pub elapsed: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyAccessRequestReasonCode {
    RequestSymbolMissing,
    RequestReturnedFalse,
    RequestGranted,
}

impl HotkeyAccessRequestReasonCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RequestSymbolMissing => "request_symbol_missing",
            Self::RequestReturnedFalse => "request_returned_false",
            Self::RequestGranted => "request_granted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HotkeyAccessRequestClassification {
    pub reason_code: HotkeyAccessRequestReasonCode,
    pub elapsed_ms: u64,
}

/// 把 FFI 返回形状归一成稳定的取证 reason code，不碰 TCC 或其他系统状态。
pub fn classify_listen_event_access_request(
    outcome: ListenEventAccessRequestOutcome,
    elapsed: Duration,
) -> HotkeyAccessRequestClassification {
    let reason_code = match outcome {
        ListenEventAccessRequestOutcome::SymbolMissing => {
            HotkeyAccessRequestReasonCode::RequestSymbolMissing
        }
        ListenEventAccessRequestOutcome::ReturnedFalse => {
            HotkeyAccessRequestReasonCode::RequestReturnedFalse
        }
        ListenEventAccessRequestOutcome::ReturnedTrue => {
            HotkeyAccessRequestReasonCode::RequestGranted
        }
    };
    HotkeyAccessRequestClassification {
        reason_code,
        elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
    }
}

/// 纯决策：三个布尔进，一个动作出。启动路径传 `explicit_request=false`；设置页
/// 「开启快捷键」按钮传 `true`（Dev 通道的显式请求仍然放行，给真要在该槽测热键的人
/// 一个入口——跳过只发生在启动路径）。
pub fn decide_hotkey_install(
    preflight_granted: bool,
    dev_channel: bool,
    explicit_request: bool,
) -> HotkeyInstallDecision {
    if dev_channel && !explicit_request {
        return HotkeyInstallDecision::SkipDevChannel;
    }
    if preflight_granted {
        return HotkeyInstallDecision::Install;
    }
    if explicit_request {
        return HotkeyInstallDecision::RequestThenInstallIfGranted;
    }
    HotkeyInstallDecision::SkipNoPermission
}

/// 「preflight 说已授权，但装 tap 失败」之后的后续动作（只在显式请求的 Install 分支用到）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContradictionFollowup {
    /// 与 preflight 一致（装成功），无需后续。
    Consistent,
    /// preflight 被推翻且本进程还没发过系统请求 → 发一次。
    ContradictedRequestOnce,
    /// preflight 被推翻但本进程已发过请求 → 不再骚扰，只刷新状态。
    ContradictedLatchedSkip,
}

impl ContradictionFollowup {
    /// 取证 reason code；`Consistent` 不写事件。
    pub const fn reason_code(self) -> Option<&'static str> {
        match self {
            Self::Consistent => None,
            Self::ContradictedRequestOnce => Some("preflight_true_install_failed"),
            Self::ContradictedLatchedSkip => Some("preflight_true_install_failed_latched_skip"),
        }
    }
}

/// preflight 为真时安装 tap 的结果 → 后续动作。
pub fn decide_contradiction_followup(
    install_failed: bool,
    request_already_sent: bool,
) -> ContradictionFollowup {
    match (install_failed, request_already_sent) {
        (false, _) => ContradictionFollowup::Consistent,
        (true, false) => ContradictionFollowup::ContradictedRequestOnce,
        (true, true) => ContradictionFollowup::ContradictedLatchedSkip,
    }
}

/// 对外汇报的 permission_granted：preflight 为真，但「被推翻」标记在且 tap 没装上 →
/// 报未授权，让 UI 给出完整的去设置指引；tap 已装上则以事实为准（视为已授权）。
pub fn effective_permission_granted(
    preflight_granted: bool,
    contradicted: bool,
    tap_installed: bool,
) -> bool {
    if tap_installed {
        return true;
    }
    preflight_granted && !contradicted
}

#[cfg(test)]
mod tests {
    use super::*;
    use HotkeyInstallDecision::*;

    #[test]
    fn appshots_hotkey_not_granted_startup_skips_without_asking() {
        assert_eq!(decide_hotkey_install(false, false, false), SkipNoPermission);
    }

    #[test]
    fn appshots_hotkey_granted_non_dev_startup_installs() {
        assert_eq!(decide_hotkey_install(true, false, false), Install);
    }

    #[test]
    fn appshots_hotkey_dev_channel_startup_skips_even_when_granted() {
        assert_eq!(decide_hotkey_install(true, true, false), SkipDevChannel);
        assert_eq!(decide_hotkey_install(false, true, false), SkipDevChannel);
    }

    #[test]
    fn appshots_hotkey_explicit_request_asks_then_installs_only_if_granted() {
        assert_eq!(
            decide_hotkey_install(false, false, true),
            RequestThenInstallIfGranted
        );
        // 显式请求时已授权 → 直接装，不再弹系统框。
        assert_eq!(decide_hotkey_install(true, false, true), Install);
        // Dev 通道显式请求放行（入口在设置页）。
        assert_eq!(
            decide_hotkey_install(false, true, true),
            RequestThenInstallIfGranted
        );
        assert_eq!(decide_hotkey_install(true, true, true), Install);
    }

    #[test]
    fn appshots_hotkey_request_reason_classifier_covers_all_outcomes() {
        let cases = [
            (
                ListenEventAccessRequestOutcome::SymbolMissing,
                11,
                HotkeyAccessRequestReasonCode::RequestSymbolMissing,
            ),
            (
                ListenEventAccessRequestOutcome::ReturnedFalse,
                22,
                HotkeyAccessRequestReasonCode::RequestReturnedFalse,
            ),
            (
                ListenEventAccessRequestOutcome::ReturnedTrue,
                33,
                HotkeyAccessRequestReasonCode::RequestGranted,
            ),
        ];

        for (outcome, elapsed_ms, expected_reason_code) in cases {
            assert_eq!(
                classify_listen_event_access_request(outcome, Duration::from_millis(elapsed_ms)),
                HotkeyAccessRequestClassification {
                    reason_code: expected_reason_code,
                    elapsed_ms,
                }
            );
        }
    }

    #[test]
    fn appshots_hotkey_preflight_true_install_failed_requests_once_then_latches() {
        assert_eq!(
            decide_contradiction_followup(true, false),
            ContradictionFollowup::ContradictedRequestOnce
        );
        assert_eq!(
            decide_contradiction_followup(true, true),
            ContradictionFollowup::ContradictedLatchedSkip
        );
        assert_eq!(
            decide_contradiction_followup(false, false),
            ContradictionFollowup::Consistent
        );
        assert_eq!(
            ContradictionFollowup::ContradictedRequestOnce.reason_code(),
            Some("preflight_true_install_failed")
        );
        assert_eq!(
            ContradictionFollowup::ContradictedLatchedSkip.reason_code(),
            Some("preflight_true_install_failed_latched_skip")
        );
        assert_eq!(ContradictionFollowup::Consistent.reason_code(), None);
    }

    #[test]
    fn appshots_hotkey_contradicted_flag_reports_not_granted_until_tap_installed() {
        assert!(effective_permission_granted(true, false, false));
        assert!(!effective_permission_granted(true, true, false));
        assert!(effective_permission_granted(true, true, true));
        assert!(!effective_permission_granted(false, false, false));
    }
}
