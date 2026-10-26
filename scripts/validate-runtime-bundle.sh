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
# 用法: ./scripts/validate-runtime-bundle.sh [--ci | --static-only]
#   --ci           CI 模式：严格模式，任何失败都会退出码非 0
#   --static-only  只执行静态检查段（[2/6] noExternal 对账 + [3/6] 源码 CJS 兼容
#                  禁令），跳过需构建产物/需运行环境的段——CI invariants job 的
#                  免构建直调形态，与全量跑共享同一段实现

set -e

# 检查失败原则提示（合并进 cleanup EXIT trap，避免覆盖）
__check_principle() {
  [ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须当场直接修复解决，不允许跳过。" >&2
  return 0
}

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CI_MODE=false
STATIC_ONLY=false
if [ "$1" = "--ci" ]; then
    CI_MODE=true
fi
if [ "$1" = "--static-only" ]; then
    STATIC_ONLY=true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Gate 0：pnpm store 布局检查——布局被沙箱执行体（zsw 引擎 HOME 覆盖）翻转时，
# 下方 verify-plugin-e2e 的自含 install 会以 ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
# 硬崩；先拦下给出可操作指引（见 docs/TROUBLESHOOTING.md「pnpm store 布局双向翻转」）。
# --static-only 跳过：布局预检的服务对象是 verify-plugin-e2e 的自含 install，静态段不跑它。
if [ "$STATIC_ONLY" != true ]; then
    bash "$PROJECT_ROOT/.githooks/check_pnpm_store_layout.sh" || exit 1
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Runtime Bundle 验证]${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

RUNTIME_DIR="$PROJECT_ROOT/packages/runtime"
DIST_RUNTIME="$PROJECT_ROOT/apps/electron/dist/runtime"
BUNDLE_PATH="$DIST_RUNTIME/index.cjs"
BOOTSTRAP_PATH="$DIST_RUNTIME/plugin-bootstrap.cjs"
BOOTSTRAP_PROCESS_PATH="$DIST_RUNTIME/plugin-bootstrap-process.cjs"
ESM_LOADER_PATH="$DIST_RUNTIME/plugin-esm-loader.cjs"

# ── 静态检查段（--static-only 与全量路径共用实现）────────────────────
# [2/6] 与 [3/6] 段体函数化：CI invariants job 直调 `--static-only` 免构建获得
# 同两段检查，全量路径按原段序调用同一函数——静态检查单一实现，无 CI 内联镜像。
# 失败路径输出 ::error 注解（GitHub Actions 注解格式；本地全量跑时为普通文本）。
check_noexternal_parity() {
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
      echo "::error::runtime 依赖未在 tsup noExternal 中:$MISSING —— 修复：packages/runtime/tsup.config.ts 的 noExternal 追加该依赖"
      echo -e "${RED}[ERROR] 以下 runtime 依赖未在 tsup noExternal 中：$MISSING${NC}"
      echo -e "${YELLOW}[FIX] 编辑 $RUNTIME_DIR/tsup.config.ts，noExternal 追加:$MISSING${NC}"
      exit 1
  fi
  [ -z "$NATIVE_SKIPPED" ] && echo -e "${GREEN}[OK] 所有 runtime dependencies 已打包 (noExternal: $NO_EXTERNAL)${NC}"
  # 尾部 `[ ... ] && echo` 形态在 NATIVE_SKIPPED 非空时返回 1；函数化后它会成为函数
  # 返回码、在 set -e 下令调用点静默退出——显式 return 0 保持原段序继续语义。
  return 0
}

check_cjs_source_bans() {
  echo ""
  echo -e "${BLUE}[3/6] 检查 CJS 兼容性（禁止无 guard 的 import.meta / globalThis.__dirname）...${NC}"

  # 扫描根 = runtime src + tsup noExternal 所列 workspace 包 src（C-build-01 前置化，
  # dev-0.11.8 残余 S-12：workspace 包内联进 bundle 后其源码形态同样是 CJS 失效面）。
  # 判定/豁免/guard 语义的单一权威 = .githooks/check_runtime_meta_url.py——本步骤曾经的
  # 三段 grep 已收编进该脚本：任意 import.meta 属性访问（规则 A，强度不降）、
  # fileURLToPath(import.meta（规则 A 子集）、globalThis.__dirname（规则 B）；且 grep
  # 不剥注释，扩展扫描根后对 workspace 包 JSDoc 内的 import.meta 字样会误报。
  # [HISTORICAL] 2026-08-05：排除 __tests__ 目录——测试文件不走 tsup CJS bundle（entry 只含
  # index.ts + bootstrap），vitest 在 ESM 环境直接跑源码，import.meta 有效（收编后由脚本内
  # 同款排除承载）。[HISTORICAL] 2026-08-17：fileURLToPath 全量匹配误报收窄（security slice
  # W3）与 [D8b] globalThis.__dirname 禁令的语义均由脚本规则 A/B 承载。
  if ! python3 "$PROJECT_ROOT/.githooks/check_runtime_meta_url.py"; then
      echo "::error::runtime 打包面源码存在无 guard 的 import.meta / globalThis.__dirname（违规清单见上方输出，修复指引见下方 [FIX]）"
      echo -e "${YELLOW}[FIX] 路径解析用 typeof __dirname !== 'undefined' ? __dirname : undefined guard（参照 plugin-host.ts）；双形态 guard 实现登记脚本 allowlist（参照 d8-compat.ts）${NC}"
      exit 1
  fi

  echo -e "${GREEN}[OK] 打包面源码（runtime + noExternal workspace 包）无未加 guard 的 import.meta / globalThis.__dirname 引用${NC}"
}

# --static-only：只执行静态检查段，跳过需构建产物/需运行环境的段（Gate 0 / [1/*] /
# [2b] / [4]-[7]）——构建失败之外的红灯（noExternal 漏配 / 源码 CJS 禁令）免构建即暴露。
if [ "$STATIC_ONLY" = true ]; then
    echo -e "${BLUE}[Runtime Bundle 验证 --static-only（[2/6] noExternal 对账 + [3/6] 源码 CJS 禁令）]${NC}"
    check_noexternal_parity
    check_cjs_source_bans
    echo -e "${GREEN}[OK] 静态检查段通过（--static-only）${NC}"
    exit 0
fi

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
  const m = pkg["taiji"]?.subagentEngine;
  if (m?.id !== d.name || typeof m?.bin !== "string" || m.bin === "" || pkg.bin?.[m.bin] !== "./index.js")
    fail(`engine ${d.name}: staged package.json manifest/bin 无效`);
  console.log(`[OK] engine ${d.name}: index.js + manifest 有效`);
}
' "$STAGED_ENGINES"; then
    echo -e "${YELLOW}[FIX] 运行 node scripts/bundle-extensions.mjs 重新 staged，并核对 packages/*-subagent-cli 的 taiji.subagentEngine manifest${NC}"
    exit 1
