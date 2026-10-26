#!/bin/bash
# pre-merge-check.sh — Merge 前强制本地验证脚本
#
# 在 feature worktree 中运行。taiji 专用验证（多项目通用形态已退役：旧版 npm/frontend
# 通用分支自引的保留依据「AGENTS.md §5」已不存在，且 find -maxdepth 2 只能发现 extensions
# 一个 tsconfig——包级 tsconfig 都在深度 3，类型检查范围结构性小于 pr-cr-fix 静态门）。
# 类型检查 / 守卫测试出口 = scripts/quality-gates.mjs（typecheck 四处 + 快速守卫测试族
# 的单一登记处）；完整单测覆盖由阶段 2 的 PR CI 等待承担（同一 commit，无覆盖缺口）。
# 任何一项失败都会以非零退出码退出，并输出明确错误信息。
#
# 用法: cd $WS_ROOT/main && bash .agents/skills/merge/scripts/pre-merge-check.sh [worktree-path]
#   worktree-path: 可选，可被 cd 解析的 worktree 路径（相对或绝对），默认当前目录；
#                  SKILL.md 调用模板传 $WS_ROOT/<worktree-dir>
#
# AI 行为约束：
#   - 此脚本的每一项检查都不可跳过
#   - 失败时必须修复后重新运行，直到全部通过
#   - 即使失败原因是"不是你改的代码"也必须修复
#   - 如果 node_modules 缺失，脚本会自动安装

set -euo pipefail

WORKTREE_DIR="${1:-.}"
cd "$WORKTREE_DIR"

# 颜色常量收敛到 _lib 共享库（本脚本若复制到其它仓库单独使用，须连同 _lib/ 一并复制）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/../_lib/output.sh"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILURES=()

# ── 日志支持（可选：MERGE_LOG_FILE 环境变量由调用方按需注入，SKILL.md 编排的 merge
#    流程可设置它收集检查日志；未设置时 `[[ -n ... ]] || return 0` 静默跳过，不影响功能）──
_chk_log() {
    [[ -n "${MERGE_LOG_FILE:-}" ]] || return 0
    echo "[$(date +%Y-%m-%dT%H:%M:%S)] [CHECK] $*" >> "$MERGE_LOG_FILE"
}

# ── 辅助函数 ────────────────────────────────────────

pass() {
    echo -e "  ${GREEN}✅ PASS${NC}: $1"
    PASS_COUNT=$((PASS_COUNT + 1))
    _chk_log "PASS: $1"
}

fail() {
    echo -e "  ${RED}❌ FAIL${NC}: $1"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    _chk_log "FAIL: $1"
    FAILURES+=("$1")
}

skip() {
    echo -e "  ${YELLOW}⏭️  SKIP${NC}: $1"
    SKIP_COUNT=$((SKIP_COUNT + 1))
}

section() {
    echo ""
    echo -e "${BOLD}── $1 ──${NC}"
}

# 运行命令，捕获输出，根据退出码报告 pass/fail
run_check() {
    local desc="$1"
    shift
    local output
    output=$("$@" 2>&1) && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 0 ]]; then
        pass "$desc"
    else
        echo "$output" | tail -20 | sed 's/^/    /'
        fail "$desc"
    fi
    return $exit_code
}

# 获取 package.json 中的 script 值
get_script() {
    local pkg_file="$1"
    local script_name="$2"
    node -e "
        const p = require('$pkg_file');
        const val = p.scripts && p.scripts['$script_name'];
        console.log(val || '');
    " 2>/dev/null || echo ""
}

# ── 步骤 0: 确保依赖已安装 ──────────────────────────

section "步骤 0/4: 检查依赖"

if [[ -f "package.json" ]]; then
    # pnpm 项目：根目录 pnpm install --frozen-lockfile 一次装完所有 workspace + hoisted deps。
    # 跳过下面的 npm/子目录扫描逻辑——pnpm hoisted 项目子目录不该独立 install。
    # pnpm workspace 单步安装（hoisted：所有 workspace + 根依赖一次装完；taiji 唯一包管理器）
    if [[ ! -d "node_modules" ]] || [[ ! -d "node_modules/.pnpm" ]]; then
        echo "  📦 安装依赖（pnpm --frozen-lockfile）..."
        pnpm install --frozen-lockfile 2>&1
    fi
    pass "依赖已就绪（pnpm）"
else
    skip "未检测到 package.json，跳过依赖安装"
fi

# ── 步骤 1/4: TypeScript 类型检查 + 快速守卫测试族 ──
#
# 单次 quality-gates --only typecheck,test 调用（ADR-0169 ① 口径）：typecheck 四处
# （extensions / runtime / renderer / mobile-renderer，单一登记）+ SUITES 单一登记的
# 四族守卫（taste-lint / resources-plugins / builtin-ext-bundle / scripts-guards）。
# 不传 --base：typecheck/test 组不消费 base。
# [e2e 执行准则]（SSOT = AGENTS.md「测试」节）：e2e / 真实进程 / 真实 LLM 用例只在
# 开发阶段按改动范围跑；**merge / PR 门禁一律不跑 e2e**。全量单测不在阶段 1 本地重跑
# ——同一 commit 的完整 CI（test job 全量）由阶段 2 的 PR CI 等待裁决，本地重复跑只
# 加时长不加覆盖。

section "步骤 1/4: TypeScript 类型检查 + 快速守卫测试族"

