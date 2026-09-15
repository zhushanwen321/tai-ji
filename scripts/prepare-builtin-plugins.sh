#!/usr/bin/env bash
# prepare-builtin-plugins.sh — 预编译 built-in taiji plugins（resources/plugins/<name>/）。
#
# 机制：esbuild 把每个插件的 index.ts 编译为同目录 index.js（type-only import 剥离，
# 无 runtime 依赖，自包含）。
#
# 根因（2026-08-16 诊断）：built-in statusline 插件自加入以来从未激活成功——
# plugin-registry 曾把 pluginPath 存为目录，plugin-bootstrap 直接 import(pluginPath)
# 触发 ESM ERR_UNSUPPORTED_DIR_IMPORT；且 resources/plugins/statusline/ 只有 index.ts
# 源码，index.js 在 git 全历史从未存在，manifest main 字段无消费方。registry 侧已修
# （pluginPath 解析为入口文件），本脚本补齐构建期编译：源 index.ts 是 SSOT，产物
# index.js 构建期生成（.gitignore 忽略），不进 git。
#
# 运行形态覆盖：
#  - 本地 dist 运行（cwd=repo 根）：registry 扫描 <repo>/resources/plugins → 编译产物
#    与源同目录，直接命中
#  - 打包产物（cwd=Resources）：electron-builder extraResources 把 resources/plugins
#    拷入 Resources/resources/plugins（electron-builder.yml 有对应条目）
#
# dev 模式注意：dev 下 cwd=apps/electron，registry 扫描 apps/electron/resources/plugins
# （目录不存在）→ built-in 插件在 dev 不被发现（独立已知缺口，不在本脚本范围）。
#
# Usage: bash scripts/prepare-builtin-plugins.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PLUGINS_DIR="$REPO_ROOT/resources/plugins"
ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
	echo "ERROR: esbuild 未找到（${ESBUILD}），先 pnpm install" >&2
	exit 1
fi

if [[ ! -d "$PLUGINS_DIR" ]]; then
	echo "=== prepare-builtin-plugins: $PLUGINS_DIR 不存在，跳过 ==="
	exit 0
fi

echo "=== prepare-builtin-plugins ==="
echo "plugins dir: ${PLUGINS_DIR}"

COMPILED=0
for plugin_dir in "$PLUGINS_DIR"/*/; do
	[[ -f "${plugin_dir}index.ts" ]] || continue
	name="$(basename "$plugin_dir")"
	# 先删旧产物再编译：入口改名时防 stale index.js 残留（同 bundle-extensions.mjs 清 staged 的动机）
	rm -f "${plugin_dir}index.js"
	"$ESBUILD" "${plugin_dir}index.ts" \
		--bundle --format=esm --platform=node --target=node18 \
		--log-level=warning \
		--outfile="${plugin_dir}index.js"
	if [[ ! -f "${plugin_dir}index.js" ]]; then
		echo "ERROR: $name 编译未产出 index.js" >&2
		exit 1
	fi
	echo "  ${name}: index.ts → index.js ($(du -h "${plugin_dir}index.js" | cut -f1))"
	COMPILED=$((COMPILED + 1))
done

# fail-fast：每个含 taijiPlugin manifest 的插件目录必须有 main 入口文件（编译产物）
# main SSOT = 各插件 package.json 的 taijiPlugin.main（缺省 index.js，与 plugin-registry 解析一致）
FAIL=0
for plugin_dir in "$PLUGINS_DIR"/*/; do
	[[ -f "${plugin_dir}package.json" ]] || continue
	name="$(basename "$plugin_dir")"
	main=$(node -e "const p=require(process.argv[1]);process.stdout.write(p.taijiPlugin?.main ?? 'index.js')" "${plugin_dir}package.json")
	if [[ ! -f "${plugin_dir}${main}" ]]; then
		echo "ERROR: $name 缺入口文件 ${main}（manifest main 指向的文件不存在，prepare 是否覆盖该插件？）" >&2
		FAIL=1
	fi
done
if [[ $FAIL -ne 0 ]]; then
	echo "[FIX] 检查 resources/plugins/<name>/ 的 index.ts 是否存在，或 manifest main 路径是否正确" >&2
	exit 1
fi

echo "=== Done: prepare-builtin-plugins ($COMPILED compiled) ==="
