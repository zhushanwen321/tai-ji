/**
 * 线进程生命周期（btw-question D1）：惰性 spawn / 闲置 30min destroy /
 * 有待处理交互豁免计闲置 / 回收前提醒挂点 / reattach 自建附着编排（V5）/ 关线原语。
 * timer 走 fake timers（测试红线：禁真实等待）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BtwError, BtwService } from '../btw-service.js'
import { getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
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
    // 进程引用摘除（原「闲置回收后」形态；回收机制已随 ADR-0112 退役，重附着由
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
  it('closeLine：杀进程 + 注册表移除 + 文件删除限定 btw 根内', async () => {
    // 线文件写在 btw 根内（规范布局 D2：btw/<enc>/<mainSid>/，级联删除面）
    const inside = writeSessionFile(
      getBtwThreadDir(CWD, MAIN_SID), 'inside.jsonl',
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

  it('closeLine 不删 btw 根外文件（防误删面）', async () => {
    const outside = writeSessionFile(join(fx, 'elsewhere'), 'out.jsonl', {
      type: 'session', version: 3, id: 'sid-out', timestamp: 't', cwd: CWD,
    }, [])
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.state = { sessionId: 'sid-out', sessionFile: outside }
    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(await svc.closeLine(res.vid, { deleteSessionFile: true })).toBe(true)
    expect(existsSync(outside)).toBe(true) // 根外文件保留（守卫拦截 rm）
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
