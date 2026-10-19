#!/bin/bash
# wait-for-ci.sh — 薄壳：实现在仓库 scripts/merge/wait-for-ci.mjs（经 main worktree
# 调起，恒取 main 分支最新版）。用法与功能契约不变:
#   wait-for-ci.sh <commit-sha> [--timeout 600] [--workflow <name>] [--verify-release <tag>] [--repo <owner/repo>]
# 新增：省略 <commit-sha> 时自动读取 merge 状态文件（pr-merge 写入的 headSha）。
# 退出码：0 = 通过/无 CI 放行，1 = 失败，2 = 超时（AI 应询问用户）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WS_ROOT="$SCRIPT_DIR"
while [[ "$WS_ROOT" != "/" && ! -d "$WS_ROOT/.bare" ]]; do
    WS_ROOT="$(dirname "$WS_ROOT")"
done

if [[ ! -f "$WS_ROOT/main/scripts/merge/wait-for-ci.mjs" ]]; then
    echo "Error: main worktree 缺少 scripts/merge/wait-for-ci.mjs（实现未落到 main？）" >&2
    echo "  确认 main worktree 已合入 merge 管线 Node 实现后重试" >&2
    exit 1
fi

exec node "$WS_ROOT/main/scripts/merge/wait-for-ci.mjs" "$@"
