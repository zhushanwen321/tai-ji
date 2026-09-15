#!/usr/bin/env bash
# sm-e2e.sh — cw acceptance wrapper for sm-e2e unit (E1-E10)
# e2e-real 型：每个 id 分支输出 "<id> PASS"/"<id> FAIL" 标记行，exit code 与标记一致。
# e2e 探针为 packages/runtime/test/e2e/scoped-model.e2e.mjs（node ≥22 内置 WebSocket）。
# E9 unit 型由 vitest 直接执行。
#
# 用法：bash scripts/cw-acceptance/sm-e2e.sh <E1|E2|E3|E4|E5|E6|E7|E8|E9|E10|all>

set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "FAIL: cannot cd to repo root"; exit 1; }

ID="${1:?Usage: $0 <E1|E2|...|E10|all>}"

# ── 公共前置 ────────────────────────────────────────────────────

# 1. 依赖就绪
if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "[sm-e2e] node_modules missing, installing..." >&2
  env ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --silent || { echo "$ID FAIL"; exit 1; }
fi

# 2. 隔离数据目录
DATA_DIR=$(mktemp -d -t taiji-sm-e2e-XXXXXX)
trap 'rm -rf "$DATA_DIR"' EXIT

# 隔离性断言：DATA_DIR 不能是 ~/.taiji
if [ "$DATA_DIR" = "$HOME/.taiji" ] || [ "$DATA_DIR" = "$HOME/.taiji/" ]; then
  echo "[sm-e2e] FATAL: DATA_DIR equals real ~/.taiji" >&2
  echo "$ID FAIL"
  exit 1
fi

export TAIJI_AGENT_DATA_DIR="$DATA_DIR"
export TAIJI_RUNTIME_TOKEN="test-token-sm-e2e"

# ── all: 聚合模式（循环 E1-E9，汇总输出 R2 标记行）───────────────
if [ "$ID" = "all" ]; then
  PASS_COUNT=0
  FAIL_COUNT=0
  FAILED_IDS=""
  # E7 内联回归，E9 单测，其余走 e2e 探针
  for eid in E1 E2 E3 E4 E5 E6 E7 E8 E9 E10; do
    echo "[sm-e2e] all: running $eid..." >&2
    if bash "$0" "$eid" 2>&1; then
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      FAIL_COUNT=$((FAIL_COUNT + 1))
      FAILED_IDS="$FAILED_IDS $eid"
    fi
  done
  echo "[sm-e2e] all summary: $PASS_COUNT passed, $FAIL_COUNT failed" >&2
  if [ -z "$FAILED_IDS" ]; then
    echo "R2 PASS"
    exit 0
  else
    echo "[sm-e2e] failed:$FAILED_IDS" >&2
    echo "R2 FAIL"
    exit 1
  fi
fi

# ── E9: 单测（vitest 直接执行，不需要 e2e 探针）─────────────────
if [ "$ID" = "E9" ]; then
  if (cd "$REPO_ROOT/packages/runtime" && npx vitest run test/scoped-model-e9.test.ts -t "E9"); then
    echo "E9 PASS"
    exit 0
  else
    echo "E9 FAIL"
    exit 1
  fi
fi

