/**
 * WorkflowRunEventsReader 路径白名单双域放行测试（[session-store-layout-inversion]
 * 读侧跟随：新布局 run journal 落 session 存储树，白名单只认 piAgentDir 单域时新树
 * 路径恒拒 → renderer workflow 详情 RPC 对新会话必 record_not_found——本文件锚定修复）。
 *
 * 双域 = pi 宿主树（getPiAgentDir）+ session 存储树（getSessionStoreDir），各自数据的
 * 物理域；白名单是安全边界非数据读取，双域放行不是 D6 双根读。
 *
 * 覆盖：新树路径放行 / piAgentDir 路径放行 / 树外路径拒绝（事件流归并 record_not_found
 * + DAG 闭集 path_rejected）/ 穿越形态（resolve 后逃出双域的 ../）拒绝。
 *
 * getPiAgentDir / getSessionStoreDir 经 vi.mock 指向 mkdtemp tmp（写删目标自建自删红线）。
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/workflow-run-events-reader.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunEventsReader } from '../workflow-run-events-reader.js'

const allowDirs = vi.hoisted(() => ({ piAgentDir: '', storeDir: '' }))

vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => allowDirs.piAgentDir }
})

vi.mock('@taiji/shared/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/shared/paths')>()
  return { ...actual, getSessionStoreDir: () => allowDirs.storeDir }
})

let root: string
let storeDir: string
const SID = '0aaaaaaa-bbbb-7ccc-dddd-000000000001'

/** 写一个最小 run journal（单 run-created 行）。 */
function writeJournal(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({ type: 'run-created', seq: 1, ts: 1000, runId: 'run-1', workflowName: 'flow', argsSummary: '{}' })}\n`,
    'utf8',
  )
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wf-events-reader-'))
  allowDirs.piAgentDir = join(root, 'agent')
  allowDirs.storeDir = join(root, 'ext-sessions')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('WorkflowRunEventsReader 路径白名单双域', () => {
  it('新树路径（存储树 workflow/runs/）放行：events 正常读出', () => {
    const recordPath = join(allowDirs.storeDir, SID, 'workflow', 'runs', 'run-1.record.jsonl')
    writeJournal(recordPath)
    const reader = new WorkflowRunEventsReader()
    const reply = reader.readRunEvents(SID, 'run-1', recordPath)
    if (!('events' in reply)) throw new Error(`expected events arm, got ${JSON.stringify(reply)}`)
    expect(reply.events).toHaveLength(1)
    expect(reply.events[0]?.type).toBe('run-created')
  })

  it('piAgentDir 路径放行：pi 宿主树域保持放行（存量旧布局 run journal 域）', () => {
    const recordPath = join(allowDirs.piAgentDir, 'sessions', '--demo--', 'workflow-state', 'run-1.record.jsonl')
    writeJournal(recordPath)
    const reader = new WorkflowRunEventsReader()
    const reply = reader.readRunEvents(SID, 'run-1', recordPath)
    if (!('events' in reply)) throw new Error(`expected events arm, got ${JSON.stringify(reply)}`)
    expect(reply.events).toHaveLength(1)
  })

  it('树外路径拒绝：事件流归并 record_not_found（白名单文案留痕），DAG 闭集 path_rejected', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wf-events-reader-outside-'))
    try {
      const recordPath = join(outside, 'run-1.record.jsonl')
      writeJournal(recordPath)
      const reader = new WorkflowRunEventsReader()
      const reply = reader.readRunEvents(SID, 'run-1', recordPath)
      if ('events' in reply) throw new Error(`expected error arm, got ${JSON.stringify(reply)}`)
      expect(reply.code).toBe('record_not_found')
      expect(reply.message).toContain('rejected by allowlist')
      const dag = reader.readDag(SID, 'run-dag-reject', recordPath)
      if ('dag' in dag) throw new Error(`expected error arm, got ${JSON.stringify(dag)}`)
      expect(dag.code).toBe('path_rejected')
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })

  it('穿越形态（../ resolve 后逃出双域）拒绝', () => {
    // 四级 .. 恰好逃出存储树分区（join 消解后 = <root>/escape.record.jsonl，树外）
    const recordPath = join(
      allowDirs.storeDir, SID, 'workflow', 'runs', '..', '..', '..', '..', 'escape.record.jsonl',
    )
    const reader = new WorkflowRunEventsReader()
    // resolve 后逃出双域 → 白名单拒绝（语义等价 record_not_found + 留痕文案）
    const reply = reader.readRunEvents(SID, 'run-1', recordPath)
    if ('events' in reply) throw new Error(`expected error arm, got ${JSON.stringify(reply)}`)
    expect(reply.code).toBe('record_not_found')
    expect(reply.message).toContain('rejected by allowlist')
    const dag = reader.readDag(SID, 'run-dag-traversal', recordPath)
    if ('dag' in dag) throw new Error(`expected error arm, got ${JSON.stringify(dag)}`)
    expect(dag.code).toBe('path_rejected')
  })
})
