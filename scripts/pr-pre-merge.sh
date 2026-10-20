#!/usr/bin/env bash
# pr-pre-merge.sh — pre-merge 工程验证一体化（taiji 适配版）
#
# 按顺序执行 typecheck → lint → test → build，任意一步失败立即退出。
# 覆盖四条代码线：extensions/ + packages/runtime + packages/renderer + packages/mobile-renderer
# （mobile-renderer 在列的根据：renderer 同构消费包，缺列时其类型/测试破坏要到构建或
# 合并后才暴露——v0.10.14 轮 U4 词表改名实例）。
#
# 三种模式（无参默认行为与旧版完全一致，向后兼容）:
#   bash scripts/pr-pre-merge.sh                          # 默认：typecheck(仅 extensions) + lint
#                                                         #        + 四线测试全跑
#   bash scripts/pr-pre-merge.sh --skip-tests             # static gate（流程阶段 1.1）：
#                                                         #   typecheck 五处 + lint；测试步全跳过，
#                                                         #   result 反映 typecheck + lint
#   bash scripts/pr-pre-merge.sh --test-result PASS|FAIL  # 终局 gate（流程阶段 3a）：
#                                                         #   typecheck 五处 + lint + test:runtime 实跑
#                                                         #   （无插桩；TAIJI_SKIP_REAL_PI=1 只跑 unit 轨，
#                                                         #   e2e 不在 PR/merge 承接）；test:extensions/renderer
#                                                         #   不执行，以注入值计入 result
#
#   --quiet 可与任一模式组合（只输出最终结果）
#
# 退出码:
#   0 = 全部通过
#   1 = 任意一步失败（输出失败步骤的 stderr 末 30 行；含 --test-result 注入 FAIL）
#   2 = 用法/环境错误（未知参数、--test-result 下 coverage.json 缺失或 base/headCommit 不一致）
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
  bash scripts/pr-pre-merge.sh --skip-tests             # static gate：typecheck 五处 + lint，测试全跳过
  bash scripts/pr-pre-merge.sh --test-result PASS|FAIL  # 终局 gate：typecheck 四处 + lint + test:runtime 实跑，
                                                        # 其余测试线以注入值计入 result
通用参数: --quiet（只输出最终结果，等价 PR_PRE_MERGE_QUIET=1）
          --base <ref>（注入值产物的 base 口径，默认 main；stacked PR（base≠main）必须传与
          coverage-gate.py 相同的 --base，否则 --test-result 校验 base/headCommit 不一致 exit 2）
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

# 工具链自举：本脚本依赖 npm/npx/pnpm，而托管执行环境（workflow gate / CI runner）的
# PATH 常被削减到只剩 node。nvm / homebrew / 官方 pkg 三种 node 安装形态下 npm/npx/pnpm
# 均与 node 同目录，从 node 实际位置推导补齐；同时前置仓库 node_modules/.bin（与 npx
# 本地优先语义一致，tsc/vitest/eslint 直接走 workspace 依赖，行为无变化）。
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
    echo "ERROR: node not found in PATH —— pr-pre-merge.sh 依赖 node 工具链（npm/npx/pnpm 按其与 node 同目录的安装惯例推导）。" >&2
    echo "恢复：在 PATH 中提供 node（如 source nvm 初始化脚本或 export PATH=<node 安装目录>:$PATH）后重跑。" >&2
    exit 2
fi
# node 常以 symlink 暴露在 PATH（如 homebrew 链接 nvm 版本）而 npm/npx/pnpm 只在真实目录——
# 解析到真实路径再取目录；readlink -f 不可用（旧 BSD / 非 symlink）时原路径兜底。
NODE_BIN_REAL="$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
export PATH="$(dirname "$NODE_BIN_REAL"):$GIT_ROOT/node_modules/.bin:$PATH"

