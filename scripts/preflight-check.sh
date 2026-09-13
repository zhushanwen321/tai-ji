#!/bin/bash
# scripts/preflight-check.sh — 打包前预检查
#
# 检查项：
# 1. package.json 完整性（name, version, main）
# 2. 产物存在性（dist/main, dist/preload, dist/runtime, renderer/dist）
# 3. tsup noExternal 与 runtime dependencies 一致性
# 4. electron-builder.yml 结构完整性
# 5. artifactName 固定名检查（不含 ${version}，支持自动升级 + releases/latest/download 静态 URL）
# 6. asarUnpack 与 files 一致性（防止 files 排除 dist/runtime）
# 7. resources/pi 无指向外部绝对路径的 symlink
# 8. 磁盘空间
# 9. extension-dependencies.json 一致性
# 10. Provider 凭据读取单通道守卫（C-proc-14/15，runtime 源码约束）
#
# 注：builtin pi-extensions（@zhushanwen/pi-*）打包内置（2026-08 重构），
# 由 prepare-builtin-extensions.sh 部署 + electron-builder extraResources 拷贝。
# 产物存在性校验在 postbuild-validate.sh；此处不预检（产物由 build 前置步骤生成）。
#
# 用法: npm run preflight 或 CI 中单独调用
# CI 模式: ./scripts/preflight-check.sh --ci（任何失败都非 0）

set -euo pipefail

# 检查失败原则：任何非 0 退出都输出（不管从哪个 exit 点）
trap '[ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。" >&2' EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

CI_MODE=false
if [ "${1:-}" = "--ci" ]; then
    CI_MODE=true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Git Bash on Windows 把 D:\foo 翻译成 /d/foo（POSIX 风格），但原生 Node.js 不识别
# 这种路径（require 会返回 MODULE_NOT_FOUND）。Node 调用前必须把绝对路径转回 Windows 原生形态
# （cygpath -w 在 Git Bash for Windows 自带；非 Windows 时为 no-op）。
# 其它程序（ls/cp/git 等 Git Bash 内置命令）继续用 POSIX 风格路径不受影响。
#
# Windows 原生路径含反斜杠（D:\...），直接嵌入 JS 字符串字面量会被 V8 解析为转义序列
# （\a 触发 SyntaxError）。需要再把反斜杠换成双反斜杠。
if command -v cygpath >/dev/null 2>&1; then
    to_native_path() { cygpath -w "$1" | sed 's/\\/\\\\/g'; }
else
    to_native_path() { echo "$1"; }
