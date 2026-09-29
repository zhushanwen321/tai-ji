/**
 * death-disposition 立标判据回归防线（审查 unreasonable#3 修复的同批补测）：
 * SessionLifecycle.delete 的 fire 点携带 detail.hasDestroySink =「session 是否在册」——
 * 组合根 suppressedDeaths 抑制标只在 true 时立（在册 ⇒ 随后必有 removeSessionEntry
 * 销毁回调消费标；scanned / 未找到 throw 不在册 ⇒ 立标必成 stale id 无界滞留）。
 * 用例钉住 fire 时点与判据取值，防未来 delete 控制流改动（分支挪动 / fire 提前或后移）
 * 让判据与真实消费点再度脱钩。
 *
 * Mock 策略同 session-lifecycle-trash-error-chain.test.ts：唯一 mock = infra trash（防真
 * 移文件）；SessionLifecycle / PiSessionStore 真实实例，仅 spy 目录列举与刷新面。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-death-disposition.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/infra/system/trash.js', () => ({ trash: vi.fn() }))
import { trash } from '../src/infra/system/trash.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'
import { SessionLifecycle, setBtwCascadeOps, subscribeSessionDeathDisposition } from '../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps } from '../src/services/session/session-internal.js'
import type { ScannedSession } from '../src/services/session/types.js'
import type { IEventAdapter } from '../src/interfaces.js'
import type { IProcessManager, IPiEngine } from '../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { SessionSummary } from '@taiji/shared'

const trashMock = vi.mocked(trash)

/** 捕获到的一次死亡处置 fire（detail.hasDestroySink 是本文件的断言本体） */
interface DispositionFire {
  sessionId: string
  disposition: 'delete' | 'suppress'
  hasDestroySink: boolean
}

let fires: DispositionFire[] = []
let unsubscribe: () => void = () => {}
let tmpDir: string
let tmpFile: string

function makeLifecycle() {
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const pm = { destroySession: vi.fn().mockResolvedValue(undefined) } as unknown as IProcessManager
  const configStore = { getDefaultModel: vi.fn(() => undefined) } as unknown as IConfigStore
  const store = new PiSessionStore()
  vi.spyOn(store, 'scanSessions').mockReturnValue([])
  vi.spyOn(store, 'invalidateScanCache').mockImplementation(() => {})
  vi.spyOn(store, 'refreshAll').mockImplementation(() => {})
  const svc = {
    getActiveSummaries: vi.fn((): SessionSummary[] => []),
    removeSessionEntry: vi.fn(),
    findScannedSession: vi.fn(),
  } as unknown as ILifecycleSessionOps
  const lifecycle = new SessionLifecycle(svc, pm, configStore, store, workspace, {
    adapterFactory: () => ({ attach: vi.fn(), detach: vi.fn() }) as unknown as IEventAdapter,
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  })
  return { lifecycle, svc, store, pm }
}

function scannedEntry(filePath: string): ScannedSession {
  return { id: 's-scanned', cwd: '/p', filePath } as unknown as ScannedSession
}

describe('delete 立标判据 hasDestroySink（unreasonable#3 回归防线）', () => {
  beforeEach(() => {
    trashMock.mockReset().mockResolvedValue(undefined)
    fires = []
    // 组合根同款订阅面（本文件是唯一 fire 源消费者；afterEach 退订防跨用例串音）
    unsubscribe = subscribeSessionDeathDisposition((sessionId, disposition, detail) => {
      fires.push({ sessionId, disposition, hasDestroySink: detail.hasDestroySink })
    })
    tmpDir = mkdtempSync(join(tmpdir(), 'death-disposition-'))
    tmpFile = join(tmpDir, 'session.jsonl')
    writeFileSync(tmpFile, '{}\n', 'utf-8')
  })

  afterEach(() => {
    unsubscribe()
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('active（在册 ⇒ 销毁回调消费点存在）→ hasDestroySink true，且 removeSessionEntry 确被调用', async () => {
    const { lifecycle, svc } = makeLifecycle()
    await lifecycle.registerSession('s-active', {} as unknown as IPiEngine, '/p', 'label', tmpFile)

    await lifecycle.delete('s-active')

    expect(fires).toEqual([{ sessionId: 's-active', disposition: 'delete', hasDestroySink: true }])
    // 消费点存在性与判据同向：在册分支确实走到 removeSessionEntry（销毁回调扇出宿主）
    expect(svc.removeSessionEntry).toHaveBeenCalledWith('s-active')
  })

  it('scanned（非在册 ⇒ 无销毁回调）→ hasDestroySink false，且不走 removeSessionEntry', async () => {
    const { lifecycle, svc } = makeLifecycle()
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(scannedEntry(tmpFile))

    await lifecycle.delete('s-scanned')

    expect(fires).toEqual([{ sessionId: 's-scanned', disposition: 'delete', hasDestroySink: false }])
    expect(svc.removeSessionEntry).not.toHaveBeenCalled()
  })

  it('not-found throw：fire 在 throw 之前已发且判据为 false（发声 latch 不因失败路径丢失、标不立）', async () => {
    const { lifecycle, svc } = makeLifecycle()
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

    await expect(lifecycle.delete('s-missing')).rejects.toThrow('Session s-missing not found')

    // 关键断言：即便方法以 throw 收场，fire 已在入口发出（检查点①）且未立标（无滞留源）
    expect(fires).toEqual([{ sessionId: 's-missing', disposition: 'delete', hasDestroySink: false }])
    expect(svc.removeSessionEntry).not.toHaveBeenCalled()
  })

  it('btw 活线（在册 vid + ops 注入 → closeLine 终结扇出的销毁回调存在）→ hasDestroySink true，走 closeLine 不落主会话清理面', async () => {
    const { lifecycle, svc } = makeLifecycle()
    // 组合根同款注入面（setBtwCascadeOps，官方「测试注入 fake / 置 null 复位」语义）：
    // 本用例钉审查 finding 1 的回退形态——判据若改回 `session !== undefined && !isBtwLine`
    //（btw 活线在册被错判无 sink），既有 3 用例全绿测不出，唯本象限红。真实装配下
    // hasDestroySink true 的消费点 = closeLine → fireLineTerminated → onLineTerminated →
    // removeSessionEntry（组合根镜像主会话 delete 收尾序），fake ops 只钉 delete 分支形态。
    const closeLine = vi.fn().mockResolvedValue(true)
    const closeAllForMain = vi.fn().mockResolvedValue(undefined)
    setBtwCascadeOps({ closeLine, closeAllForMain })
    try {
      // vid 两段式（btw:<piSessionId>，第二段禁冒号）——registerSession 接受 vid 在册
      await lifecycle.registerSession('btw:s-line', {} as unknown as IPiEngine, '/p', 'label', tmpFile)

      await lifecycle.delete('btw:s-line')

      expect(fires).toEqual([{ sessionId: 'btw:s-line', disposition: 'delete', hasDestroySink: true }])
      // btw 直删分支形态：单入口 closeLine（删线文件），不落主会话 trash/sidecar 清理面，
      // 也不经 lifecycle 直调 removeSessionEntry（那是 onLineTerminated 扇出的事）
      expect(closeLine).toHaveBeenCalledWith('btw:s-line', { deleteSessionFile: true })
      expect(closeAllForMain).not.toHaveBeenCalled()
      expect(trashMock).not.toHaveBeenCalled()
      expect(svc.removeSessionEntry).not.toHaveBeenCalled()
    } finally {
      setBtwCascadeOps(null)
    }
  })
})
