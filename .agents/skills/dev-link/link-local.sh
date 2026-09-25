#!/usr/bin/env bash
# link-local.sh — 添加 extension 到 TAIJI_EXTENSION_PATHS（本地源码，live edit）
# 用法: ./link-local.sh <package> [package2 ...]
#   <package> = 短名 (cw-tool) / pi-前缀 (pi-cw-tool) / npm全名 (@zhushanwen/pi-cw-tool)
#
# 幂等安全：重复添加不会产生重复条目，已是目标状态时直接跳过。
# 写入项目根目录的 .env.dev-extensions 文件（已 gitignore）。
#
# 映射查 dev-link-lib.sh（SSOT = extensions/<short>/package.json）：源码目录、npm 包名、
# 是否真 extension 均来自 package.json 事实，不按命名约定推导。库包（无 pi.extensions，
# 如 llm-shared）自动跳过。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=dev-link-lib.sh
source "$SCRIPT_DIR/dev-link-lib.sh"

ENV_FILE_NAME=".env.dev-extensions"
ENV_VAR="TAIJI_EXTENSION_PATHS"

# ── 定位项目根目录 ──────────────────────────────────────
# 用 git rev-parse 定位 worktree 根（多 worktree 友好）
dl_git_root || { red "✗ 不在 git 仓库中"; exit 2; }
ENV_FILE="$DL_GIT_ROOT/$ENV_FILE_NAME"

# ── 主逻辑 ──────────────────────────────────────────────
main() {
	if [ $# -lt 1 ]; then
		echo "用法: $0 <package> [package2 ...]"
		echo "  <package> = 短名 (cw-tool) / pi-前缀 (pi-cw-tool) / npm全名 (@zhushanwen/pi-cw-tool)"
		echo "  可一次 link 多个: $0 goal todo ask-user"
		exit 1
	fi

	# 创建 .env.dev-extensions（如不存在）
	if [ ! -f "$ENV_FILE" ]; then
		echo "# 由 dev-link skill 生成，管理 TAIJI_EXTENSION_PATHS（本地 extension 源码路径）" > "$ENV_FILE"
		echo "# 不进 git（已覆盖在 .gitignore 的 .env.* 规则下）" >> "$ENV_FILE"
		echo "# 用法: set -a && source $ENV_FILE_NAME && set +a && pnpm dev" >> "$ENV_FILE"
		green "✓ 创建 $ENV_FILE_NAME"
	fi

	local added=0
	local skipped=0

	for input in "$@"; do
		local short
		short=$(dl_resolve_short_name "$input")

		# 查映射（源码目录 + npm 包名 + 是否真 extension，均来自 package.json）
		if ! dl_lookup "$short"; then
			red "✗ 找不到 extension: ${short}（extensions/${short} 或 extensions/shared/${short} 需有 package.json）"
			((skipped++)) || true
			continue
		fi

		# 库包检查（package.json 无 pi.extensions → 跳过）
		if [ "$DL_IS_EXT" != "yes" ]; then
			yellow "↷ 跳过 ${short}：是库包（shared lib，${DL_NPM_NAME}），不是 pi extension，不进 ${ENV_VAR}"
			((skipped++)) || true
			continue
		fi

		local ext_dir="$DL_SRC_DIR"

		# 检查是否已在 ENV_FILE 中
		if grep -qF "$ext_dir" "$ENV_FILE" 2>/dev/null; then
			echo "  · ${short} 已 link，跳过"
			((skipped++)) || true
			continue
		fi

		# 追加到 TAIJI_EXTENSION_PATHS
		# 读取当前值（从 ENV_FILE 解析，格式：TAIJI_EXTENSION_PATHS=path1:path2）
		local current=""
		if grep -q "^${ENV_VAR}=" "$ENV_FILE" 2>/dev/null; then
			current=$(grep "^${ENV_VAR}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
		fi

		if [ -z "$current" ]; then
			# 新行
			echo "${ENV_VAR}=${ext_dir}" >> "$ENV_FILE"
		else
			# 追加到现有值（用 node 重写整个 ENV_FILE，避免 sed 转义问题）
			ENV_FILE="$ENV_FILE" ENV_VAR="$ENV_VAR" NEW_PATH="$ext_dir" node -e "
				const fs = require('fs');
				const lines = fs.readFileSync(process.env.ENV_FILE, 'utf-8').split('\n');
				const updated = lines.map(line => {
					if (line.startsWith(process.env.ENV_VAR + '=')) {
						return line + ':' + process.env.NEW_PATH;
					}
					return line;
				});
				fs.writeFileSync(process.env.ENV_FILE, updated.join('\n'));
			"
		fi

		green "✓ link: ${short} → ${ext_dir}"
		((added++)) || true
	done

	echo ""
	if [ "$added" -gt 0 ]; then
		green "✓ 完成: 新增 $added 个 link，跳过 $skipped 个"
		echo ""
		echo "  启动带 link 的 dev（source 环境变量后启动）:"
		echo "    set -a && source $ENV_FILE_NAME && set +a && pnpm dev"
		echo ""
		echo "  改源码后在 taiji 中新建 session 即生效（无需重启）"
	else
		echo "  无新增 link（$skipped 个跳过）"
	fi
}

main "$@"
