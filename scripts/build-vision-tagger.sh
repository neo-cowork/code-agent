#!/usr/bin/env bash
# ============================================================================
# 构建 vision-tagger Swift 工具（人脸检测 + 主题分类）
# ============================================================================
# 依赖: macOS + swiftc（Xcode Command Line Tools）
# 产物: scripts/vision-tagger（Mach-O arm64）
# 触发时机: 首次 clone 后、scripts/vision-tagger.swift 变更后
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/vision-tagger.swift"
OUTPUT="$SCRIPT_DIR/vision-tagger"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ vision-tagger 仅支持 macOS" >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "❌ 找不到 swiftc — 请安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "❌ Swift 源文件缺失: $SOURCE" >&2
  exit 1
fi

# arch 感知交叉编译：SWIFT_BUILD_ARCH=x86_64|arm64 显式指定（CI 出 x64 包用）。
# 不设则编当前架构（保持原行为）。最低系统版本对齐 tauri.conf 的 11.0。
TARGET_ARGS=()
case "${SWIFT_BUILD_ARCH:-}" in
  x86_64|x64)    TARGET_ARGS=(-target x86_64-apple-macos11) ;;
  arm64|aarch64) TARGET_ARGS=(-target arm64-apple-macos11) ;;
  "") ;;
  *) echo "❌ 不支持的 SWIFT_BUILD_ARCH=${SWIFT_BUILD_ARCH}（仅 x86_64 / arm64）" >&2; exit 1 ;;
esac

# 增量检查按源码内容哈希，不比文件时间：worktree 引导会把主树旧产物拷过来，拷出的文件
# 时间比源码新，按时间判断永远「已是最新」，Swift 改动进不了 Dev 包（N-MEETING-DUALTRACK-FU1 真机查出）。
# 交叉编译指定 arch 时强制重编。
LOCAL_SHA="$(shasum -a 256 "$SOURCE" | cut -d' ' -f1)"
if [[ -z "${SWIFT_BUILD_ARCH:-}" && -f "$OUTPUT" && "$(cat "$OUTPUT.srcsha" 2>/dev/null)" == "$LOCAL_SHA" ]]; then
  echo "✓ vision-tagger 已是最新（源文件未变）"
  exit 0
fi

echo "→ 编译 vision-tagger${SWIFT_BUILD_ARCH:+ (target=$SWIFT_BUILD_ARCH)}..."
swiftc \
  -O \
  ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} \
  -framework Vision \
  -framework AppKit \
  -o "$OUTPUT" \
  "$SOURCE"

chmod +x "$OUTPUT"
if [[ -z "${SWIFT_BUILD_ARCH:-}" ]]; then echo "$LOCAL_SHA" > "$OUTPUT.srcsha"; else rm -f "$OUTPUT.srcsha"; fi
echo "✓ 产物: $OUTPUT"
ls -lh "$OUTPUT"
