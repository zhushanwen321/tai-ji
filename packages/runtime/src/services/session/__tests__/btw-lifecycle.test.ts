/**
 * 线进程生命周期（btw-question D1）：惰性 spawn / 闲置 30min destroy /
 * 有待处理交互豁免计闲置 / 回收前提醒挂点 / reattach 自建附着编排（V5）/ 关线原语。
 * timer 走 fake timers（测试红线：禁真实等待）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BtwError, BtwService, BTW_IDLE_RECLAIM_MS, BTW_IDLE_TICK_MS } from '../btw-service.js'
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

describe('闲置回收（D1：30min destroy 进程、文件保留）', () => {
  it('提前 1 拍提醒窗（阈值−1 拍）置 reclaimImminent + 提醒挂点；满阈值 destroy、提醒清，注册表与文件保留', async () => {
    const { vid, file } = await createNoForkLine()

    // D1「回收前」提醒窗 = 阈值 − 扫描节拍：29min 拍进入窗口（badge 置「待处理」，
    // 数据源 = reclaimImminent；提醒挂点每回收周期恰一次）
    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS - BTW_IDLE_TICK_MS)
    expect(h.reclaimed).toEqual([vid]) // 提醒在回收前触发（修复前 = 回收同拍才触发）
    expect(svc.getLine(vid)!.reclaimImminent).toBe(true)
    expect(h.destroyed).toEqual([]) // 本拍只提醒不回收

    await vi.advanceTimersByTimeAsync(BTW_IDLE_TICK_MS * 2)
    expect(h.reclaimed).toEqual([vid]) // 不重复提醒
    expect(h.destroyed).toContain(vid)

    const rec = svc.getLine(vid)!
    expect(rec.client).toBeUndefined() // 进程已亡
    expect(rec.reclaimImminent).toBe(false) // D1：回收发生 → 提醒清（清除支）
    expect(rec.sessionFilePath).toBe(file) // 文件保留（裁决⑧）
    expect(existsSync(file)).toBe(true)
  })

  it('有待处理交互豁免计闲置；终态解除后恢复计龄（从最后活跃起算）', async () => {
    const { vid } = await createNoForkLine()
    svc.setPendingInteraction(vid, true)

    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS * 4) // 2h 全程豁免
    expect(h.reclaimed).toEqual([])
    expect(h.destroyed).toEqual([])

    svc.setPendingInteraction(vid, false) // 终态解除 + 视为一次活跃
    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS - BTW_IDLE_TICK_MS)
    expect(h.destroyed).toEqual([]) // 解除后仍从解除时刻重新计龄（29min 拍只进提醒窗）
    expect(h.reclaimed).toEqual([vid])

    await vi.advanceTimersByTimeAsync(BTW_IDLE_TICK_MS * 2)
    expect(h.reclaimed).toEqual([vid])
    expect(h.destroyed).toContain(vid)
  })

  it('markActivity 刷新空闲钟（消息活跃不被误回收）', async () => {
    const { vid } = await createNoForkLine()
    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS - BTW_IDLE_TICK_MS * 2)
    svc.markActivity(vid)
    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS - BTW_IDLE_TICK_MS * 2)
    expect(h.reclaimed).toEqual([])
  })

  it('进程自发死亡条目：清 client 引用但不触发回收提醒（失效 ≠ 回收）', async () => {
    const { vid } = await createNoForkLine()
    h.spawned[0].client.exited = true
    await vi.advanceTimersByTimeAsync(BTW_IDLE_TICK_MS * 2)
    expect(h.reclaimed).toEqual([])
    expect(h.destroyed).toEqual([])
    expect(svc.getLine(vid)!.client).toBeUndefined()
  })

  it('idleThresholdMs 可注入（V3 调档口）', async () => {
    svc.dispose()
    svc = new BtwService({ ...h.deps, idleThresholdMs: 60_000 })
    const { vid } = await createNoForkLine()
    await vi.advanceTimersByTimeAsync(60_000 + BTW_IDLE_TICK_MS * 2)
    expect(h.reclaimed).toEqual([vid])
  })

  it('[BU1] rebuildFromDisk → ensureProcess 拉起的线同样武装定时器：满 30min + tick → 提醒 + destroy（修复前该链从不 arm、永不回收）', async () => {
    const file = writeSessionFile(getBtwThreadDir(CWD, MAIN_SID), 'sid-a1.jsonl', {
      type: 'session', version: 3, id: 'sid-a1', timestamp: 't', cwd: CWD,
    }, [])
    const rebuilt = svc.rebuildFromDisk() // 启动链：只登记不 spawn、不 arm
    expect(rebuilt).toHaveLength(1)
    const rec = rebuilt[0]
    h.state = { sessionId: rec.piSessionId, sessionFile: file }

    await svc.ensureProcess(rec.vid) // 续问/重开附着口（本修复点：成功路径 armTimer）

    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS + BTW_IDLE_TICK_MS)
    expect(h.reclaimed).toContain(rec.vid)
    expect(h.destroyed).toContain(rec.vid) // timer 已武装 → 回收真正发生
    expect(svc.getLine(rec.vid)!.client).toBeUndefined()
    expect(existsSync(file)).toBe(true) // 文件保留（裁决⑧）
  })

  it('[BU2] D1 闲置豁免派生通道：置位期间 idleTick 不 destroy；交互中转见空（respond/expired/失效）→ 派生解除后恢复回收', async () => {
    const { vid } = await createNoForkLine()
    let pending = true
    h.deps.hasPendingUiRequests = vi.fn(() => pending)
    svc.setPendingInteraction(vid, true) // 生产置位通道 = index.ts onExtensionUIRequest 推送（组合根接线）

    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS * 2) // 2h 全程豁免（含已过阈值）
    expect(h.destroyed).toEqual([])
    expect(svc.getLine(vid)!.pendingInteraction).toBe(true)

    pending = false // 终态（respond 移除 / expired·失效 invalidate）→ 中转 pending 表清空
    await vi.advanceTimersByTimeAsync(BTW_IDLE_TICK_MS) // 下一拍派生解除 + re-age，本拍不回收
    expect(svc.getLine(vid)!.pendingInteraction).toBe(false)
    expect(h.destroyed).toEqual([])

    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS + BTW_IDLE_TICK_MS)
    expect(h.destroyed).toContain(vid) // 解除后恢复计龄并回收
  })

  it('[BU2] 进程亡结构解除：exited 分支清 pendingInteraction 与回收提醒（失效腿，tick 兜底）', async () => {
    const { vid } = await createNoForkLine()
    svc.setPendingInteraction(vid, true)
    h.spawned[0].client.exited = true

    await vi.advanceTimersByTimeAsync(BTW_IDLE_TICK_MS * 2)

    expect(svc.getLine(vid)!.pendingInteraction).toBe(false)
    expect(svc.getLine(vid)!.client).toBeUndefined()
    expect(h.reclaimed).toEqual([]) // 失效 ≠ 回收（不触发提醒）
    expect(h.destroyed).toEqual([])
  })

  it('[BU3] 提醒窗广播驱动：置位经 onWillReclaim、清除经 onThreadStateChanged（回收发生）', async () => {
    const onThreadStateChanged = vi.fn()
    svc.dispose()
    svc = new BtwService({ ...h.deps, onThreadStateChanged })
    const { vid } = await createNoForkLine()

    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS - BTW_IDLE_TICK_MS) // 29min 提醒窗
    expect(h.reclaimed).toEqual([vid])
    expect(svc.getLine(vid)!.reclaimImminent).toBe(true)
    expect(onThreadStateChanged).not.toHaveBeenCalled() // 置位侧只走 onWillReclaim

    await vi.advanceTimersByTimeAsync(BTW_IDLE_TICK_MS) // 满阈值回收
    expect(h.destroyed).toContain(vid)
    expect(svc.getLine(vid)!.reclaimImminent).toBe(false)
    expect(onThreadStateChanged).toHaveBeenCalledWith(vid) // 清除支广播驱动（协议数据源翻转）
  })

  it('[BU3] 用户续问（markActivity）清回收提醒并驱动清除广播（D1 提醒清除支）', async () => {
    const onThreadStateChanged = vi.fn()
    svc.dispose()
    svc = new BtwService({ ...h.deps, onThreadStateChanged })
    const { vid } = await createNoForkLine()

    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS - BTW_IDLE_TICK_MS)
    expect(svc.getLine(vid)!.reclaimImminent).toBe(true)

    svc.markActivity(vid)
    expect(svc.getLine(vid)!.reclaimImminent).toBe(false)
    expect(onThreadStateChanged).toHaveBeenCalledWith(vid)

    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS - BTW_IDLE_TICK_MS) // 重新计龄未到阈值
    expect(h.destroyed).toEqual([])
  })
})

describe('reattach spawn 形态（自建附着编排；restore 离线腿不通用——V5）', () => {
  it('进程存活 → 短路复用（不重复 spawn）', async () => {
    const { vid } = await createNoForkLine()
    const c1 = await svc.ensureProcess(vid)
    const c2 = await svc.ensureProcess(vid)
    expect(c1).toBe(c2)
    expect(h.spawned).toHaveLength(1)
  })

  it('回收后续问：spawn → switch_session(线文件) → 一致性守卫 → rekey → hidden 注册', async () => {
    const { vid, file } = await createNoForkLine('sid-r1')
    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS + BTW_IDLE_TICK_MS * 2)
    expect(h.destroyed).toContain(vid) // 已回收

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
    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS + BTW_IDLE_TICK_MS * 2)

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
    await vi.advanceTimersByTimeAsync(BTW_IDLE_RECLAIM_MS + BTW_IDLE_TICK_MS * 2)
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
