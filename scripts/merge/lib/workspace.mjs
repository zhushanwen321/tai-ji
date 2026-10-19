/**
 * workspace 定位（bare repo + 多 worktree 布局的唯一实现）。
 *
 * 曾在 6 处脚本各内联一份「向上查找含 .bare 的目录」循环，布局漂移时逐份修
 * （固定层数推导失效事故的修法当时也是逐份打的）。收敛为一份。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 从 startDir 逐级向上找含 .bare/ 的目录；到根仍无则返回 null。 */
export function findWorkspaceRoot(startDir = process.cwd()) {
  let cur = startDir
  for (;;) {
    if (existsSync(join(cur, '.bare'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/** main worktree 路径（sync/发布阶段的目标 worktree）。 */
export function mainWorktreePath(root) {
  return join(root, 'main')
}
