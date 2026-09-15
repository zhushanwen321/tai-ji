#!/bin/bash
# check_pnpm_store_layout.sh — pnpm store 布局守卫（pre-commit 与 validate-runtime-bundle.sh 共用）
#
# [HISTORICAL 2026-09-03] zsw 引擎 worker 覆写 HOME（~/.zcode/zsw/engines/*/home-appserver），
# pnpm store 默认路径随 HOME 解析 → 引擎侧 pre-commit 内 verify-*.sh 的自含 install 把引擎
# store 写进 node_modules/.modules.yaml；本地（正常 HOME）后续 install 判布局过期，要求删除
# 重建，非 TTY 上下文直接 abort：ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY（间歇复现，
# 谁最后 install 谁的 storeDir 生效）。本守卫把该场景从「5 分钟排障」收敛为一条 [FIX] 指引，
# 同时是引擎侧 HOME 修复的验收探针——引擎仍覆写 HOME 时，workflow 一跑、本地一 commit 本
# 护栏立刻红。根因/恢复/排障：docs/TROUBLESHOOTING.md「pnpm store 布局双向翻转」条目。

set -u

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
MODULES_YAML="$PROJECT_ROOT/node_modules/.modules.yaml"

# node_modules 未初始化（fresh checkout）→ 无布局可判，install 首跑自会写入
[ -f "$MODULES_YAML" ] || exit 0

# pnpm 缺失时后续检查自会失败，不在此添噪
command -v pnpm >/dev/null 2>&1 || exit 0

EXPECTED="$(cd "$PROJECT_ROOT" && pnpm store path 2>/dev/null)" || exit 0
RECORDED="$(grep -m1 '^storeDir:' "$MODULES_YAML" | sed 's/^storeDir:[[:space:]]*//')"

# 记录缺失属 install 语义问题，不是翻转问题，不在此判
[ -n "$RECORDED" ] || exit 0

if [ "$EXPECTED" != "$RECORDED" ]; then
    echo -e "${RED}[FAIL] pnpm store 布局翻转：.modules.yaml 记录 ${RECORDED} ，当前环境解析 ${EXPECTED} ${NC}"
    echo -e "${YELLOW}[根因] 沙箱执行体（zsw 引擎 worker / CI）覆写 HOME → store 路径分叉，见 docs/TROUBLESHOOTING.md「pnpm store 布局双向翻转」${NC}"
    echo -e "${YELLOW}[FIX] cd ${PROJECT_ROOT} && CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install  （约 6-7s 重建后重试 commit）${NC}"
    exit 1
fi

echo -e "${GREEN}[OK] pnpm store 布局一致：${EXPECTED} ${NC}"
exit 0
