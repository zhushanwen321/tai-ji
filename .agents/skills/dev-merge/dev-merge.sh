#!/usr/bin/env bash
# dev-merge.sh — 将当前 feat worktree 的分支合并到兄弟 dev-x.x.x 集成 worktree。
#
# 用法（cwd 必须在待合并 feat worktree 根目录；用当前 worktree 内的脚本副本动态拼路径，禁止写死其他 worktree 目录——会随其 cleanup 过期）：
#   bash "$(git rev-parse --show-toplevel)/.agents/skills/dev-merge/dev-merge.sh" merge   <dev-branch>   # 预检（目标 worktree 缺失时自动创建）+ 合并
#   bash "$(git rev-parse --show-toplevel)/.agents/skills/dev-merge/dev-merge.sh" cleanup <dev-branch>   # 确认已合并后删当前 worktree + 分支
#
# 退出码：
#   0  成功
#   1  预检失败 / 参数错误（错误信息含恢复动作）
#   2  合并冲突（脚本已停在 merge 中间态，冲突清单见输出；解决后 git add + git commit 完成 merge，再跑 cleanup）
#
# 设计约束（SKILL.md 为编排权威，本脚本只做机械步骤）：
# - 不自动提交未提交改动（提交是 AI 决策行为：message / 粒度 / 认知外改动检查）
# - 不 push（push 必须用户明确授权）
# - cleanup 拒绝删除未合并分支 / 脏 worktree（脏检查在删除前由脚本 status --short 预检，rm -rf 无内建拒删）
# - 删除用显式两步 rm -rf + worktree prune（先删目录后清登记，顺序与 git worktree remove 内部相反，
#   后者先删登记，目录删除失败时留下登记已失、目录内 git 全废的半删态且曾被误诊，2026-09 事故后改此）

set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

SUBCMD="${1:-}"
DEV_BRANCH="${2:-}"

[[ "$SUBCMD" =~ ^(merge|cleanup)$ ]] || die "用法: bash $0 merge|cleanup <dev-branch>，如 bash $0 merge dev-0.9.11"

# ── 当前 worktree 定位 ──
CUR_DIR="$(git rev-parse --show-toplevel 2>/dev/null)" || die "当前目录不在 git 仓库内，请在待合并的 feat worktree 中运行本脚本"
CUR_BRANCH="$(git -C "$CUR_DIR" branch --show-current)"
[[ -n "$CUR_BRANCH" ]] || die "当前 worktree 处于 detached HEAD，无法合并。请先 checkout 到 feature 分支"

WS_ROOT="$(dirname "$CUR_DIR")"
DEV_DIR="$WS_ROOT/$DEV_BRANCH"

list_dev_worktrees() { ls "$WS_ROOT" | grep '^dev-' | tr '\n' ' ' || true; }

[[ -n "$DEV_BRANCH" ]] || die "缺少目标分支参数（如 dev-0.9.11）。可用 dev worktree: $(list_dev_worktrees)"

# merge 时目标 worktree 缺失 → 自动创建（cleanup 不创建：清理语义下目标必须已存在）
# 复用全局 worktree-manipulate 的创建脚本：分支已存在则检出，不存在则基于 main 新建
# （本仓库 dev 集成分支惯例从 main fork），并经 .bare/custom-hooks/setup-worktree.sh
# 完成 pnpm 依赖安装 + Electron/pi 缓存链接——merge commit 的 pre-commit 检查依赖它们
CREATE_WORKTREE_SH="$HOME/.agents/skills/worktree-manipulate/create-worktree/create-worktree.sh"
if [[ ! -d "$DEV_DIR" ]]; then
  if [[ "$SUBCMD" != "merge" ]]; then
    die "目标 worktree $DEV_DIR 不存在，无法 cleanup。可用 dev worktree: $(list_dev_worktrees)"
  fi
  [[ -f "$CREATE_WORKTREE_SH" ]] || die "创建脚本不存在: $CREATE_WORKTREE_SH。恢复动作: 先安装 worktree-manipulate skill，或手动创建 worktree: git -C $CUR_DIR worktree add $DEV_DIR -b $DEV_BRANCH main"
  echo ">> 目标 worktree $DEV_DIR 不存在，自动创建（分支 $DEV_BRANCH 基于 main，含依赖安装，可能需要数分钟）"
  if ! bash "$CREATE_WORKTREE_SH" "$DEV_BRANCH" main; then
    die "自动创建 worktree 失败。恢复动作: bash $CREATE_WORKTREE_SH $DEV_BRANCH main；或改用已存在的 dev worktree: $(list_dev_worktrees)"
  fi
  [[ -d "$DEV_DIR" ]] || die "创建脚本已执行但 $DEV_DIR 仍不存在，中止"
  echo "OK: worktree $DEV_DIR 已自动创建（分支 $DEV_BRANCH 基于 main）"
fi

# ── 公共预检：两边 worktree 都必须干净（tracked 改动）──
check_clean() {
  local dir="$1" label="$2"
  git -C "$dir" diff --quiet && git -C "$dir" diff --cached --quiet \
    || die "$label 有未提交改动（tracked）。先按提交策略处理（自己的改动 commit；认知外改动先询问用户），再重跑本脚本"
}

is_merged() { git -C "$DEV_DIR" merge-base --is-ancestor "$CUR_BRANCH" "$DEV_BRANCH"; }