fi

# ── 2. 依赖打包检查 ─────────────────────────────────────────────────
check_noexternal_parity

# ── 2b. 裸 require 说明符全量白名单（W11/A5 + 传递内联断链防线 dmg-r1-6）──
# 第 2 步把 workspace:* 协议依赖从 DEPS 断言中过滤（它们被 tsup inline 是预期），
# 但「inline 后产物里不再出现裸 require(workspace 包名)」与「传递依赖的内联」
# 均未覆盖——noExternal 漏配、或 esbuild 对内联包（如 subagent-core dist CJS
# 内部的 acorn）递归解析断链时，残留的 require("dep") 在打包态（runtime 子进程
# 无完整 node_modules）变 Cannot find module，延迟到 release 后才暴露。此处扫描
# 产物内全部字面量 require 说明符，∉ 允许集合（node 内建 + tsup external 显式
# 登记项 + 设计内可选 native）即红——A5 验收（SDK grep 零命中）与其余全部
# 传递内联链由同一条扫描拦截。
echo ""
echo -e "${BLUE}[2b/6] 检查产物裸 require 说明符白名单（workspace/传递依赖零外漏）...${NC}"
BUNDLE_DIR_FOR_GREP="$(dirname "$BUNDLE_PATH")"
# tsup external 显式登记项（native module 等，允许以外部形态保留）
TSUP_EXTERNAL=$(node -e "
const fs=require('fs');
const content=fs.readFileSync('$TSUP_CONFIG','utf-8');
const match=content.match(/external:\\s*\\[([^\\]]+)\\]/);
if(match) console.log(match[1].split(/[,\n]/).map(s=>s.trim().replace(/['\"]/g,'')).filter(Boolean).join('\n'));
else console.log('');
")
if ! node -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1];
const external = (process.argv[2] || "").split("\n").filter(Boolean);
const builtins = new Set(require("module").builtinModules);
// 设计内可选 native（真实调用，豁免理由）：ws 内联源码的 try/catch 可选加速，
// 包缺失时回退纯 JS 实现（WS_NO_BUFFER_UTIL / WS_NO_UTF_8_VALIDATE 亦可关）
const optionalNative = new Set(["bufferutil", "utf-8-validate"]);
// 文本形态误报（非真实调用，前缀匹配）：注释/错误消息里的 require 文本、
// 内联包编译产物残留的模块 id 元数据字符串（ajv 的 equal.code 即此形态）
const textualOnly = ["electron", "ajv/dist/runtime/"];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".cjs")).sort();
if (files.length === 0) { console.error("[ERROR] bundle 目录无 .cjs 产物: " + dir); process.exit(1); }
const bad = [];
const re = /require\(\s*(["\u0027])([^"\u0027\n]+)\1\s*\)/g;
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), "utf8");
  let m;
  while ((m = re.exec(src))) {
    const spec = m[2];
    // 模板插值（${...}）等非说明符字符 = 错误消息文本，非真实 require
    if (!/^[@a-zA-Z0-9][@a-zA-Z0-9/._-]*$/.test(spec)) continue;
    if (spec.startsWith("node:") || builtins.has(spec)) continue;
    if (external.some((e) => spec === e || spec.startsWith(e + "/"))) continue;
    if (optionalNative.has(spec)) continue;
    if (textualOnly.some((p) => spec === p || spec.startsWith(p))) continue;
    bad.push(f + ": require(\"" + spec + "\")");
  }
}
if (bad.length > 0) {
  console.error("[ERROR] 产物内出现允许集合外的裸 require（依赖未内联残留——打包态 runtime 子进程无完整 node_modules，运行期 Cannot find module）：");
  for (const b of bad) console.error("  " + b);
  process.exit(1);
}
console.log("[OK] " + files.length + " 个产物的裸 require 说明符均在允许集合内（传递内联链已补全）");
' "$BUNDLE_DIR_FOR_GREP" "$TSUP_EXTERNAL"; then
    echo -e "${YELLOW}[FIX] 纯 JS 依赖补进 $RUNTIME_DIR/tsup.config.ts 的 noExternal（内联）后重跑 build；native module（含 .node 二进制）才走 external + electron-builder asarUnpack${NC}"
    exit 1
