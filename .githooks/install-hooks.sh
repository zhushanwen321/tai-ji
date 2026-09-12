#!/bin/bash
# Git Hooks 安装脚本
#
# 用法: cd .githooks && ./install-hooks.sh
# 或通过 npm prepare 自动执行

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 获取项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}Git Hooks 安装脚本${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""

# Handle both regular repo (.git dir) and worktree (.git file)
# [HISTORICAL] bare repo + worktree 模式下，git 读 hook 从 commondir（即 .bare/）的 hooks，
# 不是 per-worktree 的 git-dir。曾用 --git-dir 导致 hook 写到 worktree 局部目录，git 根本不读，
# 整个项目的 pre-commit 静默失效（2026-06-20 v3 重建审查发现）。改用 --git-common-dir。
# [2026-09-11 独立 hooks 改造] 共享 commondir/hooks 的代价暴露：任一 worktree 重装 hooks
# 即覆盖全部 worktree，版本错位的分支被不属于它的检查拦死（实测 14:50 extensions worktree
# 的 C-pi-14 段覆盖后，renderer 分支含 packages/ 的 commit 全部被 208 处存量字面量拦下）。
# 现改为 per-worktree 独立 hooks：extensions.worktreeConfig=true +
# core.hooksPath(--worktree) 指向本 worktree 的 git-dir/hooks——worktree 级配置优先于
# commondir 共享副本，各 worktree 各自安装互不覆盖。hooksPath 必须绝对路径（相对路径
# 按 CWD 解析不可靠）。
IS_WORKTREE=false
if [ -f "$PROJECT_ROOT/.git" ]; then
    # worktree 模式（.git 是文件）→ 本 worktree 独立 hooks
    IS_WORKTREE=true
    git -C "$PROJECT_ROOT" config extensions.worktreeConfig true
    # [2026-09-11] 手动开启 extensions.worktreeConfig 时 git 不会代写 core.bare——
    # worktree 会继承共享 config 的 core.bare=true，被当成 bare 仓库（status/show-toplevel
    # 报 "must be run in a work tree"）。显式置 false，幂等。
    git -C "$PROJECT_ROOT" config --worktree core.bare false
    GIT_DIR=$(git -C "$PROJECT_ROOT" rev-parse --absolute-git-dir)
    GIT_HOOKS_DIR="$GIT_DIR/hooks"
elif [ -d "$PROJECT_ROOT/.git" ]; then
    GIT_HOOKS_DIR="$PROJECT_ROOT/.git/hooks"
else
    echo -e "${RED}[ERROR] 未在 Git 仓库中${NC}"
    exit 1
fi

mkdir -p "$GIT_HOOKS_DIR"

# 生成 pre-commit hook
echo -e "${BLUE}[INFO] 安装 pre-commit hook...${NC}"

# [F5] 原子写：先写同目录临时文件，成功后 mv 到目标。禁止 cat > 直接截断目标——
# pre-commit 执行中内部跑 pnpm install → prepare → 本脚本重写「正在被执行的」钩子
# 文件时，truncate 使 bash 读偏移失步，脚本片段被当命令执行（假语法错误中止
# commit，2026-09-10 实发一次）。mktemp 同目录保证同一文件系统、rename 原子：
# 执行中的 bash 要么看到完整旧文件要么完整新文件，truncate 永不发生在目标路径上。
# 写入/chmod 失败由 EXIT trap 清理临时文件，随 set -e 以原退出码失败（既有语义不变）。
PRE_COMMIT_TMP=$(mktemp "$GIT_HOOKS_DIR/pre-commit.tmp.XXXXXX")
trap 'rm -f "$PRE_COMMIT_TMP"' EXIT
cat > "$PRE_COMMIT_TMP" << 'HOOK_EOF'
#!/bin/bash
# Git pre-commit hook: 代码质量检查
#
# 原则：无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。
# SKIP_* 环境变量仅为经明确批准的紧急逃生口，不应作为常规手段。

set -e

# ── [HISTORICAL] 自保护：先复制自身再 exec ──────────────────────────────────
# bare repo + worktree 布局下 pre-commit 是**共享单槽**资源（<bare>/hooks/pre-commit）：
# 任何 worktree 的 `pnpm install`（prepare → install-hooks.sh）都会按**该分支的模板**重写
# 它。若重写恰好发生在某个正在执行的 hook 中间，bash 按字节偏移懒读脚本会读到错位内容，
# 报出与真实代码无关的随机错误（2026-09-11 实测：`line 871: syntax error near unexpected
# token 'then'`、`line 140: cho: command not found`；同一 commit 重试时两次命中，三个不同
# 字节数 65100/66987/67901 对应三个 worktree 的模板，且每份单独 `bash -n` 均通过）。
# 复制成私有副本再 exec，运行中的字节流不再受后续重写影响；副本退出时自删。
if [ "${XYZ_PRE_COMMIT_REEXEC:-0}" != "1" ]; then
    _xyz_self_copy="$(mktemp -t xyz-pre-commit.XXXXXX)"
    cp "$0" "$_xyz_self_copy"
    XYZ_PRE_COMMIT_REEXEC=1 exec bash "$_xyz_self_copy" "$@"
fi
trap 'rm -f "$0"' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PROJECT_ROOT="$(git rev-parse --show-toplevel)"
cd "$PROJECT_ROOT"

print_section() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# 一键跳过
if [ "$SKIP_ALL_CHECKS" = "1" ]; then
    echo -e "${YELLOW}[WARN] 已跳过所有检查 (SKIP_ALL_CHECKS=1)${NC}"
    exit 0
fi

# 获取变更文件
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR)
FRONTEND_FILES=$(echo "$STAGED_FILES" | grep "^packages/renderer/src/" || true)
EXTENSION_FILES=$(echo "$STAGED_FILES" | grep -E "^extensions/.*\.ts$" | grep -vE "__tests__|\.test\.|/workflows/|/examples/|\.d\.ts$" || true)

# ============================================================================
# 0. pnpm store 布局守卫（翻转地雷：zsw 引擎 HOME 覆盖 × pnpm HOME 相对 store）
#    后续 validate-runtime-bundle → verify-* e2e 的自含 install 撞上翻转布局会以
#    ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY 硬崩，先拦下给出指引。
# ============================================================================
if ! bash .githooks/check_pnpm_store_layout.sh; then
    echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
    exit 1
fi

# ============================================================================
# 1. 前端 ESLint 检查
# ============================================================================

if [ -n "$FRONTEND_FILES" ]; then
    print_section "[前端 ESLint 检查]"

    if [ "$SKIP_FRONTEND_LINT" != "1" ]; then
        echo -e "${BLUE}[INFO] 运行 ESLint 检查...${NC}"

        CHANGED_VUE_TS=$(echo "$FRONTEND_FILES" | grep -E "\.(vue|ts)$" || true)

        if [ -n "$CHANGED_VUE_TS" ]; then
            ESLINT_FILES=$(echo "$CHANGED_VUE_TS" | tr '\n' ' ')

            # 自动修复
            npx eslint --fix $ESLINT_FILES 2>/dev/null || true

            # 重新检查
            ESLINT_OUTPUT=$(npx eslint --max-warnings=0 --no-warn-ignored $ESLINT_FILES 2>&1)
            ESLINT_EXIT_CODE=$?

            if [ $ESLINT_EXIT_CODE -ne 0 ]; then
                echo -e "${RED}[ERROR] ESLint 检查失败:${NC}"
                echo "$ESLINT_OUTPUT"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi

            # 自动添加修复后的文件
            FIXED_FILES=$(git diff --cached --name-only --diff-filter=M | grep "^packages/renderer/src/" || true)
            if [ -n "$FIXED_FILES" ]; then
                echo -e "${BLUE}[INFO] ESLint 自动修复了以下文件:${NC}"
                echo "$FIXED_FILES" | sed 's/^/  - /'
                git add $FIXED_FILES
            fi

            echo -e "${GREEN}[OK] ESLint 检查通过${NC}"
        else
            echo -e "${GREEN}[OK] 无 .vue/.ts 文件变更${NC}"
        fi
    else
        echo -e "${YELLOW}[SKIP] ESLint 检查已跳过${NC}"
    fi
fi

# ============================================================================
# 2. 前端 vue-tsc 类型检查（与 CI 等价）
# ============================================================================

if [ -n "$FRONTEND_FILES" ]; then
    print_section "[前端 vue-tsc 类型检查]"

    if [ "$SKIP_TYPE_CHECK" != "1" ]; then
        CHANGED_VUE_TS=$(echo "$FRONTEND_FILES" | grep -E "\.(vue|ts)$" || true)

        if [ -n "$CHANGED_VUE_TS" ]; then
            echo -e "${BLUE}[INFO] 执行全量类型检查...${NC}"

            if ! (cd packages/renderer && npx vue-tsc --noEmit 2>&1); then
                echo ""
                echo -e "${RED}[ERROR] vue-tsc 类型检查失败${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi

            echo -e "${GREEN}[OK] vue-tsc 类型检查通过${NC}"

            # 测试 tsconfig（tsconfig.typecheck-test.json）：vitest 测试文件被默认 tsconfig
            # 的 exclude 挡在门外，只有此处纳入 include——测试桩与生产契约漂移的唯一编译期
            # 拦截点（残留风险 8：该脚本此前从未被任何 gate 执行，3 个测试文件的基线漂移
            # 因此长期无信号）。
            echo -e "${BLUE}[INFO] 执行测试类型检查（tsconfig.typecheck-test.json）...${NC}"

            if ! (cd packages/renderer && npx vue-tsc --noEmit -p tsconfig.typecheck-test.json 2>&1); then
                echo ""
                echo -e "${RED}[ERROR] vue-tsc 测试类型检查失败（测试桩与生产契约漂移）${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi

            echo -e "${GREEN}[OK] vue-tsc 测试类型检查通过${NC}"
        else
            echo -e "${GREEN}[OK] 无 .vue/.ts 文件变更${NC}"
        fi
    else
        echo -e "${YELLOW}[SKIP] vue-tsc 类型检查已跳过${NC}"
    fi
fi

