/**
 * merge 管线的显式状态（发布流程状态机的最小落地）。
 *
 * 发布流程此前没有状态对象：阶段推进靠 SKILL.md 散文、阶段间参数靠 AI 手抄、
 * 每脚本各自发明幂等启发式。此处立单一状态文件，阶段命令读状态 → 干活 → 写状态。
 *
 * 管线身份与字段契约（跨轮残留防护）：每条管线由阶段 0（init）以 { reset: true }
 * 开启——写新 pipelineId 并清空上一轮全部字段（否则上一轮 release 的 tag/releasedAt
 * 会与本轮 pr/stage 叠在同一对象里，读者无法分辨属于哪一轮）；阶段 2（pr-merge）
 * 同样以 { reset: true } 写入（init 被跳过时自兜底），并保留已有 pipelineId。
 *
 * stage 词表与读者门：
 *   'init'（阶段 0 落盘）→ 'merged'（阶段 2 落盘，同时落 mergeSha）→ 'released'（终态，release 落盘）
 * wait-for-ci 的无参路径只消费 stage === 'merged' 的 mergeSha（merge commit 的 push CI
 * 判定对象）——headSha 是 PR head，判的是阶段 2 已裁决过的 PR 侧 runs，禁止作为阶段 3
 * 的判定对象。init 以非终态 + 近窗口 updatedAt 作发布互斥（详见 init.sh）。
 *
 * 落位 <workspace 根>/.merge-state/current.json——workspace 级运行态（与 .bare、
 * .agents 同级，在 git 工作树之外），发布管线按 workspace 串行（同一时刻一条线），
 * 单文件即够；无 key 时为 null，消费方自行兜底。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MERGE_STATE_DIRNAME = '.merge-state'

/** stage 终态词表：到达即代表管线完结，不再参与 init 的发布互斥判定。 */
export const TERMINAL_STAGES = ['released']

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

/**
 * 合并写入状态；写失败返回 null 不抛。
 * opts.reset = true 时丢弃旧状态整体重写（新管线开启——见文件头的跨轮残留防护）。
 */
export function writeMergeState(root, patch, opts = {}) {
  const path = mergeStatePath(root)
  const prev = opts.reset ? {} : readMergeState(root) ?? {}
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
    return next
  } catch {
    return null
  }
}
