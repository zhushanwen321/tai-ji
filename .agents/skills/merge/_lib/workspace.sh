#!/bin/bash
# 共享函数库：workspace 操作相关
# 当前唯一调用方：本 skill 的 scripts/remove-worktree.sh（source 后使用 find_workspace_root / remove_worktree）

# 从当前目录向上查找 workspace 根（包含 .bare/ 的目录）
find_workspace_root() {
    local dir="$1"
    while [[ "$dir" != "/" ]]; do
        if [[ -d "$dir/.bare" ]]; then
            echo "$dir"
            return 0
        fi
        dir="$(cd "$dir/.." && pwd)"
    done
    return 1
}

# 获取当前分支名
get_current_branch() {
    git rev-parse --abbrev-ref HEAD 2>/dev/null
}

# 清理 worktree + 可选删除分支
# Usage: remove_worktree <workspace_root> <branch_name> [delete_branch=false] [force=false]
#   delete_branch: 是否删除本地分支
#   force: 强制删除——跳过 dirty 拦截，删除前打印 git status --short 清单（让将销毁的内容可见）；
#          删除本身恒为显式 rm -rf + worktree prune（先删目录后清登记，避免半删态）；
#          非 force 路径行为不变（脏 worktree 仍拦下）
remove_worktree() {
    local workspace_root="$1"
    local branch_name="$2"
    local delete_branch="${3:-false}"
    local force="${4:-false}"
    local dir_name="${branch_name//\//-}"
    local worktree_path="$workspace_root/$dir_name"

    if [[ ! -d "$worktree_path" ]]; then
        echo "Error: worktree '$dir_name' 不存在。"
        return 1
    fi

    # 检查未提交/未跟踪的更改
    local has_changes=false
    if ! git -C "$worktree_path" diff --quiet 2>/dev/null || \
       ! git -C "$worktree_path" diff --cached --quiet 2>/dev/null; then
        has_changes=true
    fi
    # 检查 untracked 文件
    local untracked
    untracked=$(git -C "$worktree_path" ls-files --others --exclude-standard 2>/dev/null)
    if [[ -n "$untracked" ]]; then
        has_changes=true
    fi
    if $has_changes; then
        if [[ "$force" != "true" ]]; then
            echo "Error: '$dir_name' 有未提交/未跟踪的更改，请先提交或 stash。"
            git -C "$worktree_path" status --short
            return 1
        fi
        echo "Warning: '$dir_name' 有未提交/未跟踪的更改，以下内容将随 worktree 一并销毁（--force）:"
        git -C "$worktree_path" status --short
    fi

    # 删除 worktree：显式两步 rm -rf + worktree prune（先删目录、后清登记）。
    # [HISTORICAL] 旧版用 git worktree remove —— 其内部先删登记、后删目录，目录删除失败
    # （未跟踪产物 / 文件锁）时留下「登记已失、目录仍在、目录内 git 全废」的半删态
    # （2026-09-10 v0.9.16 发布实测 Directory not empty）。本顺序下任一步中途失败，登记与
    # 分支都未动，状态永远可从兄弟 worktree 诊断重试；脏检查闸门在上方（rm -rf 无内建拒删，
    # 该闸门是拿掉 git 内建检查的交换条件）。与 dev-merge skill 同结构（ca6091f7e）。
    echo "删除 worktree '$dir_name'（rm -rf + prune）..."
    if ! rm -rf "$worktree_path"; then
        echo "Error: 目录删除失败：$worktree_path（rm stderr 见上）。git 登记与分支均未动。"
        echo "       排查根因（文件锁 / 权限 / 外部挂载）后重跑本脚本，或执行单命令："
        echo "       rm -rf '$worktree_path' && git -C '$workspace_root/.bare' worktree prune"
        return 1
    fi
    # prune 幂等：只清「目录已丢失」的登记，不碰活跃 worktree
    git -C "$workspace_root/.bare" worktree prune

    # 可选删除分支
    if $delete_branch; then
        if git -C "$workspace_root/.bare" rev-parse --verify "$branch_name" >/dev/null 2>&1; then
            echo "删除本地分支 '$branch_name'..."
            git -C "$workspace_root/.bare" branch -d "$branch_name" 2>/dev/null || \
                git -C "$workspace_root/.bare" branch -D "$branch_name"
        fi
    fi
}

# 检查 worktree 是否干净（无未提交变更）
is_worktree_clean() {
    local workspace_root="$1"
    local branch_name="$2"
    local dir_name="${branch_name//\//-}"
    git -C "$workspace_root/$dir_name" diff --quiet 2>/dev/null && \
    git -C "$workspace_root/$dir_name" diff --cached --quiet 2>/dev/null
}

# 获取所有 worktree 目录（排除 .bare 和 node_modules）
list_worktrees() {
    local workspace_root="$1"
    for wt in "$workspace_root"/*/; do
        local name
        name="$(basename "$wt")"
        [[ "$name" == ".bare" || "$name" == "node_modules" ]] && continue
        echo "$name"
    done
}