# ── E7: 全量回归（冒烟 + lint + vitest）─────────────────────────
if [ "$ID" = "E7" ]; then
  # (1) scoped 实现存在性冒烟
  echo "[sm-e2e] E7: scoped smoke test..." >&2
  SMOKE_DIR=$(mktemp -d -t taiji-sm-e2e-smoke-XXXXXX)
  trap 'rm -rf "$SMOKE_DIR" "$DATA_DIR"' EXIT
  export TAIJI_AGENT_DATA_DIR="$SMOKE_DIR"
  if ! node "$REPO_ROOT/packages/runtime/test/e2e/scoped-model.e2e.mjs" smoke 2>/dev/null; then
    echo "[sm-e2e] E7 FAIL: scoped smoke failed (implementation missing?)" >&2
    echo "E7 FAIL"
    exit 1
  fi
  export TAIJI_AGENT_DATA_DIR="$DATA_DIR"

  # (2) lint 预检
  echo "[sm-e2e] E7: lint check..." >&2
  BASE_COMMIT="75f596069"
  if ! git merge-base --is-ancestor "$BASE_COMMIT" HEAD 2>/dev/null; then
    echo "E7 FAIL: base commit $BASE_COMMIT not reachable"
    exit 1
  fi
  # 不带 HEAD：diff 到工作树，覆盖已提交 + 未提交改动（与 affected-tests.sh 同理由：
  # cw 场景 worker 修复完未提交即跑验收是常态）。untracked 新文件仍不可见（已知边界）。
  CHANGED_FILES=$(git diff --name-only "$BASE_COMMIT" -- '*.ts' '*.tsx' '*.vue' '*.mts' '*.mjs' 2>/dev/null || true)
  if [ -n "$CHANGED_FILES" ]; then
    # 对改动文件逐个执行 eslint --format=json，解析 error 数。
    # eslint exit code 语义：0=干净 1=有 lint 结果 ≥2=崩溃。崩溃/输出为空/JSON
    # 不可解析一律按 FAIL（否则 catch 归零会静默绕过 lint 门）。
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      [ ! -f "$f" ] && continue
      LINT_JSON=$(cd "$REPO_ROOT" && npx eslint --format=json "$f" 2>/dev/null)
      LINT_EXIT=$?
      if [ "$LINT_EXIT" -ge 2 ]; then
        echo "[sm-e2e] E7 FAIL: eslint crashed on $f (exit=$LINT_EXIT)" >&2
        echo "E7 FAIL"
        exit 1
      fi
      if [ -z "$LINT_JSON" ]; then
        echo "[sm-e2e] E7 FAIL: eslint crashed on $f (empty output, exit=$LINT_EXIT)" >&2
        echo "E7 FAIL"
        exit 1
      fi
      ERROR_COUNT=$(echo "$LINT_JSON" | node -e "
        let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
          try {
            const arr = JSON.parse(d);
            if (!Array.isArray(arr)) throw new Error('not an array');
            process.stdout.write(String(arr.reduce((s,f)=>s+f.errorCount,0)));
          } catch { process.stdout.write('CRASH'); }
        });
      " 2>/dev/null)
      if [ -z "$ERROR_COUNT" ] || [ "$ERROR_COUNT" = "CRASH" ]; then
        echo "[sm-e2e] E7 FAIL: eslint crashed on $f (unparseable lint output)" >&2
        echo "E7 FAIL"
        exit 1
      fi
      if [ "$ERROR_COUNT" -gt 0 ] 2>/dev/null; then
        echo "[sm-e2e] E7 FAIL: $ERROR_COUNT lint error(s) in $f" >&2
        echo "E7 FAIL"
        exit 1
      fi
    done <<< "$CHANGED_FILES"
  fi

  # (3) 受影响测试集（增量推导 + 逐包串行 vitest，见 affected-tests.sh）
  # 曾每包全量 vitest——并行验收时打满 CPU（用户明确要求每层只跑自己改动涉及的 test）。
  # TAIJI_SKIP_REAL_PI=1（real-pi 等价组走 TEST-STRATEGY.md §4 / pi-fixture.ts 双轨机制）
  # 由 affected-tests.sh 自身 export，无需在此重复；real-pi 完整基线（300-600s/文件，
  # verify 高负载环境下时序随机翻转）仍跑开发机。
  echo "[sm-e2e] E7: running affected tests since $BASE_COMMIT..." >&2
  if ! bash "$REPO_ROOT/scripts/cw-acceptance/affected-tests.sh" "$BASE_COMMIT" --run 2>&1; then
    echo "[sm-e2e] E7 FAIL: affected-tests failed" >&2
    echo "E7 FAIL"
    exit 1
  fi

  echo "E7 PASS"
  exit 0
fi

# ── E1-E6, E8, E10: e2e 探针 ──────────────────────────────────
E2E_PROBE="$REPO_ROOT/packages/runtime/test/e2e/scoped-model.e2e.mjs"

if [ ! -f "$E2E_PROBE" ]; then
  echo "[sm-e2e] e2e probe not found: $E2E_PROBE" >&2
  echo "$ID FAIL"
  exit 1
fi

PROBE_OUTPUT=$(node "$E2E_PROBE" "$ID" "$DATA_DIR" 2>&1)
PROBE_STATUS=$?
echo "$PROBE_OUTPUT"
if [ "$PROBE_STATUS" -ne 0 ]; then
  # 探针 exit non-zero：确保有 FAIL 标记行（探针 crash 未输出标记时补齐，不重跑探针）
  if ! grep -q "^${ID} FAIL" <<< "$PROBE_OUTPUT"; then
    echo "$ID FAIL"
  fi
  exit 1
fi
# 探针 exit 0：标记行与 exit code 必须一致（缺 PASS 标记 = 探针契约破坏，按 FAIL 处理）
if ! grep -q "^${ID} PASS" <<< "$PROBE_OUTPUT"; then
  echo "[sm-e2e] probe exited 0 but no '${ID} PASS' marker line in output" >&2
  echo "$ID FAIL"
  exit 1
fi
exit 0
