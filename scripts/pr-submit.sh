#!/usr/bin/env bash
# pr-submit.sh — push + 创建/更新 PR 一体化
#
# 对应 .agents/skills/pr-cr-fix/SKILL.md 阶段 1.3。
# 自动检测 PR 是否已存在、仅在 title/body 有变化时更新。
#
# 用法:
#   bash scripts/pr-submit.sh --title-file <path> --body-file <path>
#   bash scripts/pr-submit.sh --title "feat: x" --body "..."            # 直接传字符串
#   bash scripts/pr-submit.sh --base main --dry-run                     # 不真 push 也不 create
#   bash scripts/pr-submit.sh --review-report <aggregated.md path>       # 自动附到 body 末尾
#
# 退出码:
#   0 = 成功（push + pr create/edit 完成）
#   1 = 入参错误
#   2 = git push 失败
#   3 = gh 调用失败（已认证但调用失败）
#   4 = PR 不存在且 --update-only 被设置
#   5 = title/body 文件缺失或不可读

set -euo pipefail

TITLE=""
BODY=""
BODY_FILE=""
TITLE_FILE=""
BASE="main"
DRY_RUN=0
UPDATE_ONLY=0
REVIEW_REPORT=""

usage() {
    sed -n '2,12p' "$0" | sed 's/^# \?//'
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --title)         TITLE="$2"; shift 2 ;;
        --body)          BODY="$2"; shift 2 ;;
        --title-file)    TITLE_FILE="$2"; shift 2 ;;
        --body-file)     BODY_FILE="$2"; shift 2 ;;
        --base)          BASE="$2"; shift 2 ;;
        --dry-run)       DRY_RUN=1; shift ;;
        --update-only)   UPDATE_ONLY=1; shift ;;
        --review-report) REVIEW_REPORT="$2"; shift 2 ;;
        -h|--help)       usage ;;
        *)               echo "Unknown arg: $1" >&2; usage ;;
    esac
done

GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "Not a git repo" >&2; exit 2; })"
cd "$GIT_ROOT"

BRANCH="$(git branch --show-current)"
[[ -z "$BRANCH" ]] && { echo "Cannot determine current branch" >&2; exit 2; }
[[ "$BRANCH" == "$BASE" ]] && { echo "Current branch is $BASE; refusing to push" >&2; exit 2; }

# ── 解析 title/body
if [[ -n "$TITLE_FILE" ]]; then
    [[ -r "$TITLE_FILE" ]] || { echo "Title file not readable: $TITLE_FILE" >&2; exit 5; }
    TITLE="$(cat "$TITLE_FILE")"
fi
if [[ -z "$TITLE" ]]; then
    # 默认：取最新 commit subject 加 conventional commit 前缀规范
    TITLE="$(git log -1 --format='%s')"
fi
# --body 直传字符串：落临时文件，与 --body-file 同构（usage 承诺的两形态对齐）
if [[ -n "$BODY" && -z "$BODY_FILE" ]]; then
    BODY_FILE="$(mktemp -t pr-body.XXXXXX)"
    printf '%s' "$BODY" > "$BODY_FILE"
fi
[[ -n "$BODY_FILE" ]] || BODY_FILE="$(mktemp -t pr-body.XXXXXX)"
[[ -r "$BODY_FILE" ]] || { echo "Body file not readable: $BODY_FILE" >&2; exit 5; }

# ── 若 --review-report 提供，把它的内容 append 到 body 末尾
if [[ -n "$REVIEW_REPORT" && -r "$REVIEW_REPORT" ]]; then
    REVIEW_SECTION="$(mktemp -t pr-review.XXXXXX)"
    # 维度列表从 report 的 "Dimensions reviewed:" 行动态解析（维度数随 batch 配置变化，
    # pr-cr-fix 7 维 / code-review 5 维等，不能写死）。解析失败降级为通用文案。
    DIMENSIONS_LINE="$(grep -m1 -i 'Dimensions reviewed:' "$REVIEW_REPORT" 2>/dev/null || true)"
    if [[ -n "$DIMENSIONS_LINE" ]]; then
        DIM_LIST="${DIMENSIONS_LINE#*Dimensions reviewed:}"
        DIM_LIST="$(echo "$DIM_LIST" | sed 's/^ *//;s/ *$//;s/, */ \/ /g')"
        DIM_COUNT="$(echo "$DIM_LIST" | awk -F' / ' '{print NF}')"
        DIM_DESC="$DIM_COUNT dimensions ($DIM_LIST)"
    else
        DIM_DESC="multi-dimension review"
    fi
    {
        echo ""
        echo "## Review Summary"
        echo ""
        echo "Aggregated review across $DIM_DESC:"
        echo ""
        # 只抓 Summary 段，避免污染（其余表格留给 reviewer 直接看 PR conversation）
        awk '/^## Summary/,/^## [^S]/' "$REVIEW_REPORT" \
            | sed '/^## [^S]/d' \
            > "$REVIEW_SECTION"
        cat "$REVIEW_SECTION"
    } >> "$BODY_FILE"
    rm -f "$REVIEW_SECTION"
fi

log() { echo "[pr-submit] $*" >&2; }

