#!/usr/bin/env bash
# pi-link.sh — pi 模式：symlink 本地源码 + pi uninstall 清 npm 版（避免两源并存）
#
# 做两件事（映射查 dev-link-lib.sh，SSOT = extensions/<short>/package.json）：
#   1. ln -sfn <源码目录> ~/.pi/agent/extensions/pi-<short>（globalExtDir，loader 扫描）
#   2. pi uninstall npm:@zhushanwen/pi-<short>（清 settings 条目 + node_modules 包）
#      pi uninstall 是 pi 原生命令，同时管 settings + node_modules，无需自己写清理逻辑。
#
# 为何 symlink 而非 pi install path：symlink 在 globalExtDir（loader 扫描早于 configuredPaths），
# pi list 不显示（pi list 只列 packages），但 loader 会发现并加载。pi-statusline 即此模式。
# loader 不读目录名——包身份来自目录内 package.json 的 pi.extensions 字段（pi 实装版 loader.js，语义不绑版本）。
#
# 恢复（pi-unlink）：rm symlink + pi install 重装 npm 版。
#
# 用法: ./pi-link.sh <package> [package2 ...]
#   <package> = 短名 (subagent-workflow) / pi-前缀 / @zhushanwen/pi-全名
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dev-link-lib.sh
source "$SCRIPT_DIR/dev-link-lib.sh"

[ $# -lt 1 ] && { echo "用法: $0 <package> [package2 ...]"; exit 1; }
mkdir -p "$PI_EXT_DIR"

for input in "$@"; do
	short=$(dl_resolve_short_name "$input")

	# 查映射（源码目录 + npm 包名 + 是否真 extension，均来自 package.json）
	if ! dl_lookup "$short"; then
		red "✗ 找不到 extension: ${short}（extensions/${short} 或 extensions/shared/${short} 需有 package.json）"
		continue
	fi
	if [ "$DL_IS_EXT" != "yes" ]; then
		yellow "↷ 跳过 ${short}：是库包（shared lib，${DL_NPM_NAME}），不是 pi extension"
		continue
	fi

	# 1. symlink 本地源码到 globalExtDir
	link_name="$PI_EXT_DIR/pi-$short"
	if ln -sfn "$DL_SRC_DIR" "$link_name" 2>/dev/null; then
		green "✓ symlink: ${short} → ${link_name}"
	else
		red "✗ symlink 失败: ${link_name}"
		continue
	fi

	# 2. pi uninstall 清 npm 版（settings 条目 + node_modules 包，避免与 symlink 两源并存）
	#    pi uninstall 即使 settings 无条目（如旧 pi-link 清过）也会删 node_modules 包；
	#    exit code 不可靠（无条目时非 0），故不依赖，目标是确保 node_modules 无 npm 版。
	pi uninstall "npm:$DL_NPM_NAME" >/dev/null 2>&1 || true
	echo "  · pi uninstall 清 npm 版 ${DL_NPM_NAME}（settings + node_modules，如存在）"

	# 3. symlink extension 的 skills 到 pi skill 目录（绕过 globalExtDir 不读 pi.skills）
	skill_count=$(dl_link_skills "$DL_SRC_DIR")
	if [ "$skill_count" != "0" ]; then
		echo "  · symlink ${skill_count} 个 skill 到 $PI_SKILL_DIR"
	fi
done

echo ""
green "✓ pi 模式 link 完成"
echo "  生效：新建 pi session（当前 session 已加载旧版）"
echo "  注：pi list 只列 packages，不显示 globalExtDir symlink——loader 仍会加载（pi-statusline 同模式）"
echo "  恢复：./pi-unlink.sh $*（rm symlink + pi install 重装，需联网）"
