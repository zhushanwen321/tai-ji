#!/usr/bin/env bash
# verify-run.sh —— dev-flow D3 verify 节点的**唯一调用形态**（审查 C M1/M2/M3）。
#
# 为什么需要这层壳：
#   dev-flow 的引擎执行器（wave-executor 的 runVerifyScript）只做
#   `spawn(解释器, [script], { cwd })` —— **零参数**。而 run.mjs 必须拿到
#   `<scenario>` 与 `--artifacts-dir`，否则：
#     · script = scenario 本身 → ESM 顶层 export 被当成空操作 → exit 0、零断言（假绿）
#     · script = run.mjs       → exit 2（缺 scenario 参数）
#   所以 verify 节点的 `script` 字段必须指向**本文件**，参数全部经 env 传入。
#
# 用法（两种，等价）：
#   # A. env 驱动（dev-flow 引擎形态，零参数调用）
#   TAIJI_VERIFY_SCENARIO=scenarios/p0-env-smoke.mjs \
#   TAIJI_VERIFY_ARTIFACTS=/path/to/acceptance/<node-id> \
#   TAIJI_VERIFY_NAME=verify-<node-id> \
#   bash .agents/skills/verify-taiji/scripts/verify-run.sh
#
#   # B. 位置/flag 驱动（人工复跑）
#   bash .agents/skills/verify-taiji/scripts/verify-run.sh \
#     scenarios/p0-env-smoke.mjs --artifacts-dir /tmp/acc --name verify-manual
#
# 环境变量（全部可选，flag 优先）：
#   TAIJI_VERIFY_SCENARIO   scenario 路径（相对 <repo> 或绝对）
#   TAIJI_VERIFY_ARTIFACTS  证据根（默认 ~/.agents/skill-data/verify-taiji/<worktree>/<runId>）
#   TAIJI_VERIFY_NAME       实例名（默认 verify-<runId>；并发场景必须给不同值）
#   TAIJI_VERIFY_RUN_ID     runId（默认秒级时间戳）
#   TAIJI_VERIFY_REPO       worktree 根（默认 $PWD；也可 --repo）
#   TAIJI_VERIFY_STRICT     1 = degraded 也返非零（默认 0）
#
# 退出码：与 run.mjs 一致（pass=0 / degraded=0（STRICT=1 时 2）/ fail=1）。
#   另：本壳自身参数/环境错误 → exit 2（不会被误判为验收失败）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_MJS="$SCRIPT_DIR/run.mjs"

REPO="${TAIJI_VERIFY_REPO:-$PWD}"
SCENARIO="${TAIJI_VERIFY_SCENARIO:-}"
ARTIFACTS="${TAIJI_VERIFY_ARTIFACTS:-}"
NAME="${TAIJI_VERIFY_NAME:-}"
RUN_ID="${TAIJI_VERIFY_RUN_ID:-}"
ARGS=()

# ── 解析 flag（与 env 同义，flag 优先）─────────────────────────────
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)          REPO="$2"; shift 2 ;;
    --artifacts-dir) ARTIFACTS="$2"; shift 2 ;;
    --name)          NAME="$2"; shift 2 ;;
    --run-id)        RUN_ID="$2"; shift 2 ;;
    --scenario)      SCENARIO="$2"; shift 2 ;;
    --strict)        ARGS+=("--strict"); shift ;;
    --keep)          ARGS+=("--keep"); shift ;;
    --json)          ARGS+=("--json"); shift ;;
    --)              shift; POSITIONAL+=("$@"); break ;;
    -*)              echo "verify-run: 未知 flag $1" >&2; exit 2 ;;
    *)               POSITIONAL+=("$1"); shift ;;
  esac
done

# 第一个位置参数 = scenario（env 未给时）
if [[ -z "$SCENARIO" && ${#POSITIONAL[@]} -gt 0 ]]; then
  SCENARIO="${POSITIONAL[0]}"
fi

if [[ -z "$SCENARIO" ]]; then
  echo "verify-run: 缺 scenario" >&2
  echo "  用法: TAIJI_VERIFY_SCENARIO=<scenario.mjs> TAIJI_VERIFY_ARTIFACTS=<dir> bash $0" >&2
  echo "    或: bash $0 <scenario.mjs> [--artifacts-dir <dir>] [--name <实例名>]" >&2
  exit 2
fi

# scenario 相对路径解析顺序（两个都是合法写法）：
#   1) 相对 <repo>（dev-flow 里写仓库相对路径时）
#   2) 相对技能目录（`scenarios/p0-env-smoke.mjs` 这种技能内相对路径——最常见）
#   3) 相对技能目录的 scenarios/<basename>（只给文件名时）
if [[ "$SCENARIO" != /* ]]; then
  SKILL_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  for cand in "$REPO/$SCENARIO" "$SKILL_ROOT/$SCENARIO" "$SKILL_ROOT/scenarios/$(basename "$SCENARIO")"; do
    if [[ -f "$cand" ]]; then SCENARIO="$cand"; break; fi
  done
fi

if [[ ! -f "$SCENARIO" ]]; then
  echo "verify-run: scenario 不存在: $SCENARIO" >&2
  echo "  已尝试: <repo>/$SCENARIO / <skill>/$SCENARIO / <skill>/scenarios/$(basename "$SCENARIO")" >&2
  exit 2
fi
if [[ ! -f "$RUN_MJS" ]]; then
  echo "verify-run: run.mjs 不存在: $RUN_MJS（技能目录被移动？）" >&2
  exit 2
fi

CMD=("$RUN_MJS" "$SCENARIO" "--repo" "$REPO")
[[ -n "$ARTIFACTS" ]] && CMD+=("--artifacts-dir" "$ARTIFACTS")
[[ -n "$NAME" ]]      && CMD+=("--name" "$NAME")
[[ -n "$RUN_ID" ]]    && CMD+=("--run-id" "$RUN_ID")
CMD+=("${ARGS[@]+"${ARGS[@]}"}")

exec node "${CMD[@]}"