# ── --test-result 前置校验（防注入值与 coverage 产物竞态）：
#    注入值来源是 coverage-gate 的测试判定，产物必须存在且针对同一 base + 当前 HEAD，
#    否则注入的是过期读数。不一致 → exit 2（工具错误），错误信息指向恢复动作。
if [[ "$MODE" == "test-result" ]]; then
    EXPECTED_BASE="$BASE"  # --base 可选参数（默认 main）；须与 coverage-gate.py 的 --base 同值
    # 产物目录解析（impl-spec §2.2）：新 pr-review 目录优先，缺产物时回退旧 .review/
    #（迁移过渡期 design.md §7 风险 2——coverage-gate 写方降级或在途分支只写旧目录）
    REVIEW_NEW="$(node "$GIT_ROOT/scripts/skill-data-dir.mjs" pr-review "$GIT_ROOT" 2>/dev/null || true)"
    COV_FILE=""
    if [[ -n "$REVIEW_NEW" && -f "$REVIEW_NEW/coverage.json" ]]; then
        COV_FILE="$REVIEW_NEW/coverage.json"
    elif [[ -f "$GIT_ROOT/.review/coverage.json" ]]; then
        COV_FILE="$GIT_ROOT/.review/coverage.json"
    fi
    if [[ -z "$COV_FILE" ]]; then
        echo "ERROR: --test-result 需要 coverage.json（新 pr-review 目录与 .review/ 均未找到，注入值缺少来源产物）。" >&2
        echo "恢复：先运行 python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ${EXPECTED_BASE}，" >&2
        echo "再执行 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL" >&2
        exit 2
    fi
    # base + headCommit 双锚一次读取
    COV_BASE="" COV_HEAD=""
    read -r COV_BASE COV_HEAD <<< "$(node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write([typeof c.base === "string" ? c.base : "", typeof c.headCommit === "string" ? c.headCommit : ""].join(" "));
' "$COV_FILE" 2>/dev/null || true)"
    if [[ -z "$COV_BASE" ]]; then
        echo "ERROR: coverage.json（${COV_FILE}）缺少 base 字段（或 JSON 无效）——无法确认产物针对的 base，注入判定不可信。" >&2
        echo "恢复：先运行 python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ${EXPECTED_BASE}，" >&2
        echo "再执行 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL" >&2
        exit 2
    fi
    if [[ "$COV_BASE" != "$EXPECTED_BASE" ]]; then
        echo "ERROR: coverage.json（${COV_FILE}）的 base=\"$COV_BASE\" 与本次 base=\"$EXPECTED_BASE\" 不一致——产物过期（来自其他 base），注入判定不可信。" >&2
        echo "恢复二选一：① 产物过期 → 先运行 python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ${EXPECTED_BASE}，再执行 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL；" >&2
        echo "          ② \"$COV_BASE\" 才是本次正确口径（stacked PR）→ 改用 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL --base ${COV_BASE} 重跑" >&2
        exit 2
    fi
    # head 锚（design.md §7 风险 3）：worktree 删除重建复用同一 project-slug，base 相同
    # ≠ 产物新鲜（同分支重开场景 base 不变）；headCommit 缺失（旧版脚本产出）视为不匹配
    EXPECTED_HEAD="$(git rev-parse HEAD)"
    if [[ -z "$COV_HEAD" ]]; then
        echo "ERROR: coverage.json（${COV_FILE}）缺少 headCommit 字段——产物由旧版脚本产出，无法确认针对的 HEAD（base 相同 ≠ 内容新鲜），注入判定不可信。" >&2
        echo "恢复：重跑 python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ${EXPECTED_BASE}，再执行 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL" >&2
        exit 2
    fi
    if [[ "$COV_HEAD" != "$EXPECTED_HEAD" ]]; then
        echo "ERROR: coverage.json（${COV_FILE}）的 headCommit=\"$COV_HEAD\" 与当前 HEAD=\"$EXPECTED_HEAD\" 不一致——产物过期（HEAD 已前移），注入判定不可信。" >&2
        echo "恢复：重跑 python3 .agents/skills/pr-cr-fix/scripts/coverage-gate.py --base ${EXPECTED_BASE}，再执行 bash scripts/pr-pre-merge.sh --test-result PASS|FAIL" >&2
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
        snapshot_test_evidence "step:$name exit=$exit_code" "$output_file"
        rm -f "$output_file"
        write_result_marker "FAIL"
        return $exit_code
    fi
}

