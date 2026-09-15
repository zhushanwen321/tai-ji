#!/bin/bash
# 预发布测试：创建 -beta 版本触发 CI，验证产物，还原代码
# Usage: bash scripts/prerelease-test.sh
set -euo pipefail

# 检查失败原则：任何非 0 退出都输出（不管从哪个 exit 点）
trap '[ $? -ne 0 ] && echo "[原则] 无论是否本次改动引入的问题，都必须正面修复解决，不允许跳过。" >&2' EXIT

REPO="zhushanwen321/tai-ji"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WS_ROOT="${WS_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
GITHUB_REMOTE="github"
CI_TIMEOUT_MINS=30
POLL_INTERVAL=20

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[PRERELEASE]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*"; }

# CI 失败/超时时不自动删除任何远程状态（bump commit / beta tag / release 会残留），
# 由失败路径打印手动还原命令，人工确认后执行

# ── 阶段 1/6: 前置检查 ──
log "=== 阶段 1/6: 前置检查 ==="

BRANCH=$(git -C "$WS_ROOT" branch --show-current)
if [ "$BRANCH" != "main" ]; then
  warn "当前在 ${BRANCH} 分支（非 main），产物将包含此分支的未合并改动"
fi

if ! git -C "$WS_ROOT" diff-index --quiet HEAD --; then
  err "工作区不干净，请先 commit 或 stash"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  err "gh CLI 未认证，请先运行 gh auth login"
  exit 1
fi

log "前置检查通过: ${BRANCH} 分支, 工作区干净, gh 已认证"

# ── 阶段 2/6: 计算 beta 版本号 ──
log "=== 阶段 2/6: 计算 beta 版本号 ==="

# 2a. 获取最新正式 release
LATEST=$(gh release list --repo "$REPO" --limit 100 \
  --json tagName,isDraft,isPrerelease \
  | jq -r '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' \
  | head -1)

if [ -z "$LATEST" ]; then
  err "未找到正式 release"
  exit 1
fi
LATEST_VER="${LATEST#v}"
log "最新正式 release: v${LATEST_VER}"

# 2b. 确认代码版本匹配
CURRENT_VER=$(node -p "require('${WS_ROOT}/package.json').version")
if [ "$LATEST_VER" != "$CURRENT_VER" ]; then
  err "代码版本 (${CURRENT_VER}) != 最新 release (${LATEST_VER})"
  exit 1
fi

# 2c. 计算下一个正式版本号（默认 patch +1）
IFS='.' read -r MAJOR MINOR PATCH <<< "$LATEST_VER"
NEXT_PATCH=$((PATCH + 1))
BASE_NEXT="${MAJOR}.${MINOR}.${NEXT_PATCH}"

# 2d. 清理旧 beta release/tag，使用固定 -beta 后缀
BETA_VERSION="${BASE_NEXT}-beta"
BETA_TAG="v${BETA_VERSION}"
ORIGINAL_VERSION="$CURRENT_VER"

# 清理已有的同名 beta release 和 tag
if gh release view "$BETA_TAG" --repo "$REPO" &>/dev/null; then
  log "清理旧 beta release: ${BETA_TAG}"
  gh release delete "$BETA_TAG" --repo "$REPO" --yes 2>/dev/null || true
fi
git push "$GITHUB_REMOTE" --delete "$BETA_TAG" 2>/dev/null || true
git tag -d "$BETA_TAG" 2>/dev/null || true

log "beta 版本: ${BETA_TAG}"

# ── 阶段 3/6: Bump + Push ──
log "=== 阶段 3/6: Bump 版本并推送 ==="

cd "$WS_ROOT"
pnpm version "$BETA_VERSION" --no-git-tag-version 1>/dev/null
cd apps/electron
pnpm version "$BETA_VERSION" --no-git-tag-version 1>/dev/null
cd "$WS_ROOT"

git add package.json apps/electron/package.json
git commit -m "chore: prerelease ${BETA_TAG}"
git tag "$BETA_TAG"
git push "$GITHUB_REMOTE" HEAD
git push "$GITHUB_REMOTE" "$BETA_TAG"

log "Tag ${BETA_TAG} 已推送，CI 开始构建..."

# ── 阶段 4/6: 等待 CI 完成 ──
log "=== 阶段 4/6: 等待 CI 完成（超时: ${CI_TIMEOUT_MINS} 分钟）==="

