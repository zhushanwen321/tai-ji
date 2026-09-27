#!/bin/bash
# 清理 git worktree：检查合并状态 → 同步其他 worktree → 删除目标 worktree
# Usage: remove-worktree.sh <branch-name> [--force] [--skip-sync]
#   --force: 跳过已合并检查，并强制删除（含未提交/未跟踪内容，删除前会列出将销毁的清单）
#   --skip-sync: 跳过同步其他 worktree
# Example: remove-worktree.sh feat/new-feature
#          remove-worktree.sh feat/old-feature --force
#          remove-worktree.sh feat/experiment --force --skip-sync
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/../_lib/workspace.sh"

BRANCH_NAME="${1:?Usage: remove-worktree.sh <branch-name> [--force] [--skip-sync]}"
shift || true
FORCE=false
SKIP_SYNC=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force)      FORCE=true; shift ;;
        --skip-sync)  SKIP_SYNC=true; shift ;;
        *)            echo "Unknown option: $1"; exit 1 ;;
    esac
done

DIR_NAME="${BRANCH_NAME//\//-}"

WORKSPACE_ROOT=$(find_workspace_root "$(pwd)") || {
    echo "Error: 未找到 workspace。当前目录及其父目录中没有 .bare/。"
    exit 1
}
echo "Workspace: $WORKSPACE_ROOT"

# 立即切到 workspace root，避免当前目录后续被删除
cd "$WORKSPACE_ROOT"

WT_PATH="$WORKSPACE_ROOT/$DIR_NAME"

# 检查 worktree 是否存在
if [[ ! -d "$WT_PATH" ]]; then
    echo "Error: worktree 目录 '$DIR_NAME' 不存在。"
    echo ""
    echo "当前 worktree 列表:"
    git -C .bare worktree list 2>/dev/null || true
    exit 1
fi

# --- 合并状态检查（非 force 模式） ---
if [[ "$FORCE" != "true" ]]; then
    echo ""
    echo "=== 检查合并状态 ==="

    # 先 fetch 获取最新远程状态
    git -C .bare fetch github --prune 2>&1 | tail -1

    # 检查分支是否已合并到 github/main
    MAIN_BRANCH=$(git -C .bare remote show github 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}') || true
    MAIN_BRANCH="${MAIN_BRANCH:-main}"

    if git -C .bare branch --merged "github/$MAIN_BRANCH" 2>/dev/null | grep -q "$BRANCH_NAME"; then
        echo "✓ 分支 '$BRANCH_NAME' 已合并到 github/$MAIN_BRANCH"
    else
        echo "✗ 分支 '$BRANCH_NAME' 尚未合并到 github/$MAIN_BRANCH"
        echo ""
        # 显示未合并的 commits
        echo "未合并的 commits:"
        git -C .bare log --oneline "github/$MAIN_BRANCH..$BRANCH_NAME" 2>/dev/null | head -10 || echo "  (无法获取 commit 历史)"
        echo ""
        echo "Error: 分支未合并，拒绝删除。使用 --force 强制清理。"
        exit 1
    fi
else
    echo ""
    echo "=== 强制模式（跳过合并检查）==="
fi

# 检查未提交变更
DIRTY=$(cd "$WT_PATH" && git status --short 2>/dev/null) || true
if [[ -n "$DIRTY" ]]; then
    if [[ "$FORCE" != "true" ]]; then
        echo ""
        echo "Error: worktree 有未提交变更:"
        echo "$DIRTY"
        echo "使用 --force 强制删除。"
        exit 1
    else
        echo ""
        echo "Warning: worktree 有未提交变更（--force 模式下继续删除）:"
        echo "$DIRTY" | head -10
    fi
fi

# --- 同步其他 worktree ---
SYNCED=0
CONFLICTS=0
CONFLICT_WTS=""

if [[ "$SKIP_SYNC" != "true" ]]; then
    echo ""
    echo "=== 同步其他 worktree 到 github/main ==="

    MAIN_BRANCH=$(git -C .bare remote show github 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}') || true
    MAIN_BRANCH="${MAIN_BRANCH:-main}"

    for _wt_entry in */; do
        _wt_name="${_wt_entry%/}"
        [[ "$_wt_name" == ".bare" ]] && continue
        [[ "$_wt_name" == "$DIR_NAME" ]] && continue
        [[ "$_wt_name" == "node_modules" ]] && continue
        [[ "$_wt_name" =~ ^\. ]] && continue  # 跳过隐藏目录

        _branch=""
        _branch=$(cd "$WORKSPACE_ROOT/$_wt_name" 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null) || _branch=""

        # 跳过 main/master 和空分支
        [[ "$_branch" == "main" || "$_branch" == "master" ]] && continue
        [[ -z "$_branch" ]] && continue

        echo "同步 $_wt_name ($_branch)..."

        cd "$WORKSPACE_ROOT/$_wt_name"
        git fetch github "$MAIN_BRANCH" 2>&1 | tail -1

        if git merge --no-ff "github/$MAIN_BRANCH"; then
            echo "  OK: $_wt_name 已同步到最新 $MAIN_BRANCH"
            SYNCED=$((SYNCED + 1))
        else
            echo "  CONFLICT: $_wt_name merge 冲突:"
            git diff --name-only --diff-filter=U 2>/dev/null | sed 's/^/    - /'
            CONFLICTS=$((CONFLICTS + 1))
            CONFLICT_WTS="${CONFLICT_WTS:+$CONFLICT_WTS }$_wt_name"
            # 不 abort — 保留冲突状态让 AI/用户来处理
        fi
        cd "$WORKSPACE_ROOT"
    done
