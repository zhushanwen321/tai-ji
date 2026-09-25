#!/bin/bash
# release.sh — taiji merge 流程阶段 5：Release Notes + 创建/更新 GitHub Release
#
# 做什么：
#   1. 从 conventional commits 自动生成 release notes 草稿（双语三节结构，对齐 docs/release-notes.md；
#      条目为 commit 原文直出，须按该规范人工定稿）
#   2. 创建或更新 GitHub Release（优先更新 CI 创建的 Draft Release）
#
# 前置：阶段 4 已完成（version bump + tag push + CI 构建产物）
# 用法: bash .agents/skills/merge/scripts/release.sh [tag] [--notes <file>]
#   tag:       如 v0.6.5（不提供则从 main worktree 的 package.json 读取）
#   --notes:   指定 release notes 文件（不提供则从 commit 自动生成）
# 退出码：0 = 成功，1 = 失败

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

GH_REPO="zhushanwen321/tai-ji"
GH_REMOTE="github"

# 参数解析
NOTES_FILE=""
POSITIONAL=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --notes) NOTES_FILE="$2"; shift 2 ;;
        *)       POSITIONAL+=("$1"); shift ;;
    esac
done
set -- "${POSITIONAL[@]}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WS_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd -P)"
MAIN_WT="$WS_ROOT/main"

