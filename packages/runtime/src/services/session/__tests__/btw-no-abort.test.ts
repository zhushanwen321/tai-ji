/**
 * P-no-abort 的结构侧（M1-b）：btw 建线路径与主会话进程零耦合——
 *  - 依赖范围构造性无主进程句柄（deps 里不存在任何「主 client」通道，createLine 照常完成
 *    ⇒ 主 turn 不可能被本路径打断）；
 *  - 主会话文件字节级不变（宿主只读交源给 pi fork 链路，零直写）；
 *  - 进程键从不使用主会话 id（不碰主进程的 ProcessManager 条目）。
 * 真机断言（主 turn 进行中发 btw prompt、turn_end 正常到达）归 S7 真实进程层（M4-b e2e）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BtwService } from '../btw-service.js'
import {
  cleanEntries, cleanupDir, makeHarness, makeTmpDir, useTmpDataDir, writeSessionFile,
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

describe('P-no-abort 结构侧：建线路径与主会话零耦合', () => {
  it('deps 无主进程通道时 createLine 照常完成 + 主会话文件字节级不变', async () => {
    // 主会话 fixture（模拟主 turn 落盘中：含分支 + 悬空 tool-call）
    const mainFile = writeSessionFile(join(fx, 'main'), 'main.jsonl', {
      type: 'session', version: 3, id: MAIN_SID, timestamp: 't', cwd: CWD,
    }, cleanEntries())
    const before = readFileSync(mainFile)
    h.deps.resolveMainSessionFile = vi.fn(() => mainFile)
    const forkFile = writeSessionFile(join(fx, 'fork'), 'fork.jsonl', {
      type: 'session', version: 3, id: 'sid-n1', timestamp: 't', cwd: CWD, parentSession: mainFile,
    }, cleanEntries())
    h.deps.forkSession = vi.fn(async () => forkFile)
    h.state = { sessionId: 'sid-n1', sessionFile: forkFile }

    // deps 全集只含进程/注册/解析/追踪面——不存在任何「向主进程发命令」的通道（构造性证明）
    expect(Object.keys(h.deps).sort()).toEqual([
      'buildLineSpawnOptions', 'forkSession', 'processes',
      'registerSession', 'resolveMainSessionFile', 'resolvePiCommand', 'traceContractInjection',
      'trashDirectory', // D5 线树软删通道（C-comm-03 deps 注入形态；仍非主进程命令通道）
      // W5：onWillReclaim 挂点随闲置回收机制残留删除（ADR-0122 清查收尾）已不在 deps 面
    ])

    const res = await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    // 主会话文件字节级不变（宿主零直写；pi fork 只读源）
    expect(readFileSync(mainFile)).toEqual(before)
    // fork 交接是只读 handoff：源路径原样传递
    expect(h.deps.forkSession).toHaveBeenCalledWith({ sourceFile: mainFile, threadDir: expect.any(String), cwd: CWD })
    // 进程键从不使用主会话 id（不 touch 主进程的 ProcessManager 条目）
    for (const key of [...h.spawned.map(s => s.key), ...h.rekeyed.map(([, to]) => to)]) {
      expect(key).not.toBe(MAIN_SID)
    }
    expect(res.sessionId).toBe('sid-n1')
  })

  it('建线只产生 btw 自己的进程条目（spawn 键 = btw 临时键，rekey 到线 pi 真实 id）', async () => {
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.state = { sessionId: 'sid-n2', sessionFile: join(fx, 't', 'x.jsonl') }

    await svc.createLine({ mainSid: MAIN_SID, cwd: CWD })

    expect(h.spawned).toHaveLength(1)
    expect(h.rekeyed[0][0]).toMatch(/^btw-create-/)
    expect(h.rekeyed[0][1]).toBe('sid-n2') // rekey 目标 = 线 pi 真实 id（W4a：pm 键 ≡ 注册 id）
    // 主进程 destroy 面零触达：destroyed 只可能含 btw 自己的键（临时键或线 pi 真实 id）
    expect(h.destroyed.every(k => k.startsWith('btw-create-') || k === 'sid-n2')).toBe(true)
  })
})
