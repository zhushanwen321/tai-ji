#!/bin/bash
# 校验代码版本与最新正式 release 一致
# Exit: 0 = 可以安全 bump, 1 = 版本不匹配 或 pi 协议契约测试失败（W25 接线，见下方 pi 段）
set -euo pipefail

REPO="zhushanwen321/tai-ji"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WS_ROOT="${WS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# 获取最新正式 release（排除 draft 和 prerelease）
LATEST=$(gh release list --repo "$REPO" --limit 100 \
  --json tagName,isDraft,isPrerelease \
  | jq -r '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' \
  | head -1)

if [ -z "$LATEST" ]; then
  # 仓库尚无任何正式 release（首次发布场景）：无跳版基线可比对，守卫前提不成立，显式放行。
  # W25 对比同样依赖 v* ref 基线，一并跳过；pi 契约面由 equivalence faux 轨用例覆盖。
  echo "OK: 仓库尚无任何正式 release（首次发布），无跳版基线，放行。"
  echo "注意: W25 pi 依赖对比无 release 基线，跳过（契约面由 equivalence faux 轨覆盖）。"
  exit 0
fi

LATEST_VER="${LATEST#v}"
CURRENT_VER=$(node -p "require('${WS_ROOT}/package.json').version")

if [ "$LATEST_VER" != "$CURRENT_VER" ]; then
  echo "ERROR: 版本不匹配！"
  echo "  最新正式 release: v${LATEST_VER}"
  echo "  当前代码版本:     v${CURRENT_VER}"
  echo ""
  echo "当前代码版本必须等于最新正式 release 版本。"
  echo "Bump 后才能保证新版本 = ${LATEST_VER} + 1。"
  echo ""
  echo "如果当前代码版本已经大于最新 release，可能是："
  echo "  1. 有 draft/prerelease 占用了目标版本号"
  echo "  2. 已经手动 bump 过版本"
  echo "  3. 需要先还原到 ${LATEST_VER} 再重新 bump"
  exit 1
fi

# ── W25 接线（data-source-governance P4.3）：pi 依赖版本变更 → bump 前先跑协议契约测试 ──
# 检测待发布范围（v<LATEST_VER> tag → 当前工作区）内 @earendil-works/pi-coding-agent
# 依赖是否变更（实际声明在 root package.json devDependencies；同时覆盖
# packages/runtime/package.json，对齐 plan W25 对两处表述的兼容）。变更时先跑
# packages/runtime/src/__tests__/equivalence/pi-protocol-contract.test.ts
# （RPC 命令面 / 事件面 / entry 面三断言 + entry_appended 不发射的 D5 固化），
# 红 = 上游协议漂移，先处理漂移再 bump，防事件语义漂移静默制造新分叉。
# 注意：契约测试 spawn 真实 pi（skip-if-no-pi 约定）——pi 缺席时 skip 放行并警告补跑。
pi_dep_at_ref() {
  git -C "$WS_ROOT" show "${1}:${2}" 2>/dev/null \
    | jq -r '.devDependencies["@earendil-works/pi-coding-agent"] // .dependencies["@earendil-works/pi-coding-agent"] // "-"' \
    || echo '-'
}
pi_dep_on_disk() {
  jq -r '.devDependencies["@earendil-works/pi-coding-agent"] // .dependencies["@earendil-works/pi-coding-agent"] // "-"' "$1" 2>/dev/null \
    || echo '-'
}

RELEASE_PI="$(pi_dep_at_ref "v${LATEST_VER}" package.json)|$(pi_dep_at_ref "v${LATEST_VER}" packages/runtime/package.json)"
CURRENT_PI="$(pi_dep_on_disk "${WS_ROOT}/package.json")|$(pi_dep_on_disk "${WS_ROOT}/packages/runtime/package.json")"

if [ "$RELEASE_PI" != "$CURRENT_PI" ]; then
  echo ""
  echo "检测到 pi 依赖版本变更（W25 契约测试接线）："
  echo "  v${LATEST_VER} release: ${RELEASE_PI}"
  echo "  当前工作区:             ${CURRENT_PI}"
  if ! command -v pi > /dev/null 2>&1; then
    echo "警告: pi 不在 PATH，契约测试将 skip（skipIf 约定）——请在有 pi 的环境补跑："
    echo "  cd packages/runtime && pnpm exec vitest run src/__tests__/equivalence/pi-protocol-contract.test.ts"
  fi
  echo "运行 pi 协议契约测试（RPC 面 / 事件面 / entry 面 + D5 固化）..."
  if ! (cd "${WS_ROOT}/packages/runtime" && pnpm exec vitest run src/__tests__/equivalence/pi-protocol-contract.test.ts); then
    echo ""
    echo "ERROR: pi 协议契约测试失败——上游协议漂移，禁止直接 bump 发布。"
    echo "处置路径（data-source-governance W25）："
    echo "  1. 对照 packages/runtime/src/infra/pi/pi-protocol.ts（ADR-0037 真契约）定位漂移的事件/字段"
    echo "  2. entry_appended 断言红 = 上游补发射 → 触发 W21 预留的换源适配，勿静默改断言"
    echo "  3. 漂移处理完重跑本脚本: bash scripts/check-version-bump.sh"
    exit 1
  fi
  echo "OK: pi 协议契约测试通过。"
fi

echo "OK: 当前代码版本 (${CURRENT_VER}) == 最新正式 release (${LATEST_VER})"
echo "可以执行版本 bump。"
