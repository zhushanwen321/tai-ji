#!/usr/bin/env bash
# pr-pre-merge.sh — pre-merge 工程验证一体化（taiji 适配版）
#
# 按顺序执行 typecheck → lint → test → build，任意一步失败立即退出。
# 覆盖三条代码线：extensions/ + packages/runtime + packages/renderer。
#
# 三种模式（无参默认行为与旧版完全一致，向后兼容）:
#   bash scripts/pr-pre-merge.sh                          # 默认：typecheck(仅 extensions) + lint
#                                                         #        + 三线测试全跑
#   bash scripts/pr-pre-merge.sh --skip-tests             # static gate（流程阶段 1.1）：
#                                                         #   typecheck 四处 + lint；测试步全跳过，
#                                                         #   result 反映 typecheck + lint
#   bash scripts/pr-pre-merge.sh --test-result PASS|FAIL  # 终局 gate（流程阶段 3a）：
#                                                         #   typecheck 四处 + lint + test:runtime 实跑
#                                                         #   （无插桩；TAIJI_SKIP_REAL_PI=1 只跑 unit 轨，
#                                                         #   e2e 不在 PR/merge 承接）；test:extensions/renderer
#                                                         #   不执行，以注入值计入 result
#
#   --quiet 可与任一模式组合（只输出最终结果）
#
# 退出码:
#   0 = 全部通过
#   1 = 任意一步失败（输出失败步骤的 stderr 末 30 行；含 --test-result 注入 FAIL）
#   2 = 用法/环境错误（未知参数、--test-result 下 coverage.json 缺失或 base 不一致）
#
# 环境变量:
#   PR_PRE_MERGE_SKIP_BUILD=1   跳过 build 步骤（Electron build 耗时较长）
#   PR_PRE_MERGE_QUIET=1        静默模式（只在结束时输出汇总）

set -euo pipefail

QUIET="${PR_PRE_MERGE_QUIET:-0}"

usage() {
    cat >&2 <<'USAGE'
用法:
  bash scripts/pr-pre-merge.sh                          # 默认：typecheck(仅 extensions) + lint + 三线测试全跑
  bash scripts/pr-pre-merge.sh --skip-tests             # static gate：typecheck 三处 + lint，测试全跳过
  bash scripts/pr-pre-merge.sh --test-result PASS|FAIL  # 终局 gate：typecheck 四处 + lint + test:runtime 实跑，
                                                        # 其余测试线以注入值计入 result
通用参数: --quiet（只输出最终结果，等价 PR_PRE_MERGE_QUIET=1）
          --base <ref>（注入值产物的 base 口径，默认 main；stacked PR（base≠main）必须传与
          coverage-gate.py 相同的 --base，否则 --test-result 校验 base 不一致 exit 2）
USAGE
}

# ── 参数解析：模式（default / skip-tests / test-result）+ --quiet ──
MODE="default"
TEST_RESULT_INJECT=""
BASE="main"  # 注入值产物的 base 口径（与 coverage-gate.py --base 同一 ref 名文本比对）
while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet)
            QUIET=1
            ;;
        --base)
            [[ -n "${2:-}" ]] || { echo "ERROR: --base 需要一个 ref 名参数" >&2; usage; exit 2; }
            BASE="$2"
            # 只 shift 掉 value；flag 本身由循环底部公共 shift 消费（此处 shift 2 会
            # 在 --base 是末尾参数时多移一次，set -e 下静默 exit 1）
            shift
            ;;
        --skip-tests|--test-result)
            if [[ "$MODE" != "default" ]]; then
                echo "ERROR: --skip-tests 与 --test-result 互斥，只能指定一个" >&2
                usage
                exit 2
            fi
            if [[ "$1" == "--skip-tests" ]]; then
                MODE="skip-tests"
            else
                MODE="test-result"
                shift
                if [[ "${1:-}" != "PASS" && "${1:-}" != "FAIL" ]]; then
                    echo "ERROR: --test-result 需要注入值 PASS 或 FAIL（得到：${1:-<空>}）" >&2
                    usage
                    exit 2
                fi
                TEST_RESULT_INJECT="$1"
            fi
            ;;
        *)
            echo "ERROR: 未知参数: $1" >&2
            usage
            exit 2
            ;;
    esac
    shift
done

log() {
    [[ "$QUIET" == "1" ]] || echo "[pr-pre-merge] $*"
}

# 必须在 git 仓库根目录
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "Not a git repo" >&2; exit 2; })"
cd "$GIT_ROOT"