# 失败证据快照：任意步骤失败或注入 FAIL 时，把全仓 vitest junit 报告与失败步骤完整
# 输出复制进带时间戳的证据目录再退出。背景：v0.11.9 ui 包 CPU 并发偶发失败的用例名
# 因复跑覆盖 junit 而永久丢失——「先保 junit 再复跑」从 AI 行为约定改为脚本必然。
# junit 的 mtime 可能早于本次运行（typecheck/lint 失败时未重跑测试），以 manifest 所列
# mtime 判新旧。快照内部任何失败只 WARN，不改变主流程退出码与判定。
snapshot_test_evidence() {
    local reason="$1" step_output="${2:-}"
    local ev_root ev_dir ts f rel
    ts="$(date +%Y%m%d-%H%M%S)"
    ev_root="$(node "$GIT_ROOT/scripts/skill-data-dir.mjs" pre-merge-evidence "$GIT_ROOT" 2>/dev/null || true)"
    # 解析失败降级 /tmp（skill-data 目录机制不可用时不阻断主流程）
    [[ -n "$ev_root" ]] || ev_root="/tmp/pre-merge-evidence"
    ev_dir="$ev_root/$ts"
    if ! mkdir -p "$ev_dir/junit" 2>/dev/null; then
        log "  WARN: 证据快照目录创建失败（$ev_dir），跳过快照"
        return 0
    fi
    find "$GIT_ROOT" \( -name node_modules -o -name .git \) -prune -o \
        -type f -name 'vitest-junit.xml' -path '*/test-results/*' -print 2>/dev/null |
        while IFS= read -r f; do
            rel="${f#"$GIT_ROOT"/}"
            mkdir -p "$ev_dir/junit/$(dirname "$rel")"
            cp "$f" "$ev_dir/junit/$rel" 2>/dev/null || true
        done
    if [[ -n "$step_output" && -f "$step_output" ]]; then
        cp "$step_output" "$ev_dir/failed-step-output.log" 2>/dev/null || true
    fi
    {
        echo "reason: $reason"
        echo "time: $ts"
        echo "head: $(git rev-parse HEAD 2>/dev/null || true)"
        echo "junit files (含 mtime，判新旧用):"
        ( cd "$ev_dir/junit" && find . -type f -exec ls -l {} + 2>/dev/null || true )
    } > "$ev_dir/manifest.txt" 2>/dev/null || true
    log "  证据已快照: $ev_dir"
}

