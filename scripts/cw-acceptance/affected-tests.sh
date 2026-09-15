#!/usr/bin/env bash
# affected-tests.sh — 增量测试集推导与执行
# 用法：bash scripts/cw-acceptance/affected-tests.sh <base-commit> [--run]
#
# 从基线 commit 推导受影响测试集：
#   1. diff 中的测试文件（*.test.ts / *.spec.ts / *.test.tsx）
#   2. diff 中的源文件 → 同名/同目录测试文件（推测映射）
# 去重后逐包串行 vitest，输出 R1 PASS/R1 FAIL 标记行。
#
# --run 时实际执行测试；不带 --run 只输出受影响文件列表（dry-run）。
#
# 设计约束：
#   - 不用 set -e（失败须落到 FAIL 标记行，不中途退出）
#   - vitest 不自带 --reporter（gate 规则⑨：仅 cw 追加的 --reporter=json 放行）
#   - TAIJI_SKIP_REAL_PI 双轨机制保留（real-pi 组时序不稳定）

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || { echo "R1 FAIL"; exit 1; }

BASE_COMMIT="${1:?Usage: $0 <base-commit> [--run]}"
RUN_FLAG="${2:-}"

# 验证基线 commit 可达
if ! git merge-base --is-ancestor "$BASE_COMMIT" HEAD 2>/dev/null; then
  echo "[affected-tests] FAIL: base commit $BASE_COMMIT not reachable from HEAD" >&2
  echo "R1 FAIL"
  exit 1
fi

# 推导 diff 中变更的文件
# 不带 HEAD：diff 到工作树（覆盖已提交 + 未提交改动）——cw 场景 worker 修复完未提交
# 即跑验收是常态，`BASE_COMMIT HEAD` 会漏掉工作区改动导致漏测。
# 已知残留边界：untracked 新文件 git diff 不可见（不扩大修复，接受该缺口）。
CHANGED_FILES=$(git diff --name-only "$BASE_COMMIT" -- '*.ts' '*.tsx' '*.vue' '*.mts' '*.mjs' 2>/dev/null || true)

if [ -z "$CHANGED_FILES" ]; then
  echo "[affected-tests] no changed source files, skipping" >&2
  echo "R1 PASS"
  exit 0
fi

# 推导受影响测试集
# declare -A（关联数组）需要 bash >= 4；macOS 系统 /bin/bash 是 3.2 会直接挂
if [ "${BASH_VERSINFO:-0}" -lt 4 ]; then
  echo "[affected-tests] FAIL: bash >= 4 required, current is ${BASH_VERSION:-unknown}." >&2
  echo "[affected-tests] fix: brew install bash && rerun with \"\$(brew --prefix)/bin/bash $0 $*\"" >&2
  echo "R1 FAIL"
  exit 1
fi

