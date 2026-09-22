/**
 * M4-a / P-persist：启动孤儿补账（主会话已不存在的线目录清理）+ 重建次序 + checkpoint 豁免
 * （registerSession 订阅者豁免——不为 btw 建档，重启不误 reattach）。
 *
 * 覆盖边界（防重复写已有断言）：
 * - 注册表重建基础面（vid/header cwd/mainSid/hidden 复原/幂等/坏文件跳过）已由
 *   btw-registry.test.ts 覆盖——本文件只补「孤儿补账先于重建」的次序与交互断言。
 * - 回放等价半边由 M2-c 落地：renderer `src/__tests__/stores/btw-replay.test.ts` +
 *   core `chat-lru-btw.test.ts`（live≡reload / 同驱派生键），本文件不重复。
 * - 线进程/目录级联在 btw-cascade.test.ts（P-cascade）。
 *
 * 防线：TAIJI_AGENT_DATA_DIR 钉 tmp（fs-guard 白名单）；checkpoint store 显式 init 到
 * 独立 tmp 目录（singleton ??=——beforeAll 一次，用例用唯一 sid 防串扰）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/btw-persist-reload.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initRuntimeCheckpointStore, getRuntimeCheckpointStore } from '../runtime-checkpoint.js'
import { BtwService } from '../btw-service.js'
import { getBtwSessionsRoot, getBtwThreadDir } from '../../../infra/pi/pi-paths.js'
import {
  cleanupDir,
  makeHarness,
  makeTmpDir,
  useTmpDataDir,
  writeSessionFile,
  type BtwHarness,
} from './helpers/btw-harness.js'
import { createSetup } from './helpers/session-service-setup.js'
import type { IPiEngine } from '../../ports/pi-engine.js'

const CWD = '/Users/x/proj'

let checkpointDir: string
let restoreDataDir: () => void
let fx: string
let h: BtwHarness
let svc: BtwService

beforeAll(() => {
  checkpointDir = mkdtempSync(join(tmpdir(), 'btw-persist-checkpoint-'))
  initRuntimeCheckpointStore({ dir: checkpointDir })
})
afterAll(() => {
  rmSync(checkpointDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
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

/** 在真实 btw 根下铺一条线目录 + 线文件（mainSid 存在性由 resolveMainSessionFile 判定）。 */
function seedThreadDir(mainSid: string, linePiSid: string): string {
  const threadDir = getBtwThreadDir(CWD, mainSid)
  writeSessionFile(threadDir, `${linePiSid}.jsonl`, {
    type: 'session', version: 3, id: linePiSid, timestamp: 't', cwd: CWD,
  }, [])
  return threadDir
}

describe('启动孤儿补账（D5：主会话已不存在的线目录清理；退出/回收不删）', () => {
  it('主缺失 → 目录删除 + warn 留痕；主在场 → 目录与线保留；非 pi 目录名跳过（不代删 junk）', () => {
    h.deps.resolveMainSessionFile = vi.fn((sid: string) => (sid === 'main-present-1' ? '/sessions/main-present-1.jsonl' : undefined))
    const keptDir = seedThreadDir('main-present-1', 'linepi-keep')
    const orphanDir = seedThreadDir('main-missing-1', 'linepi-orphan')
    const junkDir = join(getBtwSessionsRoot(), 'enc-not-used', 'trailing-') // pi 正则拒（尾字符 '-'）
    writeSessionFile(junkDir, 'x.jsonl', { type: 'session', id: 'whatever', cwd: CWD }, [])

    const removed = svc.reconcileOrphanThreadDirs()

    expect(removed).toBe(1)
    expect(existsSync(orphanDir)).toBe(false) // 崩溃恢复对齐「主删即删」
    expect(existsSync(keptDir)).toBe(true) // 主在场的线绝不 GC（裁决⑧：退出不删的前提 = 启动不误删）
    expect(existsSync(junkDir)).toBe(true) // junk 归 rebuild warn 面，不代删
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('orphan reconcile: removed thread dir'))

    // 幂等：二次补账零动作
    expect(svc.reconcileOrphanThreadDirs()).toBe(0)
  })

  it('[BU5] 扫描降级（本轮 sessions 扫描不可信）→ 补账整轮跳过、零删除，改下次启动重试', () => {
    // 降级表现：readdir EACCES/IO → 扫描腿显式返回空列表 → 冷主会话解析全部落空
    h.deps.resolveMainSessionFile = vi.fn(() => undefined)
    h.deps.isSessionScanDegraded = vi.fn(() => true)
    const orphanA = seedThreadDir('main-missing-d3', 'linepi-d3')
    const orphanB = seedThreadDir('main-missing-d4', 'linepi-d4')

    const removed = svc.reconcileOrphanThreadDirs()

    expect(removed).toBe(0)
    expect(existsSync(orphanA)).toBe(true) // 降级角落零删除（rm -rf 不可逆面，裁决⑧不被摧毁）
    expect(existsSync(orphanB)).toBe(true)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('session scan degraded this round'))
    // 判据仍先解析、闸在解析落空后（主在场且扫描降级时不受影响——闸不早于 resolve）
    expect(h.deps.resolveMainSessionFile).toHaveBeenCalled()
  })

  it('补账先于重建：reconcile → rebuild 后注册表只含在场主线的线（孤儿不入册）', () => {
    h.deps.resolveMainSessionFile = vi.fn((sid: string) => (sid === 'main-present-2' ? '/s/main-present-2.jsonl' : undefined))
    seedThreadDir('main-present-2', 'linepi-kept-2')
    seedThreadDir('main-missing-2', 'linepi-dropped-2')

    svc.reconcileOrphanThreadDirs() // 组合根同款调用序（index.ts）
    const rebuilt = svc.rebuildFromDisk()

    expect(rebuilt.map(r => r.mainSid)).toEqual(['main-present-2'])
    expect(svc.listLines('main-missing-2')).toEqual([])
    expect(svc.listLines('main-present-2')).toHaveLength(1)
  })
})

describe('checkpoint 豁免（P-persist 重启半边：不为 btw 建档 → 重启不误 reattach）', () => {
  it('registerSession(vid) 后 checkpoint 无该条目；普通 session 照常入档（订阅者其余保留）', async () => {
    const { service } = createSetup()
    const vid = `btw:linepi-ckpt-${Date.now()}`
    const mainSid = `main-ckpt-${Date.now()}`

    await service.initializeManagedSession(vid, {} as IPiEngine, CWD, 'line', undefined, true)
    await service.initializeManagedSession(mainSid, {} as IPiEngine, CWD, 'main')

    const ids = getRuntimeCheckpointStore().read()?.sessions.map(s => s.piSessionId) ?? []
    expect(ids).not.toContain(vid) // 豁免生效：reattach 编排结构上看不见 btw 线
    expect(ids).toContain(mainSid) // 对照：主会话建档不受影响（D3 语义保持）

    // 卸载清理（避免条目跨用例累积噪音）
    getRuntimeCheckpointStore().removeSession(mainSid)
  })
})