# ── --test-result 前置校验（防注入值与 coverage 产物竞态）：
#    注入值来源是 coverage-gate 的测试判定，产物必须存在且针对同一 base，
#    否则注入的是过期读数。不一致 → exit 2（工具错误），错误信息指向恢复动作。
if [[ "$MODE" == "test-result" ]]; then
    EXPECTED_BASE="$BASE"  # --base 可选参数（默认 main）；须与 coverage-gate.py 的 --base 同值
    if [[ ! -f .review/coverage.json ]]; then
        echo "ERROR: --test-result 需要 .review/coverage.json（未找到，注入值缺少来源产物）。" >&2
        echo "恢复：先运行 python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ${EXPECTED_BASE}，" >&2
        echo "再执行 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL" >&2
        exit 2
    fi
    COV_BASE="$(node -e 'try{const c=require("./.review/coverage.json");process.stdout.write(typeof c.base==="string"?c.base:"")}catch(e){}' 2>/dev/null || true)"
    if [[ -z "$COV_BASE" ]]; then
        echo "ERROR: .review/coverage.json 缺少 base 字段（或 JSON 无效）——无法确认产物针对的 base，注入判定不可信。" >&2
        echo "恢复：先运行 python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ${EXPECTED_BASE}，" >&2
        echo "再执行 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL" >&2
        exit 2
    fi
    if [[ "$COV_BASE" != "$EXPECTED_BASE" ]]; then
        echo "ERROR: .review/coverage.json 的 base=\"$COV_BASE\" 与本次 base=\"$EXPECTED_BASE\" 不一致——产物过期（来自其他 base），注入判定不可信。" >&2
        echo "恢复二选一：① 产物过期 → 先运行 python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ${EXPECTED_BASE}，再执行 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL；" >&2
        echo "          ② \"$COV_BASE\" 才是本次正确口径（stacked PR）→ 改用 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL --base ${COV_BASE} 重跑" >&2
        exit 2
    fi
fi

START=$(date +%s)
RESULTS=()

run_step() {
    local name="$1"; shift
    log "▸ Step: $name"
    local step_start=$(date +%s)
    local exit_code=0
    local output_file
    output_file="$(mktemp -t pr-pre-merge.XXXXXX)"

    # 同时捕获 stdout+stderr；只对命令本身静默
    # [HISTORICAL] 非安静分支原裸写 `"$@" | tee` 后取 PIPESTATUS[0]：pipefail 下步骤
    # 失败时该管道直接触发 set -e 退出 shell，下方 FAIL 分支（✗ 日志 / last-30 dump /
    # marker FAIL 写入）是死代码——marker 失败时不更新（2026-08-22 --test-result 实测
    # 暴露：EXIT_CODE=1 但 marker 停留旧值）。改 `|| exit_code=$?` 进条件上下文，失败
    # 统一走 FAIL 判定，marker 必须反映终态（pr-cr-fix 精简设计 D4/S3）。成功路径零变化
    # （PIPESTATUS[0] 与管道状态同为 0）。
    if [[ "$QUIET" == "1" ]]; then
        "$@" >"$output_file" 2>&1 || exit_code=$?
    else
        "$@" 2>&1 | tee "$output_file" || exit_code=$?
    fi

    local step_end=$(date +%s)
    local elapsed=$((step_end - step_start))

    if [[ $exit_code -eq 0 ]]; then
        RESULTS+=("PASS $name ${elapsed}s")
        log "  ✓ $name passed in ${elapsed}s"
        rm -f "$output_file"
    else
        RESULTS+=("FAIL $name ${elapsed}s (exit=$exit_code)")
        log "  ✗ $name failed in ${elapsed}s (exit=$exit_code)"
        log "  --- last 30 lines of output ---"
        tail -30 "$output_file" >&2 || true
        log "  -------------------------------"
        rm -f "$output_file"
        write_result_marker "FAIL"
        return $exit_code
    fi
}

# 写入 stage gate marker（供 pr-status.sh 读取）
write_result_marker() {
    local result="$1"
    mkdir -p .review
    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    cat > .review/premerge-result <<MARKER
timestamp="$ts"
result="$result"
MARKER
}

