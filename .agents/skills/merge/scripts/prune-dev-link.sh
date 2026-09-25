#!/usr/bin/env bash
# prune-dev-link.sh — merge 阶段 1.5：跨 worktree 清理指向即将删除的 feature worktree 的 dev-link
#
# 做什么：扫描所有 worktree 的 .env.dev-extensions，移除 TAIJI_EXTENSION_PATHS 中指向
#         feature worktree 的路径条目（dev-link 写入的环境变量路径，不是 symlink）。
#
# 为什么要清理：dev-link 让 pi 通过 TAIJI_EXTENSION_PATHS 加载本地源码 extension。
#   标准用法下 link 指向当前 worktree 自己的 extensions/，删 worktree 时 .env.dev-extensions
#   随之删除。但存在跨 worktree 残留场景（用户在 main worktree link 指向 feature worktree
#   测改动、手动编辑/复制配置）——这些残留 link 在 feature worktree 删除后指向不存在的路径，
#   下次 pnpm dev 时 pi 加载报 ENOENT。本脚本在删 worktree 前兜底清理所有这类残留。
#
# 用法: bash prune-dev-link.sh <feature-worktree-path>
#   feature-worktree-path: feature worktree 绝对路径或相对路径（脚本会规范化）
#
# 退出码：0 = 成功（无论是否清理到东西）；2 = 定位/参数错误
set -euo pipefail

ENV_FILE_NAME=".env.dev-extensions"
ENV_VAR="TAIJI_EXTENSION_PATHS"

# ── 颜色输出 ────────────────────────────────────────────
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }

# ── 参数与 workspace root 定位 ──────────────────────────
FEATURE_WT_RAW="${1:-}"
if [ -z "$FEATURE_WT_RAW" ]; then
	echo "用法: $0 <feature-worktree-path>"
	echo "  清理所有 worktree 的 $ENV_FILE_NAME 中指向该 worktree 的 dev-link 路径"
	exit 2
fi

if [ ! -d "$FEATURE_WT_RAW" ]; then
	red "✗ feature worktree 不存在: $FEATURE_WT_RAW"
	exit 2
fi

# 规范化为绝对路径（pwd -P 解析 symlink）
FEATURE_WT="$(cd "$FEATURE_WT_RAW" && pwd -P)"

# 向上查找 .bare 定位 workspace root
dir="$FEATURE_WT"
WS_ROOT=""
while [ "$dir" != "/" ]; do
	if [ -d "$dir/.bare" ]; then WS_ROOT="$dir"; break; fi
	dir="$(dirname "$dir")"
done
if [ -z "$WS_ROOT" ]; then
	red "✗ 无法定位 workspace root（从 $FEATURE_WT 向上未找到 .bare/）"
	exit 2
fi

BARE="$WS_ROOT/.bare"

echo ""
cyan "═══ Dev-Link 跨 worktree 清理 ═══"
echo "  目标 worktree: $FEATURE_WT"
echo ""

# ── 收集所有 worktree 路径 ──────────────────────────────
mapfile -t WT_LIST < <(git --git-dir="$BARE" worktree list --porcelain | awk '/^worktree /{print $2}')

if [ ${#WT_LIST[@]} -eq 0 ]; then
	red "✗ 未列出任何 worktree（git --git-dir=$BARE 失败？）"
	exit 2
fi

# ── 遍历每个 worktree 的 .env.dev-extensions ────────────
cleaned_files=0
total_removed=0
scanned_files=0

for wt in "${WT_LIST[@]}"; do
	envf="$wt/$ENV_FILE_NAME"
	[ -f "$envf" ] || continue
	scanned_files=$((scanned_files + 1))

	# node 检查并清理（startsWith 精确匹配，避免 /feat-xxx 误伤 /feat-xxx-suffix）
	# 输出 JSON：{"changed":bool,"removed":["path",...]}
	RESULT=$(ENV_FILE="$envf" FEATURE_WT="$FEATURE_WT" ENV_VAR="$ENV_VAR" node -e '
		const fs = require("fs");
		const f = process.env.ENV_FILE;
		const fw = process.env.FEATURE_WT + "/"; // 末尾斜杠确保是路径分隔，不误匹配同前缀目录名
		const prefix = process.env.ENV_VAR + "=";
		const lines = fs.readFileSync(f, "utf-8").split("\n");
		const removed = [];
		const updated = lines.map(line => {
			if (!line.startsWith(prefix)) return line;
			const val = line.slice(prefix.length);
			const kept = [];
			for (const p of val.split(":")) {
				if (!p) continue;
				// p 形如 /abs/feat-xxx/extensions/universal/goal；fw 形如 /abs/feat-xxx/
				if (p.startsWith(fw) || p === process.env.FEATURE_WT) {
					removed.push(p);
				} else {
					kept.push(p);
				}
			}
			return kept.length ? prefix + kept.join(":") : null; // null = 删整行
		}).filter(l => l !== null);

		if (removed.length === 0) {
			process.stdout.write(JSON.stringify({ changed: false }));
		} else {
			// 保留末尾换行，去掉多余空行
			const content = updated.join("\n").replace(/\n+$/, "") + "\n";
			fs.writeFileSync(f, content);
			process.stdout.write(JSON.stringify({ changed: true, removed }));
		}
	')

	if echo "$RESULT" | grep -q '"changed":true'; then
		cleaned_files=$((cleaned_files + 1))
		removed_count=$(echo "$RESULT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).removed.length')
		total_removed=$((total_removed + removed_count))
		echo "✓ 清理: ${envf}（移除 ${removed_count} 个 link）"
		echo "$RESULT" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8")).removed.forEach(p=>console.log("    - "+p))'
	fi
done

# ── 汇总 ───────────────────────────────────────────────
echo ""
if [ "$total_removed" -gt 0 ]; then
	green "✓ Dev-link 清理完成：扫描 ${scanned_files} 个 ${ENV_FILE_NAME}，清理 ${cleaned_files} 个文件，移除 ${total_removed} 个 link"
	echo "  被清理的 worktree 下次 pnpm dev 不再加载这些本地 extension（回退到 npm 版或不加载）"
else
	green "✓ 无残留 link（扫描 ${scanned_files} 个 ${ENV_FILE_NAME}，无条目指向 ${FEATURE_WT}）"
fi
echo ""
