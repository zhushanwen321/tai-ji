/**
 * merge 管线的显式状态（发布流程状态机的最小落地）。
 *
 * 发布流程此前没有状态对象：阶段推进靠 SKILL.md 散文、阶段间参数靠 AI 手抄、
 * 每脚本各自发明幂等启发式。此处立单一状态文件，阶段命令读状态 → 干活 → 写状态；
 * 后续波次（init / release 移植）把各自的幂等守卫改为状态转移条件。
 *
 * 落位 <workspace 根>/.merge-state/current.json——workspace 级运行态（与 .bare、
 * .agents 同级，在 git 工作树之外），发布管线按 workspace 串行（同一时刻一条线），
 * 单文件即够；无 key 时为 null，消费方自行兜底。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MERGE_STATE_DIRNAME = '.merge-state'

export function mergeStatePath(root) {
  return join(root, MERGE_STATE_DIRNAME, 'current.json')
}

/** 读取当前管线状态；无文件/损坏返回 null（状态是辅助通道，不阻塞主流程）。 */
export function readMergeState(root) {
  const path = mergeStatePath(root)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 合并写入状态（浅合并，自动盖 updatedAt 时间戳）；写失败返回 null 不抛。 */
export function writeMergeState(root, patch) {
  const path = mergeStatePath(root)
  const prev = readMergeState(root) ?? {}
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
    return next
  } catch {
    return null
  }
}
