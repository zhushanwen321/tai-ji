#!/bin/bash
# validate-runtime-bundle.sh — 验证 runtime 打包产物可正常启动
#
# 检查项：
# 1. tsup build 产物存在（index.cjs + plugin-bootstrap.cjs）
# 2. 产物包含所有 runtime dependencies（semver, fast-glob, ws）
# 3. CJS 产物不依赖 import.meta（兼容 Electron 子进程 ELECTRON_RUN_AS_NODE）
# 4. 产物自包含验证（所有依赖已打入 bundle）
# 5. plugin-bootstrap.cjs 可独立解析（Worker Thread 入口）
# 6. 产物能正常启动（health check）
# 7. 插件系统非 mock 端到端验收（隔离 runtime + 真实插件，~8s；verify-plugin-e2e.sh）
#
# 用法: ./scripts/validate-runtime-bundle.sh [--ci]
#   --ci    CI 模式：严格模式，任何失败都会退出码非 0

set -e

# 检查失败原则提示（合并进 cleanup EXIT trap，避免覆盖）
__check_principle() {
  [ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。" >&2
  return 0
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CI_MODE=false
if [ "$1" = "--ci" ]; then
    CI_MODE=true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Gate 0：pnpm store 布局守卫——布局被沙箱执行体（zsw 引擎 HOME 覆盖）翻转时，
# 下方 verify-plugin-e2e 的自含 install 会以 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
# 硬崩；先拦下给出可操作指引（见 docs/TROUBLESHOOTING.md「pnpm store 布局双向翻转」）。
bash "$PROJECT_ROOT/.githooks/check_pnpm_store_layout.sh" || exit 1

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Runtime Bundle 验证]${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

RUNTIME_DIR="$PROJECT_ROOT/packages/runtime"
DIST_RUNTIME="$PROJECT_ROOT/apps/electron/dist/runtime"
BUNDLE_PATH="$DIST_RUNTIME/index.cjs"
BOOTSTRAP_PATH="$DIST_RUNTIME/plugin-bootstrap.cjs"
BOOTSTRAP_PROCESS_PATH="$DIST_RUNTIME/plugin-bootstrap-process.cjs"
ESM_LOADER_PATH="$DIST_RUNTIME/plugin-esm-loader.cjs"

# ── 1. Build 产物存在（index.cjs + plugin-bootstrap.cjs + 子进程产物）──
echo ""
echo -e "${BLUE}[1/6] 检查 build 产物...${NC}"

if [ ! -f "$BUNDLE_PATH" ] || [ ! -f "$BOOTSTRAP_PATH" ] || [ ! -f "$BOOTSTRAP_PROCESS_PATH" ] || [ ! -f "$ESM_LOADER_PATH" ]; then
    echo -e "${YELLOW}[WARN] 产物不完整，先运行 build...${NC}"
    # runtime tsup（format cjs）对 @zhushanwen/subagent-core 走 require 条件 -> packages/subagent-core/dist/*.cjs，
    # dist 被 .gitignore（fresh checkout 无产物），须先链式构建 core（与 electron build:runtime 同链）
    pnpm --filter @zhushanwen/subagent-core run build
    cd "$RUNTIME_DIR" && pnpm run build
fi

if [ ! -f "$BUNDLE_PATH" ]; then
    echo -e "${RED}[ERROR] 产物不存在: $BUNDLE_PATH${NC}"
    exit 1
fi
if [ ! -f "$BOOTSTRAP_PATH" ]; then
    echo -e "${RED}[ERROR] Worker bootstrap 不存在: $BOOTSTRAP_PATH${NC}"
    echo -e "${YELLOW}[FIX] tsup entry 必须包含 plugin-bootstrap.ts，输出为 plugin-bootstrap.cjs${NC}"
    exit 1
fi
if [ ! -f "$BOOTSTRAP_PROCESS_PATH" ]; then
    echo -e "${RED}[ERROR] 子进程 bootstrap 不存在: $BOOTSTRAP_PROCESS_PATH${NC}"
    echo -e "${YELLOW}[FIX] tsup entry 必须包含 plugin-bootstrap-process.ts（fork 子进程入口，host-process resolveAndValidateFile 定位）${NC}"
    exit 1
fi
if [ ! -f "$ESM_LOADER_PATH" ]; then
    echo -e "${RED}[ERROR] ESM loader 不存在: $ESM_LOADER_PATH${NC}"
    echo -e "${YELLOW}[FIX] tsup entry 必须包含 plugin-esm-loader.cjs（sandbox 子进程 execArgv --import 注入目标）${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] 产物存在: index.cjs + plugin-bootstrap.cjs + plugin-bootstrap-process.cjs + plugin-esm-loader.cjs${NC}"

# ── 1b. staged 引擎 CLI 包（W9，设计 §3.7 Electron 打包态）────────────
# bundle-extensions.mjs 把 packages/*-subagent-cli bundle 到
# apps/electron/resources/engines/<id>/；缺失/退化（漏跑 bundle / 引擎包 manifest
# 坏 / index.js 不可执行）在此拦截——否则 electron-builder extraResources 静默拷空，
# 打包态引擎发现零命中，延迟到 release 后 GUI 才暴露。
echo ""
echo -e "${BLUE}[1b/6] 检查 staged 引擎包...${NC}"
STAGED_ENGINES="$PROJECT_ROOT/apps/electron/resources/engines"
if ! node -e '
const fs = require("fs"), path = require("path");
const root = process.argv[1];
const fail = (msg) => { console.error(`[ERROR] ${msg}`); process.exit(1); };
let entries;
try { entries = fs.readdirSync(root, { withFileTypes: true }); }
catch { fail(`engines staged 根缺失: ${root}（先跑 node scripts/bundle-extensions.mjs）`); }
const dirs = entries.filter((e) => e.isDirectory());
if (dirs.length === 0) fail(`engines staged 根为空: ${root}（packages/*-subagent-cli 未 staged = 打包回归）`);
for (const d of dirs) {
  const dir = path.join(root, d.name);
  const idx = path.join(dir, "index.js");
  try { if (!fs.statSync(idx).isFile() || !(fs.statSync(idx).mode & 0o111)) fail(`engine ${d.name}: index.js 缺失或不可执行: ${idx}`); }
  catch { fail(`engine ${d.name}: index.js 缺失: ${idx}`); }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const m = pkg["xyz-agent"]?.subagentEngine;
  if (m?.id !== d.name || typeof m?.bin !== "string" || m.bin === "" || pkg.bin?.[m.bin] !== "./index.js")
    fail(`engine ${d.name}: staged package.json manifest/bin 无效`);
  console.log(`[OK] engine ${d.name}: index.js + manifest 有效`);
}
' "$STAGED_ENGINES"; then
    echo -e "${YELLOW}[FIX] 运行 node scripts/bundle-extensions.mjs 重新 staged，并核对 packages/*-subagent-cli 的 xyz-agent.subagentEngine manifest${NC}"
    exit 1
fi

# ── 2. 依赖打包检查 ─────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[2/6] 检查依赖是否打包（noExternal）...${NC}"

# 从 package.json 读取 dependencies（过滤 workspace:* 协议依赖——它们被 tsup inline，
# 包名在 bundle 中消失是预期行为，第 4 步 grep 包名检查不适用）
RUNTIME_PKG="$RUNTIME_DIR/package.json"
DEPS=$(node -e "
const p=require('$RUNTIME_PKG');
const deps=p.dependencies||{};
console.log(Object.keys(deps).filter(k=>!deps[k].startsWith('workspace:')).join('\n'));
")

# 从 tsup.config.ts 读取 noExternal 配置
TSUP_CONFIG="$RUNTIME_DIR/tsup.config.ts"
NO_EXTERNAL=$(node -e "
const fs=require('fs');
const content=fs.readFileSync('$TSUP_CONFIG','utf-8');
const match=content.match(/noExternal:\\s*\\[([^\\]]+)\\]/);
if(match) console.log(match[1].split(/[,\n]/).map(s=>s.trim().replace(/['\"]/g,'')).filter(Boolean).join('\n'));
else console.log('');
")

MISSING=""
NATIVE_SKIPPED=""
for dep in $DEPS; do
    if [ -z "$dep" ]; then continue; fi
    if echo "$NO_EXTERNAL" | grep -qx "$dep"; then continue; fi
    # [HISTORICAL] native module（含 .node 二进制）必须保持 external，不能 bundle：
    # bundle 后 __dirname 变 dist/runtime，node-gyp-build 找不到 prebuilds/*.node。
    # 判定：dep 目录下有 binding.gyp / prebuilds 目录 / .node 文件。
    DEP_DIR="$PROJECT_ROOT/node_modules/$dep"
    if [ -f "$DEP_DIR/binding.gyp" ] || [ -d "$DEP_DIR/prebuilds" ] || find "$DEP_DIR" -name '*.node' 2>/dev/null | grep -q .; then
        NATIVE_SKIPPED="$NATIVE_SKIPPED $dep"
        continue
    fi
    MISSING="$MISSING $dep"
done

[ -n "$NATIVE_SKIPPED" ] && echo -e "${GREEN}[OK] native module (external 正确，不打包):$NATIVE_SKIPPED${NC}"
if [ -n "$MISSING" ]; then
    echo -e "${RED}[ERROR] 以下 runtime 依赖未在 tsup noExternal 中：$MISSING${NC}"
    echo -e "${YELLOW}[FIX] 编辑 $RUNTIME_DIR/tsup.config.ts，noExternal 追加:$MISSING${NC}"
    exit 1
fi
[ -z "$NATIVE_SKIPPED" ] && echo -e "${GREEN}[OK] 所有 runtime dependencies 已打包 (noExternal: $NO_EXTERNAL)${NC}"

# ── 2b. workspace:* 依赖零外漏（W11/A5，第 2 步 DEPS 过滤的盲区补口）─────
# 第 2 步把 workspace:* 协议依赖从 DEPS 断言中过滤（它们被 tsup inline 是预期），
# 但「inline 后产物里不再出现裸 require(workspace 包名)」未被覆盖——SDK 若因
# noExternal 漏配以外部依赖形态残留在 bundle，打包态 Cannot find module 延迟到
# release 后才暴露。此处对产物 grep 断言零命中（A5 验收：产物 grep
# require("@zhushanwen/subagent-engine-sdk") 零命中）。
echo ""
echo -e "${BLUE}[2b/6] 检查 workspace:* 依赖零外漏（SDK grep 零命中）...${NC}"
BUNDLE_DIR_FOR_GREP="$(dirname "$BUNDLE_PATH")"
if grep -rn 'require("@zhushanwen/subagent-engine-sdk")' "$BUNDLE_DIR_FOR_GREP"/*.cjs >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] runtime bundle 内出现裸 require(\"@zhushanwen/subagent-engine-sdk\")——SDK 未被 noExternal 内联${NC}"
    echo -e "${YELLOW}[FIX] 编辑 $RUNTIME_DIR/tsup.config.ts，noExternal 追加 '@zhushanwen/subagent-engine-sdk' 后重跑 build${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] 产物 require(\"@zhushanwen/subagent-engine-sdk\") 零命中（SDK 已内联）${NC}"

# ── 3. CJS 兼容性检查 ───────────────────────────────────────────────
echo ""
echo -e "${BLUE}[3/6] 检查 CJS 兼容性（禁止 import.meta / fileURLToPath / globalThis.__dirname）...${NC}"

# 允许的 import.meta 用法：有 __dirname 兼容层或 getAppVersion/getPluginHostDir 的注释说明
# plugin-host.ts 和 plugin-version-checker.ts 有专门的 __dirname 兼容层，予以排除
# [HISTORICAL] 2026-08-05：排除 __tests__ 目录——测试文件不走 tsup CJS bundle（entry 只含 index.ts + bootstrap），
# vitest 在 ESM 环境直接跑源码，import.meta 有效；此前误扫 plugin-esm-loader.test.ts（fixture 路径定位用 import.meta）导致误报。
IMPORTS_META=$(grep -rn "import\.meta" "$RUNTIME_DIR/src" --include="*.ts" --exclude-dir=__tests__ 2>/dev/null | grep -v "plugin-host.ts\|plugin-version-checker.ts" || true)

if [ -n "$IMPORTS_META" ]; then
    echo -e "${RED}[ERROR] runtime 源码使用了 import.meta，CJS bundle 会变成 undefined：${NC}"
    echo "$IMPORTS_META" | sed 's/^/  /'
    echo -e "${YELLOW}[FIX] 使用 __dirname 或 process.cwd() 代替 import.meta.url${NC}"
    exit 1
fi

# [HISTORICAL] 2026-08-17：检查收窄到 fileURLToPath(import.meta...) 危险模式——对普通
# 字符串参数的调用（如 plugin-sandbox.ts 转换插件传入的 file:// URL）在 CJS bundle 下
# require('node:url') 正常可用，与 import.meta 无关，原全量匹配属误报（security slice W3 实证）。
FILE_URL_USAGE=$(grep -rn "fileURLToPath(import\.meta" "$RUNTIME_DIR/src" --include="*.ts" --exclude-dir=__tests__ 2>/dev/null | grep -v "plugin-host.ts" || true)
if [ -n "$FILE_URL_USAGE" ]; then
    echo -e "${RED}[ERROR] runtime 源码使用了 fileURLToPath（CJS 中需要 import.meta.url）：${NC}"
    echo "$FILE_URL_USAGE" | sed 's/^/  /'
    echo -e "${YELLOW}[FIX] 使用 __dirname 兼容层或 process.cwd() 代替${NC}"
    exit 1
fi

# [D8b] globalThis.__dirname 禁令（AGENTS.md #12）：CJS 中 __dirname 是模块作用域变量，
# 不在 globalThis 上——globalThis.__dirname 恒为 undefined，路径解析静默指向错误位置。
# 合规形态：typeof __dirname !== 'undefined' ? __dirname : undefined（plugin-host.ts 范本）。
GLOBAL_DIRNAME_USAGE=$(grep -rn "globalThis\.__dirname" "$RUNTIME_DIR/src" --include="*.ts" --exclude-dir=__tests__ 2>/dev/null || true)

if [ -n "$GLOBAL_DIRNAME_USAGE" ]; then
    echo -e "${RED}[ERROR] runtime 源码使用了 globalThis.__dirname（CJS bundle 中恒为 undefined）：${NC}"
    echo "$GLOBAL_DIRNAME_USAGE" | sed 's/^/  /'
    echo -e "${YELLOW}[FIX] 使用模块作用域 __dirname（typeof __dirname !== 'undefined' 兼容层），见 plugin-host.ts resolvePluginHostDir${NC}"
    exit 1
fi

echo -e "${GREEN}[OK] 无 import.meta / fileURLToPath / globalThis.__dirname 引用${NC}"

# ── 4. 产物自包含验证 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[4/6] 检查产物是否包含所有依赖...${NC}"

for dep in $DEPS; do
    if [ -z "$dep" ]; then continue; fi
    # native module 保持 external，bundle 里是 require("dep") 而非打包源码；
    # 且 runtime 源码当前可能还没 import 它（无 require 字样），grep 不到属正常。
    DEP_DIR="$PROJECT_ROOT/node_modules/$dep"
    if [ -f "$DEP_DIR/binding.gyp" ] || [ -d "$DEP_DIR/prebuilds" ] || find "$DEP_DIR" -name '*.node' 2>/dev/null | grep -q .; then
        continue
    fi
    if ! grep -q "$dep" "$BUNDLE_PATH"; then
        echo -e "${RED}[ERROR] 产物缺少依赖 ${dep}（noExternal 可能遗漏）${NC}"
        exit 1
    fi
done
echo -e "${GREEN}[OK] 产物包含所有依赖${NC}"

# ── 5. plugin-bootstrap.cjs 可独立运行 ──────────────────────────────
echo ""
echo -e "${BLUE}[5/6] Worker bootstrap 可独立解析...${NC}"

# plugin-bootstrap.cjs 作为 Worker Thread 入口，必须能独立 require
# 验证：文件包含 createRequire 或 node:worker_threads，无顶层 require(index.cjs) 依赖
if ! grep -q "worker_threads" "$BOOTSTRAP_PATH"; then
    echo -e "${RED}[ERROR] plugin-bootstrap.cjs 缺少 worker_threads 引用${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] plugin-bootstrap.cjs 结构正确${NC}"

# ── 5b. plugin-bootstrap-process.cjs 结构检查（fork 子进程入口）────────
echo ""
echo -e "${BLUE}[5b/6] 子进程 bootstrap 结构检查...${NC}"

# fork 子进程入口：必须用 process IPC（process.send 发送 + process.on('message') 接收）。
# 注意：不能 grep 排除 worker_threads——产物内联了 plugin-bootstrap.ts 的 parentPort import
# （post 注入改造后 Worker 版复用，fork 进程里 parentPort undefined + 可选链，安全）。
if ! grep -q "process.send" "$BOOTSTRAP_PROCESS_PATH"; then
    echo -e "${RED}[ERROR] plugin-bootstrap-process.cjs 缺少 process.send（fork IPC 发送通道）${NC}"
    exit 1
fi
if ! grep -q 'process.on("message"' "$BOOTSTRAP_PROCESS_PATH"; then
    echo -e "${RED}[ERROR] plugin-bootstrap-process.cjs 缺少 process.on('message')（fork IPC 消息循环）${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] plugin-bootstrap-process.cjs 结构正确（process.send + process.on('message') IPC 通道）${NC}"

# ── 6. 运行时健康检查 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[6/6] 运行时健康检查...${NC}"

# 随机选一个可用端口
PORT=3250
for p in $(seq 3250 3260); do
    if ! lsof -n -P -i :$p 2>/dev/null | grep LISTEN > /dev/null; then
        PORT=$p
        break
    fi
done

# 启动 runtime，等待 ready，发送 health check，清理
RUNTIME_PID=""
cleanup() {
    __check_principle
    if [ -n "$RUNTIME_PID" ] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
        kill "$RUNTIME_PID" 2>/dev/null || true
        wait "$RUNTIME_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

node "$BUNDLE_PATH" --port=$PORT > /tmp/runtime-validate.log 2>&1 &
RUNTIME_PID=$!

# 等待 runtime ready（最多 15s）
READY=false
for i in $(seq 1 30); do
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q "ok"; then
        READY=true
        break
    fi
    sleep 0.5
done

if [ "$READY" = true ]; then
    echo -e "${GREEN}[OK] Runtime 启动成功 (port $PORT)${NC}"

    # 检查 plugin 初始化是否成功（防止 globalThis.__dirname 等错误被 try-catch 吞掉）
    if grep -q 'plugin initialization failed' /tmp/runtime-validate.log; then
        echo -e "${RED}[ERROR] Plugin 初始化失败（被 try-catch 吞掉但不应忽略）${NC}"
        echo -e "${YELLOW}日志:${NC}"
        grep 'plugin initialization failed\|plugin-host\|Required file not found' /tmp/runtime-validate.log | tail -10
        echo -e "${YELLOW}[FIX] 检查 plugin-host.ts 的 __dirname 兼容层、tsup 配置、plugin-bootstrap.cjs 是否存在${NC}"
        exit 1
    fi

    # 确认 plugins initialized 成功输出
    if grep -q 'plugins initialized' /tmp/runtime-validate.log; then
        echo -e "${GREEN}[OK] Plugin 系统初始化成功${NC}"
    else
        echo -e "${YELLOW}[WARN] 未检测到 'plugins initialized' 日志（可能无插件或被 catch）${NC}"
    fi
else
    echo -e "${RED}[ERROR] Runtime 启动超时或失败${NC}"
    echo -e "${YELLOW}日志:${NC}"
    cat /tmp/runtime-validate.log | tail -20
    exit 1
fi

# ── 7. 插件系统非 mock 端到端验收（隔离 runtime + 真实插件文件 + 真实 WS）──────
# 前 6 步验证「打包产物」；本步验证「dev 源码形态」的插件真实加载路径（sandbox fork
# 激活 / toggle / built-in 扫描 / onBeforeSendMessage hook 执行）。F1-F4 四个 bug 的
# 共同根因是测试金字塔底部全是 mock、真实加载路径零覆盖——本步是结构性防护。
# 实测耗时 ~8s（含隔离 runtime 启动），在 pre-commit 可接受范围内（阈值 ~30s）。
echo ""
echo -e "${BLUE}[7/7] 插件系统非 mock 端到端验收...${NC}"
if bash "$PROJECT_ROOT/scripts/verify-plugin-e2e.sh"; then
    echo -e "${GREEN}[OK] 插件端到端验收通过${NC}"
else
    echo -e "${RED}[ERROR] 插件端到端验收失败（A 激活 / B toggle / C built-in / D hook 中有失败步骤，详见上方输出）${NC}"
    echo -e "${YELLOW}[FIX] 定位见 verify-plugin-e2e.sh 输出的 [FAIL]/[定位] 行；验收范围见 docs/testing/13-plugin-e2e.md${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}[OK] Runtime Bundle 验证全部通过${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"