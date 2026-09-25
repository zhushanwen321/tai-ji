#!/usr/bin/env bash
# link-npm.sh — 从 TAIJI_EXTENSION_PATHS 移除 extension（恢复走 npm 或不加载）
# 用法:
#   ./link-npm.sh <package> [package2 ...]   # 移除指定包的 link
#   ./link-npm.sh --all                       # 移除所有 link（清空 .env.dev-extensions）
#
#   <package> = 短名 (cw-tool) / pi-前缀 (pi-cw-tool) / npm全名 (@zhushanwen/pi-cw-tool)
#
# 幂等安全：link 不存在时直接跳过。
# 路径匹配用映射的完整源码目录（dev-link-lib.sh 查表），不用 "extensions/<short>" 子串
# —— 避免前缀同名包（如 goal vs goal-extra）误删。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dev-link-lib.sh
source "$SCRIPT_DIR/dev-link-lib.sh"

ENV_FILE_NAME=".env.dev-extensions"
ENV_VAR="TAIJI_EXTENSION_PATHS"

# ── 定位项目根目录 ──────────────────────────────────────
dl_git_root || { red "✗ 不在 git 仓库中"; exit 2; }
ENV_FILE="$DL_GIT_ROOT/$ENV_FILE_NAME"

# ── 从 TAIJI_EXTENSION_PATHS 值中移除路径（node 处理，避免 sed 转义问题）──
remove_path_from_value() {
	local value="$1"
	local path_to_remove="$2"
	# RM_PATH 必须在 node 命令前面（bash 环境变量前缀语法），否则被当作 argv
	RM_PATH="$path_to_remove" node -e "
		const input = require('fs').readFileSync(0, 'utf-8').trim();
		const paths = input ? input.split(':') : [];
		const filtered = paths.filter(p => p !== process.env.RM_PATH);
		process.stdout.write(filtered.join(':'));
	" <<< "$value"
}

# ── 主逻辑 ──────────────────────────────────────────────
main() {
	if [ $# -lt 1 ]; then
		echo "用法: $0 <package> [package2 ...] | --all"
		echo "  移除指定包的 link，或用 --all 清除所有 link"
		exit 1
	fi

	if [ ! -f "$ENV_FILE" ]; then
		green "✓ $ENV_FILE_NAME 不存在，无需清理"
		exit 0
	fi

	# --all 模式：清空整个 ENV_FILE
	if [ "${1:-}" == "--all" ]; then
		echo "==> 清除所有 extension link"
		rm -f "$ENV_FILE"
		green "✓ 已删除 ${ENV_FILE_NAME}（所有 link 已清除）"
		echo "  下次 pnpm dev 不再加载本地 extension（恢复走 npm 或不加载）"
		exit 0
	fi

	local removed=0
	local not_found=0

	# 读取当前 TAIJI_EXTENSION_PATHS 值
	local current=""
	if grep -q "^${ENV_VAR}=" "$ENV_FILE" 2>/dev/null; then
		current=$(grep "^${ENV_VAR}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
	fi

	if [ -z "$current" ]; then
		green "✓ $ENV_VAR 为空或不存在，无需清理"
		exit 0
	fi

	local new_value="$current"

	for input in "$@"; do
		local short
		short=$(dl_resolve_short_name "$input")

		# 精确匹配完整源码目录路径；查不到映射时（外部包等）fallback 旧约定子串
		local pattern
		if dl_lookup "$short"; then
			pattern="$DL_SRC_DIR"
		else
			pattern="extensions/$short"
		fi

		if echo "$new_value" | grep -qF "$pattern"; then
			new_value=$(remove_path_from_value "$new_value" "$pattern")
			green "✓ unlink: ${short}（匹配 ${pattern}）"
			((removed++)) || true
		else
			echo "  · ${short} 未 link，跳过"
			((not_found++)) || true
		fi
	done

	# 写回 ENV_FILE（用 node 处理，避免 sed 跨平台 + 转义问题）
	if [ -z "$new_value" ]; then
		# 值为空，删除整行（避免空 TAIJI_EXTENSION_PATHS= 覆盖）
		ENV_FILE="$ENV_FILE" ENV_VAR="$ENV_VAR" node -e "
			const fs = require('fs');
			const lines = fs.readFileSync(process.env.ENV_FILE, 'utf-8').split('\n');
			const filtered = lines.filter(l => !l.startsWith(process.env.ENV_VAR + '='));
			fs.writeFileSync(process.env.ENV_FILE, filtered.join('\n'));
		"
		green "✓ ${ENV_VAR} 已清空（所有 link 移除）"
	else
		ENV_FILE="$ENV_FILE" ENV_VAR="$ENV_VAR" NEW_VALUE="$new_value" node -e "
			const fs = require('fs');
			const lines = fs.readFileSync(process.env.ENV_FILE, 'utf-8').split('\n');
			const updated = lines.map(line => {
				if (line.startsWith(process.env.ENV_VAR + '=')) {
					return process.env.ENV_VAR + '=' + process.env.NEW_VALUE;
				}
				return line;
			});
			fs.writeFileSync(process.env.ENV_FILE, updated.join('\n'));
		"
		local remaining
		remaining=$(echo "$new_value" | tr ':' '\n' | grep -c .)
		green "✓ 更新 ${ENV_VAR}（剩余 ${remaining} 个 link）"
	fi

	echo ""
	if [ "$removed" -gt 0 ]; then
		echo "  移除 $removed 个，未找到 $not_found 个"
		echo "  重启 dev 生效（或新建 session，运行中的 session 仍用旧 link）"
	fi
}

main "$@"
