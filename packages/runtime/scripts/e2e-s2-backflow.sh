#!/usr/bin/env bash
# e2e-s2-backflow.sh — sd-u6 完成回流真机 e2e（design.md §4 S2 场景）
#
# 验证链：子 pi 短任务 settled → 真实 completion-backflow + 真实 delivery 内核 →
# 父 pi 无人工输入自动开新 turn，上下文含完成通知（label/status/Full transcript 指针行）。
#
# 驱动形态说明：回流编排在 taiji runtime 侧组合根（不在裸 pi extension 内），故本 e2e 不用
# sd-u4 的「裸 pi + FIFO」形态，而是 vitest 真机 e2e 文件（起两个真实 pi rpc 子进程，
# 驱动器 import 真实 completion-backflow / session-delivery-registry 模块）——与 equivalence
# 族的 pi-fixture.ts 事件同步驱动基建复用（waitForEvent 边沿等待，禁固定 sleep）。
#
# 标记行 U6_BACKFLOW_E2E PASS|FAIL 由外层（cw e2e-sh 适配器 / sd-u6-spec.json 命令）echo；
# 本脚本只保证 exit code 与结果一致。
# exit 0 = PASS / exit 1 = FAIL / pi 缺席 = SKIP（exit 0，与 sd-u4 e2e-scheduler-s4.sh 同约定）
set -o pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PKG_DIR" || { echo "FAIL: cannot cd to packages/runtime" >&2; exit 1; }

if ! command -v pi >/dev/null 2>&1; then
  echo "[e2e-s2-backflow] SKIP: pi not found in PATH" >&2
  exit 0
fi

npx vitest run src/__tests__/equivalence/completion-backflow-e2e.test.ts
