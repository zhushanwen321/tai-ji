#!/usr/bin/env bash
# L3 端到端验收剧本 A1a：V1 exit 链八场景（plan-mode-audit-remediation §4 V1 行）
# 场景：①审批挂起中 /plan abort ②审批挂起中 plan 工具 abort ③执行方式表单挂起中 /plan abort
#       ⑤complete 终局后再调 abort ⑦退出后重开会话不复活 ⑧idle 格双通道 abort
#       ⑨a 坏格终态残留清洗 ⑨b 坏格 idle 残留清洗
# 驱动形态：真实 pi（-ne --mode rpc）+ 本地 mock LLM server（零外部 token），详见 verify-A1a.mjs 头注。
# 不依赖调用方 cwd：项目根按本脚本位置上四级推导（exit-chain → plan-mode → acceptance → scripts → 根）。
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
ARTIFACTS_DIR="$REPO_ROOT/.tmp/acceptance/exit-chain"
mkdir -p "$ARTIFACTS_DIR"

node "$SCRIPT_DIR/verify-A1a.mjs" "$ARTIFACTS_DIR" 2>&1 | tee "$ARTIFACTS_DIR/run.log"
EXIT="${PIPESTATUS[0]}"

{
  echo "# A1a RESULT"
  echo "- 时间：$(date '+%Y-%m-%d %H:%M:%S')"
  echo "- 退出码：$EXIT"
  echo "- 结论：$([ "$EXIT" -eq 0 ] && echo 'V1 exit 链八场景全部 PASS（①②③⑤⑦⑧⑨a⑨b）' || echo '存在 FAIL 场景（见下方逐条结果与 scenes/*.log）')"
  echo ""
  if [ -f "$ARTIFACTS_DIR/scenarios.md" ]; then
    cat "$ARTIFACTS_DIR/scenarios.md"
  else
    echo "（scenarios.md 缺失：驱动脚本未跑到汇总段，检查 run.log）"
  fi
} > "$ARTIFACTS_DIR/RESULT.md"
exit "$EXIT"
