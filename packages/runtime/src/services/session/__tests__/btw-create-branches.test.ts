/**
 * BtwService.createLine 源状态三分支（btw-question D3）—— fixture 文件驱动。
 * 探针对映：P-fork-source（三分支显式）/ 落点不变量（V2②③ env session-dir 强制覆写）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BtwError, BtwService } from '../btw-service.js'
import { getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
import {
  cleanEntries, cleanupDir, danglingEntries, makeFakeClient, makeHarness,
  makeTmpDir, useTmpDataDir, writeSessionFile,
  type BtwHarness,
} from './helpers/btw-harness.js'

const MAIN_SID = 'main-sid-001'
const CWD = '/Users/x/proj'

let restoreDataDir: () => void
let fx: string
let h: BtwHarness
let svc: BtwService

beforeEach(() => {
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
  vi.restoreAllMocks()
})

/** 源 fixture（干净可 fork）。 */
function stubCleanSource(): { src: string; forkFile: string } {
  const src = writeSessionFile(join(fx, 'src'), 'main.jsonl', {
    type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
  }, cleanEntries())
  h.deps.resolveMainSessionFile = vi.fn(() => src)
  const forkFile = writeSessionFile(join(fx, 'fork'), 'fork.jsonl', {
    type: 'session', version: 3, id: 'sid-f1', timestamp: 't', cwd: CWD, parentSession: src,
  }, cleanEntries())
  h.deps.forkSession = vi.fn(async () => forkFile)
  return { src, forkFile }
}

describe('分支①：源已落盘 → 正常 fork（pi 原生 --fork 链路）', () => {
  it('fork → switch_session 附着 → registerSession(hidden) → 注册表登记', async () => {
    const { forkFile } = stubCleanSource()
    h.state = { sessionId: 'sid-f1', sessionFile: forkFile }

    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(res).toEqual({ vid: 'btw:sid-f1', mainSid: MAIN_SID, snapshotKind: 'forked', sessionFilePath: forkFile })
    // spawn 键 = tempKey（日志文件名避冒号）→ rekey 到 vid（pm 键 ≡ 注册 id）
    expect(h.spawned).toHaveLength(1)
    expect(h.rekeyed[0][0]).toMatch(/^btw-create-/)
    expect(h.spawned[0].key).toBe('btw:sid-f1') // rekey 后 pm 键 ≡ 注册 id
    expect(h.rekeyed).toEqual([[expect.stringMatching(/^btw-create-/), 'btw:sid-f1']])
    // 附着编排：switchSession(forkFile)
    expect(h.spawned[0].client.switchSession).toHaveBeenCalledWith(forkFile)
    // hidden:true 注册（6 参 = 不含 parentSession 血缘——关联不进展示链，D4 结构性成立）
    expect(h.registered).toHaveLength(1)
    expect(h.registered[0]).toMatchObject({ id: 'btw:sid-f1', file: forkFile, hidden: true, cwd: CWD, label: 'proj' })
    expect(h.registered[0].argc).toBe(6)
    // 落点不变量（V2②③）：env session-dir 强制覆写为线目录
    expect(h.spawned[0].options.env?.PI_CODING_AGENT_SESSION_DIR).toBe(getBtwThreadDir(CWD, MAIN_SID))
    // 注册表
    const rec = svc.getLine('btw:sid-f1')!
    expect(rec).toMatchObject({ mainSid: MAIN_SID, piSessionId: 'sid-f1', hidden: true, snapshotKind: 'forked', contractRounds: 1 })
    expect(svc.listLines(MAIN_SID).map(l => l.vid)).toEqual(['btw:sid-f1'])
  })

  it('label 覆写透传 registerSession', async () => {
    const { forkFile } = stubCleanSource()
    h.state = { sessionId: 'sid-f1', sessionFile: forkFile }
    await svc.createLine({ mainSid: MAIN_SID, cwd: CWD, label: '提问-自定义' })
    expect(h.registered[0].label).toBe('提问-自定义')
  })
})