if [[ -f "scripts/quality-gates.mjs" ]]; then
    echo "  运行 quality-gates --only typecheck,test（四处 + 四族） ..."
    run_check "类型检查 + 守卫测试族（quality-gates typecheck,test）" node scripts/quality-gates.mjs --side pr-cr-fix --only typecheck,test
else
    fail "scripts/quality-gates.mjs 缺失（仓库布局变更？）——类型检查与守卫测试无法执行"
fi

# ── 步骤 2: Lint ───────────────────────────────────

section "步骤 2/4: Lint 检查"

LINT_RAN=false

# 1. 根 package.json 的 lint
if [[ -f "package.json" ]]; then
    lint_script=$(get_script "./package.json" "lint")
    if [[ -n "$lint_script" ]]; then
        echo "  运行 pnpm run lint ..."
        run_check "Lint 检查" pnpm run lint
        LINT_RAN=true
    fi
fi

# ── 步骤 3: 构建 ───────────────────────────────────

section "步骤 3/4: 构建检查"

BUILD_RAN=false

if [[ -f "package.json" ]]; then
    build_script=$(get_script "./package.json" "build")
    if [[ -n "$build_script" ]]; then
        echo "  运行 pnpm run build ..."
        run_check "构建检查" pnpm run build
        BUILD_RAN=true
    fi
fi

# ── 步骤 4: Git 状态 ──────────────────────────────

section "步骤 4/4: Git 状态检查"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # 刷新 index stat 缓存，避免 tsc/vite 构建修改文件 mtime 后导致的误报
    git update-index --refresh > /dev/null 2>&1 || true
    # 未提交变更
    changed_files=$(git diff --name-only HEAD 2>/dev/null)
    cached_files=$(git diff --cached --name-only 2>/dev/null)
    if [[ -n "$changed_files" ]] || [[ -n "$cached_files" ]]; then
        fail "有未提交的代码变更 — 必须先 git commit 后才能合并"
        echo "  未提交文件:"
        (echo "$changed_files"; echo "$cached_files") | grep -v '^$' | sort -u | head -20 | sed 's/^/    M /'
    else
        pass "Git 工作区干净"
    fi

    # 未推送 commits：bare repo workspace 下 origin 是本地 bare repo，github 才是真正远程。
    # 合并流程在 github 上操作（PR merge），所以优先检查 github/$BRANCH；
    # 非 bare repo 项目（origin 即真正远程）fallback 到 origin/$BRANCH。
    _BRANCH=$(git branch --show-current 2>/dev/null || echo "")
    if [[ -n "$_BRANCH" ]]; then
        # 优先 github remote（bare repo workspace），fallback origin（普通 repo）
        if git rev-parse --verify "github/$_BRANCH" >/dev/null 2>&1; then
            REMOTE_REF="github/$_BRANCH"
        elif git rev-parse --verify "origin/$_BRANCH" >/dev/null 2>&1; then
            REMOTE_REF="origin/$_BRANCH"
        else
            REMOTE_REF=""
        fi
        if [[ -n "$REMOTE_REF" ]]; then
            UNPUSHED=$(git log --oneline "${REMOTE_REF}..HEAD" 2>/dev/null || echo "")
        else
            # 无 remote ref（新分支尚未 push 过任何 remote）→ 所有 commits 都算未推送
            UNPUSHED=$(git log --oneline "origin/$_BRANCH..HEAD" 2>/dev/null || git log --oneline -5 2>/dev/null || echo "")
        fi
    else
        UNPUSHED=$(git log --oneline '@{upstream}..HEAD' 2>/dev/null || echo "")
    fi
    if [[ -n "$UNPUSHED" ]]; then
        fail "有未推送的 commits — 必须先 git push 后才能合并"
        echo "  未推送:"
        echo "$UNPUSHED" | sed 's/^/    /'
    else
        pass "所有 commits 已推送"
    fi
else
    skip "不在 git 仓库中"
fi

# ── 汇总报告 ───────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════"
echo -e "${BOLD}验证报告${NC}"
echo "══════════════════════════════════════════════════"
echo ""
echo -e "  通过: ${GREEN}${PASS_COUNT}${NC}"
echo -e "  失败: ${RED}${FAIL_COUNT}${NC}"
echo -e "  跳过: ${YELLOW}${SKIP_COUNT}${NC}"

if [[ ${#FAILURES[@]} -gt 0 ]]; then
    echo ""
    echo -e "${RED}${BOLD}失败项:${NC}"
    for f in "${FAILURES[@]}"; do
        echo -e "  ${RED}❌ $f${NC}"
    done
fi

echo ""
if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}${BOLD}⛔ 本地验证未通过！${NC}"
    echo ""
    echo -e "  ${BOLD}AI 行为约束（不可违反）:${NC}"
    echo "  1. 必须修复所有失败项后才能继续 merge 流程"
    echo "  2. 即使失败不是你修改的代码造成的，也必须修复"
    echo "  3. 修复后重新运行本脚本，直到全部通过"
    echo "  4. 不得跳过任何失败项"
    echo "  5. 不得使用 --skip-ci 等参数绕过验证"
    echo -e "${RED}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
else
    _chk_log "验证报告: $PASS_COUNT passed, $FAIL_COUNT failed, $SKIP_COUNT skipped"
    echo -e "${GREEN}${BOLD}✅ 本地验证全部通过！可以进入 merge 流程。${NC}"
    exit 0
fi