# ── Step 1: typecheck（extensions 独立 tsconfig + 项目层）
# extensions/ 有独立 tsconfig.json（noEmit），项目层暂无全局 typecheck script
# 默认模式仅 extensions（向后兼容）；--skip-tests / --test-result 扩展为四处
# （runtime / renderer 的 package.json 均声明 typecheck script：tsc / vue-tsc --noEmit；
#  renderer 测试 tsconfig 走 typecheck:test——默认 tsconfig exclude 掉测试文件，
#  测试桩与生产契约的漂移只有该 tsconfig 能编译期拦截）
run_step "typecheck:extensions" bash -c 'cd "$0" && npx tsc --noEmit' extensions
if [[ "$MODE" != "default" ]]; then
    run_step "typecheck:runtime" bash -c 'cd packages/runtime && pnpm run typecheck'
    run_step "typecheck:renderer" bash -c 'cd packages/renderer && pnpm run typecheck'
    # 测试 tsconfig（tsconfig.typecheck-test.json）：vitest 测试文件被默认 tsconfig 的 exclude
    # 挡在门外，只有此脚本纳入 include——测试桩与生产契约漂移的唯一编译期拦截点。
    run_step "typecheck:renderer-tests" bash -c 'cd packages/renderer && pnpm run typecheck:test'
fi

# ── Step 2: lint（根 eslint 覆盖全局含 extensions）
run_step "lint" pnpm run lint

# ── Step 3: test（extensions + runtime + renderer 三条线；按模式取舍）
# [e2e 执行准则] PR/merge 门禁不跑 e2e：test:runtime 以 TAIJI_SKIP_REAL_PI=1 跑 unit 轨
#（与 CI test-runtime job 同口径）；真实 pi 等价性用例只在开发阶段按改动面跑
#（清单由 tech-design e2e 影响面评估 + dev-flow 验收计划表圈定，SSOT = AGENTS.md「测试」节）
if [[ "$MODE" == "default" ]]; then
    # extensions 测试（pnpm -r --filter @zhushanwen/pi-* test = vitest run）
    run_step "test:extensions" pnpm extensions:test
    # runtime 测试（vitest config 在 packages/runtime/）
    run_step "test:runtime" bash -c 'cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run'
    # renderer 测试（vitest config 在 packages/renderer/，含 @ alias）
    run_step "test:renderer" bash -c 'cd packages/renderer && npx vitest run'
elif [[ "$MODE" == "test-result" ]]; then
    # extensions / renderer 线由 coverage-gate 承接（插桩口径），此处不重复执行，
    # 判定以注入值计入最终 result；runtime 线实跑——无插桩，TAIJI_SKIP_REAL_PI=1 跑
    # unit 轨（e2e 执行准则：real-pi 不在 PR/merge 承接，开发阶段按改动面跑）
    log "  ↷ test:extensions skipped（--test-result 注入: ${TEST_RESULT_INJECT}）"
    RESULTS+=("SKIP test:extensions 0s (injected=${TEST_RESULT_INJECT})")
    run_step "test:runtime" bash -c 'cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run'
    log "  ↷ test:renderer skipped（--test-result 注入: ${TEST_RESULT_INJECT}）"
    RESULTS+=("SKIP test:renderer 0s (injected=${TEST_RESULT_INJECT})")
else
    # --skip-tests：全部测试步跳过（阶段 1.1 static gate，测试由 coverage-gate 承接）
    log "  ↷ test:extensions skipped (--skip-tests)"
    RESULTS+=("SKIP test:extensions 0s (--skip-tests)")
    log "  ↷ test:runtime skipped (--skip-tests)"
    RESULTS+=("SKIP test:runtime 0s (--skip-tests)")
    log "  ↷ test:renderer skipped (--skip-tests)"
    RESULTS+=("SKIP test:renderer 0s (--skip-tests)")
fi

# ── Step 4: build（可选，Electron build 耗时较长，默认跳过除非显式要求）
if [[ "${PR_PRE_MERGE_SKIP_BUILD:-1}" == "1" ]]; then
    log "  ↷ build skipped (PR_PRE_MERGE_SKIP_BUILD=1, default for Electron project)"
    RESULTS+=("SKIP build 0s")
else
    run_step "build" pnpm run build
fi