case "$SUBCMD" in
  merge)
    check_clean "$CUR_DIR" "当前 worktree ($CUR_BRANCH)"
    check_clean "$DEV_DIR" "$DEV_BRANCH"

    if is_merged; then
      echo "SKIP: $CUR_BRANCH 已是 $DEV_BRANCH 的祖先（已合并过），无需重复 merge，可直接跑 cleanup"
      exit 0
    fi

    echo ">> git -C $DEV_DIR merge --no-ff $CUR_BRANCH"
    if git -C "$DEV_DIR" merge --no-ff "$CUR_BRANCH"; then
      echo "OK: $CUR_BRANCH 已合并进 ${DEV_BRANCH}（--no-ff 保留分支历史）"
      echo "NEXT: 确认无误后运行 bash $0 cleanup $DEV_BRANCH 清理源 worktree"
    else
      echo "CONFLICT: 以下文件需要解决（在 $DEV_DIR 内处理）：" >&2
      git -C "$DEV_DIR" diff --name-only --diff-filter=U >&2 || true
      echo "HINT: 解决冲突后 cd $DEV_DIR && git add <files> && git commit 完成 merge，再跑 cleanup 子命令" >&2
      exit 2
    fi
    ;;

  cleanup)
    # 闸 1：cwd 所在 worktree 检出 dev-* 分支即拒绝（覆盖跨 dev 误用：如在 dev-0.9.11 内 cleanup dev-0.9.10）
    [[ "$CUR_BRANCH" != dev-* ]] || die "当前 worktree 检出的是 dev 集成分支（${CUR_BRANCH}），拒绝 cleanup。cleanup 必须在待清理 feat worktree 根目录内运行"
    # 闸 2：拒绝 cleanup 目标自身（覆盖 dev worktree 内检出非 dev-* 分支的残余路径）
    [[ "$DEV_DIR" != "$CUR_DIR" ]] || die "当前已在 ${DEV_BRANCH} worktree 内，拒绝 cleanup 自身。请在待清理 feat worktree 根目录内运行"
    is_merged || die "$CUR_BRANCH 尚未合并进 ${DEV_BRANCH}，拒绝清理。先跑 merge 子命令（或处理完冲突后 git commit 完成 merge）"
    check_clean "$DEV_DIR" "$DEV_BRANCH"

    # 闸 3：源 worktree 脏检查前移（tracked + untracked 一并拦，git 完好时采集、结果可信）。
    # 删除动作是显式 rm -rf，没有 git worktree remove 的内建拒删兜底，此闸是拿掉内建检查的交换条件
    UNTRACKED="$(git -C "$CUR_DIR" status --short)" \
      || die "读取源 worktree 状态失败（见上方 git 报错）。尚未删除任何东西，先排查 git 状态后重跑：bash $0 cleanup $DEV_BRANCH"
    if [[ -n "$UNTRACKED" ]]; then
      # 不自动 clean：删未提交/未跟踪文件是破坏性操作，须用户检视确认（脚本不内置强删，见 SKILL.md 安全语义）
      die "源 worktree 有未提交/未跟踪文件，rm -rf 会无条件删除它们，脚本拒绝继续。git status --short 清单：
$UNTRACKED
先检视上述文件：本次会话产生的按提交策略处理；认知外的询问用户；确认全部可丢弃后执行 git -C $CUR_DIR clean -fd，再重跑：bash $0 cleanup $DEV_BRANCH"
    fi

    # 先 cd 出待删目录（macOS 删除 cwd 所在目录后 shell cwd 悬空，后续命令无法执行）
    cd "$DEV_DIR"
    # 显式两步删除：先删目录、后清登记。git worktree remove 内部顺序相反（先删登记后删目录），
    # 目录删除失败时留下半删态；本顺序下任何一步中途失败，登记与分支都未动，状态永远可从 dev 侧诊断重试
    echo ">> rm -rf $CUR_DIR && git worktree prune（显式两步，登记不先于目录消失）"
    if ! rm -rf "$CUR_DIR"; then
      die "目录删除失败（见上方 rm 报错，rm 的 stderr 原样透传）。git 登记与分支均未动、dev 侧状态完好。
排查根因（文件锁 / 权限 / 外部挂载等）并解除后，一条命令完成清理：
rm -rf $CUR_DIR && git -C $DEV_DIR worktree prune && git -C $DEV_DIR branch -D $CUR_BRANCH
（agent 会话注意：该命令删除会话默认 cwd 所在目录，执行后本会话 bash 报废，应作为最后一条 bash 命令）"
    fi
    # prune 幂等，只清"目录已丢失"的登记，不碰活跃 worktree
    git worktree prune \
      || die "worktree 登记 prune 失败（无破坏性：目录已删、分支未动）。恢复命令：git -C $DEV_DIR worktree prune"
    # is_merged 闸门已证明合入 dev；-D 避免依赖 upstream/HEAD 校验的不确定性，已合并与否由 is_merged 闸门保证
    git branch -D "$CUR_BRANCH" \
      || die "分支 $CUR_BRANCH 删除失败。恢复命令：git -C $DEV_DIR branch -D $CUR_BRANCH"
    echo "OK: worktree $CUR_DIR 与分支 $CUR_BRANCH 已清理"
    echo "NOTE: 原 worktree 目录已删除，会话默认 cwd 已悬空。手动终端：显式 cd 到 ${DEV_DIR} 继续；agent 会话：见 SKILL.md「bash 会话报废信号解码」，停止 bash 调用直接收尾"
    ;;
esac