# 确定 tag
if [[ $# -ge 1 ]]; then
    TAG="$1"
else
    VERSION=$(node -p "require('$MAIN_WT/package.json').version" 2>/dev/null || echo "")
    if [[ -z "$VERSION" ]]; then
        echo -e "${RED}Error: 无法读取版本号，请显式传入 tag${NC}"
        exit 1
    fi
    TAG="v$VERSION"
fi

if [[ -n "$NOTES_FILE" ]] && [[ ! -f "$NOTES_FILE" ]]; then
    echo -e "${RED}Error: Release notes 文件不存在: $NOTES_FILE${NC}"
    exit 1
fi

echo -e "${BOLD}═══ 阶段 5: Release ($TAG) ═══${NC}"

REPO_URL="https://github.com/$GH_REPO"

# 5a. 确定 release notes
if [[ -n "$NOTES_FILE" ]]; then
    echo "  使用指定的 release notes: $NOTES_FILE"
    FINAL_NOTES_FILE="$NOTES_FILE"
else
    # 生成 commit 清单
    LAST_TAG=$(git -C "$MAIN_WT" describe --tags --abbrev=0 HEAD^ 2>/dev/null || echo "")
    if [[ -n "$LAST_TAG" ]]; then
        LOG_RANGE="$LAST_TAG..HEAD"
        echo "  上一个 tag: $LAST_TAG"
        echo "  commit 范围: $LOG_RANGE"
    else
        LOG_RANGE="HEAD~30..HEAD"
        echo "  无上一个 tag，取最近 30 条 commit"
    fi

    FINAL_NOTES_FILE="$WS_ROOT/.release-notes-auto.md"
    COMMIT_FILE="$WS_ROOT/.release-commits.txt"
    git -C "$MAIN_WT" log "$LOG_RANGE" --pretty=format:"%s" --no-merges > "$COMMIT_FILE" 2>/dev/null || echo "(无 commit)" > "$COMMIT_FILE"

    echo "  从 conventional commits 自动生成 release notes..."
    # conventional commit 分组
    features="" fixes="" perfs="" breaking=""
    while IFS= read -r line; do
        msg="${line#*: }"
        case "$line" in
            feat:*|feat\(*:*)
                [[ -n "$features" ]] && features+=$'\n'
                features+="  - ${msg}" ;;
            fix:*|fix\(*:*)
                [[ -n "$fixes" ]] && fixes+=$'\n'
                fixes+="  - ${msg}" ;;
            perf:*|perf\(*:*)
                [[ -n "$perfs" ]] && perfs+=$'\n'
                perfs+="  - ${msg}" ;;
            breaking:*|breaking\(*:*)
                [[ -n "$breaking" ]] && breaking+=$'\n'
                breaking+="  - ${msg}" ;;
        esac
    done < "$COMMIT_FILE"

    {
        echo "<!-- LANG:en -->"
        if [[ -n "$breaking" ]]; then
            echo "## Breaking Changes"
            echo "$breaking"
            echo ""
        fi
        if [[ -n "$features" ]]; then
            echo "## New Features"
            echo "$features"
            echo ""
        fi
        if [[ -n "$perfs" ]]; then
            echo "## Improvements"
            echo "$perfs"
            echo ""
        fi
        if [[ -n "$fixes" ]]; then
            echo "## Bug Fixes"
            echo "$fixes"
            echo ""
        fi
        if [[ -n "$LAST_TAG" ]]; then
            echo "**Full Changelog**: ${REPO_URL}/compare/${LAST_TAG}...${TAG}"
            echo ""
        fi
        echo "<!-- LANG:zh -->"
        if [[ -n "$breaking" ]]; then
            echo "## 重大变更"
            echo "$breaking"
            echo ""
        fi
        if [[ -n "$features" ]]; then
            echo "## 新增功能"
            echo "$features"
            echo ""
        fi
        if [[ -n "$perfs" ]]; then
            echo "## 功能优化"
            echo "$perfs"
            echo ""
        fi
        if [[ -n "$fixes" ]]; then
            echo "## 修复缺陷"
            echo "$fixes"
            echo ""
        fi
        if [[ -n "$LAST_TAG" ]]; then
            echo "**完整变更**: ${REPO_URL}/compare/${LAST_TAG}...${TAG}"
            echo ""
        fi
    } > "$FINAL_NOTES_FILE"

    LINES=$(wc -l < "$FINAL_NOTES_FILE" | tr -d ' ')
    if [[ "$LINES" -le 2 ]]; then
        echo -e "  ${YELLOW}⚠️  自动生成的 release notes 为空（无 feat/fix/perf/breaking commit）${NC}"
        echo "  使用 PR 标题作为默认内容"
        PR_TITLE=$(gh pr list --repo "$GH_REPO" --state merged --limit 1 --json title --jq '.[0].title' 2>/dev/null || echo "Release $TAG")
        {
            echo "<!-- LANG:en -->"
            echo "## New Features"
            echo ""
            echo "- $PR_TITLE"
            if [[ -n "$LAST_TAG" ]]; then
                echo ""
                echo "**Full Changelog**: ${REPO_URL}/compare/${LAST_TAG}...${TAG}"
            fi
            echo ""
            echo "<!-- LANG:zh -->"
            echo "## 新增功能"
            echo ""
            echo "- $PR_TITLE"
            if [[ -n "$LAST_TAG" ]]; then
                echo ""
                echo "**完整变更**: ${REPO_URL}/compare/${LAST_TAG}...${TAG}"
            fi
        } > "$FINAL_NOTES_FILE"
    fi

    echo -e "  ${YELLOW}⚠️  以上为自动草稿：条目是 commit 原文直出，未按规范模糊化 / 排序 / 合并${NC}"
    echo -e "  ${YELLOW}     定稿要求见 docs/release-notes.md，手写后覆盖：gh release edit $TAG --repo $GH_REPO --notes-file <双语文件>${NC}"
fi

# 5b. 创建或更新 Release
# 优先等 CI 创建 Draft Release（含构建产物），fallback 手动创建
EXISTING_RELEASE=$(gh release view "$TAG" --repo "$GH_REPO" --json isDraft,id,body,assets --jq '.' 2>/dev/null || echo "")

if [[ -n "$EXISTING_RELEASE" ]]; then
    ASSET_COUNT=$(echo "$EXISTING_RELEASE" | jq -r '.assets | length // 0' 2>/dev/null) || ASSET_COUNT="0"
    IS_DRAFT=$(echo "$EXISTING_RELEASE" | jq -r '.isDraft // false' 2>/dev/null) || IS_DRAFT="false"
    # [HISTORICAL] $IS_DRAFT 必须用 ${IS_DRAFT} 显式界定变量名边界：
    # 紧跟的 ） 是 UTF-8 全角括号（U+FF09，3 字节 ef bc 89）。
    # 裸 $IS_DRAFT 后 bash 变量名扫描器会把首字节 0xEF 吞进变量名，
    # 触发 `IS_DRAFT$'\357': unbound variable`（set -u 下退出）。
    echo "  发现已有 Release（assets=$ASSET_COUNT, draft=${IS_DRAFT}）"

    EXISTING_BODY=$(echo "$EXISTING_RELEASE" | jq -r '.body // ""' 2>/dev/null || echo "")
    if [[ -z "$EXISTING_BODY" ]] || [[ ${#EXISTING_BODY} -lt 20 ]]; then
        echo "  Release notes 为空，回填中..."
    else
        echo "  更新已有 Release notes"
    fi
    gh release edit "$TAG" --repo "$GH_REPO" --notes-file "$FINAL_NOTES_FILE" 2>&1 || true

    # 如果是 Draft，发布它
    if [[ "$IS_DRAFT" == "true" ]]; then
        echo "  发布 Draft Release..."
        gh release edit "$TAG" --repo "$GH_REPO" --draft=false 2>&1 || true
    fi
    RELEASE_URL="${REPO_URL}/releases/tag/$TAG"
else
    # CI 可能还没创建，等待最多 120 秒
    echo "  未找到 Release，等待 CI 创建 Draft Release（最多 120s）..."
    WAIT_ELAPSED=0
    while [[ $WAIT_ELAPSED -lt 120 ]]; do
        sleep 5
        WAIT_ELAPSED=$((WAIT_ELAPSED + 5))
        EXISTING_RELEASE=$(gh release view "$TAG" --repo "$GH_REPO" --json isDraft,id,body,assets --jq '.' 2>/dev/null || echo "")
        if [[ -n "$EXISTING_RELEASE" ]]; then
            ASSET_COUNT=$(echo "$EXISTING_RELEASE" | jq -r '.assets | length // 0' 2>/dev/null) || ASSET_COUNT="0"
            if [[ "$ASSET_COUNT" -gt 0 ]]; then
                echo -e "  ${GREEN}✅ CI 已创建 Draft Release（$ASSET_COUNT 个产物，${WAIT_ELAPSED}s）${NC}"
                break
            fi
        fi
        echo "  ⏳ 等待中... (${WAIT_ELAPSED}s/120s)"
    done

    # 再次检查（等待循环中可能已创建）
    EXISTING_RELEASE=$(gh release view "$TAG" --repo "$GH_REPO" --json isDraft,id,body,assets --jq '.' 2>/dev/null || echo "")
    if [[ -n "$EXISTING_RELEASE" ]]; then
        echo "  Release 已存在，更新 notes"
        gh release edit "$TAG" --repo "$GH_REPO" --notes-file "$FINAL_NOTES_FILE" 2>&1 || true
        IS_DRAFT=$(echo "$EXISTING_RELEASE" | jq -r '.isDraft // false' 2>/dev/null) || IS_DRAFT="false"
        if [[ "$IS_DRAFT" == "true" ]]; then
            echo "  发布 Draft Release..."
            gh release edit "$TAG" --repo "$GH_REPO" --draft=false 2>&1 || true
        fi
        RELEASE_URL="${REPO_URL}/releases/tag/$TAG"
    else
        echo -e "  ${YELLOW}⚠️  CI 未创建 Release，手动创建（将无构建产物）${NC}"
        echo -e "  ${YELLOW}如需构建产物: gh workflow run release.yml --repo $GH_REPO${NC}"
        RELEASE_URL=$(gh release create "$TAG" --repo "$GH_REPO" \
            --title "$TAG" \
            --notes-file "$FINAL_NOTES_FILE" \
            --target main 2>&1 | tail -1) || {
            echo -e "${RED}❌ Release 创建失败${NC}"
            exit 1
        }
        echo -e "  ${GREEN}✅ Release 已创建${NC}"
    fi
fi

# 最终产物验证
FINAL_ASSETS=$(gh release view "$TAG" --repo "$GH_REPO" --json assets --jq '.assets | length' 2>/dev/null || echo "0")
if [[ "$FINAL_ASSETS" -eq 0 ]]; then
    echo -e "  ${YELLOW}⚠️  Release 无构建产物（dmg/exe/AppImage）${NC}"
    echo -e "  ${YELLOW}手动触发: gh workflow run release.yml --repo $GH_REPO${NC}"
else
    echo -e "  ${GREEN}✅ Release 含 $FINAL_ASSETS 个产物${NC}"
fi

# 清理临时文件
rm -f "$WS_ROOT/.release-notes-auto.md" "$WS_ROOT/.release-commits.txt"

echo ""
echo "  URL: $RELEASE_URL"
echo -e "  ${GREEN}✅ 阶段 5 完成${NC}"
