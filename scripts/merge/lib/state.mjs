/**
 * merge 管线的显式状态（发布流程状态机的最小落地）。
 *
 * 发布流程此前没有状态对象：阶段推进靠 SKILL.md 散文、阶段间参数靠 AI 手抄、
 * 每脚本各自发明幂等启发式。此处立单一状态文件，阶段命令读状态 → 干活 → 写状态。
 *
 * 管线身份与字段契约（跨轮残留防护）：每条管线由阶段 0（init）以 { reset: true }
 * 开启——写新 pipelineId 并清空上一轮全部字段（否则上一轮 release 的 tag/releasedAt
 * 会与本轮 pr/stage 叠在同一对象里，读者无法分辨属于哪一轮）；阶段 2（pr-merge）
 * 同样以 { reset: true } 写入（init 被跳过时自兜底）。写前先做两项判定（谓词导出
 * 在本文件）：isPipelineBusy —— 在途管线互斥，与 init 入口的 BUSY 防线同源；
 * isSamePipeline —— prevState 属于本管线（非终态且 pr 同号，即 init 正常跑过）时
 * 才延续其 pipelineId/branch/headSha，上一轮残留（终态或不同 pr 号）一律按新管线。
 *
 * stage 词表与读者门：
 *   'init'（阶段 0 落盘）→ 'merged'（阶段 2 落盘，同时落 mergeSha）→ 'released'（终态，release 落盘）
 * wait-for-ci 的无参路径只消费 stage === 'merged' 的 mergeSha（merge commit 的 push CI
 * 判定对象）——headSha 是 PR head，判的是阶段 2 已裁决过的 PR 侧 runs，禁止作为阶段 3
 * 的判定对象。init 与 pr-merge 两个开线入口均以非终态 + 12h 活跃窗作发布互斥（判定谓词 isPipelineBusy，见下方导出；消费方 init.sh 经 import 复用）。
 *
 * 落位 <workspace 根>/.merge-state/current.json——workspace 级运行态（与 .bare、
 * .agents 同级，在 git 工作树之外），发布管线按 workspace 串行（同一时刻一条线），
 * 单文件即够；无 key 时为 null，消费方自行兜底。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MERGE_STATE_DIRNAME = '.merge-state'

/** stage 终态词表：到达即代表管线完结，不再参与 init 的发布互斥判定。 */
export const TERMINAL_STAGES = ['released']

/** 发布互斥窗口：与 init.sh 的 BUSY 判定同源（12h 内的非终态视为在途）。 */
const BUSY_WINDOW_MS = 12 * 60 * 60 * 1000

/**
 * 管线是否疑似在途（发布互斥判定，init 与 pr-merge 两个开线入口同源共用）：
 * stage 非终态且 updatedAt 落在互斥窗口内。开新管线前必须先问它。
 */
export function isPipelineBusy(state, windowMs = BUSY_WINDOW_MS) {
  return state != null
    && typeof state.stage === 'string' && state.stage !== ''
    && !TERMINAL_STAGES.includes(state.stage)
    && Date.now() - Date.parse(state.updatedAt ?? '0') < windowMs
}

/**
 * prevState 是否属于本管线（pr-merge 自兜底写状态时的身份判定）：非终态且 pr 同号
 * = init 正常跑过的本管线在途状态，pipelineId/branch/headSha 可延续；终态或不同
 * pr 号 = 上一轮管线残留，一律按新管线处理（pipelineId 新生成，不从 prevState 取）。
 */
export function isSamePipeline(state, prNumber) {
  return state != null
    && typeof state.stage === 'string' && state.stage !== ''
    && !TERMINAL_STAGES.includes(state.stage)
    && state.pr === prNumber
}

/**
 * 阶段 2（pr-merge）落盘 patch 的组装。身份字段（pipelineId/branch/headSha）按
 * isSamePipeline 判定：prevState 属于本管线（init 正常跑过）时延续；上一轮残留
 * （终态或不同 pr 号）一律按新管线——pipelineId 新生成，branch/headSha 只用本次
 * PR 数据（缺失兜底空串），绝不回填旧管线的值。
 */
export function buildMergedPatch(prevState, { prNumber, headBranch, headSha, mergeSha }) {
  const same = isSamePipeline(prevState, prNumber)
  return {
    pipelineId: (same ? prevState.pipelineId : undefined) ?? `${Date.now()}-${process.pid}`,
    branch: headBranch || (same ? prevState.branch : '') || '',
    pr: prNumber,
    headSha: headSha || (same ? prevState.headSha : '') || '',
    mergeSha,
    stage: 'merged',
    mergedAt: new Date().toISOString(),
  }
}

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
 *
 * 原子写（C-data-11）：先写同目录临时文件再 rename 原子覆盖主文件——直写主文件在
 * 写入中断（进程被杀/磁盘满）时留半写 JSON，readMergeState 解析失败返回 null 等于
 * 整轮管线状态丢弃（后续阶段需手传参数恢复）。
 */
export function writeMergeState(root, patch, opts = {}) {
  const path = mergeStatePath(root)
  const prev = opts.reset ? {} : readMergeState(root) ?? {}
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() }
  const tmpPath = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(tmpPath, path)
    return next
  } catch {
    return null
  }
}
