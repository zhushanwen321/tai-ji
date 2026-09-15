import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseSessionContent } from '../core/parser.js'
import type { SessionRef, WorkflowRef } from '../core/family.js'
import { extractSessionIdFromFilename } from './subagents.js'

// ============================================================
// workflow-state 发现链路（w5 从 subagents.ts 物理迁移，架构归位 SSOT §6.3）
// ============================================================
//
// 本文件持有 workflow run 的发现与 sessionFile 提取逻辑（IO 适配层）：
// - resolveWorkflows：读目标 session 的 workflow-state-link custom entry → 每个 link 的
//   wf-state 文件 → 提 calls 的 sessionFile → SessionRef[]。返回 WorkflowRef[]（family.workflows 腿）。
// - readRunSnapshot：读 wf-state 文件尾向找首个可解析行，返回原始对象（unknown，格式收窄交 core 层）。
// - extractCallSessionFiles：从快照对象提 calls 的 sessionFile 绝对路径数组（NEW/OLD 双格式）。
// - sessionRefFromPath：sessionFile 路径 → SessionRef（命中 pathToRef 取完整，否则文件名提取最小 ref）。
//
// 分层约定（w5 TC-wf-core-pure-logic）：IO 全在 discovery/，core/workflow.ts 的
// parseRunSnapshot/renderWorkflowOverview 是纯逻辑零 IO（喂 mock 可单测）。readRunSnapshot 返
// unknown 不收窄——NEW/OLD 双格式的类型化是 core 层 parseRunSnapshot 的职责（TC-wf-snapshot-version-union）。
//
// extractSessionIdFromFilename 留在 subagents.ts（find.ts + 导出契约测试直接消费），此处反向 import。

/**
 * 从 wf-state 快照对象提取 calls[].sessionFile（绝对路径数组）。
 *
 * 两种格式（探查确认，本机 371 个 wf 文件）：
 * - NEW (v="wf-run-v1" 或 "wf-run-v2"，读取面形状一致)：state.calls[]，每项顶层
 *   .sessionFile（258 文件 / 1590 sessionFile）。v2 由 pi-subagent-workflow 8.x 一次性
 *   生命周期收敛引入（status 两态、无 pausedAt），calls[].sessionFile/result 保留
 * - OLD (无 v)：callCache[]=[{key,value}]，value.sessionFile（112 文件 / 0 sessionFile，旧 pi 不持久化）
 */
export function extractCallSessionFiles(snap: unknown): string[] {
  const out: string[] = []
  if (typeof snap !== 'object' || snap === null) return out
  const s = snap as Record<string, unknown>
  const isNew = isNewSnapshotFormat(s)
  const callsRaw = extractCallsRaw(s, isNew)
  if (!Array.isArray(callsRaw)) return out
  for (const c of callsRaw) {
    if (typeof c !== 'object' || c === null) continue
    const item = resolveCallItem(c as Record<string, unknown>, isNew)
    const sf = extractSessionFileFromItem(item)
    if (sf !== undefined) out.push(sf)
  }
  return out
}

/** 快照是否为 NEW 格式（v="wf-run-v1"/"wf-run-v2"，读取面形状一致） */
function isNewSnapshotFormat(s: Record<string, unknown>): boolean {
  return s.v === 'wf-run-v1' || s.v === 'wf-run-v2'
}

/** 按格式取 calls 原始集合：NEW 读 state.calls（state 守卫后取），OLD 读顶层 callCache */
function extractCallsRaw(s: Record<string, unknown>, isNew: boolean): unknown {
  if (isNew) {
    const state = s.state
    return typeof state === 'object' && state !== null
      ? (state as Record<string, unknown>).calls
      : undefined
  }
  return s.callCache
}

/**
 * 单条 call 归一为可取 sessionFile 的对象：
 * NEW: call 本身；OLD: {key, value}，取 value（value 非对象时回退 call 本身，容错脏数据）
 */
function resolveCallItem(co: Record<string, unknown>, isNew: boolean): Record<string, unknown> {
  if (isNew) return co
  const value = co.value
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : co
}

/** 从归一后的 call 对象提 sessionFile：顶层优先，回退 result.sessionFile；均缺 → undefined */
function extractSessionFileFromItem(item: Record<string, unknown>): string | undefined {
  const sf = item.sessionFile
  if (typeof sf === 'string') return sf
  const result = item.result
  const sf2 =
    typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>).sessionFile
      : undefined
  if (typeof sf2 === 'string') return sf2
  return undefined
}