# ── Step 5: changeset 完整性检查（WARNING 级别，不阻断）
# 检测：改了 extensions/ 发布包但无对应 changeset → 提醒（不发版的改动可忽略）
check_changeset() {
    log "▸ Step: changeset check"

    # 只在 feature 分支（有 main 可对比）时检查
    if ! git rev-parse --verify main >/dev/null 2>&1 && ! git rev-parse --verify github/main >/dev/null 2>&1; then
        log "  ↷ skip（找不到 main 分支，无法对比）"
        RESULTS+=("SKIP changeset-check 0s (no main)")
        return 0
    fi

    # 找出改了 src/ 的 extension 包（只改 docs/test/examples 的不算）
    local changed_pkgs=()
    while IFS= read -r file; do
        # 提取包目录。三种布局：旧扁平 extensions/<name>/、2026-08-22 分组后的
        # extensions/<group>/<name>/（group ∈ shared|taiji|universal）。
        # [HISTORICAL] 曾只特判 shared/ 一个分组，universal/ taiji/ 下的包全被
        # 漏检（extensions/universal/ 无 package.json 整组被跳过，WARN 少报 6 包）
        local pkg_dir
        pkg_dir=$(echo "$file" | grep -oE '^extensions/((shared|taiji|universal)/[^/]+|[^/]+)/' | sed 's:/$::' || true)
        [ -z "$pkg_dir" ] && continue

        # 只关心改了 src/ 的（排除 README、docs、examples、workflows）；已删除的
        # 包（如 quota-providers 移除）读不到 package.json 会在下方自然跳过
        echo "$file" | grep -qE '^extensions/((shared|taiji|universal)/[^/]+|[^/]+)/src/' || continue

        # 读 package.json 的 name 字段
        local pkg_name
        pkg_name=$(node -p "require('./$pkg_dir/package.json').name" 2>/dev/null || echo "")
        [ -z "$pkg_name" ] && continue

        # 去重
        local found=0
        for p in "${changed_pkgs[@]:-}"; do [ "$p" = "$pkg_name" ] && found=1 && break; done
        [ "$found" = "0" ] && changed_pkgs+=("$pkg_name")
    done < <(git diff main...HEAD --name-only 2>/dev/null || git diff github/main...HEAD --name-only 2>/dev/null)

    if [ "${#changed_pkgs[@]}" -eq 0 ]; then
        log "  ✓ 无 extension src/ 改动，跳过 changeset 检查"
        RESULTS+=("PASS changeset-check 0s (no ext changes)")
        return 0
    fi

    # 收集 changeset 文件中声明的包名
    local declared_pkgs
    # 支持单引号和双引号两种 changeset frontmatter 格式（@changesets/cli 默认生成单引号）
    declared_pkgs=$(grep -rhE "['\"]@" .changeset/*.md 2>/dev/null | grep -oE "['\"]@[^'\"]+['\"]" | tr -d "'\"" | sort -u || echo "")

    # 找出改了但没声明 changeset 的包
    local missing=()
    for pkg in "${changed_pkgs[@]}"; do
        if ! echo "$declared_pkgs" | grep -qF "$pkg"; then
            missing+=("$pkg")
        fi
    done

    if [ "${#missing[@]}" -eq 0 ]; then
        log "  ✓ 所有改动的 extension 包都有 changeset（${#changed_pkgs[@]} 个包）"
        RESULTS+=("PASS changeset-check 0s (${#changed_pkgs[@]} pkgs)")
    else
        log "  ⚠ ${#missing[@]} 个 extension 改了 src/ 但无 changeset："
        for pkg in "${missing[@]}"; do
            log "    - $pkg"
        done
        log "  如需发布，运行: pnpm changeset"
        log "  如是纯文档/测试/重构改动无需发布，可忽略此警告"
        RESULTS+=("WARN changeset-check 0s (${#missing[@]} missing)")
    fi
}
check_changeset

END=$(date +%s)
TOTAL=$((END - START))

echo ""
echo "[pr-pre-merge] === SUMMARY (${TOTAL}s total) ==="
for r in "${RESULTS[@]}"; do
    echo "  $r"
done
# ── 终局 result 判定：注入 FAIL 即使实跑步全过也判 FAIL。
# （实跑步失败已在 run_step 内直接写 FAIL marker 并中止，不会到达此处）
FINAL_RESULT="PASS"
if [[ "$MODE" == "test-result" && "$TEST_RESULT_INJECT" == "FAIL" ]]; then
    FINAL_RESULT="FAIL"
fi

if [[ "$FINAL_RESULT" == "PASS" ]]; then
    echo "[pr-pre-merge] all checks passed ✓"
else
    echo "[pr-pre-merge] FAILED ✗ —— 注入测试判定为 FAIL（test:extensions / test:renderer 未实跑，" >&2
    echo "判定继承自 coverage-gate；失败明细见 .review/coverage.json 的 packages[].reason）" >&2
fi

write_result_marker "$FINAL_RESULT"

if [[ "$FINAL_RESULT" == "PASS" ]]; then
    exit 0
fi
exit 1
