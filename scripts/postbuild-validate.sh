#!/bin/bash
# scripts/postbuild-validate.sh — 打包后产物验证
#
# 检查项：
# 1. 产物存在性（dmg/exe/AppImage）
# 2. macOS/Windows unpacked app 结构（main executable, asar, runtime, native resources）
# 3. asar 内容正确性
# 4. renderer WASM chunk 检查（CSP 能力防线：产物级拦截依赖暗藏的可执行 WASM）
# 5. 产物大小合理性
#
# 用法: ./scripts/postbuild-validate.sh [--ci] [--dir-only]（参数顺序无关）

set -euo pipefail

# 检查失败原则：任何非 0 退出都输出（不管从哪个 exit 点）
trap '[ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。" >&2' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 参数解析（位置无关：循环遍历所有 args，任意顺序解析结果一致）：
# - --dir-only：只验证 unpacked 目录（跳过安装器产物检查）
# - --ci：接受的 no-op flag。原 CI_MODE 变量自 main 起设置后全脚本无读取点
#   （死变量，grep 全仓确认），已删除；build.yml 调用仍传 --ci，保留解析以兼容。
DIR_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --dir-only) DIR_ONLY=true ;;
        --ci) ;; # no-op（原 CI_MODE 死变量已删）
        *) echo "未知参数: ${arg}（支持: --ci --dir-only），已忽略" >&2 ;;
    esac
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# staged 引擎 CLI 包完整性校验（W9，设计 §3.7 Electron 打包态，三平台共用）：
# bundle-extensions.mjs 预 bundle 到 resources/engines/<id>/ + electron-builder
# extraResources 拷贝。断言：目录存在、每引擎 index.js 存在且可执行（发现器
# canExecute 判据）、package.json 的 manifest id == 目录名、bin 映射指向 ./index.js。
# 任一失败 = 打包配置回归（bundle 脚本漏跑 / yml extraResources 漏拷 / staged 退化）。
check_staged_engines() {
    local engines_dir="$1"
    if [ ! -d "$engines_dir" ]; then
        echo -e "  ${RED}✗${NC} engines 目录缺失: ${engines_dir}（检查 bundle-extensions.mjs 引擎 staging + electron-builder.yml extraResources）"
        return 1
    fi
    local failed=0 count=0
    for engine_dir in "$engines_dir"/*/; do
        [ -d "$engine_dir" ] || continue
        count=$((count + 1))
        local engine_id; engine_id="$(basename "$engine_dir")"
        if [ ! -x "${engine_dir}index.js" ]; then
            echo -e "  ${RED}✗${NC} engine ${engine_id} 缺可执行 index.js: ${engine_dir}index.js"
            failed=1
            continue
        fi
        if ! node -e '
            const fs = require("fs");
            const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const m = pkg["taiji"]?.subagentEngine;
            const ok = m?.id === process.argv[2]
                && typeof m?.bin === "string" && m.bin !== ""
                && pkg.bin?.[m.bin] === "./index.js";
            process.exit(ok ? 0 : 1);
        ' "${engine_dir}package.json" "$engine_id" 2>/dev/null; then
            echo -e "  ${RED}✗${NC} engine ${engine_id} staged package.json manifest/bin 无效（id≠目录名 或 bin 未指向 ./index.js）"
            failed=1
        fi
    done
    if [ "$count" -eq 0 ]; then
        echo -e "  ${RED}✗${NC} engines 目录为空: ${engines_dir}（packages/*-subagent-cli 未 staged）"
        return 1
    fi
    if [ "$failed" -ne 0 ]; then return 1; fi
    echo -e "  ${GREEN}✓${NC} staged engines 完整性校验通过（$count engines: ${engines_dir}）"
    return 0
}

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Postbuild Validation]${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

OUTPUT_DIR="$PROJECT_ROOT/apps/electron/dist/builder-output"
FAILED=0

# ── 1. 产物存在性 ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[1/6] Build artifacts...${NC}"

if [ "$DIR_ONLY" = true ]; then
    # dir-only 模式：跳过安装器产物检查，只验证 unpacked 目录存在
    UNPACKED_COUNT=0
    [ -d "$OUTPUT_DIR/mac-arm64" ] && UNPACKED_COUNT=$((UNPACKED_COUNT + 1))
    [ -d "$OUTPUT_DIR/win-unpacked" ] && UNPACKED_COUNT=$((UNPACKED_COUNT + 1))
    [ -d "$OUTPUT_DIR/linux-unpacked" ] && UNPACKED_COUNT=$((UNPACKED_COUNT + 1))
    if [ "$UNPACKED_COUNT" -eq 0 ]; then
        echo -e "  ${RED}✗ dir-only 模式：未找到任何 unpacked 目录${NC}"
        FAILED=1
    else
        echo -e "  ${GREEN}✓ dir-only 模式：找到 $UNPACKED_COUNT 个 unpacked 目录${NC}"
    fi
else
    ARTIFACT_COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 \( -name "*.dmg" -o -name "*.exe" -o -name "*.AppImage" \) | wc -l | tr -d ' ')
    if [ "$ARTIFACT_COUNT" -eq 0 ]; then
        echo -e "  ${RED}✗ 未找到任何构建产物${NC}"
        FAILED=1
    else
        echo -e "  ${GREEN}✓ 找到 $ARTIFACT_COUNT 个产物${NC}"
    fi
fi

# ── 2. macOS app 结构 ──────────────────────────────────────────────
if [ -d "$OUTPUT_DIR/mac-arm64" ]; then
    echo ""
    echo -e "${BLUE}[2/6] macOS app structure...${NC}"

    APP_PATH=$(find "$OUTPUT_DIR/mac-arm64" -name "*.app" -maxdepth 1 | head -1)

    if [ -n "$APP_PATH" ] && [ -d "$APP_PATH" ]; then
        # Info.plist
        if [ -f "$APP_PATH/Contents/Info.plist" ]; then
            echo -e "  ${GREEN}✓${NC} Info.plist"
        else
            echo -e "  ${RED}✗${NC} Info.plist 缺失"
            FAILED=1
        fi

        # main executable
        MAIN_EXE=$(find "$APP_PATH/Contents/MacOS" -type f -maxdepth 1 | head -1)
        if [ -n "$MAIN_EXE" ]; then
            echo -e "  ${GREEN}✓${NC} Main: $(basename "$MAIN_EXE")"
        else
            echo -e "  ${RED}✗${NC} 无 main executable"
            FAILED=1
        fi

        # asar
        if [ -f "$APP_PATH/Contents/Resources/app.asar" ]; then
            echo -e "  ${GREEN}✓${NC} app.asar"

            # 检查关键文件在 asar 内
            if npx asar list "$APP_PATH/Contents/Resources/app.asar" 2>/dev/null | grep -q "dist/main/main.cjs"; then
                echo -e "  ${GREEN}✓${NC} dist/main/main.cjs in asar"
            else
                echo -e "  ${RED}✗${NC} dist/main/main.cjs NOT in asar"
                FAILED=1
            fi

            if npx asar list "$APP_PATH/Contents/Resources/app.asar" 2>/dev/null | grep -q "dist/preload/preload.cjs"; then
                echo -e "  ${GREEN}✓${NC} dist/preload/preload.cjs in asar"
            else
                echo -e "  ${RED}✗${NC} dist/preload/preload.cjs NOT in asar"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} app.asar 缺失"
            FAILED=1
        fi

        # asar.unpacked
        if [ -d "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime" ]; then
            echo -e "  ${GREEN}✓${NC} runtime in app.asar.unpacked"
            RUNTIME_SIZE=$(du -sm "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime" | cut -f1)
            echo -e "  ℹ  Runtime size: ${RUNTIME_SIZE}MB"

            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/index.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/index.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/index.cjs 缺失"
                FAILED=1
            fi

            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/plugin-bootstrap.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/plugin-bootstrap.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/plugin-bootstrap.cjs 缺失"
                FAILED=1
            fi

            # plugin-bootstrap-process.cjs：sandbox 子进程（fork）入口，重构 3 新增产物。
            # 缺失则 sandbox 插件子进程无法启动（host-process resolveAndValidateFile 定位失败）。
            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/plugin-bootstrap-process.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/plugin-bootstrap-process.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/plugin-bootstrap-process.cjs 缺失"
                FAILED=1
            fi

            # plugin-esm-loader.cjs：sandbox 子进程 ESM resolve hook（execArgv --import 注入）。
            # 缺失则 sandbox ESM import 绕过未封堵（node:fs 等越权 import 放行），
            # plugin-service.resolveEsmLoaderExecArgv fail-open 仅 console.error 不阻断启动。
            if [ -f "$APP_PATH/Contents/Resources/app.asar.unpacked/dist/runtime/plugin-esm-loader.cjs" ]; then
                echo -e "  ${GREEN}✓${NC} runtime/plugin-esm-loader.cjs"
            else
                echo -e "  ${RED}✗${NC} runtime/plugin-esm-loader.cjs 缺失"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} app.asar.unpacked/dist/runtime 缺失"
            FAILED=1
        fi

        # node-pty helperPath guard — 防 postinstall patch 静默失效
        # scripts/fix-node-pty-permissions.sh 给 node-pty lib/unixTerminal.js 加
        # helperPath 二次 asar 替换 guard（等价上游 PR #924）。该 patch 用 grep
        # 匹配源文件，node-pty 升级若改了行格式则匹配失败——patch 脚本只 warn 不
        # fail（postinstall 不应阻断 install），patch 静默未应用，打包后终端重新
        # 坏掉但 CI 无感知。此处检查产物 unixTerminal.js 含 guard 标记，捕获此类
        # 静默回归。整个 node-pty 被 asarUnpack，runtime 实际加载的就是 unpacked
        # 这份（app.asar 内的副本不会被加载），故只查 app.asar.unpacked 副本。
        UNIX_TERMINAL_IN_APP="$APP_PATH/Contents/Resources/app.asar.unpacked/node_modules/node-pty/lib/unixTerminal.js"
        if [ -f "$UNIX_TERMINAL_IN_APP" ]; then
            echo -e "  ℹ  node-pty helperPath guard..."
            if grep -q "helperPath.indexOf('app.asar.unpacked')" "$UNIX_TERMINAL_IN_APP"; then
                echo -e "  ${GREEN}✓${NC} unixTerminal.js 含 helperPath guard（postinstall patch 生效）"
            else
                echo -e "  ${RED}✗${NC} unixTerminal.js 缺 helperPath guard — postinstall patch 可能未应用（node-pty 升级？）"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} app.asar.unpacked/node_modules/node-pty/lib/unixTerminal.js 缺失（无法验证 helperPath guard）"
            FAILED=1
        fi

        # node-pty prebuilds 平台裁剪守卫 — u2（设计 batch3 §3.2.2）靠 electron-builder.yml
        # mac 平台段 files 排除 win32-*/darwin-x64 prebuilds。yml 回退或 electron-builder
        # 升级改变 files 匹配语义时，全平台 prebuilds 会静默回到产物（死重 + 体积回涨），
        # CI 无感。产物级断言：prebuilds 目录仅含 darwin-arm64，且 pty.node/spawn-helper 在位
        # （darwin-arm64 被误裁时 S5 冒烟前在此捕获）。node-pty 整包 asarUnpack，prebuilds
        # 目录本身缺失亦属回归。
        PTY_PREBUILDS_DIR="$APP_PATH/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds"
        if [ -d "$PTY_PREBUILDS_DIR" ]; then
            PTY_FOREIGN_PLATFORMS=$(find "$PTY_PREBUILDS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name 'darwin-arm64' -exec basename {} \;)
            if [ -n "$PTY_FOREIGN_PLATFORMS" ]; then
                echo -e "  ${RED}✗${NC} node-pty prebuilds 含非 darwin-arm64 平台目录:$(echo "$PTY_FOREIGN_PLATFORMS" | tr '\n' ' ')"
                echo -e "        u2 平台裁剪疑似被回退——检查 electron-builder.yml mac 段 files 的 prebuilds 排除行（设计 batch3 §3.2.2）"
                FAILED=1
            elif [ -f "$PTY_PREBUILDS_DIR/darwin-arm64/pty.node" ] && [ -f "$PTY_PREBUILDS_DIR/darwin-arm64/spawn-helper" ]; then
                echo -e "  ${GREEN}✓${NC} node-pty prebuilds 仅 darwin-arm64（pty.node + spawn-helper 在位）"
            else
                echo -e "  ${RED}✗${NC} node-pty darwin-arm64 native 缺失（pty.node/spawn-helper）: $PTY_PREBUILDS_DIR/darwin-arm64"
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} node-pty prebuilds 目录缺失: $PTY_PREBUILDS_DIR"
            FAILED=1
        fi

        # extraResources (pi binary)
        if [ -d "$APP_PATH/Contents/Resources/pi" ]; then
            echo -e "  ${GREEN}✓${NC} pi binary in Resources"

            # 致命：pi 目录中不能有指向外部绝对路径的 symlink
            PI_SYMLINK=$(find "$APP_PATH/Contents/Resources/pi" -maxdepth 1 -type l 2>/dev/null | head -1)
            if [ -n "$PI_SYMLINK" ]; then
                echo -e "  ${RED}✗${NC} Resources/pi 存在 symlink: $(basename "$PI_SYMLINK")"
                FAILED=1
            else
                echo -e "  ${GREEN}✓${NC} Resources/pi 无 symlink"
            fi
        fi

        # extraResources: bin/taiji-settings CLI（tsup 打包的 cli.cjs，pi Skill 引用）
        # 与两个 extension.js 同模式校验（electron-builder from 错误只警告不失败）。
        if [ -f "$APP_PATH/Contents/Resources/bin/taiji-settings" ]; then
            echo -e "  ${GREEN}✓${NC} bin/taiji-settings in Resources"
        else
            echo -e "  ${RED}✗${NC} bin/taiji-settings 缺失（检查 electron-builder.yml from 路径 dist/runtime/cli.cjs）"
            FAILED=1
        fi
        # builtin pi extensions 完整性校验（index.js 存在 / 无 .ts 残留 R3 / permission wasm / dry-run import）
        # prepare-builtin-extensions.sh 部署 + electron-builder extraResources 拷贝。
        # 复用 verify-staged-extensions.mjs：文件级校验 + import dry-run（external 缺失降级，
        # prod 环境无 node_modules 属预期，pi runtime 提供）。
        BUILTIN_EXT_DIR="$APP_PATH/Contents/Resources/extensions/@zhushanwen"
        if [ -d "$BUILTIN_EXT_DIR" ]; then
            if node "$PROJECT_ROOT/scripts/verify-staged-extensions.mjs" --staged-dir "$BUILTIN_EXT_DIR" > /tmp/ext-verify-mac.log 2>&1; then
                echo -e "  ${GREEN}✓${NC} builtin ext 完整性校验通过（verify-staged）"
            else
                echo -e "  ${RED}✗${NC} builtin ext 完整性校验失败（缺 index.js / 残留 .ts / 缺 wasm）:"
                sed 's/^/    /' /tmp/ext-verify-mac.log
                FAILED=1
            fi
        else
            echo -e "  ${RED}✗${NC} builtin ext 目录缺失: ${BUILTIN_EXT_DIR}（检查 prepare-builtin-extensions.sh + electron-builder.yml）"
            FAILED=1
        fi
        # staged subagent 引擎 CLI（W9，三平台共用 check_staged_engines）
        if ! check_staged_engines "$APP_PATH/Contents/Resources/engines"; then
            FAILED=1
        fi
        # builtin taiji plugins 完整性校验（resources/plugins/<name>，如 statusline）
        # prepare-builtin-plugins.sh 预编译 index.js + electron-builder extraResources 拷贝。
        # registry 打包后扫描 <cwd>/resources/plugins；缺入口文件则插件静默不被发现或
        # 激活必炸（ERR_UNSUPPORTED_DIR_IMPORT，2026-08-16 statusline 从未激活成功事故）。
        # 入口 SSOT = 各插件 package.json 的 taijiPlugin.main（缺省 index.js）。
        BUILTIN_PLUGINS_DIR="$APP_PATH/Contents/Resources/resources/plugins"
        if [ -d "$BUILTIN_PLUGINS_DIR" ]; then
            PLUGINS_MISSING=0
            for plugin_dir in "$BUILTIN_PLUGINS_DIR"/*/; do
                plugin_name="$(basename "$plugin_dir")"
                main_entry=$(node -e "const p=require(process.argv[1]);process.stdout.write(p.taijiPlugin?.main ?? 'index.js')" "${plugin_dir}package.json" 2>/dev/null || echo "")
                if [ -z "$main_entry" ] || [ ! -f "${plugin_dir}${main_entry}" ]; then
                    echo -e "  ${RED}✗${NC} builtin plugin ${plugin_name} 缺入口 ${main_entry:-<manifest 无效>}"
                    PLUGINS_MISSING=1
                fi
            done
            if [ "$PLUGINS_MISSING" -ne 0 ]; then
                FAILED=1
            else
                PLUGIN_COUNT=$(find "$BUILTIN_PLUGINS_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
                echo -e "  ${GREEN}✓${NC} builtin plugins 完整性校验通过（$PLUGIN_COUNT plugins）"
            fi
        else
            echo -e "  ${RED}✗${NC} builtin plugins 目录缺失: ${BUILTIN_PLUGINS_DIR}（检查 prepare-builtin-plugins.sh + electron-builder.yml）"
            FAILED=1
        fi
    else
        echo -e "  ${YELLOW}⚠ 未找到 .app 目录${NC}"
    fi
else
    echo ""
    echo -e "${YELLOW}[2/6] macOS 结构跳过（非 macOS 构建）${NC}"
fi

# ── Windows unpacked app structure ───────────────────────────────────
if [ -d "$OUTPUT_DIR/win-unpacked" ]; then
    echo ""
    echo -e "${BLUE}[2/6] Windows unpacked app structure...${NC}"
    WIN_ROOT="$OUTPUT_DIR/win-unpacked"
    WIN_RESOURCES="$WIN_ROOT/resources"
    WIN_UNPACKED="$WIN_RESOURCES/app.asar.unpacked"

    for required in \
        "$WIN_ROOT/TaiJi.exe" \
        "$WIN_UNPACKED/dist/runtime/index.cjs" \
        "$WIN_UNPACKED/dist/runtime/plugin-bootstrap.cjs" \
        "$WIN_UNPACKED/dist/runtime/plugin-bootstrap-process.cjs" \
        "$WIN_UNPACKED/dist/runtime/plugin-esm-loader.cjs" \
        "$WIN_RESOURCES/pi/pi-windows-x64.exe" \
        "$WIN_RESOURCES/bin/taiji-settings"; do
        if [ -f "$required" ]; then
            echo -e "  ${GREEN}✓${NC} ${required#$WIN_ROOT/}"
        else
            echo -e "  ${RED}✗${NC} ${required#$WIN_ROOT/} 缺失"
            FAILED=1
        fi
    done
    # builtin pi extensions（Windows 同 mac 校验，复用 verify-staged）
    WIN_BUILTIN="$WIN_RESOURCES/extensions/@zhushanwen"
    if [ -d "$WIN_BUILTIN" ]; then
        if node "$PROJECT_ROOT/scripts/verify-staged-extensions.mjs" --staged-dir "$WIN_BUILTIN" > /tmp/ext-verify-win.log 2>&1; then
            echo -e "  ${GREEN}✓${NC} builtin ext 完整性校验通过（verify-staged）"
        else
            echo -e "  ${RED}✗${NC} builtin ext 完整性校验失败:"
            sed 's/^/    /' /tmp/ext-verify-win.log
            FAILED=1
        fi
    else
        echo -e "  ${RED}✗${NC} builtin ext 目录缺失: $WIN_BUILTIN"
        FAILED=1
    fi
    # staged subagent 引擎 CLI（W9，三平台共用 check_staged_engines）
    if ! check_staged_engines "$WIN_RESOURCES/engines"; then
        FAILED=1
    fi
    # builtin taiji plugins（Windows 同 mac 校验：每插件 manifest main 入口存在）
    WIN_PLUGINS_DIR="$WIN_RESOURCES/resources/plugins"
    if [ -d "$WIN_PLUGINS_DIR" ]; then
        WIN_PLUGINS_MISSING=0
        for plugin_dir in "$WIN_PLUGINS_DIR"/*/; do
            plugin_name="$(basename "$plugin_dir")"
            main_entry=$(node -e "const p=require(process.argv[1]);process.stdout.write(p.taijiPlugin?.main ?? 'index.js')" "${plugin_dir}package.json" 2>/dev/null || echo "")
            if [ -z "$main_entry" ] || [ ! -f "${plugin_dir}${main_entry}" ]; then
                echo -e "  ${RED}✗${NC} builtin plugin ${plugin_name} 缺入口 ${main_entry:-<manifest 无效>}"
                WIN_PLUGINS_MISSING=1
            fi
        done
        if [ "$WIN_PLUGINS_MISSING" -ne 0 ]; then
            FAILED=1
        else
            echo -e "  ${GREEN}✓${NC} builtin plugins 完整性校验通过"
        fi
    else
        echo -e "  ${RED}✗${NC} builtin plugins 目录缺失: $WIN_PLUGINS_DIR"
        FAILED=1
    fi

    WINDOWS_PTY_PREBUILDS="$WIN_UNPACKED/node_modules/node-pty/prebuilds/win32-x64"
    WINDOWS_PTY_MISSING=0
    for required_native in \
        "$WINDOWS_PTY_PREBUILDS/conpty.node" \
        "$WINDOWS_PTY_PREBUILDS/pty.node"; do
        if [ -f "$required_native" ]; then
            echo -e "  ${GREEN}✓${NC} node-pty Windows native: ${required_native#$WIN_ROOT/}"
        else
            echo -e "  ${RED}✗${NC} node-pty Windows native 缺失: ${required_native#$WIN_ROOT/}"
            WINDOWS_PTY_MISSING=1
        fi
    done
    if [ "$WINDOWS_PTY_MISSING" -ne 0 ]; then
        FAILED=1
    fi
fi

# ── Linux unpacked app structure ─────────────────────────────────────
# dir-only 模式（ci.yml）也执行本段：只要 linux-unpacked 目录存在就校验结构，
# 否则 linux 平台打包回归（tsup noExternal 缺失、extraResources from 路径错等）
# CI 捕获不到，延迟到 release 才暴露。
# 布局依据：executableName 动态读自 electron-builder.yml（曾硬编码旧 bin 名，
# 2026-08 TaiJi 品牌重命名后 CI 断裂——禁止再硬编码可执行名）；
# asarUnpack dist/runtime/**/* 与 win 段同构；pi binary 名 prepare-pi-resources.sh
# BINARY_NAME="pi-linux-${PI_ARCH}"（linux target arch x64）。
if [ -d "$OUTPUT_DIR/linux-unpacked" ]; then
    echo ""
    echo -e "${BLUE}[2/6] Linux unpacked app structure...${NC}"
    LINUX_ROOT="$OUTPUT_DIR/linux-unpacked"
    LINUX_RESOURCES="$LINUX_ROOT/resources"
    LINUX_UNPACKED="$LINUX_RESOURCES/app.asar.unpacked"
    LINUX_EXECUTABLE="$(grep -E '^executableName:' apps/electron/electron-builder.yml | head -1 | awk '{print $2}')"

    if [ -z "$LINUX_EXECUTABLE" ]; then
        echo -e "  ${RED}✗${NC} 无法从 apps/electron/electron-builder.yml 解析 executableName"
        FAILED=1
    else
        for required in \
            "$LINUX_ROOT/$LINUX_EXECUTABLE" \
            "$LINUX_UNPACKED/dist/runtime/index.cjs" \
            "$LINUX_UNPACKED/dist/runtime/plugin-bootstrap.cjs" \
            "$LINUX_RESOURCES/pi/pi-linux-x64" \
            "$LINUX_RESOURCES/bin/taiji-settings"; do
            if [ -f "$required" ]; then
                echo -e "  ${GREEN}✓${NC} ${required#$LINUX_ROOT/}"
            else
                echo -e "  ${RED}✗${NC} ${required#$LINUX_ROOT/} 缺失"
                FAILED=1
            fi
        done
    fi
    # builtin pi extensions（Linux 同 mac/win 校验，复用 verify-staged）。builtin 迁移
    # npm 包化（2026-08）时 mac/win 补了本校验、linux 覆盖丢失（PR #185 review S1），
    # extraResources from 路径错等 linux 专属回归将静默漏检。
    LINUX_BUILTIN="$LINUX_RESOURCES/extensions/@zhushanwen"
    if [ -d "$LINUX_BUILTIN" ]; then
        if node "$PROJECT_ROOT/scripts/verify-staged-extensions.mjs" --staged-dir "$LINUX_BUILTIN" > /tmp/ext-verify-linux.log 2>&1; then
            echo -e "  ${GREEN}✓${NC} builtin ext 完整性校验通过（verify-staged）"
        else
            echo -e "  ${RED}✗${NC} builtin ext 完整性校验失败:"
            sed 's/^/    /' /tmp/ext-verify-linux.log
            FAILED=1
        fi
    else
        echo -e "  ${RED}✗${NC} builtin ext 目录缺失: ${LINUX_BUILTIN}（检查 prepare-builtin-extensions.sh + electron-builder.yml）"
        FAILED=1
    fi
    # staged subagent 引擎 CLI（W9，三平台共用 check_staged_engines）
    if ! check_staged_engines "$LINUX_RESOURCES/engines"; then
        FAILED=1
    fi
fi
# ── 3. renderer WASM chunk 检查（CSP 能力防线，产物级）───────────────
# 背景：renderer CSP script-src 'self' 不放行 WASM。shiki 已换 createJavaScriptRegexEngine
# （markdown.ts），但 bundle-full 入口仍静态携带 oniguruma loader（dead code，tree-shake
# 边界）——白名单放行其 chunk 基名。新增依赖若把可执行 WASM 带进 renderer 产物（基名
# 不在白名单），在此拦截，防止「依赖暗藏 WASM → CSP CompileError → 功能静默降级」复发
# （2026-08 v0.9.3+ 事故：全部 markdown 渲染退化为纯文本、换行丢失）。
# 白名单维护原则：确认该 chunk 的 WASM 路径运行时不可达（如显式传入 JS engine 后的
# dead loader）才可加入；真正需要 WASM 时改 index.html CSP（加 'wasm-unsafe-eval'）并
# 同步本检查与 .githooks/check_csp_compatibility.py（源码级防线）。
echo ""
echo -e "${BLUE}[3/6] renderer WASM chunk check (CSP guard)...${NC}"
RENDERER_DIST_ASSETS="$PROJECT_ROOT/apps/electron/renderer/dist/assets"
INDEX_HTML_CSP="$PROJECT_ROOT/packages/renderer/index.html"
if [ ! -d "$RENDERER_DIST_ASSETS" ]; then
    echo -e "  ${RED}✗${NC} renderer 产物缺失: ${RENDERER_DIST_ASSETS}（先 pnpm --filter @taiji/frontend run build）"
    FAILED=1
elif grep -q "wasm-unsafe-eval\|unsafe-eval" "$INDEX_HTML_CSP"; then
    echo -e "  ${YELLOW}⚠ CSP 已放行 eval/wasm，WASM 是被允许的能力，跳过本检查${NC}"
else
    # 基名 = chunk 文件名去掉末段 8 位 hash（如 shiki-DeyQNefO → shiki）
    WASM_CHUNK_ALLOWLIST='^(shiki|wasm|wit|onig|markdown)$'
    WASM_VIOLATIONS=""
    WASM_TOTAL=0
    for js in "$RENDERER_DIST_ASSETS"/*.js; do
        grep -q "WebAssembly" "$js" 2>/dev/null || continue
        WASM_TOTAL=$((WASM_TOTAL + 1))
        base=$(basename "$js" .js | sed -E 's/-[A-Za-z0-9_-]{8}$//')
        echo "$base" | grep -qE "$WASM_CHUNK_ALLOWLIST" && continue
        WASM_VIOLATIONS="$WASM_VIOLATIONS $base($(basename "$js"))"
    done
    if [ -n "$WASM_VIOLATIONS" ]; then
        echo -e "  ${RED}✗${NC} renderer 产物新增含 WebAssembly 的 chunk（不在白名单）:$WASM_VIOLATIONS"
        echo -e "        CSP script-src 'self' 下 WebAssembly.instantiate 运行时抛 CompileError → 功能静默降级"
        echo -e "        修复：改用无 WASM 实现（参考 markdown.ts 的 createJavaScriptRegexEngine）；"
        echo -e "        或确认必需后改 index.html CSP 加 'wasm-unsafe-eval' 并同步更新本脚本白名单"
        FAILED=1
    else
        echo -e "  ${GREEN}✓${NC} renderer WASM chunk 检查通过（$WASM_TOTAL 个白名单 chunk 含 WebAssembly dead-code 残留）"
    fi
fi

echo -e "${BLUE}[4/6] Artifact sizes...${NC}"

for f in "$OUTPUT_DIR"/*.dmg "$OUTPUT_DIR"/*.exe "$OUTPUT_DIR"/*.AppImage; do
    if [ -f "$f" ]; then
        SIZE_MB=$(du -m "$f" | cut -f1)
        echo -e "  ℹ  $(basename "$f"): ${SIZE_MB}MB"

        if [[ "$f" == *.dmg ]] && [ "$SIZE_MB" -gt 800 ]; then
            echo -e "  ${YELLOW}⚠ DMG 超过 800MB，检查是否有多余文件${NC}"
        fi
    fi
done

# ── 4. Smoke test ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[5/6] Smoke test (optional)...${NC}"

if [ "$(uname)" = "Darwin" ]; then
    APP_BUNDLE=$(find "$OUTPUT_DIR/mac-arm64" -name "*.app" -maxdepth 1 2>/dev/null | head -1)
    if [ -n "$APP_BUNDLE" ]; then
        echo -e "  ${YELLOW}⚠ Smoke test 需要手动执行：open -a \"$APP_BUNDLE\"${NC}"
    fi
fi

# ── 5. 代码签名状态 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[6/6] Code signature...${NC}"

if [ "$(uname)" = "Darwin" ] && [ -n "${APP_BUNDLE:-}" ]; then
    if command -v codesign &>/dev/null; then
        if codesign --verify --verbose=0 "$APP_BUNDLE" 2>&1; then
            echo -e "  ${GREEN}✓ 代码签名有效${NC}"
        else
            echo -e "  ${YELLOW}⚠ 未签名（本地开发正常，分发需签名）${NC}"
        fi
    else
        echo -e "  ${YELLOW}⚠ codesign 不可用${NC}"
    fi
fi

# ── 结果 ───────────────────────────────────────────────────────────
echo ""
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}[OK] Postbuild 验证全部通过${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
else
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}[FAIL] Postbuild 验证有失败项${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi