#!/bin/bash
# 验证 CI 构建完成且 GitHub Release 产物完整
# Usage: bash scripts/verify-ci-release.sh <tag> [--ci-timeout N]
#   tag:         如 v0.4.7 或 v0.4.7-beta.1
#   --ci-timeout: CI 等待超时分钟数（默认 30）
#
# Exit: 0 = CI 完成 + 产物完整, 非 0 = 失败（具体见输出）

set -euo pipefail

REPO="zhushanwen321/tai-ji"
CI_TIMEOUT_MINS=30
POLL_INTERVAL=30

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[VERIFY]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }
fatal() { echo -e "${RED}[FATAL]${NC} $*"; exit 1; }

# ── 参数解析 ──
TAG="${1:-}"
if [ -z "$TAG" ]; then
  fatal "Usage: bash scripts/verify-ci-release.sh <tag> [--ci-timeout N]"
fi
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --ci-timeout) CI_TIMEOUT_MINS="$2"; shift 2 ;;
    *) fatal "Unknown option: $1" ;;
  esac
done

# ── 阶段 1: 等待 CI workflow 完成 ──
log "=== 阶段 1/3: 等待 Release CI ==="
log "Tag: ${TAG}, 超时: ${CI_TIMEOUT_MINS} 分钟"

# 查找最新的 Release workflow run（由 tag push 触发）
MAX_POLLS=$((CI_TIMEOUT_MINS * 60 / POLL_INTERVAL))
RUN_FOUND=0

for i in $(seq 1 "$MAX_POLLS"); do
  # 获取最近的 Release workflow runs
  RUNS=$(gh run list --repo "$REPO" --workflow Release --limit 5 \
    --json databaseId,status,conclusion,headBranch,displayTitle 2>/dev/null || echo "[]")
  if ! echo "$RUNS" | jq -e 'type == "array"' >/dev/null 2>&1; then RUNS='[]'; fi

  # 尝试匹配 tag 触发的 run（headBranch 可能是 tag 名或 refs/tags/...）
  RUN_ID=$(echo "$RUNS" | jq -r --arg tag "$TAG" \
    '.[] | select(.headBranch == $tag or .headBranch == "refs/tags/" + $tag) | .databaseId' \
    | head -1) || RUN_ID=""

  if [ -z "$RUN_ID" ]; then
    # 备选：按 displayTitle 模糊匹配（可能包含 tag 名）
    RUN_ID=$(echo "$RUNS" | jq -r --arg tag "$TAG" \
      '.[] | select(.displayTitle | test($tag)) | .databaseId' \
      | head -1) || RUN_ID=""
  fi

  if [ -n "$RUN_ID" ]; then
    RUN_STATUS=$(echo "$RUNS" | jq -r --arg id "$RUN_ID" '.[] | select(.databaseId == ($id | tonumber)) | "\(.status) \(.conclusion)"')
    STATUS=$(echo "$RUN_STATUS" | awk '{print $1}')
    CONCLUSION=$(echo "$RUN_STATUS" | awk '{print $2}')

    if [ "$STATUS" = "completed" ]; then
      RUN_FOUND=1
      log "CI workflow: https://github.com/${REPO}/actions/runs/${RUN_ID}"
      if [ "$CONCLUSION" = "success" ]; then
        log "CI 构建成功"
        break
      else
        fatal "CI 构建失败 (conclusion: ${CONCLUSION})"
      fi
    fi
  fi

  log "等待 CI 完成... ($i/$MAX_POLLS)"
  sleep "$POLL_INTERVAL"
done

if [ "$RUN_FOUND" -eq 0 ]; then
  fatal "CI 超时（${CI_TIMEOUT_MINS} 分钟），未找到完成的 workflow run"
fi

# ── 阶段 2: 等待 Release 创建 + 产物上传 ──
log "=== 阶段 2/3: 等待 Release 产物 ==="

# 等待 release 出现
for i in $(seq 1 12); do
  if gh release view "$TAG" --repo "$REPO" &>/dev/null; then
    log "Release ${TAG} 已创建"
    break
  fi
  log "等待 Release 创建... ($i/12)"
  sleep 10
done

if ! gh release view "$TAG" --repo "$REPO" &>/dev/null; then
  fatal "Release ${TAG} 未创建，CI 可能未完成 release 步骤"
fi

# 等待 assets 上传（至少 3 个：dmg + exe + AppImage）
for i in $(seq 1 12); do
  ASSET_COUNT=$(gh release view "$TAG" --repo "$REPO" --json assets \
    --jq '.assets | length' 2>/dev/null || echo "0")
  if [ "$ASSET_COUNT" -ge 3 ] 2>/dev/null; then
    log "产物已上传 (${ASSET_COUNT} 个)"
    break
  fi
  log "等待产物上传... ($i/12, 当前 ${ASSET_COUNT} 个)"
  sleep 10
done

# ── 阶段 3: 验证产物完整性 ──
log "=== 阶段 3/3: 验证产物完整性 ==="

ASSETS=$(gh release view "$TAG" --repo "$REPO" --json assets \
  --jq '.assets[].name' 2>/dev/null || echo "")

if [ -z "$ASSETS" ]; then
  fatal "Release ${TAG} 没有任何产物"
fi

echo ""
echo "产物列表:"
echo "$ASSETS"
echo ""

ERRORS=0
echo "$ASSETS" | grep -q "\.dmg$" || { err "缺少 macOS .dmg"; ERRORS=$((ERRORS + 1)); }
echo "$ASSETS" | grep -q "\.exe$" || { err "缺少 Windows .exe"; ERRORS=$((ERRORS + 1)); }
echo "$ASSETS" | grep -q "AppImage" || { err "缺少 Linux AppImage"; ERRORS=$((ERRORS + 1)); }
# 负向断言：zip/deb target 已删除（2026-09 产物形态收敛），残留即发布管线配置回退
echo "$ASSETS" | grep -qE "\.zip$" && { err "unexpected .zip asset (zip target removed)"; ERRORS=$((ERRORS + 1)); }
echo "$ASSETS" | grep -qE "\.deb$" && { err "unexpected .deb asset (deb target removed)"; ERRORS=$((ERRORS + 1)); }

if [ "$ERRORS" -gt 0 ]; then
  echo ""
  fatal "产物校验失败（${ERRORS} 项问题，详见上方 ERROR）"
fi

log "验证通过：CI 成功，3 个平台产物完整（mac + win + linux）"
log "下载链接: https://github.com/${REPO}/releases/tag/${TAG}"
