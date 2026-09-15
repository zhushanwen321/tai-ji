#!/bin/bash
# pr-merge.sh — taiji merge 流程阶段 2：PR CI 等待 + 合并 + sync 本地 main
#
# 做什么：
#   1. 等待 PR CI 通过（最多 10 分钟）
#   2. gh pr merge --merge --delete-branch（merge commit，绝不 squash）
#   3. sync 本地 main（fetch + reset --hard github/main）
#
# 前置：阶段 0（init.sh）已执行，PR 处于 OPEN 状态
# 用法: bash .agents/skills/merge/scripts/pr-merge.sh <branch-name> <pr-number>
# 退出码：0 = 成功，1 = 失败

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

BRANCH_NAME="${1:?Usage: pr-merge.sh <branch-name> <pr-number>}"
PR_NUMBER="${2:?Usage: pr-merge.sh <branch-name> <pr-number>}"

GH_REPO="zhushanwen321/tai-ji"
GH_REMOTE="github"

PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
PR_TITLE=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json title --jq '.title' 2>/dev/null || echo "")

echo -e "${BOLD}═══ 阶段 2: PR CI + 合并 ═══${NC}"
echo "  PR: #$PR_NUMBER — $PR_TITLE"
echo "  状态: $PR_STATE"

# 幂等：已合并则跳过
if [[ "$PR_STATE" == "MERGED" ]]; then
    echo -e "  ${GREEN}⏭️  PR 已合并，跳过${NC}"
elif [[ "$PR_STATE" != "OPEN" ]]; then
    echo -e "${RED}Error: PR 状态为 $PR_STATE，无法处理（需 OPEN 或 MERGED）${NC}"
    exit 1
