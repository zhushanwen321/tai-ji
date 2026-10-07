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

# 列出进程 pid 及其全部后代（按真实父子关系逐层展开，不做名字模式匹配）
_collect_process_tree() {
    local root="$1"
    local all="$root" frontier="$root" next p children pid
    while [[ -n "${frontier// /}" ]]; do
        next=""
        for pid in $frontier; do
            children=$(pgrep -P "$pid" 2>/dev/null || true)
            if [[ -n "$children" ]]; then
                next="${next:+$next }$children"
                all="${all:+$all }$children"
            fi
        done
        frontier="$next"
    done
    echo "$all"
}

# 删除前驻留进程预检：扫描持有 worktree 树内文件句柄的全部进程，按句柄类型分两档。
# 检测手段 = lsof +D 权威枚举（树内打开文件的进程一份不漏），不做命令行模式匹配——
# macOS pgrep -f 对含路径的模式有实测不可靠形态（argv 中段子串能中、含路径模式不中），
# 不能作为删除拦截的依据。
#   阻塞档（cwd 以外任何句柄：读写文件 / 执行树内二进制 / mmap）：会在 rm 扫描间隙
#     继续回写该树（vite 回写 .vite/deps 致 rm: Directory not empty 的实测形态），
#     必须先终止。终止时按进程树整树 TERM→KILL（concurrently 类父进程死后
#     vite/Electron 孤儿不会自行退出，只杀根会留残留）。
#   提示档（仅 cwd 挂靠：编辑器 / AI 会话 bash）：不阻塞删除，但删除后其命令将失效。
# 返回值：0 = 可删（无阻塞进程，或 force=true 且阻塞进程已全部终止）；
#         1 = 存在未终止的阻塞进程，调用方应拒绝删除。
check_resident_processes() {
    local wt_path="$1"
    local force="${2:-false}"

    [[ -z "$wt_path" ]] && return 1
    echo "  扫描持有该目录树内文件句柄的进程（含 node_modules 时约需数秒）..."
    local blocked="" cwd_only="" pid="" fd="" line=""
    while IFS= read -r line; do
        case "$line" in
            p*) pid="${line#p}" ;;
            f*)
                fd="${line#f}"
                case "$fd" in
                    cwd)
                        case " $cwd_only " in *" $pid "*) ;; *) cwd_only="$cwd_only $pid" ;; esac
                        ;;
                    *)
                        case " $blocked " in *" $pid "*) ;; *) blocked="$blocked $pid" ;; esac
                        ;;
                esac
                ;;
        esac
    done < <(lsof -F pf +D "$wt_path" 2>/dev/null)

    local p
    for p in $blocked; do
        echo "  阻塞删除: PID $p — $(ps -p "$p" -o command= 2>/dev/null | cut -c1-100)"
    done
    for p in $cwd_only; do
        case " $blocked " in *" $p "*) continue ;; esac
        echo "  仅 cwd 挂靠（不阻塞）: PID $p — $(ps -p "$p" -o command= 2>/dev/null | cut -c1-100)"
    done
    if [[ -n "$cwd_only" ]]; then
        echo "  注意: 有进程以该目录为工作目录（AI 会话 / 编辑器），删除后其命令将失效，请先收尾。"
    fi

    if [[ -z "$blocked" ]]; then
        return 0
    fi

    if [[ "$force" != "true" ]]; then
        echo "  处理: 终止上述进程后重跑；或确认清单无误后加 --force（自动终止阻塞进程整树）。"
        return 1
    fi

    echo "  --force: 自动终止阻塞进程（整树 TERM → KILL）..."
    local tree victim alive="" stat
    for p in $blocked; do
        tree=$(_collect_process_tree "$p")
        for victim in $tree; do
            kill "$victim" 2>/dev/null || true
        done
    done
    sleep 1
    for p in $blocked; do
        tree=$(_collect_process_tree "$p")
        for victim in $tree; do
            if kill -0 "$victim" 2>/dev/null; then
                stat=$(ps -p "$victim" -o stat= 2>/dev/null | awk '{print $1}')
                [[ "$stat" == Z* ]] && continue  # 僵尸 = 已死待 reap，不算存活
                kill -9 "$victim" 2>/dev/null || true
            fi
        done
    done
    sleep 0.5
    for p in $blocked; do
        tree=$(_collect_process_tree "$p")
        for victim in $tree; do
            stat=$(ps -p "$victim" -o stat= 2>/dev/null | awk '{print $1}')
            if [[ -n "$stat" && "$stat" != Z* ]] && kill -0 "$victim" 2>/dev/null; then
                alive="$alive $victim"
            fi
        done
    done
    if [[ -n "$alive" ]]; then
        echo "Error: 以下进程 SIGKILL 后仍存活，请手动处理:${alive}"
        return 1
    fi
    echo "  已终止全部阻塞进程"
    return 0
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
        # rm 报非零但可能已部分成功（目录实际已消失）。此时剩余登记/分支清理与正常路径
        # 完全同构（prune 幂等 + 分支有 delete_branch 闸），降级继续而非报错——否则留下
        # 「目录已消失、登记 prunable」的半删态需要从兄弟 worktree 手工收尾（v0.10.8 实测）。
        if [[ ! -d "$worktree_path" ]]; then
            echo "Warning: rm -rf 报错但目录已实际消失，降级为 git 侧收尾（核对上方 rm stderr）..."
        else
            echo "Error: 目录删除失败：${worktree_path}（rm stderr 见上）。git 登记与分支均未动。"
            echo "       排查根因（文件锁 / 权限 / 外部挂载）后重跑本脚本，或执行单命令："
            echo "       rm -rf '$worktree_path' && git -C '$workspace_root/.bare' worktree prune"
            return 1
        fi
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