/**
 * 读 wf-state 文件，从尾向头找首个 trim 非空且 JSON.parse 成功的行，返回解析后的原始对象。
 *
 * 拆解自原 readWorkflowCallSessionFiles 的读行职责（w5 TC-wf-core-pure-logic）——后者=读行+
 * 提 sessionFile 的胶水，迁移后由 readRunSnapshot（读行，返 unknown）+ extractCallSessionFiles
 * （提 sessionFile）组合替代。返回类型 unknown：IO 层不假设格式，类型收窄交 core/workflow.ts
 * 的 parseRunSnapshot（C-readrunsnapshot-unknown，TC-wf-snapshot-version-union）。
 *
 * 尾向回退策略（沿用原实现，ES-wf-snapshot-partial）：wf 文件是 rewrite 覆盖模式，读撞 rewrite
 * 中点时末行是半截 JSON（parse 失败）→ 试上一完整行；单行文件半行 → 全失败 → undefined。
 * 文件不存在/读失败/全行不可解析 → undefined（不抛错，调用方 resolveWorkflows 据此 calls=[]）。
 */
export async function readRunSnapshot(wfPath: string): Promise<unknown | undefined> {
  let content: string
  try {
    content = await readFile(wfPath, 'utf8')
  } catch {
    return undefined // wf 文件不存在/读失败 → undefined（不抛错）
  }
  const lines = content.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue
    try {
      return JSON.parse(lines[i])
    } catch {
      continue // 坏行（含 rewrite 中点半截 JSON），试上一行
    }
  }
  return undefined
}

/**
 * 从 sessionFile 绝对路径反查 SessionRef。优先用已扫描的 pathToRef（含真实 id/cwd/stat）；
 * 找不到（文件 GC/路径迁移）返回 fileName-only 最小 SessionRef（不抛错）。
 */
function sessionRefFromPath(path: string, pathToRef: Map<string, SessionRef>): SessionRef {
  const existing = pathToRef.get(path)
  if (existing) return existing
  return {
    sessionId: extractSessionIdFromFilename(basename(path)),
    fileName: path,
    mtime: 0,
    sizeBytes: 0,
    cwd: '',
  }
}

/**
 * 读目标 session 文件全文，解析 workflow-state-link custom entries，构造 WorkflowRef[]。
 * 同一 runId 的多个 link（workflow 多次更新产生）按 runId 去重，取最新 link（path 相同）。
 *
 * 内部用 readRunSnapshot + extractCallSessionFiles 组合替代原 readWorkflowCallSessionFiles
 *（w5 迁移，行为等价）。**签名与返回值结构（WorkflowRef[]{runId,stateFile,calls:SessionRef[]}）
 * 完全不变**（C-resolveworkflows-signature，保 m1 已冻结交付的消费者）。
 */
export async function resolveWorkflows(
  sessionId: string,
  sessionIdToPath: Map<string, string>,
  pathToRef: Map<string, SessionRef>,
): Promise<WorkflowRef[]> {
  const targetPath = sessionIdToPath.get(sessionId)
  if (!targetPath) return [] // 兜底（buildFamilyFromFs 已校验 sessionId 存在）
  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch {
    return []
  }
  const { entries } = parseSessionContent(content)
  const linkByRunId = new Map<string, { runId: string; path: string }>()
  for (const e of entries) {
    if (e.customType !== 'workflow-state-link') continue
    const data = e.data as Record<string, unknown> | undefined
    const runId = data?.runId
    const path = data?.path
    if (typeof runId === 'string' && typeof path === 'string') {
      linkByRunId.set(runId, { runId, path }) // 后写覆盖前写（取最新 link）
    }
  }
  const workflows: WorkflowRef[] = []
  for (const { runId, path } of linkByRunId.values()) {
    const snap = await readRunSnapshot(path)
    const sessionFiles = snap === undefined ? [] : extractCallSessionFiles(snap)
    workflows.push({
      runId,
      stateFile: path,
      calls: sessionFiles.map((sf) => sessionRefFromPath(sf, pathToRef)),
    })
  }
  return workflows
}
