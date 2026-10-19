#!/bin/bash
# pr-merge.sh — 薄壳：实现在仓库 scripts/merge/pr-merge.mjs（经 main worktree 调起，
# 恒取 main 分支最新版，不受当前 feature worktree 分支新旧影响）。
# 用法与功能契约不变: pr-merge.sh <pr-number>；退出码 0 = 成功，1 = 失败。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/../_lib/workspace.sh"
# 未命中时回退 WS_ROOT="/"，与旧内联循环的失败终态一致（走下方 mjs 存在性检查报错退出）
WS_ROOT="$(find_workspace_root "$SCRIPT_DIR" || echo "/")"

if [[ ! -f "$WS_ROOT/main/scripts/merge/pr-merge.mjs" ]]; then
    echo "Error: main worktree 缺少 scripts/merge/pr-merge.mjs（实现未落到 main？）" >&2
    echo "  确认 main worktree 已合入 merge 管线 Node 实现后重试" >&2
    exit 1
fi

exec node "$WS_ROOT/main/scripts/merge/pr-merge.mjs" "$@"
