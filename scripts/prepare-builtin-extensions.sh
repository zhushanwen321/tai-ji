#!/usr/bin/env bash
# prepare-builtin-extensions.sh — 准备 builtin pi extensions 打包产物。
#
# 机制（重构后）：调用 bundle-extensions.mjs，用 esbuild 把每个 builtin extension
# bundle 成自包含 index.js（所有 JS value dep inline，仅 pi virtualModules external）。
#
# 根治旧机制（"拷源码 + 人工声明 PKG_DEPS + 从根 node_modules 拷依赖"）的缺陷：
# workspace 包（@taiji/*、@zhushanwen/*）不在根 node_modules（pnpm hoisted），
# 旧机制 copy_dep 拷不到，pi 加载 extension 报 Cannot find module，新会话创建失败。
# 新机制由 esbuild 静态分析 import 自动 inline 所有 value 依赖，从结构上消除该根因，
# 并兑现 G3（新增静态 value 依赖不需改打包配置）。
#
# builtin 包清单 SSOT：packages/shared/src/mandatory-extensions.json
# （由 bundle-extensions.mjs 读取，本脚本不再硬编码包列表）
#
# 产物（apps/electron/resources/extensions/@zhushanwen/<pkg>/）：
#  - index.js + index.js.map（bundle 产物，自包含，无 node_modules）
#  - package.json（pi.extensions 改指 ./index.js；源码 package.json 不动）
#  - README.md / ARCHITECTURE.md（有则拷，供产物自描述；bundle-extensions.mjs 拷贝）
#  - pi-permission 额外含 tree-sitter-bash.wasm + web-tree-sitter.wasm
#
# dev/build 加载路径分流（见 docs/architecture/builtin-extension-dev-build-split.md）：
# 本脚本只服务 build——产出的 staged bundle 供 electron-builder extraResources 拷贝进
# Resources/extensions/。dev 模式 mandatory 扩展走源码（extensions/<pkg>/，pi 原生加载 .ts），
# 改源码新建 session 即生效，不依赖本脚本。
#
# Usage: ./scripts/prepare-builtin-extensions.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STAGED_SCOPED="$REPO_ROOT/apps/electron/resources/extensions/@zhushanwen"
MANDATORY_JSON="$REPO_ROOT/packages/shared/src/mandatory-extensions.json"

# 包目录名列表（pi-ask-user pi-goal ...），从 SSOT 一次性读取
PKG_DIRS=$(node -e "const d=require(process.argv[1]);process.stdout.write(d.map(p=>p.name.replace(/^@zhushanwen\//,'')).join(' '))" "$MANDATORY_JSON")
if [[ -z "$PKG_DIRS" ]]; then
	echo "ERROR: 无法从 $MANDATORY_JSON 读取包列表" >&2
	exit 1
fi

echo "=== prepare-builtin-extensions ==="
echo "staged: ${STAGED_SCOPED}"
echo ""

# 1. 清空 staged scoped 目录后重建（双保险：bundle-extensions.mjs 内部也会清空，
#    此处显式清空防旧机制 .ts/src 残留旁路 bundle —— extension-resolver.ts 的
#    resolveExtensionEntries fallback 顺序 index.ts 优先于 index.js，残留 .ts 会让
#    pi 加载源码旁路 bundle，bug 原样存在，R3 关键防护）
rm -rf "$STAGED_SCOPED"
mkdir -p "$STAGED_SCOPED"

# 2. esbuild bundle builtin extension（数量以 mandatory-extensions.json SSOT 为准）成自包含 index.js；
#    README/ARCHITECTURE 文档与 manifest 资源由 bundle-extensions.mjs 一并拷入 staged
#    （「mandatory 包 → 源码目录 → staged 产物」在 bundle 脚本内单一 owner，本脚本不再
#    重复推导源码目录）
node "$REPO_ROOT/scripts/bundle-extensions.mjs"

# 3. 校验 staged 无 index.ts / *.ts 残留（R3 关键防护，fail-fast）
RESIDUAL_TS=$(find "$STAGED_SCOPED" \( -name "index.ts" -o -name "*.ts" \) 2>/dev/null || true)
if [[ -n "$RESIDUAL_TS" ]]; then
	echo "" >&2
	echo "ERROR: staged 残留 .ts 文件，resolver fallback 会旁路 bundle：" >&2
	echo "$RESIDUAL_TS" >&2
	echo "" >&2
	echo "[FIX] bundle-extensions.mjs 是否正确产出 index.js（manifest 资源拷贝排除 *.ts）？" >&2
	exit 1
fi

# 4. 校验每包有 index.js + pi-permission 有 wasm（fail-fast，拦截残缺产物）
FAIL=0
for pkg_dir in $PKG_DIRS; do
	dest_pkg="$STAGED_SCOPED/$pkg_dir"
	if [[ ! -f "$dest_pkg/index.js" ]]; then
		echo "ERROR: $pkg_dir 缺 index.js（bundle 可能失败）" >&2
		FAIL=1
	fi
done
if [[ ! -f "$STAGED_SCOPED/pi-permission/tree-sitter-bash.wasm" ]] || \
   [[ ! -f "$STAGED_SCOPED/pi-permission/web-tree-sitter.wasm" ]]; then
	echo "ERROR: pi-permission 缺 wasm（permission 将无法解析 bash）" >&2
	FAIL=1
fi
if [[ $FAIL -ne 0 ]]; then
	echo "[FIX] 重新运行 bash scripts/prepare-builtin-extensions.sh" >&2
	exit 1
fi

# 5. 成功汇总
echo ""
echo "=== staged 产物汇总 ==="
TOTAL_KB=0
PKG_COUNT=0
for pkg_dir in $PKG_DIRS; do
	dest_pkg="$STAGED_SCOPED/$pkg_dir"
	js_kb=$(du -sk "$dest_pkg/index.js" 2>/dev/null | awk '{print $1}')
	dir_kb=$(du -sk "$dest_pkg" 2>/dev/null | awk '{print $1}')
	extras=""
	if [[ "$pkg_dir" == "pi-permission" ]]; then
		extras=" (+2 wasm)"
	fi
	printf "  @zhushanwen/%-18s index.js %5skb  dir %6skb%s\n" "$pkg_dir" "$js_kb" "$dir_kb" "$extras"
	TOTAL_KB=$((TOTAL_KB + dir_kb))
	PKG_COUNT=$((PKG_COUNT + 1))
done
total_mb=$(awk -v kb="$TOTAL_KB" 'BEGIN { printf "%.1f", kb / 1024 }')
echo "  ──────────────────────────────────────────────"
echo "  Total staged: ${total_mb}M (${PKG_COUNT} packages, self-contained bundles)"

echo ""
echo "=== Done: prepare-builtin-extensions ==="
