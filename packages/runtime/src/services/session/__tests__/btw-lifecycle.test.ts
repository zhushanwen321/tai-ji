/**
 * 线进程生命周期（btw-question D1）：惰性 spawn / 闲置 30min destroy /
 * 有待处理交互豁免计闲置 / 回收前提醒挂点 / reattach 自建附着编排（V5）/ 关线原语。
 * timer 走 fake timers（测试红线：禁真实等待）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { BtwError, BtwService } from '../btw-service.js'
import { getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
import { getSessionBtwDir, getSessionStoreDir } from '@taiji/shared/paths'
import { trashDirectory as realTrashDirectory } from '../../../infra/system/trash.js'
import {
  cleanupDir, makeHarness, makeTmpDir, useTmpDataDir, writeSessionFile,
  type BtwHarness,
} from './helpers/btw-harness.js'

// closeLine 线树软删走 trashDirectory：platform 钉 linux（任何宿主机都走非 mac 降级
// rmSync 分支，断言落盘效果）；child_process 整模块 mock 兜底锁定零子进程（不触真实
// 废纸篓）。tmpdir 保持真实（fs-guard 白名单 = os.tmpdir()）。trashDirectory 包装成
// 可控 spy：默认经闭包转调真实现，失败语义用例 mockRejectedValueOnce 注入。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn() }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'linux' }
})
// trashDirectory 改 deps 注入（C-comm-03：services 不得 value import infra——BtwServiceDeps
// 字段）。spy 默认闭包转调真实现；失败用例用 mockRejectedValueOnce（一次性，消费后自动
// 回到此默认形态），无需手动恢复。
const trashDirectoryMock = vi.fn((dirPath: string) => realTrashDirectory(dirPath))

const execFileSyncMock = vi.mocked(execFileSync)

const MAIN_SID = 'main-sid-001'
const CWD = '/Users/x/proj'

let restoreDataDir: () => void
let fx: string
let h: BtwHarness
let svc: BtwService

/** 分支② 形态建线（无 fork；state 给定 sid + 真实存在的线文件路径）。 */
async function createNoForkLine(fileSid = 'sid-b2'): Promise<{ vid: string; file: string }> {
  h.deps.resolveMainSessionFile = vi.fn(() => undefined)
  const file = writeSessionFile(join(fx, 'thread'), `${fileSid}.jsonl`, {
    type: 'session', version: 3, id: fileSid, timestamp: 't', cwd: CWD,
  }, [])
  h.state = { sessionId: fileSid, sessionFile: file }
  const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
  return { vid: res.vid, file: res.sessionFilePath }
}

