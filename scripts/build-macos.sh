#!/usr/bin/env bash
# 在 macOS 上构建 DeskAlarm。
#
# 为什么必须有这个脚本、且必须在 Mac 上跑：
# Tauri 的 macOS 产物（.app / .dmg）需要 Xcode 的 macOS SDK 和 codesign 工具，
# 这些只有 macOS 才有。Windows 上无论怎么配都构建不出来，
# 只能靠 CI 的 macos runner 或者一台 Mac。
#
# 用法：
#   ./scripts/build-macos.sh              # 当前架构
#   ./scripts/build-macos.sh universal    # Intel + Apple Silicon 通吃
#   ./scripts/build-macos.sh aarch64      # 只 Apple Silicon
#   ./scripts/build-macos.sh x86_64       # 只 Intel
#
# 产物在 app/src-tauri/target/<target>/release/bundle/

set -euo pipefail

TARGET="${1:-native}"

cd "$(dirname "$0")/.."
ROOT="$PWD"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- 前置检查
say "检查前置依赖"

[ "$(uname -s)" = "Darwin" ] || die "这个脚本只能在 macOS 上跑。macOS 产物需要 Xcode 的 SDK，别的平台构建不出来。"

command -v node >/dev/null || die "没装 Node.js（需要 20+）"
command -v cargo >/dev/null || die "没装 Rust。装：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"

# Xcode 完整版，不是只有 Command Line Tools。
# Command Line Tools 没有 macOS SDK，也签不了 .app。
if ! xcode-select -p >/dev/null 2>&1; then
  die "没装 Xcode。装完还要跑一次 xcode-select --install"
fi
DEVELOPER_DIR_PATH="$(xcode-select -p)"
[ -d "$DEVELOPER_DIR_PATH/Platforms/MacOSX.platform" ] \
  || die "当前只装了 Xcode Command Line Tools，没有 macOS SDK。完整安装 Xcode.app 后重试。"
xcodebuild -version >/dev/null 2>&1 \
  || die "xcodebuild 不可用。完整安装 Xcode.app 后重试。"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 版本太老（当前 $(node -v)），需要 20 或更高。"

echo "  macOS     $(sw_vers -productVersion) $(uname -m)"
echo "  Node      $(node -v)"
echo "  Rust      $(rustc --version)"
echo "  Xcode     $(xcodebuild -version | head -1)"

# ---------------------------------------------------------------- 依赖
say "安装依赖"
cd "$ROOT/app"
[ -d node_modules ] || npm install
cd "$ROOT/server"
[ -d node_modules ] || npm install

# ---------------------------------------------------------------- 目标架构
CLI_TARGET=()
case "$TARGET" in
  native)
    case "$(uname -m)" in
      arm64) rustup target add aarch64-apple-darwin >/dev/null 2>&1 || true ;;
      *)     rustup target add x86_64-apple-darwin  >/dev/null 2>&1 || true ;;
    esac
    ;;
  universal)
    # 通吃包要两个 target 都装上
    say "安装 universal 需要的两个 Rust target"
    rustup target add x86_64-apple-darwin
    rustup target add aarch64-apple-darwin
    CLI_TARGET=(--target universal-apple-darwin)
    ;;
  aarch64|x86_64)
    rustup target add "${TARGET}-apple-darwin"
    CLI_TARGET=(--target "${TARGET}-apple-darwin")
    ;;
  *)
    die "看不懂的目标：$TARGET。可选 native / universal / aarch64 / x86_64"
    ;;
esac

# ---------------------------------------------------------------- 构建
cd "$ROOT/app"

say "构建前端"
npm run build

say "构建并打包（$TARGET）"
# 只在 mac 上打 app+dmg，nsis 是 Windows 的，在这里指定会省掉一堆无谓动作
npx tauri build "${CLI_TARGET[@]}" --bundles app,dmg

# ---------------------------------------------------------------- 报位置
BUNDLE_DIR="$ROOT/app/src-tauri/target/release/bundle"
[ ${#CLI_TARGET[@]} -gt 0 ] && BUNDLE_DIR="$ROOT/app/src-tauri/target/${CLI_TARGET[2]}/release/bundle"

say "产物"
if [ -d "$BUNDLE_DIR/dmg" ]; then
  ls -lh "$BUNDLE_DIR/dmg"/*.dmg 2>/dev/null || true
fi
if [ -d "$BUNDLE_DIR/macos" ]; then
  ls -ld "$BUNDLE_DIR/macos"/*.app 2>/dev/null || true
fi

cat <<EOF

装到本机（拖 .app 进 Applications，或者命令行）：

  cp -R "$BUNDLE_DIR/macos/提醒器.app" /Applications/

首次打开如果被 Gatekeeper 拦（提示「无法验证开发者」），因为没做代码签名和公证，
本地自用可以这样放行：

  xattr -cr /Applications/提醒器.app

EOF