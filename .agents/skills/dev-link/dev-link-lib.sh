#!/usr/bin/env bash
# dev-link-lib.sh — dev-link skill 的共享库（pi 模式 + taiji 模式脚本统一 source）
#
# 核心设计：短名 → 事实的映射从本项目 extensions/ 目录扫描构建（SSOT = 各包的 package.json）：
#   extensions/<short>/package.json
#     ├─ name           → npm 包名（如 @zhushanwen/pi-subagent-workflow）
#     ├─ pi.extensions  → 是否真 pi extension（库包如 llm-shared 没有该字段）
#     ├─ 目录本身        → 源码目录（symlink target / TAIJI_EXTENSION_PATHS 条目）
#     └─ deprecated     → 已废弃包标记（字符串说明），查表时打 ⚠ 警告不阻断
#
# npm 包的安装/卸载交给 pi 原生命令（pi install / pi uninstall，同时管 settings 条目 + node_modules 包），
# 本库不自己写 settings/node_modules 操作。
#
# 兼容性：macOS 自带 bash 3.2（无关联数组），避免使用 bash 4+ 特性。

SCOPE="@zhushanwen"
PI_EXT_DIR="$HOME/.pi/agent/extensions"
PI_SKILL_DIR="$HOME/.pi/agent/skills"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# ── 定位 worktree 根（多 worktree 友好）──────────────────────────────
# 失败不退出（unlink 等场景不依赖 git），由调用方决定是否需要。
dl_git_root() {
	DL_GIT_ROOT="${DL_GIT_ROOT:-}"
	if [ -z "$DL_GIT_ROOT" ]; then
		DL_GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
	fi
	[ -n "$DL_GIT_ROOT" ]
}

# ── 包名解析：三种输入格式 → 短名 ────────────────────────────────────
#   @zhushanwen/pi-subagent-workflow → subagent-workflow
#   pi-subagent-workflow             → subagent-workflow
#   subagent-workflow                → subagent-workflow
dl_resolve_short_name() {
	local input="$1"
	if [[ "$input" == "$SCOPE/"* ]]; then
		echo "${input#$SCOPE/pi-}"
	elif [[ "$input" == pi-* ]]; then
		echo "${input#pi-}"
	else
		echo "$input"
	fi
}

# ── 构建映射：一次 node 扫描 extensions/{taiji,universal}/ + extensions/shared/ ──
# 输出行格式：short|npm_name|src_dir|is_extension|deprecated
# （is_extension = package.json 有 pi.extensions；deprecated = package.json 的 deprecated 字段值，
#   是字符串废弃说明而非布尔，空串表示未废弃）
dl_build_mapping() {
	dl_git_root || return 1
	local base="$DL_GIT_ROOT/extensions"
	node -e '
		const fs = require("fs"), path = require("path");
		const base = process.argv[1];
		const out = [];
		for (const sub of ["taiji/", "universal/", "shared/"]) {
			const dir = path.join(base, sub);
			if (!fs.existsSync(dir)) continue;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const d = path.join(dir, entry.name);
				const pkgPath = path.join(d, "package.json");
				if (!fs.existsSync(pkgPath)) continue;
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
				const isExt = !!(pkg.pi && pkg.pi.extensions);
				const dep = pkg.deprecated ? String(pkg.deprecated).replace(/[|\n]/g, " ") : "";
				out.push([entry.name, pkg.name || "", d, isExt ? "yes" : "no", dep].join("|"));
			}
		}
		process.stdout.write(out.join("\n"));
	' "$base"
}

# ── 查表：short → 事实（结果存 DL_* 全局变量）────────────────────────
# 映射懒构建并缓存到 DL_MAPPING（避免多次扫描）。
dl_lookup() {
	local short="$1"
	if [ -z "${DL_MAPPING:-}" ]; then
		DL_MAPPING="$(dl_build_mapping || true)"
	fi
	local line
	line=$(printf '%s\n' "$DL_MAPPING" | grep "^${short}|" | head -1)
	[ -n "$line" ] || return 1
	DL_SHORT="${line%%|*}"
	DL_NPM_NAME="$(echo "$line" | cut -d'|' -f2)"
	DL_SRC_DIR="$(echo "$line" | cut -d'|' -f3)"
	DL_IS_EXT="$(echo "$line" | cut -d'|' -f4)"
	DL_DEPRECATED="$(echo "$line" | cut -d'|' -f5)"
	# 废弃包警告：dl_lookup 是四个脚本共用的公共解析路径，在此统一拦截。
	# deprecated 字段值是字符串废弃说明（非布尔），非空即警告；只提示不阻断
	# （unlink 等场景仍需正常查表）。link 验证完应卸载废弃包，避免与替代包双重生效。
	if [ -n "$DL_DEPRECATED" ]; then
		yellow "⚠ ${DL_SHORT}（${DL_NPM_NAME}）已在 package.json 标记废弃：${DL_DEPRECATED}"
		yellow "  废弃包残留安装会与替代包重复生效（unified-hooks 与 base-tool-enhance 会双重拦截 bash），验证完请尽快 unlink 并卸载"
	fi
	return 0
}

# ── extension skills symlink 到 pi skill 目录（绕过 globalExtDir 不读 pi.skills）──
# pi-link 时把 extension/skills/<skill> symlink 到 PI_SKILL_DIR/<skill>，
# pi-unlink 时删（检查 symlink 存在）。stdout: 操作数。
dl_link_skills() {
	local src_dir="$1"
	local skills_root="$src_dir/skills"
	[ -d "$skills_root" ] || { echo "0"; return 0; }
	local count=0
	for skill_dir in "$skills_root"/*/; do
		[ -d "$skill_dir" ] || continue
		local skill_name; skill_name=$(basename "$skill_dir")
		ln -sfn "${skill_dir%/}" "$PI_SKILL_DIR/$skill_name"
		count=$((count + 1))
	done
	echo "$count"
}

dl_unlink_skills() {
	local src_dir="$1"
	local skills_root="$src_dir/skills"
	[ -d "$skills_root" ] || { echo "0"; return 0; }
	local count=0
	for skill_dir in "$skills_root"/*/; do
		[ -d "$skill_dir" ] || continue
		local skill_name; skill_name=$(basename "$skill_dir")
		local link="$PI_SKILL_DIR/$skill_name"
		if [ -L "$link" ]; then
			rm "$link"
			count=$((count + 1))
		fi
	done
	echo "$count"
}