beforeEach(() => {
  // 显式 toFake 含 Date：闲置钟 = Date.now，须随 advanceTimersByTime 前进
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  restoreDataDir = useTmpDataDir()
  fx = makeTmpDir()
  h = makeHarness()
  h.deps.trashDirectory = trashDirectoryMock
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

describe('reattach spawn 形态（自建附着编排；restore 离线腿不通用——V5）', () => {
  it('进程存活 → 短路复用（不重复 spawn）', async () => {
    const { vid } = await createNoForkLine()
    const c1 = await svc.ensureProcess(vid)
    const c2 = await svc.ensureProcess(vid)
    expect(c1).toBe(c2)
    expect(h.spawned).toHaveLength(1)
  })

  it('重附着后续问：spawn → switch_session(线文件) → 一致性守卫 → rekey → hidden 注册', async () => {
    const { vid, file } = await createNoForkLine('sid-r1')
    // 进程引用摘除（原「闲置回收后」形态；回收机制已随 ADR-0122 退役，重附着由
    // 进程死亡/重启场景触发）——直接置 rec.client = undefined 造重附着入口。
    svc.getLine(vid)!.client = undefined

    const client = await svc.ensureProcess(vid)

    expect(client).toBeDefined()
    expect(h.spawned).toHaveLength(2)
    expect(h.spawned[1].key).toBe(vid) // rekey 后 pm 键 ≡ 注册 id（harness rekey 会同步改 key）
    expect(h.spawned[1].client.switchSession).toHaveBeenCalledWith(file)
    expect(h.rekeyed[1]).toEqual([expect.stringMatching(/^btw-attach-/), vid]) // tempKey → vid
    expect(h.registered).toHaveLength(2)
    expect(h.registered[1]).toMatchObject({ id: vid, hidden: true, file })
    expect(svc.getLine(vid)!.contractRounds).toBe(2) // 每轮会话建立重注入契约
    expect(h.traces.map(t => t.round)).toEqual([1, 2])
  })

  it('线文件不存在（首 flush 前即回收）→ thread_file_missing（不代造文件，策略归调用方）', async () => {
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.state = { sessionId: 'sid-gone', sessionFile: join(fx, 'never-flushed.jsonl') } // 文件不落盘
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
    svc.getLine(res.vid)!.client = undefined

    await expect(svc.ensureProcess(res.vid)).rejects.toMatchObject({ code: 'thread_file_missing' })
  })

  it('[D1] 重附着 = 旧轮挂起请求失效终态：pendingInteraction 结构解除（tick 未走到也不残留豁免）', async () => {
    const { vid } = await createNoForkLine('sid-r9')
    svc.setPendingInteraction(vid, true)
    h.spawned[0].client.exited = true // 进程亡（挂起请求随之失效），tick 尚未走到

    await svc.ensureProcess(vid) // 用户续问 → 重附着

    expect(svc.getLine(vid)!.pendingInteraction).toBe(false)
  })

  it('未知线 → line_not_found', async () => {
    await expect(svc.ensureProcess('btw:nosuch')).rejects.toMatchObject({ code: 'line_not_found' })
  })

  it('附着落错会话 → state_mismatch 收尸', async () => {
    const { vid, file } = await createNoForkLine('sid-ok')
    svc.getLine(vid)!.client = undefined
    h.state = { sessionId: 'sid-WRONG', sessionFile: file } // reattach 读回与注册表不符

    await expect(svc.ensureProcess(vid)).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(h.destroyed).toContain(h.spawned[1].key) // tempKey 收尸
  })
})

describe('关线原语（btw.remove；级联归 M4-a）', () => {
  it('closeLine：杀进程 + 注册表移除 + 文件删除限定本线目录内', async () => {
    // 线文件写在本线目录内（session-store-layout-inversion 布局：<root>/<mainSid>/btw/）
    const inside = writeSessionFile(
      getBtwThreadDir(MAIN_SID), 'inside.jsonl',
      { type: 'session', version: 3, id: 'sid-inside', timestamp: 't', cwd: CWD }, [],
    )
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.state = { sessionId: 'sid-inside', sessionFile: inside }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(await svc.closeLine(res.vid, { deleteSessionFile: true })).toBe(true)
    expect(h.destroyed).toContain(res.vid)
    expect(svc.getLine(res.vid)).toBeUndefined()
    expect(existsSync(inside)).toBe(false)
    expect(await svc.closeLine(res.vid)).toBe(false) // 幂等
  })

  it('closeLine 不删本线目录外文件（防误删面）', async () => {
    const outside = writeSessionFile(join(fx, 'elsewhere'), 'out.jsonl', {
      type: 'session', version: 3, id: 'sid-out', timestamp: 't', cwd: CWD,
    }, [])
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.state = { sessionId: 'sid-out', sessionFile: outside }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(await svc.closeLine(res.vid, { deleteSessionFile: true })).toBe(true)
    expect(existsSync(outside)).toBe(true) // 线目录外文件保留（守卫拦截 rm）
  })
})

describe('closeLine 线树软删（D5 对称挂树：<root>/<线sid>/ 整树 trashDirectory）', () => {
  /** 建线并在真实线树位置预置派生数据形态（线派生 subagent 记录等）。 */
  async function createLineWithTree(fileSid: string): Promise<{ vid: string; lineTree: string }> {
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    const inside = writeSessionFile(
      getBtwThreadDir(MAIN_SID), `${fileSid}.jsonl`,
      { type: 'session', version: 3, id: fileSid, timestamp: 't', cwd: CWD }, [],
    )
    h.state = { sessionId: fileSid, sessionFile: inside }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
    const lineTree = join(getSessionStoreDir(), fileSid)
    mkdirSync(join(lineTree, 'subagents'), { recursive: true })
    writeFileSync(join(lineTree, 'subagents', 'rec.json'), '{}')
    return { vid: res.vid, lineTree }
  }

  it('删线软删线树整树（含派生数据；非 mac 降级递归删真跑 + 零子进程不触废纸篓）', async () => {
    const { vid, lineTree } = await createLineWithTree('sid-tree-1')
    expect(existsSync(lineTree)).toBe(true) // 前提自证：线树与派生数据在盘

    expect(await svc.closeLine(vid, { deleteSessionFile: true })).toBe(true)

    expect(existsSync(lineTree)).toBe(false) // 整树消失（<root>/<线sid>/ 递归删净）
    expect(execFileSyncMock).not.toHaveBeenCalled() // 降级通道零子进程
  })

  it('线树不存在（线从未派生数据——常态）→ 存在性守卫零动作，关线不炸', async () => {
    trashDirectoryMock.mockClear() // mock 调用记录跨用例累积，清零后断言本用例零调用
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    const inside = writeSessionFile(
      getBtwThreadDir(MAIN_SID), 'sid-no-tree.jsonl',
      { type: 'session', version: 3, id: 'sid-no-tree', timestamp: 't', cwd: CWD }, [],
    )
    h.state = { sessionId: 'sid-no-tree', sessionFile: inside }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })
    const lineTree = join(getSessionStoreDir(), 'sid-no-tree')
    expect(existsSync(lineTree)).toBe(false) // 前提自证：树从未创建

    expect(await svc.closeLine(res.vid, { deleteSessionFile: true })).toBe(true)
    expect(trashDirectoryMock).not.toHaveBeenCalled() // 零动作（不空跑 trash 通道）
  })

  it('线树软删失败 → 结构化错误上抛不静默（补账兜底已退役，残留必须出声）', async () => {
    const { vid, lineTree } = await createLineWithTree('sid-tree-fail')
    trashDirectoryMock.mockRejectedValueOnce(new Error('移入废纸篓失败（Finder 未在 5s 内响应）'))

    await expect(svc.closeLine(vid, { deleteSessionFile: true })).rejects.toThrow(/移入废纸篓失败/)
    expect(existsSync(lineTree)).toBe(true) // 失败保留原地（可撤销语义：不静默变不可逆）
  })
})

describe('BtwError code 面（M2-b 恢复指引映射）', () => {
  it('code 字段可判别', () => {
    const e = new BtwError('line_not_found', 'x')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('line_not_found')
    expect(e.name).toBe('BtwError')
  })
})
