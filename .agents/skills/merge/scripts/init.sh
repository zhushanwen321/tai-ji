#!/bin/bash
# init.sh — taiji merge 流程阶段 0：环境初始化
#
# 做什么：workspace 检测、PR 查找、打印流程头信息
# 用法: bash .agents/skills/merge/scripts/init.sh <worktree-dir>
#   worktree-dir: feature worktree 目录名（basename），如 feat-extensions-widget
#
# 退出码：0 = 成功，1 = 失败

set -euo pipefail

# 颜色 / 仓库标识 / workspace 定位收敛到 _lib 共享库（source 范式与 remove-worktree.sh 一致）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/../_lib/output.sh"
source "$SCRIPT_DIR/../_lib/repo.sh"
source "$SCRIPT_DIR/../_lib/workspace.sh"

WORKTREE_DIR_NAME="${1:?Usage: init.sh <worktree-dir-name>}"

# workspace 检测（向上查找含 .bare/ 的目录——.agents 实体在 workspace 根，
# worktree 内是 symlink，pwd -P 已解析到实体物理路径；固定层数推导会随布局漂移失效）
# 未命中时回退 WS_ROOT="/"，与旧内联循环的失败终态一致（走下方 .bare 存在性检查报错退出）
WS_ROOT="$(find_workspace_root "$SCRIPT_DIR" || echo "/")"

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

# ── 发布互斥检查 + 新管线状态落盘（阶段 0 = 管线开启点）──
# 互斥依据 = .merge-state/current.json：非终态且 12h 内活跃的管线视为「发布进行中」
# （两会话并发启动发布链是数据丢失源——bump/tag/push 全是写操作）；终态或超窗不阻塞。
# 状态写入用 { reset: true }——清掉上一轮 release 的 tag/releasedAt 等字段，防跨轮残留。
STATE_MSG=$(node --input-type=module -e '
import { pathToFileURL } from "node:url"
// node -e 模式下 argv 无 script 路径位：argv = [execPath, <四个参数>...]，故 slice(1)
const [root, mainWt, branch, prArg] = process.argv.slice(1)
const { readMergeState, writeMergeState, TERMINAL_STAGES } = await import(
  pathToFileURL(mainWt + "/scripts/merge/lib/state.mjs").href
)
const prev = readMergeState(root)
const WINDOW_MS = 12 * 60 * 60 * 1000
const active = prev != null && typeof prev.stage === "string" && prev.stage !== ""
  && !TERMINAL_STAGES.includes(prev.stage)
  && Date.now() - Date.parse(prev.updatedAt ?? "0") < WINDOW_MS
if (active) {
  console.log("BUSY " + JSON.stringify({ stage: prev.stage, branch: prev.branch, pr: prev.pr, updatedAt: prev.updatedAt }))
} else {
  const next = writeMergeState(root, {
    pipelineId: `${Date.now()}-${process.pid}`,
    branch: branch,
    pr: Number(prArg),
    stage: "init",
    startedAt: new Date().toISOString(),
  }, { reset: true })
  if (next === null) console.log("WARN: 管线状态写入失败（不阻塞；阶段 2 会再写）")
  else console.log("OK " + next.pipelineId)
}
' "$WS_ROOT" "$MAIN_WT" "$BRANCH_NAME" "$PR_NUMBER" 2>&1) || { echo -e "${RED}Error: 管线状态检查/写入执行失败${NC}"; echo "  $STATE_MSG"; exit 1; }

case "$STATE_MSG" in
    BUSY*)
        echo -e "${RED}Error: 检测到疑似进行中的发布管线，拒绝并发启动${NC}"
        echo "  既有管线: ${STATE_MSG#BUSY }"
        echo "  处置: 先完成该管线；确认废弃后手动删除 $WS_ROOT/.merge-state/current.json 再发起"
        exit 1
        ;;
    WARN*)
        echo -e "${YELLOW}⚠️  $STATE_MSG${NC}"
        ;;
    OK*)
        echo -e "${GREEN}✅ 新发布管线已登记（pipelineId ${STATE_MSG#OK }），上一轮字段已重置${NC}"
        ;;
    *)
        echo -e "${YELLOW}⚠️  管线状态输出异常（不阻塞）: $STATE_MSG${NC}"
        ;;
esac

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
