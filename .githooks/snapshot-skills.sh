#!/usr/bin/env bash
# ============================================================================
# snapshot-skills.sh — 把 workspace 根的 .agents 实体快照到 refs/skills-snapshot
#
# 用法：
#   .githooks/snapshot-skills.sh [--no-push]
#     手动调用（在任意 worktree 内），或由 pre-commit 尾部段自动调用。
#     --no-push 只更新本地 ref，不推远端。
#
# 机制（设计 cross-worktree-skill-sync.md D3）：
#   - 全程不碰工作树与 index：内容写入临时 GIT_INDEX_FILE（mktemp + trap 清理），
#     write-tree + commit-tree + update-ref，对象进主仓共享对象库。
#   - 实体内容与现值快照树相同 → 跳过（无变化不产生快照 commit）。
#   - 空树防御：实体不存在或为空 → 不产生快照（防好快照被空树覆盖），exit 1。
#   - 并发语义：update-ref 后写赢，后写反映更晚的实体状态（两 worktree 读同一
#     实体）；推送到达乱序的秒级窗口由下一次成功推送自愈。
#   - push 超时降级链：timeout(coreutils) → perl alarm(macOS 原生) → 跳过仅日志。
#     push 失败非致命，下次 commit 自动重试；远端 ref 是跨机器重建的权威备份点。
#
# 恢复：git archive refs/skills-snapshot | tar -x -C <workspace 根>
# ============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT_ROOT="$(dirname "$SCRIPT_DIR")"
WS_ROOT="$(dirname "$WT_ROOT")"
ENTITY="$WS_ROOT/.agents"
SNAPSHOT_REF="refs/skills-snapshot"
PUSH_TIMEOUT_SEC=20
# remote 名自适应：本 workspace 既有仓库约定为 github（无 origin，refs/remotes/origin/* 是
# 改名残留 stale refs，禁用）；fresh clone 默认 origin。取第一个存在的 remote。
WT_REMOTE="$(git -C "$WT_ROOT" remote 2>/dev/null | while read -r r; do [ "$r" = "github" ] && { echo github; break; }; done)"
[ -n "$WT_REMOTE" ] || WT_REMOTE="$(git -C "$WT_ROOT" remote 2>/dev/null | head -1)"

msg() { echo "[skills-snapshot] $*" >&2; }

# --- 空树防御 ---------------------------------------------------------------
if [ ! -d "$ENTITY" ] || [ -z "$(ls -A "$ENTITY" 2>/dev/null)" ]; then
  msg "ERROR: entity $ENTITY missing or empty; snapshot aborted (existing snapshot preserved)"
  msg "recover: see docs/TROUBLESHOOTING.md → 实体从快照还原"
  exit 1
fi

# --- 来源标记（commit message 用）------------------------------------------
BRANCH="$(git -C "$WT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
[ -n "${BRANCH:-}" ] && [ "$BRANCH" != "HEAD" ] \
  && SRC="branch=$BRANCH" || SRC="detached"
SRC="worktree=$(basename "$WT_ROOT") $SRC head=$(git -C "$WT_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# --- 写临时 index（不碰工作树与真实 index）----------------------------------
# mktemp 拿唯一路径后删除空文件本体：git add 对 0 字节 index 文件报
# "index file smaller than expected"，对不存在的路径则按空 index 处理
TMP_INDEX="$(mktemp -t skills-snapshot-index)" || { msg "ERROR: mktemp failed"; exit 1; }
rm -f "$TMP_INDEX"
trap 'rm -f "$TMP_INDEX"' EXIT

GIT_DIR="$(git -C "$WT_ROOT" rev-parse --absolute-git-dir)" || { msg "ERROR: not a git repo: $WT_ROOT"; exit 1; }
# pathspec 以 cwd 解析：必须在 workspace 根内执行 add（GIT_DIR 显式指定阻断仓库发现，
# GIT_WORK_TREE 与 cwd 一致），否则 .agents 匹配到 worktree 里的 symlink 而非实体
(
  cd "$WS_ROOT" || exit 1
  GIT_INDEX_FILE="$TMP_INDEX" GIT_DIR="$GIT_DIR" GIT_WORK_TREE="$WS_ROOT" \
    git add --force .agents || exit 1
) || { msg "ERROR: failed to index entity"; exit 1; }

TREE="$(GIT_INDEX_FILE="$TMP_INDEX" GIT_DIR="$GIT_DIR" git write-tree)" \
  || { msg "ERROR: write-tree failed"; exit 1; }

PREV_REF="$(GIT_DIR="$GIT_DIR" git rev-parse -q --verify "$SNAPSHOT_REF" 2>/dev/null || true)"
if [ -n "$PREV_REF" ]; then
  PREV_TREE="$(GIT_DIR="$GIT_DIR" git rev-parse "$PREV_REF^{tree}" 2>/dev/null || true)"
  if [ "$TREE" = "$PREV_TREE" ]; then
    msg "entity unchanged since last snapshot; skipped"
    exit 0
  fi
fi

COMMIT="$(GIT_DIR="$GIT_DIR" git commit-tree "$TREE" ${PREV_REF:+-p "$PREV_REF"} \
  -m "skills snapshot: $SRC")" || { msg "ERROR: commit-tree failed"; exit 1; }

# update-ref 带旧值乐观锁；并发方先写时重读比较，树相同则跳过，不同则后写赢
if ! GIT_DIR="$GIT_DIR" git update-ref "$SNAPSHOT_REF" "$COMMIT" ${PREV_REF:+"$PREV_REF"} 2>/dev/null; then
  msg "concurrent snapshot detected; re-checking"
  NEW_REF="$(GIT_DIR="$GIT_DIR" git rev-parse -q --verify "$SNAPSHOT_REF" 2>/dev/null || true)"
  NEW_TREE="$(GIT_DIR="$GIT_DIR" git rev-parse "${NEW_REF:-}^{tree}" 2>/dev/null || true)"
  [ "$TREE" = "$NEW_TREE" ] && { msg "concurrent writer had identical tree; skipped"; exit 0; }
  GIT_DIR="$GIT_DIR" git update-ref "$SNAPSHOT_REF" "$COMMIT" || { msg "ERROR: update-ref failed"; exit 1; }
fi
msg "snapshot updated: $COMMIT ($SRC)"

# --- 推送远端（跨机器权威备份点；失败非致命）--------------------------------
[ "${1:-}" = "--no-push" ] && { msg "--no-push given; remote snapshot not updated"; exit 0; }

push_ok=false
if command -v timeout >/dev/null 2>&1; then
  timeout "$PUSH_TIMEOUT_SEC" git -C "$WT_ROOT" push --force "$WT_REMOTE" "$SNAPSHOT_REF:$SNAPSHOT_REF" \
    && push_ok=true
elif command -v perl >/dev/null 2>&1; then
  perl -e 'alarm shift; exec @ARGV or exit 127' "$PUSH_TIMEOUT_SEC" \
    git -C "$WT_ROOT" push --force "$WT_REMOTE" "$SNAPSHOT_REF:$SNAPSHOT_REF" && push_ok=true
else
  msg "WARN: neither timeout nor perl available; skipping remote push (will retry on next snapshot)"
fi

if $push_ok; then
  msg "remote snapshot synced"
else
  msg "WARN: remote push failed or timed out (non-fatal); local snapshot intact, will retry on next snapshot"
fi
exit 0