# ============================================================================
# 2b. pi extensions ESLint + tsc 类型检查
#    extensions 是无构建的 TS 源码（pi 运行时加载），用 extensions/tsconfig.json
#    + eslint.config.mjs 的 extensions/ override 块检查。
#    ESLint 只拦 error（--quiet），warning 是迁入时已有的技术债标记（no-magic-numbers
#    等，源项目基线即 warn），不阻断提交。
# ============================================================================

if [ -n "$EXTENSION_FILES" ]; then
    print_section "[pi extensions ESLint + 类型检查]"

    if [ "$SKIP_EXTENSION_LINT" != "1" ]; then
        ESLINT_EXT_FILES=$(echo "$EXTENSION_FILES" | tr '\n' ' ')
        echo -e "${BLUE}[INFO] 运行 ESLint 检查（仅拦 error）...${NC}"
        ESLINT_EXT_OUTPUT=$(npx eslint --quiet --no-warn-ignored $ESLINT_EXT_FILES 2>&1)
        ESLINT_EXT_EXIT=$?
        if [ $ESLINT_EXT_EXIT -ne 0 ]; then
            echo -e "${RED}[ERROR] extensions ESLint 检查失败:${NC}"
            echo "$ESLINT_EXT_OUTPUT"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] extensions ESLint 检查通过（warning 为技术债标记，不阻断）${NC}"

        echo -e "${BLUE}[INFO] 运行 tsc 类型检查（extensions 全量）...${NC}"
        if ! (cd extensions && npx tsc --noEmit 2>&1); then
            echo ""
            echo -e "${RED}[ERROR] extensions tsc 类型检查失败${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] extensions tsc 类型检查通过${NC}"
    else
        echo -e "${YELLOW}[SKIP] extensions 检查已跳过${NC}"
    fi
fi

# ============================================================================
# 2c. pi extensions manifest & convention 检查
#    迁自 xyz-pi-extensions 仓库的 pre-commit，针对已迁移的 extensions/ 包：
#      (1) 禁止废弃 namespace @mariozechner/pi-*（Pi SDK 已重命名为 @earendil-works/pi-*）
#      (2) 禁止 extensions 代码用 console.log/info（会泄漏到 TUI，见 standards.md §10）
#      (3) pi manifest + package.json 深度检查（保 pi.extensions/type/keyword/
#          peerDependencies/包名/files 字段完整）
#    仅在 staged extensions/ 文件变更时触发，与 2b 共用 SKIP_EXTENSION_LINT 跳过开关。
# ============================================================================

# [HISTORICAL] 原一层模式 ^extensions/[^/]+/package\.json$ 在 2026-08-22 目录分组
# （taiji/universal）后恒空匹配——纯 package.json 变更（版本 bump / pi manifest / role
# 字段）静默跳过本段检查。改为结构无关的两段式：任意分组两段深 + 排除 shared/
# （共享库无 pi manifest，通配两层会误报）——新增分组时本模式零维护，不再依赖
# 与目录结构同步的组名清单（清单式写法正是当年恒空匹配 bug 的形态）。
EXTENSION_PKG_FILES=$(echo "$STAGED_FILES" | grep -E "^extensions/[^/]+/[^/]+/package\.json$" | grep -v "^extensions/shared/" || true)

