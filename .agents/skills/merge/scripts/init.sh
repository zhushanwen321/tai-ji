#!/bin/bash
# init.sh — taiji merge 流程阶段 0：环境初始化
#
# 做什么：workspace 检测、PR 查找、打印流程头信息
# 用法: bash .agents/skills/merge/scripts/init.sh <worktree-dir>
#   worktree-dir: feature worktree 目录名（basename），如 feat-extensions-widget
#
# 退出码：0 = 成功，1 = 失败

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

WORKTREE_DIR_NAME="${1:?Usage: init.sh <worktree-dir-name>}"

# 项目常量
GH_REPO="zhushanwen321/tai-ji"

# workspace 检测
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WS_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd -P)"

if [[ ! -d "$WS_ROOT/.bare" ]]; then
    echo -e "${RED}Error: 未找到 workspace root（向上查找 .bare/ 失败）${NC}"
    echo "  当前推导的 WS_ROOT: $WS_ROOT"
    exit 1
fi

WORKTREE_DIR="$WS_ROOT/$WORKTREE_DIR_NAME"
MAIN_WT="$WS_ROOT/main"

if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo -e "${RED}Error: worktree 目录不存在: $WORKTREE_DIR${NC}"
    echo "  workspace 下的目录:"
    ls -1 "$WS_ROOT" | grep -v '^\.' | head -20
    exit 1
fi

if [[ ! -d "$MAIN_WT" ]]; then
    echo -e "${RED}Error: main worktree 不存在: $MAIN_WT${NC}"
    echo "  创建: cd $WS_ROOT && git-cwt main"
    exit 1
fi

# 防御：阶段 4 的版本 bump 需在 main 分支上执行，pr-merge.sh 的 sync 会强制切到 main，
# 但提前暴露问题比阶段 4 才发现更省事
MAIN_BRANCH=$(git -C "$MAIN_WT" branch --show-current 2>/dev/null || echo "")
if [[ "$MAIN_BRANCH" != "main" ]]; then
    echo -e "${YELLOW}⚠️  main worktree 当前 checkout 在 '$MAIN_BRANCH'（非 main 分支）${NC}"
    echo "  阶段 4 的版本 bump 需要在 main 分支上执行"
    echo "  修复: git -C $MAIN_WT checkout main"
fi

# 分支名
BRANCH_NAME=$(git -C "$WORKTREE_DIR" branch --show-current)
if [[ -z "$BRANCH_NAME" ]]; then
    echo -e "${RED}Error: 无法获取 $WORKTREE_DIR 的当前分支${NC}"
    exit 1
fi

# 查找 PR
command -v gh >/dev/null 2>&1 || { echo -e "${RED}Error: gh CLI 未安装${NC}"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo -e "${RED}Error: gh CLI 未登录${NC}"; exit 1; }

PR_NUMBER=$(gh pr list --repo "$GH_REPO" --state all --head "$BRANCH_NAME" --json number --jq '.[0].number' 2>/dev/null || echo "")
if [[ -z "$PR_NUMBER" ]]; then
    echo -e "${RED}Error: 找不到分支 '$BRANCH_NAME' 对应的 PR${NC}"
    echo "  检查: gh pr list --repo $GH_REPO --state all --head $BRANCH_NAME"
    exit 1
fi

PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
PR_TITLE=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json title --jq '.title' 2>/dev/null || echo "")
CURRENT_VERSION=$(node -p "require('$MAIN_WT/package.json').version" 2>/dev/null || echo "unknown")

echo "══════════════════════════════════════════════════"
echo -e "${BOLD}taiji 合并发布流程${NC}"
echo "  workspace:  $WS_ROOT"
echo "  worktree:   $WORKTREE_DIR_NAME"
echo "  分支:       $BRANCH_NAME"
echo "  main worktree: $MAIN_WT"
echo "  repo:       $GH_REPO"
echo "  PR:         #$PR_NUMBER — $PR_TITLE"
echo "  PR 状态:    $PR_STATE"
echo "  当前版本:   v$CURRENT_VERSION"
echo "══════════════════════════════════════════════════"
echo ""
echo -e "${GREEN}✅ 阶段 0 完成。后续命令中用到：${NC}"
echo "  WS_ROOT=$WS_ROOT"
echo "  BRANCH_NAME=$BRANCH_NAME"
echo "  PR_NUMBER=$PR_NUMBER"
echo ""
if [[ "$PR_STATE" != "OPEN" && "$PR_STATE" != "MERGED" ]]; then
    echo -e "${RED}⚠️  PR 状态为 $PR_STATE，阶段 2 可能无法处理${NC}"
fi