else
    # 等待 PR CI
    echo "  检查 PR CI 状态..."
    CI_DATA=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json statusCheckRollup 2>&1) || {
        echo -e "  ${YELLOW}Warning: 无法获取 CI 状态，按 checks 未注册处理${NC}"
        CI_DATA='{"statusCheckRollup":[]}'
    }

    CI_CONCLUSIONS=$(echo "$CI_DATA" | jq -r '[.statusCheckRollup[] | .conclusion] | unique | join(",")' 2>/dev/null || echo "")
    CI_CHECK_COUNT=$(echo "$CI_DATA" | jq '[.statusCheckRollup[]] | length' 2>/dev/null || echo "0")

    # 空 rollup 防误判：checks 尚未注册时 CI_CONCLUSIONS 为空串，既无 failure 也无 pending，
    # 直接往下走会在 CI 完全未运行时误判「PR CI 通过」开始合并。
    # 有界重试（每 15s 一次、上限 4 次），仍为空则 exit 1 交人工排查。
    if [[ "$CI_CHECK_COUNT" -eq 0 ]]; then
        echo -e "  ${YELLOW}⚠️  CI checks 尚未注册（statusCheckRollup 为空），等待重查...${NC}"
        EMPTY_RETRIES=0
        while [[ "$CI_CHECK_COUNT" -eq 0 ]] && [[ $EMPTY_RETRIES -lt 4 ]]; do
            EMPTY_RETRIES=$((EMPTY_RETRIES + 1))
            sleep 15
            CI_DATA=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json statusCheckRollup 2>/dev/null) || CI_DATA='{"statusCheckRollup":[]}'
            CI_CHECK_COUNT=$(echo "$CI_DATA" | jq '[.statusCheckRollup[]] | length' 2>/dev/null || echo "0")
            CI_CONCLUSIONS=$(echo "$CI_DATA" | jq -r '[.statusCheckRollup[] | .conclusion] | unique | join(",")' 2>/dev/null || echo "")
            echo "  ⏳ checks 重查 ${EMPTY_RETRIES}/4..."
        done
        if [[ "$CI_CHECK_COUNT" -eq 0 ]]; then
            echo -e "  ${RED}❌ CI checks 持续未注册（重查 4 次共 60s），无法确认 PR CI 状态${NC}"
            echo "  排查指引:"
            echo "    1. 取 PR head commit，确认是否触发了 CI（ci.yml 路径过滤如只改 docs/ 可能不触发）:"
            echo "       gh pr view $PR_NUMBER --repo $GH_REPO --json headRefOid --jq .headRefOid"
            echo "       gh run list --repo $GH_REPO --commit <head-sha>"
            echo "    2. 人工核实 checks 状态:"
            echo "       gh pr view $PR_NUMBER --repo $GH_REPO --json statusCheckRollup"
            echo "    3. 确认无需 CI 时人工执行合并，不依赖本脚本的自动判定"
            exit 1
        fi
    fi

    if echo "$CI_CONCLUSIONS" | grep -qi "failure\|timed_out\|cancelled"; then
        echo -e "  ${RED}❌ PR CI 有失败项:${NC}"
        echo "$CI_DATA" | jq -r '.statusCheckRollup[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled") | "    ❌ \(.name) (\(.conclusion))"' 2>/dev/null || true
        exit 1
    fi

    # conclusions 为空串且 checks 已注册 = 全部 check 尚未完成（conclusion 为 null），等同 pending
    if [[ -z "$CI_CONCLUSIONS" ]] || echo "$CI_CONCLUSIONS" | grep -qi "pending\|queued\|in_progress"; then
        echo "  ⏳ PR CI 仍在运行，等待最多 10 分钟..."
        ELAPSED=0
        while [[ $ELAPSED -lt 600 ]]; do
            sleep 30
            ELAPSED=$((ELAPSED + 30))
            CI_DATA=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json statusCheckRollup 2>&1)
            CI_CONCLUSIONS=$(echo "$CI_DATA" | jq -r '[.statusCheckRollup[] | .conclusion] | unique | join(",")' 2>/dev/null || echo "")
            if [[ -n "$CI_CONCLUSIONS" ]] && ! echo "$CI_CONCLUSIONS" | grep -qi "pending\|queued\|in_progress"; then
                break
            fi
            echo "  ⏳ 等待中... (${ELAPSED}s/600s)"
        done
        if echo "$CI_CONCLUSIONS" | grep -qi "failure\|timed_out\|cancelled"; then
            echo -e "  ${RED}❌ PR CI 失败${NC}"
            exit 1
        fi
        # 等待循环超时退出后仍无结论（全 pending/空串）= CI 未完成，不得放行
        if [[ -z "$CI_CONCLUSIONS" ]] || echo "$CI_CONCLUSIONS" | grep -qi "pending\|queued\|in_progress"; then
            echo -e "  ${RED}❌ PR CI 在 10 分钟内未完成（checks 仍无结论）${NC}"
            echo "  排查: gh pr view $PR_NUMBER --repo $GH_REPO --json statusCheckRollup"
            exit 1
        fi
    fi

    echo -e "  ${GREEN}✅ PR CI 通过，开始合并${NC}"
    gh pr merge "$PR_NUMBER" --repo "$GH_REPO" --merge --delete-branch 2>&1 || {
        PR_STATE=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json state --jq '.state' 2>/dev/null || echo "UNKNOWN")
        if [[ "$PR_STATE" == "MERGED" ]]; then
            echo -e "  ${GREEN}PR 已合并（可能被其他进程合并）${NC}"
        else
            echo -e "${RED}Error: PR 合并失败${NC}"
            exit 1
        fi
    }
    echo -e "  ${GREEN}✅ PR #$PR_NUMBER 已合并${NC}"
fi

# sync 本地 main（gh pr merge 直接合到 github/main，不更新本地 main）
echo ""
echo "  sync 本地 main..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WS_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd -P)"
MAIN_WT="$WS_ROOT/main"

git -C "$MAIN_WT" fetch "$GH_REMOTE" main 2>&1 | tail -1

# 强制切到 main 分支（reset --hard 只移动当前分支 HEAD，不切换分支。
# 若 main worktree checkout 在其他分支，reset 会把该分支指针移到 github/main，
# 导致后续 bump/commit/push 落错分支 + tag 指向错误分支）
git -C "$MAIN_WT" checkout main 2>&1 | tail -1
git -C "$MAIN_WT" reset --hard "$GH_REMOTE/main" 2>&1 | tail -1

# 校验当前分支确实是 main（checkout 失败时 reset 仍会移动错误分支指针）
CURRENT_BRANCH=$(git -C "$MAIN_WT" branch --show-current)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo -e "${RED}Error: main worktree 当前分支为 $CURRENT_BRANCH（非 main）${NC}"
    echo "  reset 无法切换分支，手动执行: git -C $MAIN_WT checkout main"
    exit 1
fi

echo -e "  ${GREEN}✅ 本地 main 已同步到 $GH_REMOTE/main${NC}"