# ── 1. push（force-with-lease 安全推送，禁止 --force）
# Push remote 选择：bare repo workspace 模式下 origin 是本地 bare repo（非 GitHub），
# github remote 才是真正的 GitHub 远程（见 CLAUDE.md §10）。有 github remote 优先用，
# 否则 fallback origin（普通 repo 场景，origin 即 GitHub）。
if git remote get-url github >/dev/null 2>&1; then
    PUSH_REMOTE="github"
else
    PUSH_REMOTE="origin"
fi

# 从选定的 remote URL 解析 owner/repo。bare repo workspace 下 origin 是本地 bare repo，
# gh 无法从 origin 推断 GitHub repo，所有 gh 调用必须显式 --repo（见 AGENTS.md §10）。
# 兼容 SSH scp-like (git@host:owner/repo.git)、HTTPS (https://host/owner/repo.git)、ssh:// (ssh://git@host[:port]/owner/repo.git) 三种格式。
REMOTE_URL="$(git remote get-url "$PUSH_REMOTE")"
GH_REPO="$(echo "$REMOTE_URL" | sed -E 's#(git@[^:]+:|https?://[^/]+/|ssh://[^/]+/)##; s#\.git$##')"
if [[ ! "$GH_REPO" =~ ^[^/]+/[^/]+$ ]]; then
    log "failed to parse owner/repo from remote $PUSH_REMOTE ($REMOTE_URL) → got '$GH_REPO'" >&2
    exit 1
fi
OWNER="${GH_REPO%%/*}"
HEAD_REF="$OWNER:$BRANCH"

log "pushing $BRANCH to $PUSH_REMOTE (repo=$GH_REPO)..."
if [[ "$DRY_RUN" == "1" ]]; then
    log "(dry-run) skip push"
else
    if ! git push "$PUSH_REMOTE" "HEAD" --force-with-lease; then
        log "git push to $PUSH_REMOTE failed; check upstream tracking" >&2
        exit 2
    fi
fi

# ── 2. 探测现有 PR
log "checking existing PR for branch $BRANCH..."
# pr list --head 对同 repo 分支必须用分支名（owner:branch 是 fork 语义，同 repo 匹配为空）；
# pr create --head 用 owner:branch（兼容 fork，同 repo 也接受）。
EXISTING_JSON="$(gh pr list --repo "$GH_REPO" --head "$BRANCH" --base "$BASE" --state open --json number,title,body 2>/dev/null || echo '[]')"

PR_NUMBER=""
EXISTING_TITLE=""
EXISTING_BODY=""
if [[ "$EXISTING_JSON" != "[]" && -n "$EXISTING_JSON" ]]; then
    PR_NUMBER=$(echo "$EXISTING_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['number'] if d else '')")
    EXISTING_TITLE=$(echo "$EXISTING_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['title'] if d else '')")
    EXISTING_BODY=$(echo "$EXISTING_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['body'] if d else '')")
fi

NEW_BODY="$(cat "$BODY_FILE")"

# ── 3. create / edit 分支
if [[ -z "$PR_NUMBER" ]]; then
    if [[ "$UPDATE_ONLY" == "1" ]]; then
        log "no existing PR for $BRANCH and --update-only set; aborting" >&2
        exit 4
    fi

    log "creating new PR..."
    if [[ "$DRY_RUN" == "1" ]]; then
        log "(dry-run) gh pr create --repo $GH_REPO --head $HEAD_REF --base $BASE --title <title> --body-file $BODY_FILE"
        echo "https://github.com/dry-run/pr/create"
    else
        PR_URL="$(gh pr create --repo "$GH_REPO" --head "$HEAD_REF" --base "$BASE" --title "$TITLE" --body-file "$BODY_FILE")"
        log "created: $PR_URL"
        echo "$PR_URL"
    fi
else
    log "updating existing PR #$PR_NUMBER..."
    NEEDS_TITLE="false"
    NEEDS_BODY="false"

    # 简单 diff：字符串完全相等才不更新
    [[ "$TITLE" != "$EXISTING_TITLE" ]] && NEEDS_TITLE="true"
    [[ "$NEW_BODY" != "$EXISTING_BODY" ]] && NEEDS_BODY="true"

    if [[ "$DRY_RUN" == "1" ]]; then
        log "(dry-run) needs title=$NEEDS_TITLE body=$NEEDS_BODY"
        log "(dry-run) gh pr edit $PR_NUMBER --repo $GH_REPO [--title --body]"
        echo "https://github.com/dry-run/pr/$PR_NUMBER"
    else
        if [[ "$NEEDS_TITLE" == "true" || "$NEEDS_BODY" == "true" ]]; then
            EDIT_ARGS=( "$PR_NUMBER" --repo "$GH_REPO" )
            [[ "$NEEDS_TITLE" == "true" ]] && EDIT_ARGS+=( --title "$TITLE" )
            [[ "$NEEDS_BODY" == "true" ]]  && EDIT_ARGS+=( --body-file "$BODY_FILE" )
            gh pr edit "${EDIT_ARGS[@]}" || { log "gh pr edit failed" >&2; exit 3; }
            log "updated PR #$PR_NUMBER (title=$NEEDS_TITLE body=$NEEDS_BODY)"
        else
            log "PR #$PR_NUMBER already up to date; no edit needed"
        fi
        PR_URL="$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json url -q .url)"
        log "PR URL: $PR_URL"
        echo "$PR_URL"
    fi
fi