if [ -n "$EXTENSION_FILES" ] || [ -n "$EXTENSION_PKG_FILES" ]; then
    print_section "[pi extensions manifest & convention 检查]"

    if [ "$SKIP_EXTENSION_LINT" != "1" ]; then

        # ── (1) 废弃 namespace 检查：staged extensions .ts + package.json ──
        echo -e "${BLUE}[INFO] 检查废弃 namespace @mariozechner/pi-*...${NC}"
        NS_SCAN_TARGETS=""
        for f in $EXTENSION_FILES $EXTENSION_PKG_FILES; do
            NS_SCAN_TARGETS="$NS_SCAN_TARGETS $f"
        done
        NS_HITS=""
        for f in $NS_SCAN_TARGETS; do
            [ -z "$f" ] && continue
            [ -f "$f" ] || continue
            hit=$(grep -nE '@mariozechner/pi-' "$f" 2>/dev/null || true)
            if [ -n "$hit" ]; then
                while IFS= read -r line; do
                    NS_HITS="${NS_HITS}  ${f}:${line}\n"
                done <<< "$hit"
            fi
        done
        if [ -n "$NS_HITS" ]; then
            echo -e "${RED}[ERROR] 发现废弃 namespace @mariozechner/pi-*（应改用 @earendil-works/pi-*）:${NC}"
            echo -e "$NS_HITS"
            echo -e "${YELLOW}[FIX] find extensions -type f \\( -name '*.ts' -o -name '*.json' \\) -exec sed -i '' 's|@mariozechner/pi-|@earendil-works/pi-|g' {} +${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] namespace 检查通过（无 @mariozechner/pi-* 引用）${NC}"

        # ── (2) console.log/info 禁止检查（extensions/**/*.ts，排除 .d.ts/test）──
        echo -e "${BLUE}[INFO] 检查 extensions 代码 console.log/info...${NC}"
        CONSOLE_VIOLATIONS=""
        for f in $EXTENSION_FILES; do
            [ -z "$f" ] && continue
            [ -f "$f" ] || continue
            hits=$(grep -nE 'console\.(log|info)\(' "$f" 2>/dev/null || true)
            if [ -n "$hits" ]; then
                while IFS= read -r line; do
                    CONSOLE_VIOLATIONS="${CONSOLE_VIOLATIONS}  ${f}:${line}\n"
                done <<< "$hits"
            fi
        done
        if [ -n "$CONSOLE_VIOLATIONS" ]; then
            echo -e "${RED}[ERROR] extensions 中禁止使用 console.log/info（会泄漏到 TUI）:${NC}"
            echo -e "$CONSOLE_VIOLATIONS"
            echo -e "${YELLOW}[FIX] 用户可见消息 → ctx.ui.notify；内部诊断 → console.warn/error('[ext] ...')；不可恢复错误 → throw${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] console.log/info 检查通过${NC}"

        # ── (3) pi manifest + package.json 深度检查（仅 staged extensions/*/package.json）──
        if [ -n "$EXTENSION_PKG_FILES" ]; then
            echo -e "${BLUE}[INFO] 检查 pi manifest + package.json 字段完整性...${NC}"
            MANIFEST_FAIL=0
            while IFS= read -r pkg_json; do
                [ -z "$pkg_json" ] && continue
                [ -f "$pkg_json" ] || continue
                pkg_dir=$(dirname "$pkg_json")
                pkg_name_short=$(basename "$pkg_dir")

                # 跳过 private 包
                is_private=$(python3 -c "import json; print(json.load(open('$pkg_json')).get('private', False))" 2>/dev/null || echo "False")
                [ "$is_private" = "True" ] && continue

                # 检查 pi.extensions 字段（值须为 ["./index.ts"]，入口文件须存在）
                pi_result=$(python3 -c "
import json, os
d=json.load(open('$pkg_json'))
exts=d.get('pi',{}).get('extensions',[])
if exts != ['./index.ts']:
    print('BAD_VALUE:' + repr(exts)); exit(0)
entry=os.path.join('$pkg_dir', 'index.ts')
if not os.path.isfile(entry):
    print('MISSING_ENTRY:./index.ts'); exit(0)
print('OK')
" 2>/dev/null || echo "PARSE_ERROR")
                case "$pi_result" in
                    OK) ;;
                    BAD_VALUE:*)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: pi.extensions 值非 [\"./index.ts\"]（${pi_result#BAD_VALUE:}）"
                        MANIFEST_FAIL=1 ;;
                    MISSING_ENTRY:*)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: pi.extensions 入口 ./index.ts 不存在"
                        MANIFEST_FAIL=1 ;;
                    *)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: package.json 解析失败或缺少 pi.extensions"
                        echo -e "         ${YELLOW}修复：添加 \"pi\": { \"extensions\": [\"./index.ts\"] }${NC}"
                        MANIFEST_FAIL=1 ;;
                esac

                # 检查 type: module
                has_type_module=$(python3 -c "import json; print(json.load(open('$pkg_json')).get('type') == 'module')" 2>/dev/null || echo "False")
                [ "$has_type_module" != "True" ] && {
                    echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: 缺少 \"type\": \"module\""
                    MANIFEST_FAIL=1
                }

                # 检查 pi-package keyword
                has_kw=$(python3 -c "import json; print('pi-package' in json.load(open('$pkg_json')).get('keywords',[]))" 2>/dev/null || echo "False")
                [ "$has_kw" != "True" ] && {
                    echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: keywords 缺少 \"pi-package\""
                    MANIFEST_FAIL=1
                }

                # 检查包名格式 @zhushanwen/pi-*
                pkg_name=$(python3 -c "import json; print(json.load(open('$pkg_json')).get('name',''))" 2>/dev/null || echo "")
                case "$pkg_name" in
                    @zhushanwen/pi-*) ;;
                    *)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: 包名 '$pkg_name' 不符合 @zhushanwen/pi-* 格式"
                        MANIFEST_FAIL=1 ;;
                esac

                # 检查 peerDependencies 含 @earendil-works/pi-coding-agent（且不含旧 namespace）
                peer_result=$(python3 -c "
import json
d=json.load(open('$pkg_json'))
peers=d.get('peerDependencies',{})
if '@mariozechner/pi-coding-agent' in peers:
    print('LEGACY')
elif '@earendil-works/pi-coding-agent' not in peers:
    print('MISSING')
else:
    print('OK')
" 2>/dev/null || echo "MISSING")
                case "$peer_result" in
                    OK) ;;
                    LEGACY)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: peerDependencies 用旧 namespace @mariozechner/pi-coding-agent"
                        MANIFEST_FAIL=1 ;;
                    *)
                        echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: peerDependencies 缺少 @earendil-works/pi-coding-agent"
                        MANIFEST_FAIL=1 ;;
                esac

                # 检查 files 字段包含入口 ./index.ts
                files_result=$(python3 -c "
import json
d=json.load(open('$pkg_json'))
files=d.get('files',[])
matched=any('index.ts'==f or 'index.ts'.startswith(f.rstrip('/')) for f in files) if files else False
print('OK' if matched else 'MISSING')
" 2>/dev/null || echo "MISSING")
                [ "$files_result" != "OK" ] && {
                    echo -e "  ${RED}[ERROR]${NC} $pkg_name_short: files 未包含入口 index.ts（npm publish 后会丢失）"
                    MANIFEST_FAIL=1
                }
            done <<< "$EXTENSION_PKG_FILES"

            if [ $MANIFEST_FAIL -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] pi manifest + package.json 检查失败${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
            echo -e "${GREEN}[OK] pi manifest + package.json 检查通过${NC}"
        fi
    else
        echo -e "${YELLOW}[SKIP] extensions manifest & convention 检查已跳过${NC}"
    fi
fi

# ============================================================================
# 2d. extension 结构一致性检查（分组目录 / role 字段 / 依赖台账 / 一层路径残留）
#     scripts/check-extension-dependencies.mjs：①目录 ↔ xyz-agent.role 一致
#     ②taiji/ ⊆ mandatory 清单 ③extensions/ 一层禁放包 ④extension-dependencies.json
#     双向一致 ⑤活文件一层路径残留。零第三方依赖，实测 ~0.3s（~2500 文件全仓扫描，
#     随仓库线性增长）。CI 侧同一脚本由 preflight-check.sh 调用，此处提前到提交时
#     拦截。复用 SKIP_EXTENSION_LINT 开关（不新增逃生口）。
# ============================================================================

if echo "$STAGED_FILES" | grep -qE "^extensions/|^extension-dependencies\.json$|^packages/shared/src/mandatory-extensions\.json$"; then
    print_section "[extension 结构一致性检查]"

    if [ "$SKIP_EXTENSION_LINT" != "1" ]; then
        if ! node scripts/check-extension-dependencies.mjs; then
            echo -e "${RED}[ERROR] extension 结构一致性检查失败，按上方 ✗ 明细修复后重试${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${YELLOW}[SKIP] extension 结构检查已跳过${NC}"
    fi
fi

# ============================================================================
# 2e. extension npm 发布 files 白名单守卫（import 闭包 ⊆ files）
#     scripts/check-extension-files.mjs：从发布入口解析静态 import 闭包 +
#     pi.skills/agents/workflows 资源路径，逐一对照 package.json 的 files 白名单
#     （npm 只打包白名单命中文件）。起因 pi-subagent-workflow@8.8.1：逐文件枚举
#     白名单漏同步新文件 src/session-lifecycle.ts，tarball 缺文件、用户端加载即崩。
#     零第三方依赖，实测 <1s。复用 SKIP_EXTENSION_LINT 开关（不新增逃生口）。
# ============================================================================

if echo "$STAGED_FILES" | grep -qE "^extensions/.*/(package\.json|[^/]+\.ts)$|^extensions/.*/src/.*\.ts$|^scripts/check-extension-files\.mjs$"; then
    print_section "[extension files 白名单守卫]"

    if [ "$SKIP_EXTENSION_LINT" != "1" ]; then
        if ! node scripts/check-extension-files.mjs; then
            echo -e "${RED}[ERROR] extension files 白名单守卫未通过——白名单外的文件不会进 npm tarball，按上方 ✗ 明细修复后重试${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${YELLOW}[SKIP] extension files 白名单守卫已跳过${NC}"
    fi
fi

# ============================================================================
# 3. 自定义代码规范检查（原生 HTML 元素、Emoji、自定义 CSS）
# ============================================================================

print_section "[代码规范检查]"

RULES_CHECKER=".githooks/vue_rules_checker.py"

if [ "$SKIP_CODE_RULES_CHECK" != "1" ]; then
    STAGED_FRONTEND_FILES=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/src/.*\.(vue|ts)$" || true)

    if [ -n "$STAGED_FRONTEND_FILES" ]; then
        echo -e "${BLUE}[INFO] 运行代码规范检查...${NC}"

        if [ ! -f "$RULES_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $RULES_CHECKER${NC}"
        else
            ABSOLUTE_FILES=""
            for FILE in $STAGED_FRONTEND_FILES; do
                ABSOLUTE_FILES="$ABSOLUTE_FILES $PROJECT_ROOT/$FILE"
            done

            python3 "$RULES_CHECKER" --batch $ABSOLUTE_FILES
            EXIT_CODE=$?

            if [ $EXIT_CODE -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] 代码规范检查失败${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
            echo -e "${GREEN}[OK] 代码规范检查通过${NC}"
        fi
    else
        echo -e "${GREEN}[OK] 无前端源码变更，跳过代码规范检查${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] 代码规范检查已跳过${NC}"
fi

# ============================================================================
# Sidecar session 隔离检查
# ============================================================================

SIDECAR_CHECKER=".githooks/check_sidecar_session.py"
SIDECAR_SERVER="apps/electron/sidecar/src/server.ts"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_SIDECAR_SESSION_CHECK" != "1" ]; then
    if [ -f "$SIDECAR_SERVER" ]; then
        echo -e "${BLUE}[INFO] 运行 Sidecar session 隔离检查...${NC}"

        if [ ! -f "$SIDECAR_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $SIDECAR_CHECKER${NC}"
        else
            python3 "$SIDECAR_CHECKER" "$SIDECAR_SERVER"
            EXIT_CODE=$?

            if [ $EXIT_CODE -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] Sidecar session 隔离检查失败${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    else
        echo -e "${GREEN}[OK] 无 sidecar server.ts，跳过 session 隔离检查${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] Sidecar session 隔离检查已跳过${NC}"
fi

# ============================================================================
# CSS tokens 检查（style.css 不含组件级样式）
# ============================================================================

CSS_CHECKER=".githooks/check_css_tokens.py"
CSS_FILE="packages/renderer/src/style.css"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_CSS_TOKENS_CHECK" != "1" ]; then
    if [ -f "$CSS_FILE" ]; then
        echo -e "${BLUE}[INFO] 运行 CSS tokens 检查...${NC}"

        if [ ! -f "$CSS_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $CSS_CHECKER${NC}"
        else
            python3 "$CSS_CHECKER" "$CSS_FILE"
            EXIT_CODE=$?

            if [ $EXIT_CODE -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] CSS tokens 检查失败${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] CSS tokens 检查已跳过${NC}"
fi

# ============================================================================
# CSS token SSOT 一致性检查（style.css vs design-tokens.md）
# ============================================================================

CSS_SSOT_CHECKER=".githooks/check_css_token_ssot.py"
CSS_SSOT_FILES="packages/renderer/src/style.css docs/page-design/design-tokens.md"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_CSS_TOKEN_SSOT_CHECK" != "1" ]; then
    # 仅当 style.css 或 design-tokens.md 变更时才检查
    SSOT_CHANGED=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/src/style\.css$|^docs/page-design/design-tokens\.md$" || true)
    if [ -n "$SSOT_CHANGED" ]; then
        echo -e "${BLUE}[INFO] 运行 CSS token SSOT 一致性检查...${NC}"

        if [ ! -f "$CSS_SSOT_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $CSS_SSOT_CHECKER${NC}"
        else
            python3 "$CSS_SSOT_CHECKER"
            EXIT_CODE=$?

            if [ $EXIT_CODE -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] CSS token SSOT 检查失败：style.css 含 design-tokens.md 未收录的 token${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] CSS token SSOT 检查已跳过${NC}"
fi

# ============================================================================
# Renderer 依赖完整性检查（import vs package.json）
# ============================================================================

RENDERER_DEPS_CHECKER=".githooks/check_renderer_deps.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_RENDERER_DEPS_CHECK" != "1" ]; then
    # 仅当 renderer src 或 package.json 变更时才检查
    DEPS_CHANGED=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/(src/.*\.(ts|vue|tsx)|package\.json)$" || true)
    if [ -n "$DEPS_CHANGED" ]; then
        echo -e "${BLUE}[INFO] 运行 Renderer 依赖完整性检查...${NC}"

        if [ ! -f "$RENDERER_DEPS_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $RENDERER_DEPS_CHECKER${NC}"
        else
            python3 "$RENDERER_DEPS_CHECKER"
            EXIT_CODE=$?

            if [ $EXIT_CODE -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] Renderer 依赖完整性检查失败：存在 import 了但 package.json 未声明的包${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] Renderer 依赖完整性检查已跳过${NC}"
fi

# ============================================================================
# ENV_WHITELIST_PREFIXES SSOT 单一性检查
# ============================================================================

ENV_WHITELIST_CHECKER=".githooks/check_env_whitelist_sync.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_ENV_WHITELIST_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 ENV_WHITELIST_PREFIXES SSOT 检查..."

    if [ ! -f "$ENV_WHITELIST_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $ENV_WHITELIST_CHECKER${NC}"
    else
        python3 "$ENV_WHITELIST_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] ENV_WHITELIST_PREFIXES SSOT 检查失败${NC}"
            echo -e "${YELLOW}[INFO] 定义点应在 shared/constants.ts，main/runtime 只能 import${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] ENV_WHITELIST_PREFIXES SSOT 检查已跳过${NC}"
fi

# ============================================================================
# runtime 子进程 env 出站契约检查（约束 C-proc-09）
#   扫 packages/runtime/src 与 apps/electron/main 的进程创建调用点，要求子 env 经
#   buildOutboundChildEnv / composeChildEnvBase 构建（deny 剥 XYZ_AGENT_PACKAGED /
#   XYZ_RUNTIME_TOKEN）；豁免名单逐条注明理由，详见 checker 脚本头注释。
#   注：不设独立跳过开关——新增 SKIP_* 逃生口须同步登记 AGENTS.md 的 SKIP_* 清单，
#   故本段仅受既有 SKIP_ALL_CHECKS 总闸管辖。
# ============================================================================

SPAWN_ENV_BOUNDARY_CHECKER=".githooks/check_spawn_env_boundary.py"

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    print_section "[出站 env 契约检查]"
    echo -e "${BLUE}[INFO] 运行 runtime 子进程 env 出站契约检查（C-proc-09）...${NC}"

    if [ ! -f "$SPAWN_ENV_BOUNDARY_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $SPAWN_ENV_BOUNDARY_CHECKER${NC}"
    else
        python3 "$SPAWN_ENV_BOUNDARY_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] runtime 子进程 env 出站契约检查失败${NC}"
            echo -e "${YELLOW}[INFO] 新增子进程必须经 buildOutboundChildEnv 组装 env；修复指引见上方脚本输出；设计依据 docs/design/env-propagation-boundary.md${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] runtime 子进程 env 出站契约检查通过${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] runtime 子进程 env 出站契约检查已跳过${NC}"
fi

# ============================================================================
# 引擎包边界检查（W9，subagent-engine-protocolization）
#   ① check-engine-sdk-boundary（W1 守卫，随 W9 挂载进链——此前未挂载）：
#     SDK 源码 + dist 不得 import @zhushanwen/subagent-core（不变量：SDK 不得
#     import core，否则 core → SDK → core 成环）；
#   ② check-engine-package-boundary（W9 新守卫）：packages/subagent-engine-* +
#     pi/zcode-subagent-cli 不得依赖/导入 core 内部路径 + DoD#2（exports 无
#     ./engines/ 子入口、barrel 无引擎重导出）。
#   设计依据：docs/design/subagent-engine-protocolization.md §3.7 / impl-plan §2.9。
#   注：不设独立跳过开关——新增 SKIP_* 逃生口须同步登记 AGENTS.md 的 SKIP_* 清单，
#   故本段仅受既有 SKIP_ALL_CHECKS 总闸管辖。
# ============================================================================

ENGINE_SDK_BOUNDARY_CHECKER=".githooks/check-engine-sdk-boundary.mjs"
ENGINE_PACKAGE_BOUNDARY_CHECKER="scripts/check-engine-package-boundary.mjs"

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    print_section "[引擎包边界检查]"
    echo -e "${BLUE}[INFO] 运行引擎 SDK / 引擎包边界检查...${NC}"

    if [ ! -f "$ENGINE_SDK_BOUNDARY_CHECKER" ] || [ ! -f "$ENGINE_PACKAGE_BOUNDARY_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本（$ENGINE_SDK_BOUNDARY_CHECKER / $ENGINE_PACKAGE_BOUNDARY_CHECKER）${NC}"
    else
        node "$ENGINE_SDK_BOUNDARY_CHECKER" && node "$ENGINE_PACKAGE_BOUNDARY_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] 引擎包边界检查失败${NC}"
            echo -e "${YELLOW}[INFO] 引擎包只依赖 @zhushanwen/subagent-engine-sdk；共享实现下沉 SDK（core → SDK 是合法方向）；修复指引见上方脚本输出${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] 引擎包边界检查通过${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] 引擎包边界检查已跳过${NC}"
fi

# ============================================================================
# Pi extension tool schema 顶层 Object 合规检查（OpenAI 兼容性）
# ============================================================================

TOOL_SCHEMA_CHECKER=".githooks/check_tool_schema.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_TOOL_SCHEMA_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 Pi extension tool schema 顶层 Object 合规检查...${NC}"

    if [ ! -f "$TOOL_SCHEMA_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $TOOL_SCHEMA_CHECKER${NC}"
    else
        python3 "$TOOL_SCHEMA_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] Pi extension tool schema 合规检查失败${NC}"
            echo -e "${YELLOW}[INFO] parameters 顶层必须 Type.Object（OpenAI 兼容），禁止顶层 Type.Union${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] Pi extension tool schema 合规检查已跳过${NC}"
fi

# ============================================================================
# 路径白名单动态化检查
# ============================================================================

PATH_WHITELIST_CHECKER=".githooks/check_path_whitelist.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_PATH_WHITELIST_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行路径白名单动态化检查..."

    if [ ! -f "$PATH_WHITELIST_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $PATH_WHITELIST_CHECKER${NC}"
    else
        python3 "$PATH_WHITELIST_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] 路径白名单动态化检查失败${NC}"
            echo -e "${YELLOW}[INFO] 路径白名单必须使用 getConfigDir()/getPiAgentDir() 动态生成${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] 路径白名单动态化检查已跳过${NC}"
fi

# ============================================================================
# R1 pi session JSONL 直写检查（data-source-governance P0.3）
#   拦截 runtime/scripts 代码对 pi session JSONL 本体的直写，报错指向登记表。
#   注：不设独立跳过开关——新增 SKIP_* 逃生口须同步登记 AGENTS.md 的 SKIP_* 清单
#   （W3 改动范围仅限本文件与 checker 本体），故本段仅受既有 SKIP_ALL_CHECKS 总闸管辖。
# ============================================================================

PI_DIRECT_WRITE_CHECKER=".githooks/check_pi_direct_write.py"

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    print_section "[R1 pi session 直写检查]"
    echo -e "${BLUE}[INFO] 运行 pi session JSONL 直写检查（R1）...${NC}"

    if [ ! -f "$PI_DIRECT_WRITE_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $PI_DIRECT_WRITE_CHECKER${NC}"
    else
        python3 "$PI_DIRECT_WRITE_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] R1 pi session JSONL 直写检查失败${NC}"
            echo -e "${YELLOW}[INFO] session JSONL 本体唯一写方 = pi；例外与豁免登记见 docs/architecture/data-source-registry.md${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
        echo -e "${GREEN}[OK] R1 pi session 直写检查通过${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] R1 pi session 直写检查已跳过${NC}"
fi

# ============================================================================
# ws-client send 直调检查（D3 统一门面）
# ============================================================================

WS_SEND_CHECKER=".githooks/check_no_direct_ws_send.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_WS_SEND_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 ws-client send 直调检查...${NC}"

    if [ ! -f "$WS_SEND_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $WS_SEND_CHECKER${NC}"
    else
        python3 "$WS_SEND_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] ws-client send 直调检查失败${NC}"
            echo -e "${YELLOW}[INFO] renderer 禁止直调 ws-client.send，统一走 api client${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] ws-client send 直调检查已跳过${NC}"
fi

# ============================================================================
# runtime services 循环依赖检查（D6c 防护）
# ============================================================================

SERVICE_CYCLE_CHECKER=".githooks/check_no_service_cycle.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_NO_SERVICE_CYCLE_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 runtime services 循环依赖检查...${NC}"

    if [ ! -f "$SERVICE_CYCLE_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $SERVICE_CYCLE_CHECKER${NC}"
    else
        python3 "$SERVICE_CYCLE_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] runtime services 循环依赖检查失败（D6c）${NC}"
            echo -e "${YELLOW}[INFO] service 间不得具体类循环 import，改用接口/事件解耦${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] runtime services 循环依赖检查已跳过${NC}"
fi

# ============================================================================
# ============================================================================
# 架构约束登记检查（docs/constraints.json SSOT 的 machine enforcement 前置拦截）
#   - check_pi_type_leak.py         C-comm-02：services/transport 禁 PiXxx 类型（allowlist=存量待治理）
#   - check_services_infra_import.py C-comm-03：services 禁白名单外 infra value import
#   - check_shared_node_builtin.py  C-state-05：shared 禁 node: 内置 import
#   - check_runtime_meta_url.py     C-build-01：runtime 禁无 guard 的 import.meta.url / globalThis.__dirname
#   - check_staged_forbidden_lines.py C-ext-07/C-proc-04：staged 新增行禁 extensions console.warn/error
#                                    与无说明的 eslint-disable（行级增量，存量不拦）
#   注：与 R1 同例不设独立跳过开关，仅受 SKIP_ALL_CHECKS 总闸管辖。
# ============================================================================

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    print_section "[架构约束登记检查]"

    for CONSTRAINT_CHECKER in check_pi_type_leak.py check_services_infra_import.py check_shared_node_builtin.py check_runtime_meta_url.py check_staged_forbidden_lines.py; do
        CHECKER_PATH=".githooks/$CONSTRAINT_CHECKER"
        if [ ! -f "$CHECKER_PATH" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $CHECKER_PATH${NC}"
            continue
        fi
        echo -e "${BLUE}[INFO] 运行 $CONSTRAINT_CHECKER ...${NC}"
        python3 "$CHECKER_PATH"
        EXIT_CODE=$?
        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] $CONSTRAINT_CHECKER 检查失败${NC}"
            echo -e "${YELLOW}[INFO] 约束登记见 docs/constraints.json / docs/constraints.md（机器 SSOT + 人读视图）${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    done
    echo -e "${GREEN}[OK] 架构约束登记检查通过${NC}"
else
    echo -e "${YELLOW}[SKIP] 架构约束登记检查已跳过${NC}"
fi

# ============================================================================
# 约束登记 SSOT 一致性（constraints.json 改动时触发）
#   改 docs/constraints.json 后必须重跑 node scripts/render-constraints.mjs
#   生成 docs/constraints.md，防止 json/md 双份漂移。
# ============================================================================

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^docs/constraints\.json$"; then
        echo -e "${BLUE}[INFO] constraints.json 有变更，校验 md 同步...${NC}"
        node scripts/render-constraints.mjs --check
        EXIT_CODE=$?
        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] docs/constraints.md 与 constraints.json 不同步${NC}"
            echo -e "${YELLOW}[INFO] 运行 node scripts/render-constraints.mjs 重新生成后提交${NC}"
            exit 1
        fi
    fi
fi

# ============================================================================
# CSP 能力一致性检查（源码敏感 API vs index.html CSP 指令）
# ============================================================================

CSP_COMPAT_CHECKER=".githooks/check_csp_compatibility.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_CSP_COMPAT_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行 CSP 能力一致性检查...${NC}"

    if [ ! -f "$CSP_COMPAT_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $CSP_COMPAT_CHECKER${NC}"
    else
        python3 "$CSP_COMPAT_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] CSP 能力一致性检查失败${NC}"
            echo -e "${YELLOW}[INFO] 源码出现 eval/WebAssembly 用法但 CSP script-src 'self' 未放行——运行时会抛 CompileError${NC}"
            echo -e "${YELLOW}[INFO] 曾因此致全部 markdown 渲染静默降级纯文本（2026-08 v0.9.3+ 事故），改用无该能力的实现或显式改 CSP + 白名单${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] CSP 能力一致性检查已跳过${NC}"
fi

# ============================================================================
# Runtime Bundle 验证（runtime 源码有变更时触发）
# ============================================================================

RUNTIME_BUNDLE_CHECKER="scripts/validate-runtime-bundle.sh"
RUNTIME_SRC="packages/runtime/src"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_RUNTIME_BUNDLE_CHECK" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^$RUNTIME_SRC/"; then
        print_section "[Runtime Bundle 验证]"
        echo -e "${BLUE}[INFO] runtime 源码有变更，运行 Bundle 验证...${NC}"

        if [ ! -f "$RUNTIME_BUNDLE_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到验证脚本: $RUNTIME_BUNDLE_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        bash "$RUNTIME_BUNDLE_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] Runtime Bundle 验证失败${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] runtime 源码无变更，跳过 Bundle 验证${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] Runtime Bundle 验证已跳过${NC}"
fi

# ============================================================================
# 流写逃逸护栏（2026-09-04 runtime 整机崩溃事故护栏，与 ci.yml invariant 同源直调）
#   packages/runtime/src 有变更时触发：scripts/check-unsafe-stream-writes.mjs
#   （R1 裸流写 / R2 socket error 挂载 / R4 readline 转发吞咽）。豁免唯一登记
#   入口 = scripts/check-unsafe-stream-writes.allowlist.txt（随 git 跟踪，无参
#   调用自动读取；CLI 传参不生效——pre-commit/CI 均无参调用）。
#   [HISTORICAL] 本段曾只写入 .bare/hooks 运行时副本而漏掉本安装源：任何
#   worktree 的 pnpm install（prepare → 本脚本）都会用无护栏段的源覆盖运行时
#   hook，护栏静默失效（2026-09-04 S2 验收实测拦截失效后定位）。SSOT = 本文件。
#   注：不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# ============================================================================

UNSAFE_STREAM_CHECKER="scripts/check-unsafe-stream-writes.mjs"

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^$RUNTIME_SRC/"; then
        print_section "[流写逃逸护栏]"
        echo -e "${BLUE}[INFO] runtime 源码有变更，扫描流写逃逸风险...${NC}"

        if [ ! -f "$UNSAFE_STREAM_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到 $UNSAFE_STREAM_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        node "$UNSAFE_STREAM_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] runtime 源码无变更，跳过流写逃逸护栏${NC}"
    fi
fi

# ============================================================================
# 用户内容出站点守卫（adversarial-review-fixes A2 D-A2-3）
#   packages/runtime/src 有变更时触发：.githooks/check_prompt_outposts.py
#   扫描 .prompt( / .steer( / .followUp( 三方法全部调用点（任意接收者——防
#   client 变量名改写逃逸），对照白名单（文件 + 行内子串指纹 + 内容性质 +
#   注入状态 + 理由）；未登记新调用点即拦截——防新增用户内容出站通路忘挂
#   SkillInjector（MF-B @ 定向 / MF-C landing 首发同类缺口复发）。
#   注：不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# ============================================================================

PROMPT_OUTPOSTS_CHECKER=".githooks/check_prompt_outposts.py"

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^$RUNTIME_SRC/"; then
        print_section "[用户内容出站点守卫]"
        echo -e "${BLUE}[INFO] runtime 源码有变更，扫描用户内容出站点...${NC}"

        if [ ! -f "$PROMPT_OUTPOSTS_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到 $PROMPT_OUTPOSTS_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        python3 "$PROMPT_OUTPOSTS_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] runtime 源码无变更，跳过用户内容出站点守卫${NC}"
    fi
fi

# ============================================================================
# AC7 extension-host 边界检查（packages/core 源码有变更时触发）
# ============================================================================

BOUNDARY_CHECKER="scripts/verify-extension-host-boundaries.mjs"
CORE_SRC="packages/core/src"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_BOUNDARY_CHECK" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^$CORE_SRC/"; then
        print_section "[AC7 extension-host 边界检查]"
        echo -e "${BLUE}[INFO] core 源码有变更，运行 AC7 边界检查...${NC}"

        if [ ! -f "$BOUNDARY_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到验证脚本: $BOUNDARY_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        node "$BOUNDARY_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] AC7 边界检查失败：extension-host 消费端不得 import domain/stores/composables${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] core 源码无变更，跳过 AC7 边界检查${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] AC7 边界检查已跳过${NC}"
fi

# ============================================================================
# 打包配置预检查（electron-builder.yml / tsup.config.ts / resources/pi 有变更时触发）
# ============================================================================

PREFLIGHT_CHECKER="scripts/preflight-check.sh"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_PREFLIGHT_CHECK" != "1" ]; then
    if echo "$STAGED_FILES" | grep -qE "^apps/electron/electron-builder\.yml$|^packages/runtime/tsup\.config\.ts$|^resources/pi/[^/]+$"; then
        print_section "[打包配置预检查]"
        echo -e "${BLUE}[INFO] 打包配置有变更，运行 preflight 检查...${NC}"

        if [ ! -f "$PREFLIGHT_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到验证脚本: $PREFLIGHT_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        bash "$PREFLIGHT_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] 打包配置预检查失败${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        # electron-builder.yml 或 tsup.config.ts 变更时，额外运行 runtime bundle 验证
        # 包含 CJS smoke test（第 6 步），能拦截 files/asarUnpack 不一致等打包配置错误
        if echo "$STAGED_FILES" | grep -qE '^apps/electron/electron-builder\.yml$|^packages/runtime/tsup\.config\.ts$'; then
            echo -e "${BLUE}[INFO] 打包配置变更，额外运行 runtime bundle 验证（含 smoke test）...${NC}"
            bash "$RUNTIME_BUNDLE_CHECKER"
            if [ $? -ne 0 ]; then
                echo -e "${RED}[ERROR] Runtime bundle 验证失败（可能需要重新 build）${NC}"
                echo -e "${YELLOW}[FIX] cd packages/runtime && pnpm run build，然后重新 commit${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    else
        echo -e "${GREEN}[OK] 打包配置无变更，跳过 preflight 检查${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] 打包配置预检查已跳过${NC}"
fi

# ============================================================================
# 目录规范检查（禁止 demos/impeccable 目录 + 禁止外部 symlink）
# ============================================================================

DIRECTORY_RULES_CHECKER=".githooks/check_directory_rules.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_DIRECTORY_RULES_CHECK" != "1" ]; then
    echo -e "${BLUE}[INFO] 运行目录规范检查..."

    if [ ! -f "$DIRECTORY_RULES_CHECKER" ]; then
        echo -e "${YELLOW}[WARN] 找不到检查脚本 $DIRECTORY_RULES_CHECKER${NC}"
    else
        python3 "$DIRECTORY_RULES_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo ""
            echo -e "${RED}[ERROR] 目录规范检查失败${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] 目录规范检查已跳过${NC}"
fi

# ============================================================================
# i18n CJK 残留检测（.vue 模板不得含硬编码中文）
# ============================================================================

I18N_CJK_CHECKER=".githooks/check_i18n_cjk.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_I18N_CJK_CHECK" != "1" ]; then
    # 仅当 staged 含 .vue 文件时检查
    STAGED_VUE=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/src/.*\.vue$" || true)
    if [ -n "$STAGED_VUE" ]; then
        echo -e "${BLUE}[INFO] 运行 i18n CJK 残留检测...${NC}"

        if [ ! -f "$I18N_CJK_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $I18N_CJK_CHECKER${NC}"
        else
            ABSOLUTE_VUE=""
            for FILE in $STAGED_VUE; do
                ABSOLUTE_VUE="$ABSOLUTE_VUE $PROJECT_ROOT/$FILE"
            done

            python3 "$I18N_CJK_CHECKER" $ABSOLUTE_VUE
            EXIT_CODE=$?

            if [ $EXIT_CODE -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] i18n CJK 残留检测失败：模板含硬编码中文${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] i18n CJK 残留检测已跳过${NC}"
fi

# ============================================================================
# i18n locale 双侧 key 对齐检查（zh-CN === en-US）
# ============================================================================

I18N_LOCALE_CHECKER=".githooks/check_i18n_locale_sync.py"

if [ "$SKIP_ALL_CHECKS" != "1" ] && [ "$SKIP_I18N_LOCALE_SYNC_CHECK" != "1" ]; then
    # 仅当 staged 含 locale .ts 文件时检查
    LOCALE_CHANGED=$(echo "$STAGED_FILES" | grep -E "^packages/renderer/src/i18n/locales/.*\.ts$" || true)
    if [ -n "$LOCALE_CHANGED" ]; then
        echo -e "${BLUE}[INFO] 运行 i18n locale 双侧 key 对齐检查...${NC}"

        if [ ! -f "$I18N_LOCALE_CHECKER" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 $I18N_LOCALE_CHECKER${NC}"
        else
            python3 "$I18N_LOCALE_CHECKER"
            EXIT_CODE=$?

            if [ $EXIT_CODE -ne 0 ]; then
                echo ""
                echo -e "${RED}[ERROR] i18n locale 双侧 key 不一致：zh-CN 与 en-US key 集合 desync${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    fi
else
    echo -e "${YELLOW}[SKIP] i18n locale 双侧对齐检查已跳过${NC}"
fi

# ============================================================================
# pi 边界可靠性护栏（pi-boundary-reliability §3.3 D7 G1/G3/G4，U7b 接线）
#   - G1 pi 语义登记守卫：node scripts/check-pi-semantics.mjs（全仓校验：
#     registry schema / 探针存在性 / pi 三包 + runtime pin 四包版本门禁；
#     无 git index 依赖，每次必跑）
#   - pi-sync 派生锚点守卫：node scripts/check-pi-sync.mjs（pi-evolution-consistency
#     §3.2 D2：build.yml env / prepare 脚本默认值 / 快照 / extensions peerDeps /
#     KNOWN_PI_API_TYPES / pi-tui / dev binary 8 项；与 G1 零重叠，按路径触发）
#   - G3 思考档位差分探针：node scripts/diff-probe-thinking.mjs（registry
#     计算路径 vs pi-ai 同源函数逐模型比对）；staged 含四个触发文件之一时跑
#   - G4 subagent 通道禁则：python3 .githooks/check_subagent_channels.py
#     （C-ext-19：禁白名单外 deliverAs steer/nextTurn 与裸 "--model" 拼装）；
#     staged 含 subagent-workflow 目录时全包扫描
#   注：不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# ============================================================================

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    print_section "[pi 边界可靠性护栏]"

    # G1：pi 语义登记守卫
    if [ ! -f "scripts/check-pi-semantics.mjs" ]; then
        echo -e "${RED}[ERROR] 找不到 scripts/check-pi-semantics.mjs（U7a 交付物缺失）${NC}"
        exit 1
    fi
    if ! node scripts/check-pi-semantics.mjs; then
        echo -e "${RED}[ERROR] G1 pi 语义登记守卫未通过——按上方 ✗ 明细逐条恢复（每条自带动作）后重试${NC}"
        echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
        exit 1
    fi

    # pi-sync 派生锚点守卫（pi-evolution-consistency §3.2 D2，按路径触发——性能考虑，
    # 只在触碰派生锚点文件时全量跑：根 package.json / lockfile / build.yml / prepare 脚本 /
    # 快照 / gen 脚本 / shared constants / extensions 任一 package.json / 守卫脚本自身）。
    # 触发面在主 STAGED_FILES（ACMR）外并入 staged 删除列表（--diff-filter=D）：删除派生锚点
    # 必须触发守卫——各 S 项对锚点文件不存在自带 fail 分支（S1/S2/S3/S6），漏触发 = 删除场景
    # 静默放行。主 STAGED_FILES 保持 ACMR 不放行 D：会把已删除的 .ts/package.json 路径喂给
    # ESLint / manifest 等文件存在性检查段致 ERR，影响面大，仅守卫挂载点需要 D。
    # 与 G1 逐项零重叠（设计 §2.1 分工声明）；不占 G 编号（G1/G3/G4 属 pi-boundary-reliability 体系）。
    STAGED_DELETED=$(git diff --cached --name-only --diff-filter=D)
    PI_SYNC_TRIGGER_FILES="${STAGED_FILES}
${STAGED_DELETED}"
    if echo "$PI_SYNC_TRIGGER_FILES" | grep -qE "(^|/)(package\.json|pnpm-lock\.yaml)$|^(\.github/workflows/build\.yml|scripts/prepare-pi-resources\.sh|scripts/check-pi-sync\.mjs|packages/runtime/src/generated/builtin-providers\.json|packages/runtime/scripts/gen-builtin-providers\.mjs|packages/shared/src/constants\.ts)$|^extensions/.*/package\.json$"; then
        echo -e "${BLUE}[INFO] pi 派生锚点文件有变更，运行 pi-sync 派生锚点守卫...${NC}"
        if [ ! -f "scripts/check-pi-sync.mjs" ]; then
            echo -e "${RED}[ERROR] 找不到 scripts/check-pi-sync.mjs（u2 交付物缺失）${NC}"
            exit 1
        fi
        if ! node scripts/check-pi-sync.mjs; then
            echo -e "${RED}[ERROR] pi-sync 派生锚点守卫未通过——按上方 ✗ 明细逐条恢复（每条自带动作）后重试${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] 无 pi 派生锚点文件变更，跳过 pi-sync 守卫${NC}"
    fi

    # G3：registry vs pi-ai 差分探针（触发文件：档位链路四文件任一 staged，basename 匹配）
    if echo "$STAGED_FILES" | grep -qE "(^|/)(thinking-levels\.ts|use-provider-edit\.ts|builtin-providers\.json|model-capability\.ts)$"; then
        echo -e "${BLUE}[INFO] 档位链路文件有变更，运行 G3 差分探针...${NC}"
        if ! node scripts/diff-probe-thinking.mjs; then
            echo -e "${RED}[ERROR] G3 差分探针失败：registry 计算路径与 pi-ai 同源函数不一致${NC}"
            echo -e "${YELLOW}[INFO] 恢复动作：按上方 ✗ 明细核对 model-capability.ts 的档位计算后重试${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] 无档位链路文件变更，跳过 G3 差分探针${NC}"
    fi

    # G4：subagent-workflow 通道禁则（staged 含该包文件时；检查器内部全包扫描）
    if echo "$STAGED_FILES" | grep -q "^extensions/universal/subagent-workflow/"; then
        echo -e "${BLUE}[INFO] subagent-workflow 有变更，运行 G4 通道禁则检查...${NC}"
        if [ ! -f ".githooks/check_subagent_channels.py" ]; then
            echo -e "${YELLOW}[WARN] 找不到检查脚本 .githooks/check_subagent_channels.py${NC}"
        else
            if ! python3 .githooks/check_subagent_channels.py; then
                echo -e "${RED}[ERROR] G4 subagent 通道禁则检查失败（C-ext-19）——按上方明细与修复指引处理${NC}"
                echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
                exit 1
            fi
        fi
    else
        echo -e "${GREEN}[OK] 无 subagent-workflow 变更，跳过 G4 通道禁则${NC}"
    fi
else
    echo -e "${YELLOW}[SKIP] pi 边界可靠性护栏已跳过${NC}"
fi

# ============================================================================
# subagent-core 依赖闭包守卫（D9-① + 检查点 5，subagent-core 包抽离 u1-guards）
#   packages/subagent-core/** 变更时触发：scripts/check-subagent-core-closure.mjs
#   校验 C 的 dependencies/peerDependencies/optionalDependencies/源码 import 闭包不含
#   pi SDK 与宿主专属依赖（@earendil-works/*、pi-extension-logger、pi-pending-notifications、
#   session-delivery、pi-file-lock），附版本双源一致性断言（src/index.ts
#   CORE_PACKAGE_VERSION ≡ package.json version）与检查点 5 断言（worker 入口子图零
#   host-services/notify-ports——worker 内零宿主服务）。守卫脚本自身变更同样触发。
#   dist 回归门（D9-②：build + require CJS dist + golden 回放）不进 pre-commit
#   （改构建面，秒级耗时也属发布门职责），挂发布管线 npm-prerelease.sh /
#   release-npm.yml。
#   注：不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# 触发面在主 STAGED_FILES（ACMR）外并入本路径范围的 staged 删除（不带 --diff-filter
# 的 pathspec 清单，天然含 D）：单独 staged 删除守卫脚本也必须触发——下方 [ ! -f ]
# 存在性检查正是删除场景的防线，ACMR 过滤 D 导致漏触发 = 删除静默放行。主
# STAGED_FILES 保持 ACMR 的理由见上方 pi-sync 段注释（D 喂给 ESLint/manifest 等
# 文件存在性检查段会 ERR，仅守卫挂载点需要 D）。
# ============================================================================

SUBAGENT_CORE_STAGED=$(git diff --cached --name-only -- packages/subagent-core/ scripts/check-subagent-core-closure.mjs)
if echo "$SUBAGENT_CORE_STAGED" | grep -qE "^packages/subagent-core/|^scripts/check-subagent-core-closure\.mjs$"; then
    print_section "[subagent-core 依赖闭包守卫]"
    if [ ! -f "scripts/check-subagent-core-closure.mjs" ]; then
        echo -e "${RED}[ERROR] 找不到 scripts/check-subagent-core-closure.mjs（u1-guards 交付物缺失）${NC}"
        exit 1
    fi
    if ! node scripts/check-subagent-core-closure.mjs; then
        echo -e "${RED}[ERROR] subagent-core 依赖闭包守卫未通过——pi SDK / 宿主专属依赖回流闭包，按上方 ✗ 明细处理${NC}"
        echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] subagent-core 依赖闭包守卫通过${NC}"
fi

# ============================================================================
# subagent-service 聚合边界守卫（H3/R5，subagent-service-decomposition S3 依赖单向）
#   staged 命中六聚合（packages/subagent-core/src/execution/service/）或壳
#   （subagent-service.ts）或守卫脚本自身时触发：
#   scripts/check-subagent-service-boundary.mjs —— 三方向检查（聚合→聚合 import
#   台账门 + 环检测 / 聚合→壳 import 禁则 / 跨聚合私有访问 grep 门）+ 支撑文件
#   方向门（service-bootstrap/service-constants，H3/R6 扩）。
#   合法边台账（ALLOWED_EDGES）以符号级精确登记在守卫脚本内（现状两条：
#   ResolvedIdentity type-only ×2，依据 D-R4-8；[HISTORICAL] 建立时第三条
#   ENV_SELF_RECORD_ID 常量单向 D-R3-2 已随 R6 常量归位删除）。
#   触发面并入本路径范围的 staged 删除（pathspec 清单天然含 D）：单独 staged 删除
#   守卫脚本也必须触发——下方 [ ! -f ] 存在性检查正是删除场景的防线。
#   注：不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# ============================================================================

SUBAGENT_SVC_BOUNDARY_STAGED=$(git diff --cached --name-only -- packages/subagent-core/src/execution/service/ packages/subagent-core/src/execution/subagent-service.ts scripts/check-subagent-service-boundary.mjs)
if echo "$SUBAGENT_SVC_BOUNDARY_STAGED" | grep -qE "^packages/subagent-core/src/execution/service/|^packages/subagent-core/src/execution/subagent-service\.ts$|^scripts/check-subagent-service-boundary\.mjs$"; then
    print_section "[subagent-service 聚合边界守卫]"
    if [ ! -f "scripts/check-subagent-service-boundary.mjs" ]; then
        echo -e "${RED}[ERROR] 找不到 scripts/check-subagent-service-boundary.mjs（H3/R5 守卫交付物缺失）${NC}"
        exit 1
    fi
    if ! node scripts/check-subagent-service-boundary.mjs; then
        echo -e "${RED}[ERROR] subagent-service 聚合边界守卫未通过——聚合间协作走壳 deps 注入或显式接口，聚合读壳能力经注入函数非 import（设计 D4）${NC}"
        echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] subagent-service 聚合边界守卫通过${NC}"
else
    echo -e "${GREEN}[OK] 无 service 聚合/壳变更，跳过 subagent-service 聚合边界守卫${NC}"
fi

# ============================================================================
# ============================================================================
# record 持久化写面守卫（H4/S4/D7，subagent-record-persistence-consolidation）
#   staged 命中 record 写面载体（packages/subagent-core/src/）、extensions 扫描根
#   全域（extensions/**/src，与守卫脚本扫描根对齐）或守卫脚本自身时触发：
#   [HISTORICAL] 原触发面仅 extensions/universal/subagent-workflow/src 一包，触发
#   面外的包（如 session-reader）违规只能延迟暴露（阶段 3 一致性审查 P2）——扩为
#   结构无关的 glob 全域匹配，新增分组/包零维护（同上方 EXTENSION_PKG_FILES
#   两段式改造的教训：禁止与目录结构耦合的清单式写法）。
#   scripts/check-record-write-surface.mjs —— grep 门兜底（R1 六名写函数直调 +
#   R2 subagent-record entry 直写，store 外零命中）。一级拦截 = eslint
#   no-restricted-imports（eslint.config.mjs subagent-core 块，模块边界级）；
#   本门拦的是 import 层拦不住的类方法调用（ManifestStore.writeManifest）与
#   字面量写形态。触发面并入本路径范围的 staged 删除（pathspec 清单天然含 D）：
#   单独 staged 删除守卫脚本也必须触发——下方 [ ! -f ] 存在性检查正是删除场景
#   的防线。不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# ============================================================================

RECORD_WRITE_SURFACE_STAGED=$(git diff --cached --name-only -- packages/subagent-core/src/ ':(glob)extensions/**/src/**' scripts/check-record-write-surface.mjs)
if echo "$RECORD_WRITE_SURFACE_STAGED" | grep -qE "^packages/subagent-core/src/|^extensions/.*/src/|^scripts/check-record-write-surface\.mjs$"; then
    print_section "[record 持久化写面守卫]"
    if [ ! -f "scripts/check-record-write-surface.mjs" ]; then
        echo -e "${RED}[ERROR] 找不到 scripts/check-record-write-surface.mjs（H4/U5 守卫交付物缺失）${NC}"
        exit 1
    fi
    if ! node scripts/check-record-write-surface.mjs; then
        echo -e "${RED}[ERROR] record 持久化写面守卫未通过——store 外 record 写面直写，按上方 ✗ 明细与 Recovery 指引改调 RecordStore 意图原语${NC}"
        echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] record 持久化写面守卫通过${NC}"
else
    echo -e "${GREEN}[OK] 无 record 写面载体变更，跳过 record 持久化写面守卫${NC}"
fi

# 文档-代码符号漂移守卫（C-proc-10）
#   staged 命中映射设计文档（docs/design/）或 update 源码模块或守卫脚本自身时触发：
#   scripts/check-doc-symbol-drift.mjs —— TypeScript AST 提取源码符号表 × 设计文档
#   反引号符号候选，文档引用已删除/改名符号即拦截。
#   [HISTORICAL] 2026-08-31：update 路径常量函数化后设计文档 3 处旧常量引用
#   （UPDATE_DIR / MANUAL_ASSET_DIR×2）悬空存活，无机器信号，靠事后对抗审查才抓出。
#   不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# ============================================================================

DOC_SYMBOL_STAGED=$(git diff --cached --name-only -- docs/design/ apps/electron/main/update/ scripts/check-doc-symbol-drift.mjs TEST-STRATEGY.md docs/testing/)
if echo "$DOC_SYMBOL_STAGED" | grep -qE "^docs/design/|^apps/electron/main/update/|^scripts/check-doc-symbol-drift\.mjs$|^TEST-STRATEGY\.md$|^docs/testing/"; then
    print_section "[文档-代码符号漂移守卫]"
    if [ ! -f "scripts/check-doc-symbol-drift.mjs" ]; then
        echo -e "${RED}[ERROR] 找不到 scripts/check-doc-symbol-drift.mjs（守卫脚本被删除）${NC}"
        exit 1
    fi
    if ! node scripts/check-doc-symbol-drift.mjs; then
        echo -e "${RED}[ERROR] 文档符号/路径漂移：文档引用了源码中不存在的符号或仓库路径（删除/改名未同步文档）——按上方 ✗ 明细修正文档后重试${NC}"
        echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] 文档-代码符号一致性通过${NC}"
else
    echo -e "${GREEN}[OK] 无设计文档/update 源码变更，跳过文档符号漂移守卫${NC}"
fi

# ============================================================================
# 消息流滚动跟随链路守卫（约束 C-state-11，chat-pin-bottom-fix §4.4 护栏⑤）
#   staged 命中跟随链路（composables/panel/ 或 MessageStream.vue）或守卫脚本自身时触发：
#   scripts/check-scroll-follow.mjs —— ① 跟随链路内 scrollToIndex 只许白名单
#   （useVirtuaFollow 唯一原语 / useMessageStreamRail rail 导航）② packages/renderer/src
#   禁 findItemIndex(...scrollSize 模式（排除 __tests__ 与 *.test.ts，注释行豁免）。
#   [顺序依赖] M1（U1 索引直取 + D6 vlistBottom 修正）把禁用模式归零后 M2 才挂接
#   （设计 §4.4⑤ 顺序依赖声明；守卫防复发而非清存量）。
#   触发面在主 STAGED_FILES 外并入本路径范围的 staged 删除（pathspec 清单天然含 D）：
#   单独 staged 删除守卫脚本也必须触发，存在性检查正是删除场景防线。
#   注：不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兑底）。
# ============================================================================

SCROLL_FOLLOW_STAGED=$(git diff --cached --name-only -- packages/renderer/src/composables/panel/ packages/renderer/src/components/panel/MessageStream.vue scripts/check-scroll-follow.mjs)
if echo "$SCROLL_FOLLOW_STAGED" | grep -qE "^packages/renderer/src/composables/panel/|^packages/renderer/src/components/panel/MessageStream\.vue$|^scripts/check-scroll-follow\.mjs$"; then
    print_section "[消息流滚动跟随链路守卫]"
    if [ ! -f "scripts/check-scroll-follow.mjs" ]; then
        echo -e "${RED}[ERROR] 找不到 scripts/check-scroll-follow.mjs（守卫脚本被删除）${NC}"
        exit 1
    fi
    if ! node scripts/check-scroll-follow.mjs; then
        echo -e "${RED}[ERROR] 滚动跟随链路守卫失败——按上方 ✗ 明细与 [FIX] 指引修复后重试${NC}"
        echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] 滚动跟随链路守卫通过（C-state-11）${NC}"
else
    echo -e "${GREEN}[OK] 无跟随链路变更，跳过滚动跟随守卫${NC}"
fi

# ============================================================================
# 测试 flake 卫生检查（F5 no-bail + F3 递归删除重试）
#   [HISTORICAL] 一族「测试自身引入的满载 flake」中两类静态可检模式：
#     F5 - 根 package.json scripts.test 缺 --no-bail：pnpm 递归 first-fail 即中止
#         尾部包执行，一次 flake 只暴露首个失败包，掩盖失败全貌（commit b7ec0298a）。
#     F3 - 测试内 recursive 删除缺 maxRetries：teardown 递归删除与在途异步写竞争，
#         满载下 ENOTEMPTY 满载 flake（commit d9ad39cb8）。
#   F5 每次提交都跑（读一个 json，成本 ~0）；F3 仅 staged 命中测试文件 pattern
#   （/test/、/__tests__/、.test.ts、.test.mjs、.spec.ts，排除 node_modules）时扫描，
#   checker 内部按同一 pattern 过滤，无命中零成本。不设独立 SKIP_* 开关
#   （R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# ============================================================================

FLAKE_HYGIENE_CHECKER=".githooks/check_test_flake_hygiene.py"
TEST_FILE_STAGED=$(echo "$STAGED_FILES" | grep -E "(/test/|/__tests__/|\.test\.(ts|mjs)|\.spec\.ts$)" | grep -v "node_modules" || true)

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    print_section "[测试 flake 卫生检查]"
    if [ ! -f "$FLAKE_HYGIENE_CHECKER" ]; then
        echo -e "${RED}[ERROR] 找不到检查脚本 $FLAKE_HYGIENE_CHECKER${NC}"
        exit 1
    fi
    if [ -n "$TEST_FILE_STAGED" ]; then
        echo -e "${BLUE}[INFO] staged 含测试文件，同时扫描 recursive 删除 maxRetries 规则...${NC}"
    fi
    # if ! 形态跑 checker：set -e 下非零退出会先于 EXIT_CODE=$? 捕获终止本 hook
    if ! python3 "$FLAKE_HYGIENE_CHECKER"; then
        echo ""
        echo -e "${RED}[ERROR] 测试 flake 卫生检查失败${NC}"
        echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] 测试 flake 卫生检查通过${NC}"
else
    echo -e "${YELLOW}[SKIP] 测试 flake 卫生检查已跳过${NC}"
fi

# ============================================================================
# Provider 凭据读取单通道守卫（C-proc-14/15，catalog-provider-field-authority §3.3 D3/D6）
#   packages/runtime/src 有变更时触发：scripts/check-provider-credential-reads.mjs
#   守卫 A——凭据直查禁令（getApiKeyForProvider / readAuthCredentials /
#   getProviderConfig(...).apiKey，白名单 = resolver 唯一通道本体）；守卫 B——
#   upsertProvider 直调清单（白名单 = 写入载体 / importer / 迁移链 / IConfigStore
#   实现，堵防线载体被旁路的复发通道）。
#   注：不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
# ============================================================================

PROVIDER_CRED_READS_CHECKER="scripts/check-provider-credential-reads.mjs"

if [ "$SKIP_ALL_CHECKS" != "1" ]; then
    if echo "$STAGED_FILES" | grep -q "^$RUNTIME_SRC/"; then
        print_section "[Provider 凭据读取单通道守卫]"
        echo -e "${BLUE}[INFO] runtime 源码有变更，扫描凭据直查与 upsertProvider 直调...${NC}"

        if [ ! -f "$PROVIDER_CRED_READS_CHECKER" ]; then
            echo -e "${RED}[ERROR] 找不到 $PROVIDER_CRED_READS_CHECKER${NC}"
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi

        node "$PROVIDER_CRED_READS_CHECKER"
        EXIT_CODE=$?

        if [ $EXIT_CODE -ne 0 ]; then
            echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
            exit 1
        fi
    else
        echo -e "${GREEN}[OK] runtime 源码无变更，跳过 Provider 凭据读取守卫${NC}"
    fi
fi

# ============================================================================
# 数据布局字面量守卫（C-pi-14，设计 §10 U18）
#   staged 命中守卫范围（packages/ apps/ scripts/ 源码 + AGENTS.md +
#   docs/troubleshooting.md + 守卫脚本自身）时触发：
#   scripts/check-layout-literals.mjs —— 旧布局 pi/ 兄弟层字面量（join 形态
#   'pi','agent'|'sessions' 与路径形态 pi/agent|pi/sessions，显式排除 .pi 前缀）
#   回流即拦截。合法持有（bundled 资源布局/迁移语义/历史证据）集中登记在
#   守卫的 LAYOUT_LITERAL_EXEMPT 常量表（file 级 + 理由）。
#   全量扫描毫秒级，无增量模式。不设独立 SKIP_* 开关（R1 后惯例，总闸兜底）。
# ============================================================================

LAYOUT_STAGED=$(git diff --cached --name-only -- packages/ apps/ scripts/ AGENTS.md docs/troubleshooting.md scripts/check-layout-literals.mjs)
if echo "$LAYOUT_STAGED" | grep -qE "^(packages/|apps/|scripts/)|^AGENTS\.md$|^docs/troubleshooting\.md$"; then
    print_section "[数据布局字面量守卫]"
    if [ ! -f "scripts/check-layout-literals.mjs" ]; then
        echo -e "${RED}[ERROR] 找不到 scripts/check-layout-literals.mjs（C-pi-14 守卫交付物缺失）${NC}"
        exit 1
    fi
    if ! node scripts/check-layout-literals.mjs; then
        echo -e "${RED}[ERROR] 数据布局字面量守卫未通过——旧布局 pi/ 兄弟层引用回流（C-pi-14），按上方 ✗ 明细与恢复动作处理${NC}"
        echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] 数据布局字面量守卫通过（C-pi-14）${NC}"
else
    echo -e "${GREEN}[OK] 无守卫范围变更，跳过数据布局字面量守卫${NC}"
fi

# ============================================================================
# 全部通过
# ============================================================================

print_section "[所有检查通过]"

echo -e "${GREEN}代码质量检查全部通过！${NC}"
echo ""
echo -e "${RED}[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。${NC}"
echo ""

exit 0
HOOK_EOF

# chmod 755 对齐原产物权限（原路径 cat 创建 644 + chmod +x = 755；mktemp 基础
# 权限 600，仅 +x 会得 700，静默改变权限位）。mv 前任何失败：set -e 退出触发
# EXIT trap 清理临时文件，目标路径保持完整旧内容。
chmod 755 "$PRE_COMMIT_TMP"
mv -f "$PRE_COMMIT_TMP" "$GIT_HOOKS_DIR/pre-commit"
trap - EXIT

# [2026-09-11 独立 hooks 改造] worktree 模式：将本 worktree 的 hooksPath 指向独立目录并自检。
# worktree 级 core.hooksPath 覆盖 commondir 共享副本，是本 worktree 隔离生效的开关本身——
# 缺失即退回共享行为，必须显式校验，不能静默。
if [ "$IS_WORKTREE" = true ]; then
    git -C "$PROJECT_ROOT" config --worktree core.hooksPath "$GIT_HOOKS_DIR"
    INSTALLED_HOOKS_PATH=$(git -C "$PROJECT_ROOT" config --worktree --get core.hooksPath 2>/dev/null || true)
    if [ "$INSTALLED_HOOKS_PATH" != "$GIT_HOOKS_DIR" ]; then
        echo -e "${RED}[ERROR] worktree 独立 hooksPath 设置失败（期望 $GIT_HOOKS_DIR，实得 ${INSTALLED_HOOKS_PATH:-<空>}）${NC}"
        echo -e "${YELLOW}[FIX] 确认 extensions.worktreeConfig 已开启：git config extensions.worktreeConfig true；再重跑本脚本${NC}"
        exit 1
    fi
    echo -e "${GREEN}[OK] worktree 独立 hooks 已生效：core.hooksPath=$GIT_HOOKS_DIR${NC}"
fi

# 安装后自检：生成的 pre-commit 必须含流写逃逸护栏段。
# 防「源缺段/heredoc 生成失败」——本脚本源若缺护栏段或 heredoc 损坏，此处 exit 1 拦下。
# 边界：防不了「旧版源覆盖」（旧源无此自检，静默装旧版），该残留风险登记在
# docs/design/runtime-stream-fault-isolation.impl-plan.md §7 变更历史 2026-09-04 条目。
# 匹配护栏段功能行（变量赋值），不匹配任意出现——仅残留注释/引用的坏源同样拦下。
if ! grep -q 'UNSAFE_STREAM_CHECKER=' "$GIT_HOOKS_DIR/pre-commit"; then
    echo -e "${RED}[ERROR] 安装后自检失败：生成的 pre-commit 缺少流写逃逸护栏段（check-unsafe-stream-writes）${NC}"
    echo -e "${YELLOW}[FIX] 安装源已过期或 heredoc 损坏：对照 docs/design/runtime-stream-fault-isolation.md §5 核对本 worktree 的 .githooks/install-hooks.sh 是否含护栏段，更新到最新分支后重跑 bash .githooks/install-hooks.sh${NC}"
    exit 1
fi

echo -e "${GREEN}[OK] pre-commit hook 安装完成${NC}"
echo ""

if [ -x "$GIT_HOOKS_DIR/pre-commit" ]; then
    echo -e "${GREEN}[OK] Hook 已正确设置可执行权限${NC}"
fi

echo ""
echo -e "${BLUE}======================================${NC}"
echo -e "${GREEN}[安装完成]${NC}"
echo -e "${BLUE}======================================${NC}"
echo ""
echo -e "${CYAN}已安装的检查项目:${NC}"
echo -e "  ${GREEN}[+]${NC} 前端 ESLint 代码检查"
echo -e "  ${GREEN}[+]${NC} vue-tsc 类型检查（全量 + 测试 tsconfig，与 CI 等价）"
echo -e "  ${GREEN}[+]${NC} pi extensions ESLint + tsc 类型检查（extensions/ 目录）"
echo -e "  ${GREEN}[+]${NC} pi extensions manifest & convention 检查（禁废弃 namespace / 禁 console.log / pi manifest 字段）"
echo -e "  ${GREEN}[+]${NC} extension 结构一致性检查（分组/role/依赖台账/一层路径残留）"
echo -e "  ${GREEN}[+]${NC} extension npm 发布 files 白名单守卫（import 闭包 ⊆ files）"
echo -e "  ${GREEN}[+]${NC} Vue 组件规范检查（禁止原生 HTML、Emoji、自定义 CSS）"
echo -e "  ${GREEN}[+]${NC} Sidecar session 隔离检查"
echo -e "  ${GREEN}[+]${NC} CSS tokens 检查"
echo -e "  ${GREEN}[+]${NC} ENV_WHITELIST_PREFIXES SSOT 单一性检查"
echo -e "  ${GREEN}[+]${NC} Pi extension tool schema 顶层 Object 合规检查（OpenAI 兼容性）"
echo -e "  ${GREEN}[+]${NC} 路径白名单动态化检查"
echo -e "  ${GREEN}[+]${NC} R1 pi session JSONL 直写检查（data-source-governance，指向 data-source-registry.md）"
echo -e "  ${GREEN}[+]${NC} 目录规范检查（禁止 demos/impeccable + 外部 symlink）"
echo -e "  ${GREEN}[+]${NC} ws-client send 直调检查（D3 统一门面）"
echo -e "  ${GREEN}[+]${NC} runtime services 循环依赖检查（D6c 防护）"
echo -e "  ${GREEN}[+]${NC} CSP 能力一致性检查（源码 eval/WebAssembly vs index.html CSP 指令）"
echo -e "  ${GREEN}[+]${NC} Runtime Bundle 验证（依赖打包 + CJS 兼容 + 健康检查）"
echo -e "  ${GREEN}[+]${NC} 流写逃逸护栏（runtime 变更时触发：R1 裸流写 / R2 socket error / R4 readline 转发）"
echo -e "  ${GREEN}[+]${NC} 用户内容出站点守卫（runtime 变更时触发：prompt/steer/followUp 调用点白名单，防忘挂 SkillInjector）"
echo -e "  ${GREEN}[+]${NC} AC7 extension-host 边界检查（core 变更时触发，禁 domain/stores import）"
echo -e "  ${GREEN}[+]${NC} 打包配置预检查（asarUnpack/files 一致性 + symlink 检查）"
echo -e "  ${GREEN}[+]${NC} i18n CJK 残留检测（.vue 模板不得含硬编码中文）"
echo -e "  ${GREEN}[+]${NC} i18n locale 双侧 key 对齐检查（zh-CN === en-US）"
echo -e "  ${GREEN}[+]${NC} pi 边界可靠性护栏（G1 语义登记守卫 / G3 档位差分探针 / G4 subagent 通道禁则）"
echo -e "  ${GREEN}[+]${NC} subagent-core 依赖闭包守卫（D9-① 闭包 + 检查点 5 worker 零宿主服务）"
echo -e "  ${GREEN}[+]${NC} subagent-service 聚合边界守卫（H3/R5：聚合间 import 台账 + 聚合→壳禁则 + 私有互调门）"
echo -e "  ${GREEN}[+]${NC} 文档-代码符号漂移守卫（C-proc-10：设计文档引用已删除/改名符号即拦截）"
echo -e "  ${GREEN}[+]${NC} 消息流滚动跟随链路守卫（C-state-11：滚动到底唯一原语 + 禁 findItemIndex(scrollSize) 模式）"
echo -e "  ${GREEN}[+]${NC} 测试 flake 卫生检查（F5 scripts.test --no-bail + F3 recursive 删除 maxRetries）"
echo -e "  ${GREEN}[+]${NC} Provider 凭据读取单通道守卫（runtime 变更时触发：凭据直查禁令 + upsertProvider 直调清单，C-proc-14/15）"
echo -e "  ${GREEN}[+]${NC} 数据布局字面量守卫（C-pi-14：pi/ 兄弟布局引用回流拦截，豁免集中 LAYOUT_LITERAL_EXEMPT）"
echo ""
echo -e "${CYAN}Hook 脚本位置:${NC} .githooks/"
echo ""