#!/usr/bin/env bash
# sd-e2e.sh — session-delivery 根单元聚合验收分发（design.md §4 S1-S4 场景）
#
# 从仓库根可执行；按参数分派到各叶子单元的真机 e2e 入口，exit code 透传
# （外层 cw 命令会包装 PASS/FAIL 标记行，本脚本自身不输出标记行）：
#   S1 → packages/runtime send-queue-e2e（sd-u5/根聚合：目标 session streaming 期间
#        sendChecked 第二条 → queued 语义 → turn 边界注入 → 队列清空；真 pi rpc 子进程
#        + 真实 SessionDeliveryRegistry/内核，REAL_PI_TESTS 分池内）
#   S2 → packages/runtime completion-backflow-e2e（sd-u6：子 session 完成 → 父自动开新 turn）
#   S3 → subagent-workflow notifier-golden-snapshot（sd-u3：迁移后通知 golden 逐字节 diff）
#   S4 → scheduler e2e-scheduler-s4.sh（sd-u4：到期唤醒 + 双派发抑制）
#
# 用法：bash scripts/cw-acceptance/sd-e2e.sh <S1|S2|S3|S4>
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FAIL: cannot cd to repo root" >&2; exit 1; }

ID="${1:?Usage: $0 <S1|S2|S3|S4>}"

case "$ID" in
  S1)
    cd packages/runtime || { echo "FAIL: cannot cd to packages/runtime" >&2; exit 1; }
    exec npx vitest run src/__tests__/equivalence/send-queue-e2e.test.ts
    ;;
  S2)
    cd packages/runtime || { echo "FAIL: cannot cd to packages/runtime" >&2; exit 1; }
    exec npx vitest run src/__tests__/equivalence/completion-backflow-e2e.test.ts
    ;;
  S3)
    cd extensions/universal/subagent-workflow || { echo "FAIL: cannot cd to subagent-workflow" >&2; exit 1; }
    exec npx vitest run src/execution/__tests__/notifier-golden-snapshot.test.ts
    ;;
  S4)
    exec bash extensions/universal/scheduler/scripts/e2e-scheduler-s4.sh
    ;;
  *)
    echo "FAIL: unknown scenario '$ID' (expected S1|S2|S3|S4)" >&2
    exit 1
    ;;
esac