MAX_POLLS=$((CI_TIMEOUT_MINS * 60 / POLL_INTERVAL))

for i in $(seq 1 "$MAX_POLLS"); do
  # 轮询 release 是否存在（CI 最后一步会创建 release）
  if gh release view "$BETA_TAG" --repo "$REPO" &>/dev/null; then
    log "Release ${BETA_TAG} 已创建，CI 构建完成"
    break
  fi

  log "等待 CI 完成... ($i/$MAX_POLLS)"
  sleep "$POLL_INTERVAL"
done

# 检查是否超时
if ! gh release view "$BETA_TAG" --repo "$REPO" &>/dev/null; then
  err "CI 超时（${CI_TIMEOUT_MINS} 分钟），请手动检查"
  warn "https://github.com/${REPO}/actions"
  warn "脚本中断，远程已残留 bump commit 与 ${BETA_TAG} tag（release 若已创建也需清理）。确认 CI 问题后手动还原："
  warn "  git reset --hard HEAD~1 && git push ${GITHUB_REMOTE} HEAD --force-with-lease"
  warn "  git push ${GITHUB_REMOTE} --delete ${BETA_TAG}"
  warn "  gh release delete ${BETA_TAG} --repo ${REPO} --yes"
  exit 1
fi

# ── 阶段 5/6: 验证产物 ──
log "=== 阶段 5/6: 验证产物 ==="

# 等待 assets 上传完成（release 创建后 assets 可能还在上传）
for i in $(seq 1 6); do
  ASSET_COUNT=$(gh release view "$BETA_TAG" --repo "$REPO" --json assets \
    --jq '.assets | length' 2>/dev/null || echo "0")
  [[ "$ASSET_COUNT" =~ ^[0-9]+$ ]] || ASSET_COUNT=0
  ASSETS=$(gh release view "$BETA_TAG" --repo "$REPO" --json assets \
    --jq '.assets[].name' 2>/dev/null || echo "")
  if [ "$ASSET_COUNT" -ge 3 ]; then
    break
  fi
  log "等待产物上传... ($i/6, 当前 $ASSET_COUNT 个)"
  sleep 10
done

if [ -z "$ASSETS" ]; then
  warn "未找到任何产物，请手动检查"
  warn "  https://github.com/${REPO}/releases/tag/${BETA_TAG}"
else
  echo ""
  echo "产物列表:"
  echo "$ASSETS"
  echo ""

  MISSING=0
  echo "$ASSETS" | grep -q "\.dmg$" || { warn "缺少 macOS .dmg"; MISSING=1; }
  echo "$ASSETS" | grep -q "\.exe$" || { warn "缺少 Windows .exe"; MISSING=1; }
  echo "$ASSETS" | grep -q "AppImage" || { warn "缺少 Linux AppImage"; MISSING=1; }

  if [ "$MISSING" -eq 0 ]; then
    log "所有平台产物已生成 (dmg + exe + AppImage)"
  fi
fi

# ── 阶段 6/6: 还原版本 ──
log "=== 阶段 6/6: 还原版本 ==="

echo ""
warn "产物已生成，请下载并测试:"
warn "  https://github.com/${REPO}/releases/tag/${BETA_TAG}"
echo ""

read -p "测试通过？输入 yes 还原版本并清理 (输入 no 保留 beta): " CONFIRM

if [ "$CONFIRM" = "yes" ]; then
  cd "$WS_ROOT"

  # 还原代码版本（使用 --force-with-lease 防止覆盖他人提交）
  git reset --hard HEAD~1
  git push "$GITHUB_REMOTE" HEAD --force-with-lease

  # 删除 beta tag（本地和远程）
  git tag -d "$BETA_TAG" 2>/dev/null || true
  git push "$GITHUB_REMOTE" --delete "$BETA_TAG" 2>/dev/null || true

  # 删除 beta release
  gh release delete "$BETA_TAG" --repo "$REPO" --yes 2>/dev/null || true

  log "完成: 版本已还原到 ${ORIGINAL_VERSION}，beta tag 和 release 已清理"
else
  log "保留 beta 版本 ${BETA_TAG}，未还原代码版本"
  log "手动还原: git reset --hard HEAD~1 && git push github HEAD --force-with-lease"
fi