fi

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}[Preflight Checks]${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

ELECTRON_DIR="$PROJECT_ROOT/apps/electron"
FAILED=0

# ── 1. package.json 完整性 ─────────────────────────────────────────
echo ""
echo -e "${BLUE}[1/10] package.json fields...${NC}"

# 检查 apps/electron/package.json（electron-builder 的工作目录）
ELECTRON_PKG="$(to_native_path "$ELECTRON_DIR/package.json")"
node -e "
const pkg = require('$ELECTRON_PKG');
const required = ['name', 'version', 'main', 'description'];
for (const f of required) {
  if (!pkg[f]) { console.error('Missing required field:', f); process.exit(1); }
}
if (!/^\d+\.\d+\.\d+/.test(pkg.version)) {
  console.error('Invalid semver:', pkg.version); process.exit(1);
}
console.log('  ✓', pkg.name, 'v' + pkg.version);
" || { FAILED=1; echo -e "${RED}[FAIL]${NC}"; }

# ── 2. 产物存在性 ──────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[2/10] Build artifacts exist...${NC}"

check_file() {
    local path="$1"
    local label="$2"
    if [ -f "$path" ]; then
        echo -e "  ${GREEN}✓${NC} $label"
    else
        echo -e "  ${RED}✗${NC} $label NOT FOUND: $path"
        return 1
    fi
}

check_dir() {
    local path="$1"
    local label="$2"
    if [ -d "$path" ]; then
        echo -e "  ${GREEN}✓${NC} $label"
    else
        echo -e "  ${RED}✗${NC} $label NOT FOUND: $path"
        return 1
    fi
}

(
    check_file "$ELECTRON_DIR/dist/main/main.cjs" "main entry" || true
    check_file "$ELECTRON_DIR/dist/preload/preload.cjs" "preload entry" || true
    check_file "$ELECTRON_DIR/dist/runtime/index.cjs" "runtime bundle" || true
    check_file "$ELECTRON_DIR/renderer/dist/index.html" "renderer index" || true
) || FAILED=1

# ── 3. tsup noExternal 与 runtime dependencies 同步 ─────────────────
echo ""
echo -e "${BLUE}[3/10] tsup noExternal vs runtime dependencies...${NC}"

RUNTIME_PKG="$PROJECT_ROOT/packages/runtime/package.json"
RUNTIME_TSUP="$PROJECT_ROOT/packages/runtime/tsup.config.ts"
RUNTIME_PKG_NATIVE="$(to_native_path "$RUNTIME_PKG")"
RUNTIME_TSUP_NATIVE="$(to_native_path "$RUNTIME_TSUP")"

if [ -f "$RUNTIME_PKG" ] && [ -f "$RUNTIME_TSUP" ]; then
    DEPS=$(node -e "const p=require('$RUNTIME_PKG_NATIVE');console.log(Object.keys(p.dependencies||{}).join('\n'))")
    NO_EXT=$(node -e "
const fs=require('fs');
const content=fs.readFileSync('$RUNTIME_TSUP_NATIVE','utf-8');
const match=content.match(/noExternal:\\s*\\[([^\\]]+)\\]/);
if(match) console.log(match[1].split(/[,\n]/).map(s=>s.trim().replace(/['\"]/g,'')).filter(Boolean).join('\n'));
else console.log('');
")

    MISSING=""
    NATIVE_SKIPPED=""
    for dep in $DEPS; do
        if [ -z "$dep" ]; then continue; fi
        if echo "$NO_EXT" | grep -qx "$dep"; then continue; fi
        # [HISTORICAL] native module（含 .node 二进制）必须保持 external，不能 bundle 进 JS：
        # native 入口用 node-gyp-build 动态 require prebuilds/<platform>/*.node，
        # bundle 后 __dirname 变 dist/runtime，找不到 prebuilds 导致运行时 Cannot find module。
        # 判定标志：dep 目录下有 binding.gyp（node-gyp 项目）或 prebuilds 目录（prebuildify）或 .node 文件。
        # tsup external 列表 + electron-builder asarUnpack 共同处理（见 §12 native module 约束）。
        DEP_DIR="$PROJECT_ROOT/node_modules/$dep"
        if [ -f "$DEP_DIR/binding.gyp" ] || [ -d "$DEP_DIR/prebuilds" ] || find "$DEP_DIR" -name '*.node' 2>/dev/null | grep -q .; then
            NATIVE_SKIPPED="$NATIVE_SKIPPED $dep"
            continue
        fi
        MISSING="$MISSING $dep"
    done

    if [ -n "$NATIVE_SKIPPED" ]; then
        echo -e "  ${GREEN}✓ native module(external 正确):$NATIVE_SKIPPED${NC}"
    fi
    if [ -n "$MISSING" ]; then
        echo -e "  ${RED}✗ noExternal 缺少依赖:$MISSING${NC}"
        echo -e "  ${YELLOW}FIX: 编辑 ${RUNTIME_TSUP}，noExternal 追加:$MISSING${NC}"
        FAILED=1
    elif [ -z "$NATIVE_SKIPPED" ]; then
        echo -e "  ${GREEN}✓ noExternal 覆盖所有 runtime dependencies${NC}"
    fi
else
    echo -e "  ${YELLOW}⚠ 跳过（文件不存在）${NC}"
fi

# ── 4. electron-builder.yml 结构 ────────────────────────────────────
echo ""
echo -e "${BLUE}[4/10] electron-builder.yml structure...${NC}"

EB_YML="$ELECTRON_DIR/electron-builder.yml"
EB_YML_NATIVE="$(to_native_path "$EB_YML")"
if [ -f "$EB_YML" ]; then
    if node -e "const fs=require('fs');require('js-yaml').load(fs.readFileSync('$EB_YML_NATIVE','utf8'));console.log('ok')" 2>/dev/null; then
        echo -e "  ${GREEN}✓ YAML 语法正确${NC}"
    else
        echo -e "  ${YELLOW}⚠ YAML 解析跳过（js-yaml 未安装）${NC}"
    fi

    # 检查关键配置项
    for key in appId productName asar; do
        if grep -q "^$key:" "$EB_YML"; then
            echo -e "  ${GREEN}✓${NC} $key 配置存在"
        else
            echo -e "  ${YELLOW}⚠ $key 缺失${NC}"
        fi
    done
else
    echo -e "  ${RED}✗ electron-builder.yml 不存在${NC}"
    FAILED=1
fi

# ── 5. artifactName 版本号检查（含 ${version}）──────────────────────
# release asset 文件名需带版本号（便于归档识别）。release-checker 用 pattern 匹配
# 平台后缀（如 -mac-arm64.dmg）定位 asset，不依赖固定文件名。
echo ""
echo -e "${BLUE}[5/10] artifactName versioned (contains \${version})...${NC}"

if [ -f "$EB_YML" ]; then
    # grep 正则匹配 artifactName.*${version}（${ 在 BRE 中是字面量，无需转义）。
    # 排除注释行（以 # 开头）避免误报。
    if grep -v '^[[:space:]]*#' "$EB_YML" | grep -q 'artifactName.*${version}'; then
        echo -e "  ${GREEN}✓ artifactName 含 \${version}（release asset 文件名带版本号）${NC}"
    else
        echo -e "  ${RED}✗ electron-builder.yml artifactName 不含 \${version}，release asset 需带版本号${NC}"
        echo -e "  ${YELLOW}  FIX: 在 artifactName 中加入 '\${version}'（如 xyz-agent-\${version}-mac-arm64.\${ext}）${NC}"
        FAILED=1
    fi
else
    echo -e "  ${YELLOW}⚠ 跳过（electron-builder.yml 不存在）${NC}"
fi

# ── 6. asarUnpack 与 files 一致性检查 ─────────────────────────────
echo ""
echo -e "${BLUE}[6/10] asarUnpack vs files consistency...${NC}"

if [ -f "$EB_YML" ]; then
    if grep -q "asarUnpack" "$EB_YML" && grep -q "dist/runtime" "$EB_YML"; then
        echo -e "  ${GREEN}✓ runtime 在 asarUnpack 中${NC}"
    else
        echo -e "  ${RED}✗ runtime 未配置在 asarUnpack 中${NC}"
        FAILED=1
    fi

    # 致命：files 中排除 dist/runtime 会导致 asarUnpack 无文件可解压
    # 排除 YAML 注释行（以 # 开头）
    if grep -v '^[[:space:]]*#' "$EB_YML" | grep -qE '!dist/runtime'; then
        echo -e "  ${RED}✗ FATAL: files 规则排除了 dist/runtime，asarUnpack 将失效${NC}"
        echo -e "  ${YELLOW}  FIX: 删除 files 中的 '!dist/runtime/**/*'，让 asarUnpack 处理${NC}"
        FAILED=1
    else
        echo -e "  ${GREEN}✓ files 未排除 dist/runtime${NC}"
    fi

    # 致命：files 必须显式包含 dist/runtime，否则 asarUnpack 无文件可 unpack
    # electron-builder 的 files 和 asarUnpack 是 AND 关系。
    # "? 匹配可选的左双引号——同时支持 `- dist/runtime/**/*` 与 `- "dist/runtime/**/*"`
    # 两种 YAML 引号形式（之前只匹配无引号写法，导致用引号包裹的合法配置被误判缺失）。
    if grep -v '^[[:space:]]*#' "$EB_YML" | grep -qE '^[[:space:]]*-[[:space:]]+"?dist/runtime/'; then
        echo -e "  ${GREEN}✓ files 显式包含 dist/runtime${NC}"
    else
        echo -e "  ${RED}✗ FATAL: files 未显式包含 dist/runtime，asarUnpack 将静默失败${NC}"
        echo -e "  ${YELLOW}  FIX: 在 files 中添加 '- dist/runtime/**/*'${NC}"
        FAILED=1
    fi
fi

# ── 7. resources/pi symlink 检查 ───────────────────────────────────
# 仅检查 git 跟踪的 symlink（会进产物，危险）。
# .gitignore 忽略的 symlink 是 setup-worktree.sh 创建的 workspace 共享缓存
# （指向 .pi-binary-cache/），不进 git，CI 由 prepare-pi-resources.sh 重新准备。
echo ""
echo -e "${BLUE}[7/10] resources/pi symlink check...${NC}"

PI_RES_DIR="$ELECTRON_DIR/resources/pi"
SYMLINK_FOUND=false
if [ -d "$PI_RES_DIR" ]; then
    while IFS= read -r link; do
        # 跳过 .gitignore 忽略的 dev 缓存 symlink（不进 git，非打包风险）
        if git check-ignore -q "$link" 2>/dev/null; then
            continue
        fi
        target=$(readlink "$link")
        echo -e "  ${RED}✗${NC} 发现 symlink: $(basename "$link") -> $target"
        SYMLINK_FOUND=true
    done < <(find "$PI_RES_DIR" -maxdepth 1 -type l 2>/dev/null)
fi

if [ "$SYMLINK_FOUND" = true ]; then
    echo -e "  ${RED}✗ resources/pi 中存在 symlink，打包后目标路径在用户机器上不存在${NC}"
    echo -e "  ${YELLOW}  FIX: 用真实目录替换 symlink：cd $PI_RES_DIR && for l in \$(find . -maxdepth 1 -type l); do t=\$(readlink \$l); rm \$l; cp -R \"\$t\" \$(basename \$l); done${NC}"
    FAILED=1
else
    echo -e "  ${GREEN}✓ resources/pi 无 symlink${NC}"
fi

# ── 8. 磁盘空间检查 ────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[8/10] Disk space...${NC}"

# df -g 是 BSD/macOS 特有，Linux 不支持。用 df -k（KB，跨平台）换算成 GB。
AVAILABLE_GB=$(($(df -k . | tail -1 | awk '{print $4}') / 1024 / 1024))
if [ "$AVAILABLE_GB" -lt 3 ]; then
    echo -e "  ${RED}✗ 磁盘空间不足: ${AVAILABLE_GB}GB（建议 ≥3GB）${NC}"
    FAILED=1
else
    echo -e "  ${GREEN}✓ ${AVAILABLE_GB}GB 可用${NC}"
fi

# ── 9. extension 发布一致性 ────────────────────────────────────────
# S-7 守卫：extension-dependencies.json 与磁盘包清单双向对应（防 R1 MF-6 类残留/漂移
# 再次静默进入）。脚本：scripts/check-extension-dependencies.mjs（零依赖）。
# files 白名单守卫：npm 发布闭包校验（import 闭包 ⊆ files，防 pi-subagent-workflow@8.8.1
# 类缺文件包）。脚本：scripts/check-extension-files.mjs（零依赖）。
echo ""
echo -e "${BLUE}[9/10] extension consistency (dependencies + publish files)...${NC}"
if node "$PROJECT_ROOT/scripts/check-extension-dependencies.mjs"; then
    echo -e "  ${GREEN}✓ extension-dependencies 一致${NC}"
else
    FAILED=1
fi
if node "$PROJECT_ROOT/scripts/check-extension-files.mjs"; then
    echo -e "  ${GREEN}✓ extension files 白名单一致${NC}"
else
    FAILED=1
fi

# ── 10. Provider 凭据读取单通道守卫（C-proc-14/15）────────────────────
# catalog-provider-field-authority §3.3 D3/D6：runtime 源码的凭据直查禁令
# （getApiKeyForProvider / readAuthCredentials / getProviderConfig(...).apiKey，
# 白名单 = resolver 唯一通道本体）+ upsertProvider 直调清单。零依赖毫秒级，
# 与 pre-commit 同脚本同语义（CI 侧兜底——pre-commit 按路径触发，此处恒跑）。
echo ""
echo -e "${BLUE}[10/10] provider credential reads guard (C-proc-14/15)...${NC}"
if node "$PROJECT_ROOT/scripts/check-provider-credential-reads.mjs"; then
    echo -e "  ${GREEN}✓ 凭据读取单通道 / upsertProvider 直调清单一致${NC}"
else
    FAILED=1
fi

# ── 结果 ───────────────────────────────────────────────────────────
echo ""
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}[OK] Preflight 检查全部通过${NC}"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
else
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}[FAIL] Preflight 检查有失败项${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 1
fi