else
    echo ""
    echo "跳过同步其他 worktree (--skip-sync)"
fi

# --- 远端分支卫生（已合并进 main 的陈年远端分支自动清理） ---
# 根因：web 端合并 / 非 PR 直推的分支无人删除，多轮发布循环后永久滞留。每次发布必经
# 本脚本 → 残留不过夜。判定 = 纯 git 祖先关系（已合并删除零损失）；失败语义 = 辅助
# 功能，单条失败记 warning 不阻断主流程（分级即错误处理契约）。
echo ""
echo "=== 远端分支卫生检查 ==="
# 段内自 fetch：force 模式跳过了开头的合并检查段（含 fetch），此处保证视图新鲜
git -C .bare fetch github --prune --quiet 2>/dev/null || true
# MAIN_BRANCH 段内自持（force / --skip-sync 组合下前置段落可能未定义，set -u 防线）
MAIN_BRANCH=$(git -C .bare remote show github 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}') || true
MAIN_BRANCH="${MAIN_BRANCH:-main}"
# 现行 dev 集成线动态识别 = 版本号最大的 dev 分支（dev-0.11.x 出现时无需改本脚本）
ACTIVE_DEV=$(git -C .bare for-each-ref --format='%(refname:short)' refs/remotes/github 2>/dev/null | grep -E 'github/dev-[0-9]+\.[0-9]+' | sort -V | tail -1) || ACTIVE_DEV=""
HYGIENE_SKIP="^(github/main|github/HEAD|github$"  # github 裸引用 = HEAD symref 实体，fetch 副产物，非分支
[[ -n "$ACTIVE_DEV" ]] && HYGIENE_SKIP="^(github/main|github/HEAD|github|${ACTIVE_DEV//./\\.})$"
GH_BRANCHES=$(git -C .bare for-each-ref --format='%(refname:short)' refs/remotes/github 2>/dev/null | grep -vE "$HYGIENE_SKIP" | grep -v 'github/dependabot/') || GH_BRANCHES=""
HYGIENE_DELETED=0
HYGIENE_KEPT=0
for _gb in $GH_BRANCHES; do
    _branch_name="${_gb#github/}"
    if git -C .bare merge-base --is-ancestor "$_gb" "github/$MAIN_BRANCH" 2>/dev/null; then
        if git -C .bare push github --delete "$_branch_name" >/dev/null 2>&1; then
            echo "  ✓ 已删除远端已合并分支: $_branch_name"
            HYGIENE_DELETED=$((HYGIENE_DELETED + 1))
        else
            echo "  Warning: 远端分支 $_branch_name 删除失败（不阻断，留待下次）"
        fi
    else
        _ahead=$(git -C .bare rev-list --count "github/$MAIN_BRANCH..$_gb" 2>/dev/null || echo '?')
        echo "  ⚠ 未合并远端分支需人工裁决: $_branch_name（领先 $MAIN_BRANCH ${_ahead} commit）"
        HYGIENE_KEPT=$((HYGIENE_KEPT + 1))
    fi
done
if [[ $HYGIENE_DELETED -gt 0 || $HYGIENE_KEPT -gt 0 ]]; then
    echo "  卫生结果: 自动删除 ${HYGIENE_DELETED} 个 / 需人工裁决 ${HYGIENE_KEPT} 个"
fi

# --- 删除目标 worktree（最后执行） ---
echo ""
echo "=== 清理 worktree $BRANCH_NAME ==="
# delete_branch 与 force 同步传递：--force 清理时本地分支一并删除（远程 delete-branch 后本地残留无意义）；
# 非 force 模式仅删 worktree、保留本地分支（与既有行为一致）
remove_worktree "$WORKSPACE_ROOT" "$BRANCH_NAME" "$FORCE" "$FORCE"

# --- 输出报告 ---
echo ""
echo "============================================"
echo "Remove worktree 完成!"
echo "  已删除: $BRANCH_NAME"
if [[ "$SKIP_SYNC" != "true" ]]; then
    echo "  已同步: $SYNCED 个 worktree"
    if [[ $CONFLICTS -gt 0 ]]; then
        echo "  冲突: $CONFLICTS 个 worktree（需处理）:"
        for wt in $CONFLICT_WTS; do
            echo "    - $wt"
        done
        echo ""
        echo "  冲突处理: 在冲突 worktree 中执行 git diff --name-only --diff-filter=U 查看冲突文件"
        echo "  处理完成后: git add . && git commit"
        echo "  放弃同步: git merge --abort"
    else
        echo "  冲突: 0"
    fi
fi
echo "============================================"
