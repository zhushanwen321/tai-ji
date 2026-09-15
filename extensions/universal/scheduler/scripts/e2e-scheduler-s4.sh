#!/usr/bin/env bash
# e2e-scheduler-s4.sh — scheduler S4 真机探针
# 验证 scheduler 到期唤醒 + 双派发抑制
# exit 0 = PASS / exit 1 = FAIL
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT" || { echo "FAIL: cannot cd to repo root"; exit 1; }

EXTENSION_PATH="$REPO_ROOT/extensions/universal/scheduler"
if [ ! -d "$EXTENSION_PATH" ]; then
  echo "[e2e-s4] FAIL: extension path not found: $EXTENSION_PATH" >&2
  exit 1
fi

PI_CMD=$(command -v pi 2>/dev/null || echo "")
if [ -z "$PI_CMD" ]; then
  echo "[e2e-s4] SKIP: pi not found in PATH" >&2
  echo "U4_E2E_SCHEDULER SKIP"
  exit 0
fi

# 隔离 session 目录
SESSION_DIR=$(mktemp -d -t scheduler-e2e-XXXXXX)
trap 'rm -rf "$SESSION_DIR"' EXIT

echo "[e2e-s4] session dir: $SESSION_DIR" >&2

# 确保依赖就绪
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  env ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --silent 2>/dev/null || true
fi

# 使用 FIFO 保持 stdin 开放，让 pi 足够长时间运行以触发 scheduler tick
PI_FIFO=$(mktemp -u -t scheduler-pipe-XXXXXX)
mkfifo "$PI_FIFO"

echo "[e2e-s4] launching pi with scheduler extension..." >&2

# 写入 schedule prompt 到 FIFO，然后保持 FIFO 开放（每 5s 写 ping）
(
  # 发送 schedule tool 调用 prompt
  echo '{"type":"prompt","message":"Create a scheduled task: use the schedule tool to create a once task with prompt S4 probe echo hello that fires in 5 seconds. Name it S4 probe echo."}'
  # 保持 FIFO 开放：每 5s 写一个 followUp（pi 会忽略非 streaming 状态下的 followUp）
  for i in $(seq 1 12); do
    sleep 5
    # 在 agent idle 时发 prompt 会触发新 turn，但我们需要的是保持进程存活
    # 使用 streamingBehavior:followUp 让消息排队等 agent 空闲
    echo '{"type":"prompt","message":"ping","streamingBehavior":"followUp"}' 2>/dev/null || true
  done
) > "$PI_FIFO" &
WRITER_PID=$!

RESULT_FILE=$(mktemp -t scheduler-result-XXXXXX)
EXIT_CODE=0

# 启动 pi（-ne 不加载已安装扩展，避免与本地 extension 冲突）
timeout 80 pi --mode rpc -ne --session-dir "$SESSION_DIR" --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension "$EXTENSION_PATH" < "$PI_FIFO" > "$RESULT_FILE" 2>"$RESULT_FILE.stderr" &
PI_PID=$!

echo "[e2e-s4] pi PID: $PI_PID" >&2

# 等待任务到期（5s）+ tick（30s）+ margin（20s）= 55s
echo "[e2e-s4] waiting 55s for task expiry + scheduler tick..." >&2
sleep 55

# 清理
kill $PI_PID 2>/dev/null || true
kill $WRITER_PID 2>/dev/null || true
rm -f "$PI_FIFO"
wait $PI_PID 2>/dev/null || true

# 检查 session JSONL 中是否出现 dispatched entry
SESSION_FILE=$(find "$SESSION_DIR" -name "*.jsonl" -type f 2>/dev/null | head -1)

if [ -z "$SESSION_FILE" ]; then
  echo "[e2e-s4] FAIL: no session JSONL found" >&2
  if [ -f "$RESULT_FILE.stderr" ]; then
    echo "[e2e-s4] stderr:" >&2
    cat "$RESULT_FILE.stderr" >&2
  fi
  echo "U4_E2E_SCHEDULER FAIL"
  rm -f "$RESULT_FILE" "$RESULT_FILE.stderr"
  exit 1
fi

echo "[e2e-s4] session file: $SESSION_FILE" >&2

# 检查 entries：找 pi-scheduler:dispatched
DISPATCH_COUNT=$(grep -c 'pi-scheduler:dispatched' "$SESSION_FILE" 2>/dev/null || echo "0")
echo "[e2e-s4] dispatched entries: $DISPATCH_COUNT" >&2

# 断言：至少出现 1 次 dispatched entry（唤醒成功）
if [ "$DISPATCH_COUNT" -lt 1 ]; then
  echo "[e2e-s4] FAIL: no dispatched entry found" >&2
  echo "U4_E2E_SCHEDULER FAIL"
  rm -f "$RESULT_FILE" "$RESULT_FILE.stderr"
  exit 1
fi

# 断言：同一任务只出现 1 次（双派发抑制）
if [ "$DISPATCH_COUNT" -gt 1 ]; then
  echo "[e2e-s4] FAIL: dispatched $DISPATCH_COUNT times (expected 1, double-dispatch not suppressed)" >&2
  echo "U4_E2E_SCHEDULER FAIL"
  rm -f "$RESULT_FILE" "$RESULT_FILE.stderr"
  exit 1
fi

echo "[e2e-s4] PASS: scheduler 到期唤醒成功 + 双派发抑制有效" >&2
echo "U4_E2E_SCHEDULER PASS"
rm -f "$RESULT_FILE" "$RESULT_FILE.stderr"
exit 0