describe('分支②：源不存在/为空 → 回落无 fork 新建（落点 = 线目录 + 无快照标记）', () => {
  it('源 unresolved（resolveMainSessionFile 返回 undefined）→ 不调 fork、不 switch、kind=no-source', async () => {
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.state = { sessionId: 'sid-b2', sessionFile: join(fx, 'threadB', 'x.jsonl') }

    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(res.snapshotKind).toBe('no-source')
    expect(h.deps.forkSession).not.toHaveBeenCalled()
    expect(h.spawned[0].client.switchSession).not.toHaveBeenCalled()
    expect(h.registered[0]).toMatchObject({ id: 'btw:sid-b2', hidden: true, file: join(fx, 'threadB', 'x.jsonl') })
    // 回落 spawn 落点继承：env session-dir = 线目录（V2② 实测同款通道）
    expect(h.spawned[0].options.env?.PI_CODING_AGENT_SESSION_DIR).toBe(getBtwThreadDir(CWD, MAIN_SID))
    expect(svc.getLine('btw:sid-b2')?.snapshotKind).toBe('no-source')
    // 不静默：warn 登记不可用原因
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('fork source unavailable'))
  })

  it('源 missing（文件不存在）→ 回落 + forkSession 未被调用', async () => {
    const missing = join(fx, 'gone.jsonl')
    h.deps.resolveMainSessionFile = vi.fn(() => missing)
    h.state = { sessionId: 'sid-b3', sessionFile: join(fx, 't', 'y.jsonl') }

    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(res.snapshotKind).toBe('no-source')
    expect(h.deps.forkSession).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('missing'))
  })

  it('header-only 源（零 entry）→ 宿主前置判空回落，不产空上下文线', async () => {
    const headerOnly = writeSessionFile(join(fx, 'src'), 'hdr.jsonl', {
      type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
    }, [])
    h.deps.resolveMainSessionFile = vi.fn(() => headerOnly)
    h.state = { sessionId: 'sid-b4', sessionFile: join(fx, 't', 'z.jsonl') }

    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(res.snapshotKind).toBe('no-source')
    expect(h.deps.forkSession).not.toHaveBeenCalled()
  })

  it('源 ok 但 fork bootstrap 失败 → catch 回落 no-source（warn 不静默，D3 编排）', async () => {
    const src = writeSessionFile(join(fx, 'src'), 'main.jsonl', {
      type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
    }, cleanEntries())
    h.deps.resolveMainSessionFile = vi.fn(() => src)
    h.deps.forkSession = vi.fn(async () => { throw new BtwError('fork_failed', 'bootstrap exited (code 1)') })
    h.state = { sessionId: 'sid-b5', sessionFile: join(fx, 't', 'w.jsonl') }

    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(res.snapshotKind).toBe('no-source')
    expect(h.deps.forkSession).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to no-snapshot line'))
  })
})

describe('分支③：源含进行中 turn → 截断快照标记', () => {
  it('源含悬空 tool-call → kind=truncated（fixture 文件驱动）', async () => {
    const src = writeSessionFile(join(fx, 'src'), 'main.jsonl', {
      type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
    }, danglingEntries())
    h.deps.resolveMainSessionFile = vi.fn(() => src)
    const forkFile = writeSessionFile(join(fx, 'fork'), 'fork.jsonl', {
      type: 'session', version: 3, id: 'sid-f3', timestamp: 't', cwd: CWD, parentSession: src,
    }, danglingEntries())
    h.deps.forkSession = vi.fn(async () => forkFile)
    h.state = { sessionId: 'sid-f3', sessionFile: forkFile }

    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
    expect(res.snapshotKind).toBe('truncated')
    // fork 文件本身逐字节保留（截断 = 落盘即止，不改写）
    expect(existsSync(forkFile)).toBe(true)
  })

  it('干净源 + 调用方 mainTurnActive 信号 → kind=truncated（纯文本流式增强通道）', async () => {
    const { forkFile } = stubCleanSource()
    h.state = { sessionId: 'sid-f1', sessionFile: forkFile }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD, mainTurnActive: true })
    expect(res.snapshotKind).toBe('truncated')
  })
})

describe('失败路径（fail-fast + 收尸）', () => {
  it('get_state 缺 sessionId/sessionFile → spawn_state_invalid + 进程收尸', async () => {
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.state = {}
    await expect(svc.createLine({ mainSid: MAIN_SID, cwd: CWD })).rejects.toMatchObject({ code: 'spawn_state_invalid' })
    expect(h.destroyed).toEqual([h.spawned[0].key])
    expect(svc.listLines(MAIN_SID)).toEqual([])
  })

  it('附着会话 id ≠ fork header id → state_mismatch + 收尸（进程绑错 = 实现 bug 拦截）', async () => {
    const { forkFile } = stubCleanSource()
    h.state = { sessionId: 'sid-OTHER', sessionFile: forkFile }
    await expect(svc.createLine({ mainSid: MAIN_SID, cwd: CWD })).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(h.destroyed).toContain(h.spawned[0].key)
    expect(svc.listLines(MAIN_SID)).toEqual([])
  })
})