declare -A AFFECTED_TESTS

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # 规则 1：diff 中本身就是测试文件 → 直接纳入（须仍存在：diff 可能含已删除文件）
  if echo "$file" | grep -qE '\.(test|spec)\.(ts|tsx|mts)$'; then
    [ -f "$file" ] && AFFECTED_TESTS["$file"]=1
    continue
  fi

  # 规则 2：源文件 → 推测对应测试文件
  # 2a: src/foo.ts → test/foo.test.ts / src/__tests__/foo.test.ts
  # 2b: src/services/bar.ts → test/services/bar.test.ts / src/services/__tests__/bar.test.ts
  # 2c: src/foo.ts → test/foo.spec.ts
  dir=$(dirname "$file")
  # 扩展名剥离用参数扩展而非 sed：BSD sed（macOS /usr/bin/sed）BRE 不支持 \|，
  # 实测 `sed 's/\.\(ts\|tsx\|mts\)$//'` 剥离失败（base 保留扩展名 → 候选全错）。
  # CHANGED_FILES 已被 git pathspec 限定为 ts/tsx/vue/mts/mjs，${fname%.*} 通用覆盖
  # （.vue 剥扩展后可命中同名测试，如 Foo.vue → __tests__/Foo.test.ts）。
  fname=$(basename "$file")
  base="${fname%.*}"

  # 所在包根目录
  pkg_dir=""
  case "$file" in
    packages/runtime/*) pkg_dir="packages/runtime" ;;
    packages/shared/*) pkg_dir="packages/shared" ;;
    packages/renderer/*) pkg_dir="packages/renderer" ;;
    packages/core/*) pkg_dir="packages/core" ;;
    packages/ui/*) pkg_dir="packages/ui" ;;
    apps/*) pkg_dir="" ;; # apps 不纳入 vitest
    *) pkg_dir="" ;;
  esac

  [ -z "$pkg_dir" ] && continue

  # 相对于包的目录
  rel_dir="${dir#$pkg_dir/}"

  # 候选测试路径（包内多种 test 目录结构）
  candidates=()
  if [ "$rel_dir" = "$dir" ]; then
    # 文件在包根（罕见）
    candidates+=("$pkg_dir/test/$base.test.ts" "$pkg_dir/test/$base.spec.ts")
  else
    # src/services/foo.ts → 多种映射
    candidates+=(
      "$pkg_dir/$rel_dir/$base.test.ts"
      "$pkg_dir/$rel_dir/$base.spec.ts"
      "$pkg_dir/$rel_dir/__tests__/$base.test.ts"
      "$pkg_dir/$rel_dir/__tests__/$base.spec.ts"
      "$pkg_dir/test/$rel_dir/$base.test.ts"
      "$pkg_dir/test/$rel_dir/$base.spec.ts"
    )
    # 也检查去掉 src/ 前缀的路径
    rel_dir_no_src="${rel_dir#src/}"
    if [ "$rel_dir_no_src" != "$rel_dir" ]; then
      candidates+=(
        "$pkg_dir/test/$rel_dir_no_src/$base.test.ts"
        "$pkg_dir/test/$rel_dir_no_src/$base.spec.ts"
      )
    fi
  fi

  # 平铺 / 包根 __tests__ 布局（shared：src/foo.ts → __tests__/foo.test.ts；
  # 平铺 vitest：src/foo.ts → test/foo.test.ts）。无条件补两个模式——上面 rel_dir
  # 分支只生成「同目录 / test 镜像」候选，包根 __tests__ 与平铺 test 在部分 rel_dir
  # 形态下（rel_dir=src 剥前缀得空串，拼不出有效路径）不会生成，曾实际漏测
  # packages/shared/__tests__/protocol.test.ts。
  candidates+=(
    "$pkg_dir/test/$base.test.ts"
    "$pkg_dir/__tests__/$base.test.ts"
  )

  for c in "${candidates[@]}"; do
    if [ -f "$c" ]; then
      AFFECTED_TESTS["$c"]=1
    fi
  done
done <<< "$CHANGED_FILES"

# 转为排序数组
TEST_LIST=()
for f in $(printf '%s\n' "${!AFFECTED_TESTS[@]}" | sort); do
  TEST_LIST+=("$f")
done

TEST_COUNT=${#TEST_LIST[@]}
echo "[affected-tests] $TEST_COUNT affected test(s) found" >&2
for f in "${TEST_LIST[@]}"; do
  echo "  $f" >&2
done

if [ "$TEST_COUNT" -eq 0 ]; then
  echo "R1 PASS"
  exit 0
fi

if [ "$RUN_FLAG" != "--run" ]; then
  echo "[affected-tests] dry-run mode (pass --run to execute)" >&2
  printf '%s\n' "${TEST_LIST[@]}"
  exit 0
fi

# ── 执行测试 ────────────────────────────────────────────────────

export TAIJI_SKIP_REAL_PI=1
export ELECTRON_SKIP_BINARY_DOWNLOAD=1

OVERALL_STATUS=0

# 按包分组执行
for pkg in runtime shared core ui renderer; do
  pkg_tests=()
  for t in "${TEST_LIST[@]}"; do
    case "$t" in
      packages/$pkg/*) pkg_tests+=("$t") ;;
    esac
  done

  [ ${#pkg_tests[@]} -eq 0 ] && continue

  echo "[affected-tests] running ${#pkg_tests[@]} test(s) in packages/$pkg..." >&2

  # 构建 --testPathPattern（正则 OR），转换为相对于包目录的路径
  patterns=()
  for t in "${pkg_tests[@]}"; do
    rel="${t#packages/$pkg/}"
    # 去掉扩展名，用正则匹配
    patterns+=("$rel")
  done

  # vitest run 接受文件列表作为位置参数（不用 --reporter）
  if (cd "$REPO_ROOT/packages/$pkg" && npx vitest run "${patterns[@]}" 2>&1); then
    echo "[affected-tests] packages/$pkg: OK" >&2
  else
    echo "[affected-tests] packages/$pkg: FAIL" >&2
    OVERALL_STATUS=1
  fi
done

if [ "$OVERALL_STATUS" -eq 0 ]; then
  echo "R1 PASS"
  exit 0
else
  echo "R1 FAIL"
  exit 1
fi