fi
echo -e "${GREEN}[OK] 产物裸 require 白名单检查通过（node 内建 + external 登记项 + 可选 native 之外零外漏）${NC}"

# ── 3. CJS 兼容性检查 ───────────────────────────────────────────────
check_cjs_source_bans

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
# 数据目录隔离：验证 runtime 的全部写侧（日志 / runtime.port / crash journal /
# 单实例注册）必须落临时目录，禁止写任何真实数据目录（prod ~/.taiji 或 dev 树）。
# 同时剥 TAIJI_AGENT_PACKAGED：宿主泄漏该标志会使验证 runtime 按打包态解析不存在
# 的捆绑 pi 二进制、boot 即挂（spawn-env-contract 探针 P1 实锤）。
VALIDATE_DATA_DIR="$(mktemp -d /tmp/taiji-bundle-validate.XXXXXX)"
cleanup() {
    __check_principle
    if [ -n "$RUNTIME_PID" ] && kill -0 "$RUNTIME_PID" 2>/dev/null; then
        kill "$RUNTIME_PID" 2>/dev/null || true
        wait "$RUNTIME_PID" 2>/dev/null || true
    fi
    rm -rf "$VALIDATE_DATA_DIR"
}
trap cleanup EXIT

env -u TAIJI_AGENT_PACKAGED TAIJI_AGENT_DATA_DIR="$VALIDATE_DATA_DIR" \
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
