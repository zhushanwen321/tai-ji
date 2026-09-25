#!/usr/bin/env bash
# pi-unlink.sh — pi 模式：rm globalExtDir symlink + pi install 重装 npm 版（pi-link 的逆操作）
#
# 做两件事：
#   1. rm ~/.pi/agent/extensions/pi-<short> symlink
#   2. pi install npm:@zhushanwen/pi-<short> 重装 npm 版（settings 条目 + node_modules 包）
#      pi install 是 pi 原生命令，需联网（从 npm registry 下载）。
#
# 状态守恒：pi-link 时 pi uninstall 清掉的 npm 版，unlink 时 pi install 重装 → 往返后 extension 回到 npm 源。
#
# 用法: ./pi-unlink.sh <package> [package2 ...]
#   <package> = 短名 (subagent-workflow) / pi-前缀 / @zhushanwen/pi-全名
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dev-link-lib.sh
source "$SCRIPT_DIR/dev-link-lib.sh"

[ $# -lt 1 ] && { echo "用法: $0 <package> [package2 ...]"; exit 1; }

for input in "$@"; do
	short=$(dl_resolve_short_name "$input")
	link="$PI_EXT_DIR/pi-$short"
	# 清上一轮循环残留（dl_lookup 失败时不覆盖旧值，stale 名会把刚卸载的包重新 pi install 回来）
	unset DL_NPM_NAME DL_SRC_DIR
	dl_lookup "$short" || true  # 查 npm 包名（pi install 重装用）；映射不在则跳过重装

	# 1. rm symlink
	if [ -L "$link" ]; then
		rm "$link"
		green "✓ unlink: ${short}（rm ${link}）"
	else
		echo "  · ${short} 未 pi-link（${link} 不是 symlink），跳过 rm"
	fi

	# 2. 删 pi skill 目录里该 extension 的 skill symlinks（extension 源码还在时遍历其 skills/）
	if [ -n "${DL_SRC_DIR:-}" ] && [ -d "$DL_SRC_DIR/skills" ]; then
		skill_count=$(dl_unlink_skills "$DL_SRC_DIR")
		if [ "$skill_count" != "0" ]; then
			green "  ✓ 删 ${skill_count} 个 skill symlink（${PI_SKILL_DIR}）"
		fi
	fi

	# 3. pi install 重装 npm 版（需联网）
	if [ -n "${DL_NPM_NAME:-}" ]; then
		if pi install "npm:$DL_NPM_NAME" >/dev/null 2>&1; then
			green "  ✓ pi install 重装 ${DL_NPM_NAME}"
		else
			red "  ✗ pi install ${DL_NPM_NAME} 失败（检查网络 / npm registry / proxy）"
		fi
	fi
done

echo ""
green "✓ pi 模式 unlink 完成"
echo "  生效：新建 pi session"
echo "  注：pi install 需联网（从 npm registry 下载）；失败时检查网络/proxy"
