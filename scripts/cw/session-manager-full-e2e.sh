#!/usr/bin/env bash
# session-manager-full-e2e.sh — 真 pi 进程端到端冒烟探针（U9-S1 / U9-S2，设计文档 §7.2 场景 1 + §7.3 机器化）
#
# 用法：bash scripts/cw/session-manager-full-e2e.sh
#
# 测试链路（一次 vitest 运行覆盖两个验收场景）：
#   spawn 真 pi（--mode rpc + --extension extensions/universal/session-manager，model
#   xiaomi-token-plan-cn/mimo-v2.5-pro，--session-dir 用 mktmp 目录、名字带 u9-smoke）
#   → stdin JSONL prompt 写死指令驱动 agent 调 create_managed_session
#   → pi stdout extension_ui_request（SESSION_MANAGER_MARKER）
#   → 仓库真实代码（event-adapter translate + EventInterpreter + SessionManagerHandler；
#     SessionService 最小 fake——create 落盘 JSONL header + 真实 persistAgentBinding sidecar）
#   → extension_ui_response 回写 pi stdin → 工具 await 拿到结果（turn_end.toolResults）
#   → U9-S2：scanPiSessions({force:true}) 重扫恢复 spawnSource/parentAgentSessionId
#
# 输出（验收标记行，stdout）：
#   U9-S1 PASS|FAIL   真 pi 全链路 create（工具返回 + sidecar 写入 + spawnSource='agent'）
#   U9-S2 PASS|FAIL   重启恢复（scanPiSessions 恢复 spawnSource + parentAgentSessionId）
#
# 护栏：
#   - 每步 60s 上限在测试内（waitForEvent STEP_TIMEOUT_MS，agent 不调工具可重试 1 次）
#   - 总脚本 180s watchdog（超时杀 vitest + 孤儿 pi）
#   - trap 清理：pi 进程结束必须 kill，session-dir 命名带 u9-smoke 便于 pgrep 核查

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_FILE="src/__tests__/equivalence/session-manager-full-e2e.test.ts"
TOTAL_TIMEOUT_SECS=180

# shellcheck source=scripts/cw/lib/red-phase-guard.sh
source "$SCRIPT_DIR/lib/red-phase-guard.sh"

# ── 红阶段守卫：实现产物存在（区分力检查——基线代码树无这些产物会 fail）──
red_phase_guard
EXTENSION_IMPL="$PROJECT_ROOT/extensions/universal/session-manager/src/index.ts"
for guard_file in "$EXTENSION_IMPL" "$PROJECT_ROOT/packages/runtime/$TEST_FILE"; do
  if [ ! -f "$guard_file" ]; then
    echo "ERROR: implementation missing (red phase guard): $guard_file" >&2
    exit 1
  fi
done
grep -q 'create_managed_session' "$EXTENSION_IMPL" || { echo "ERROR: create_managed_session tool not found in extension" >&2; exit 1; }
# 真 pi 用例必须已加入 REAL_PI_TESTS 分池（漏加会落回 main 满并行组饿死，见 vitest.config.ts 维护契约）
grep -q 'session-manager-full-e2e.test.ts' "$PROJECT_ROOT/packages/runtime/vitest.config.ts" \
  || { echo "ERROR: test file not in REAL_PI_TESTS pool (vitest.config.ts)" >&2; exit 1; }

# ── 孤儿 pi 清理（trap 兜底；测试内 fixture dispose 已先清理）──
kill_orphan_pi() {
  # 先定位 PID 再 kill（禁宽泛 pkill 误杀）；匹配 pi 的 --session-dir …u9-smoke 命令行
  local pids
  pids=$(pgrep -f -- '--session-dir .*u9-smoke' 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "[session-manager-full-e2e] killing orphan pi: $pids" >&2
    kill $pids 2>/dev/null || true
    sleep 1
    pids=$(pgrep -f -- '--session-dir .*u9-smoke' 2>/dev/null || true)
    [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true
  fi
}

TEMP_DIR=$(mktemp -d /tmp/u9-smoke-e2e.XXXXXX)
JSON_OUT="$TEMP_DIR/vitest.json"
ERR_OUT="$TEMP_DIR/vitest.stderr.log"

cleanup() {
  local exit_code=$?
  kill_orphan_pi
  rm -rf "$TEMP_DIR"
  exit $exit_code
}
trap cleanup EXIT INT TERM

# ── 运行 vitest（真 pi 全链路；--reporter=json 供标记行判定，stderr 留人类可读输出）──
echo "[session-manager-full-e2e] running real-pi e2e (timeout ${TOTAL_TIMEOUT_SECS}s)..."
VITEST_EXIT=0
(cd "$PROJECT_ROOT/packages/runtime" && npx vitest run "$TEST_FILE" --reporter=json) > "$JSON_OUT" 2> "$ERR_OUT" &
VITEST_PID=$!

elapsed=0
while kill -0 "$VITEST_PID" 2>/dev/null; do
  if [ "$elapsed" -ge "$TOTAL_TIMEOUT_SECS" ]; then
    echo "ERROR: total timeout ${TOTAL_TIMEOUT_SECS}s exceeded, killing vitest (stderr tail:)" >&2
    tail -5 "$ERR_OUT" >&2 || true
    kill "$VITEST_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$VITEST_PID" 2>/dev/null || true
    echo "U9-S1 FAIL"
    echo "U9-S2 FAIL"
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
wait "$VITEST_PID" || VITEST_EXIT=$?

tail -5 "$ERR_OUT" >&2 || true

# ── 标记行判定：逐验收 id 解析 vitest JSON（词边界匹配用例名；skipped ≠ passed）──
MARKER_EXIT=0
node -e '
const fs = require("fs");
const raw = fs.readFileSync(process.argv[1], "utf-8");
const json = JSON.parse(raw);
const all = (json.testResults || []).flatMap((t) => t.assertionResults || []);
let exit = 0;
for (const id of ["U9-S1", "U9-S2"]) {
  // 普通字符串 "\\b" → 值 \b → RegExp 词边界（防 U9-S1 误匹配 U9-S10 之类的子串）
  const re = new RegExp("\\b" + id + "\\b");
  const matches = all.filter((a) => re.test(a.fullName || ""));
  if (matches.length === 0) {
    console.log(`${id} FAIL (no matching test found in vitest output)`);
    exit = 1;
  } else if (matches.some((a) => a.status !== "passed")) {
    const bad = matches.filter((a) => a.status !== "passed").map((a) => `${a.status}: ${a.fullName}`);
    console.log(`${id} FAIL (${bad.join("; ")})`);
    exit = 1;
  } else {
    console.log(`${id} PASS`);
  }
}
process.exit(exit);
' "$JSON_OUT" || MARKER_EXIT=1

# ── 孤儿核查：跑完不允许残留 u9-smoke pi 进程 ──
if [ -n "$(pgrep -f -- '--session-dir .*u9-smoke' 2>/dev/null || true)" ]; then
  echo "ERROR: orphan pi processes remain after run (pgrep -f u9-smoke has output)" >&2
  exit 1
fi

[ "$VITEST_EXIT" -eq 0 ] && [ "$MARKER_EXIT" -eq 0 ] || exit 1
exit 0
