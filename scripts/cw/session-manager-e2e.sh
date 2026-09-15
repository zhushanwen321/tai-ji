#!/usr/bin/env bash
# session-manager-e2e.sh — E2E mock 测试脚本
#
# 用法：bash scripts/cw/session-manager-e2e.sh <test-type>
#   test-type: create | manage | malformed
#
# 三个模式全部委托 vitest 探针驱动仓库真实实现
# （packages/runtime/src/__tests__/session-manager-e2e-probe.test.ts：
# 真实 event-adapter marker 翻译 + EventInterpreter + SessionManagerHandler）。
# 探针 import 实现符号，无实现基线树上 import 即挂 → 有红阶段区分力。
#
# 输出：<U4-EX> PASS 或 <U4-EX> FAIL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=scripts/cw/lib/red-phase-guard.sh
source "$SCRIPT_DIR/lib/red-phase-guard.sh"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

log() {
  echo -e "${GREEN}[session-manager-e2e]${NC} $*"
}

error() {
  echo -e "${RED}[session-manager-e2e]${NC} $*" >&2
}

# 红阶段守卫：验证实现产物存在（区分力检查——基线代码树无此文件会 fail）
red_phase_guard

# 根据测试类型选择验收 id 与描述，执行统一委托 vitest 探针
TEST_TYPE="${1:-create}"
case "$TEST_TYPE" in
  create)    marker='U4-E1'; desc='create action' ;;
  manage)    marker='U4-E2'; desc='manage actions (send/history/status/list/abort)' ;;
  malformed) marker='U4-E3'; desc='malformed action' ;;
  *)
    error "Unknown test type: $TEST_TYPE"
    error "Usage: $0 <create|manage|malformed>"
    exit 1
    ;;
esac

log "Testing ${desc} via vitest probe..."
if (cd "$PROJECT_ROOT/packages/runtime" && npx vitest run src/__tests__/session-manager-e2e-probe.test.ts -t "$marker"); then
  echo "$marker PASS"
else
  echo "$marker FAIL"
  exit 1
fi

log "All tests passed"
