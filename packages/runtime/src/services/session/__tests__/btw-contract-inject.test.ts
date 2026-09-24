/**
 * 行为契约注入挂点（btw-question D9⑤ / 探针 P-contract-inject）。
 * 断言窗口 = 线会话建立后首个 prompt 请求的载体（当前载体 = spawn
 * `--append-system-prompt` 组合，prompt 期注入；子通道归属随 V6 核实钉固）。
 * oracle M1 落点：traceContractInjection 记录（trace 可断言处）+ spawn options
 * 载体断言；UI 反向断言（btw 流无契约渲染）随 M2-b 消息通路落地。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { BtwService, BTW_BEHAVIOR_CONTRACT } from '../btw-service.js'
import {
  cleanupDir, makeHarness, makeTmpDir, useTmpDataDir, writeSessionFile,
  type BtwHarness,
} from './helpers/btw-harness.js'

const MAIN_SID = 'main-sid-001'
const CWD = '/Users/x/proj'

let restoreDataDir: () => void
let fx: string
let h: BtwHarness
let svc: BtwService

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  restoreDataDir = useTmpDataDir()
  fx = makeTmpDir()
  h = makeHarness()
  svc = new BtwService(h.deps)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  svc.dispose()
  cleanupDir(fx)
  restoreDataDir()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function createLine(): Promise<{ vid: string; file: string }> {
  h.deps.resolveMainSessionFile = vi.fn(() => undefined)
  const file = writeSessionFile(join(fx, 'thread'), 'sid-c1.jsonl', {
    type: 'session', version: 3, id: 'sid-c1', timestamp: 't', cwd: CWD,
  }, [])
  h.state = { sessionId: 'sid-c1', sessionFile: file }
  const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
  return { vid: res.vid, file: res.sessionFilePath }
}

describe('P-contract-inject：线会话建立时注入一次', () => {
  it('载体组合：appendSystemPrompt = 模式 append 段 ⊕ 契约（不覆盖、恰一次）', async () => {
    h.baseOptions = { appendSystemPrompt: 'MODE-APPEND-SEGMENT' }
    await createLine()

    const append = h.spawned[0].options.appendSystemPrompt!
    expect(append).toContain('MODE-APPEND-SEGMENT')
    expect(append).toContain(BTW_BEHAVIOR_CONTRACT)
    expect(append.split(BTW_BEHAVIOR_CONTRACT)).toHaveLength(2) // 恰一次
  })

  it('无模式 append 段 → 纯契约', async () => {
    await createLine()
    expect(h.spawned[0].options.appendSystemPrompt).toBe(BTW_BEHAVIOR_CONTRACT)
  })

  it('trace 断言：create 轮 round=1 恰一条（carrier + 契约文本可断言）', async () => {
    const { vid } = await createLine()
    expect(h.traces).toEqual([
      { vid, round: 1, carrier: 'append-system-prompt', contract: BTW_BEHAVIOR_CONTRACT },
    ])
  })

  it('重附着轮再注入一次（每会话建立一次，含重附着轮——D9⑤）', async () => {
    const { vid } = await createLine()
    await vi.advanceTimersByTimeAsync(31 * 60_000 + 120_000) // 闲置回收
    expect(h.destroyed).toContain(vid)

    await svc.ensureProcess(vid)

    expect(h.traces.map(t => [t.vid, t.round])).toEqual([[vid, 1], [vid, 2]])
    // 新一轮 spawn options 同样携带契约（进程重建 ⇒ prompt 期载体随之重建）
    expect(h.spawned[1].options.appendSystemPrompt).toBe(BTW_BEHAVIOR_CONTRACT)
  })

  it('契约不进注册表字段 / 不经 registerSession 参数（model-only，UI 面不可见的结构面）', async () => {
    const { vid } = await createLine()
    const rec = svc.getLine(vid)!
    // 摘除 client（fake 自引用循环）后序列化——断言注册表数据字段不含契约文本
    expect(JSON.stringify({ ...rec, client: undefined })).not.toContain(BTW_BEHAVIOR_CONTRACT)
    // registerSession 只收 6 参（id/client/cwd/label/file/hidden）——契约无传输通道
    expect(h.registered[0].argc).toBe(6)
    expect(JSON.stringify(h.registered[0])).not.toContain(BTW_BEHAVIOR_CONTRACT)
  })

  it('契约文本与设计 D9⑤ 一句话版逐字一致（防漂移锚）', () => {
    expect(BTW_BEHAVIOR_CONTRACT).toBe(
      '父任务快照仅供背景；只回答本线新问题、不自动续主任务；仅本线明确要求时才改工作区',
    )
  })
})