# 写入 stage gate marker（供 pr-status.sh 与 pr-lifecycle workflow 读取）。
# 双写（迁移过渡期 design.md §7 风险 2）：新 pr-review 目录为主 + 旧 .review/ 同步——
# pr-lifecycle（共享实体）仍读旧路径且只 match result= 行；headCommit 行供 pr-status.sh
# 防「worktree 重建后陈旧 marker 判 ready」（design.md §7 风险 3）。
write_result_marker() {
    local result="$1"
    local review_new
    review_new="$(node "$GIT_ROOT/scripts/skill-data-dir.mjs" pr-review "$GIT_ROOT" 2>/dev/null || true)"
    mkdir -p .review
    [[ -n "$review_new" ]] && mkdir -p "$review_new"
    local ts head
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    head="$(git rev-parse HEAD 2>/dev/null || true)"
    local marker
    marker=$(cat <<MARKER
timestamp="$ts"
result="$result"
headCommit="$head"
MARKER
)
    printf '%s\n' "$marker" > .review/premerge-result
    if [[ -n "$review_new" ]]; then
        printf '%s\n' "$marker" > "$review_new/premerge-result"
    else
        echo "WARN: 新产物目录解析失败，marker 只写旧目录 .review/（pr-status.sh 切新目录后将读不到本 run 结果）" >&2
    fi
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
    run_step "typecheck:mobile-renderer" bash -c 'cd packages/mobile-renderer && pnpm run typecheck'
fi

# ── Step 2: lint（根 eslint 覆盖全局含 extensions）
run_step "lint" pnpm run lint

# ── Step 3: test（extensions + runtime + renderer 三条线；按模式取舍）
# [e2e 执行准则] PR/merge 门禁不跑 e2e：test:runtime 以 TAIJI_SKIP_REAL_PI=1 跑 unit 轨
#（与 CI test-runtime job 同口径）；真实 pi 等价性用例只在开发阶段按改动范围跑
#（清单由 tech-design e2e 影响面评估 + dev-flow 验收计划表圈定，SSOT = AGENTS.md「测试」节）
if [[ "$MODE" == "default" ]]; then
    # extensions 测试（pnpm -r --filter @zhushanwen/pi-* test = vitest run）
    run_step "test:extensions" pnpm extensions:test
    # runtime 测试（vitest config 在 packages/runtime/）
    run_step "test:runtime" bash -c 'cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run'
    # renderer 测试（vitest config 在 packages/renderer/，含 @ alias）
    run_step "test:renderer" bash -c 'cd packages/renderer && npx vitest run'
    # mobile-renderer 测试（renderer 同构消费包，词表/桥接 fixture 漂移拦截点）
    run_step "test:mobile-renderer" bash -c 'cd packages/mobile-renderer && npx vitest run'
elif [[ "$MODE" == "test-result" ]]; then
    # extensions / renderer 线由 coverage-gate 承接（插桩口径），此处不重复执行，
    # 判定以注入值计入最终 result；runtime 线实跑——无插桩，TAIJI_SKIP_REAL_PI=1 跑
    # unit 轨（e2e 执行准则：real-pi 不在 PR/merge 承接，开发阶段按改动范围跑）
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

# ── Step 5: changeset 完整性检查
# 方向①（WARN 不阻断）：改了 extensions/ 发布包但无对应 changeset → 提醒（不发版的改动可忽略）
# 方向②（FAIL 阻断）：changeset 声明了 private/config.ignore 包——声明永不生效（纯 private 被
#   version 静默跳过残留、混合声明阻断 version），无条件扫描，脚本退出码 1
# [review-pipeline-redesign 决策 7] 判定逻辑唯一实装 = scripts/changeset-check.mjs；
# 本函数只做调用、文案行透传（--json 的 lines 字段，文案单源在该脚本）与 RESULTS 簿记。
check_changeset() {
    log "▸ Step: changeset check"
    local cs_json
    if ! cs_json="$(node scripts/changeset-check.mjs --json)"; then
        log "  ✗ changeset-check 工具错误："
        log "  $cs_json"
        RESULTS+=("FAIL changeset-check 0s (tool error)")
        write_result_marker "FAIL"
        exit 2
    fi
    # 一次 node 调用渲染：首行 = "status changed_n missing_n unversionable_n" 元数据，其余行 = 文案行
    local rendered first_line rest line status changed_n missing_n unversionable_n
    if ! rendered="$(node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(j.status + " " + j.changed.length + " " + j.missing.length + " " + (j.unversionable ? j.unversionable.length : 0));
for (const l of j.lines) console.log(l);
' <<< "$cs_json")"; then
        log "  ✗ changeset-check 渲染失败（产物非 JSON）："
        log "  $cs_json"
        RESULTS+=("FAIL changeset-check 0s (unparseable)")
        write_result_marker "FAIL"
        exit 2
    fi
    first_line="${rendered%%$'\n'*}"
    rest=""
    [[ "$rendered" == *$'\n'* ]] && rest="${rendered#*$'\n'}"
    read -r status changed_n missing_n unversionable_n <<< "$first_line"
    if [ -n "$rest" ]; then
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            log "  $line"
        done <<< "$rest"
    fi
    case "$status" in
        skip)
            RESULTS+=("SKIP changeset-check 0s (no main)")
            ;;
        pass)
            if [ "$changed_n" = "0" ]; then
                RESULTS+=("PASS changeset-check 0s (no ext changes)")
            else
                RESULTS+=("PASS changeset-check 0s (${changed_n} pkgs)")
            fi
            ;;
        warn)
            RESULTS+=("WARN changeset-check 0s (${missing_n} missing)")
            ;;
        fail)
            RESULTS+=("FAIL changeset-check 0s (${unversionable_n} unversionable)")
            write_result_marker "FAIL"
            exit 2
            ;;
        *)
            log "  ✗ changeset-check 输出不可解析：$cs_json"
            RESULTS+=("FAIL changeset-check 0s (unparseable)")
            write_result_marker "FAIL"
            exit 2
            ;;
    esac
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
    snapshot_test_evidence "injected:test-result=FAIL（extensions/renderer 由 coverage-gate 判定，junit 为其实跑产物）" ""
    echo "[pr-pre-merge] FAILED ✗ —— 注入测试判定为 FAIL（test:extensions / test:renderer 未实跑，" >&2
    echo "判定继承自 coverage-gate；失败明细见 coverage.json 的 packages[].reason）" >&2
fi

write_result_marker "$FINAL_RESULT"

if [[ "$FINAL_RESULT" == "PASS" ]]; then
    exit 0
fi
exit 1
