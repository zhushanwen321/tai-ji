/**
 * death-disposition 立标判据回归防线（审查 unreasonable#3 修复的同批补测）：
 * SessionLifecycle.delete 的 fire 点携带 detail.hasDestroySink =「session 是否在册」——
 * 组合根 suppressedDeaths 抑制标只在 true 时立（在册 ⇒ 随后必有 removeSessionEntry
 * 销毁回调消费标；scanned / 未找到 throw 不在册 ⇒ 立标必成 stale id 无界滞留）。
 * 用例钉住 fire 时点与判据取值，防未来 delete 控制流改动（分支挪动 / fire 提前或后移）
 * 让判据与真实消费点再度脱钩。
 *
 * 另含 'archive' 处置登记探针（archive-watch-settlement-gap 条目 28）：GUI 侧栏归档
 * 路径（session.archive RPC → ArchiveService.archive）经真实登记器触发 disposition=
 * 'archive'——组合根订阅侧同判消费（speakSessionDeath('exit') 收尾 completion-watch），
 * 收尾回到单一汇聚点。
 *
 * Mock 策略同 session-lifecycle-trash-error-chain.test.ts：唯一 mock = infra trash（防真
 * 移文件）；SessionLifecycle / PiSessionStore 真实实例，仅 spy 目录列举与刷新面。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-lifecycle-death-disposition.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// import 即生效：本 import 须保持为第一个本地 import——helper 求值时注册 infra trash
// mock，其后的本地 import 才不会捕获未 mock 的真实 trash（ESM 按序求值）
import { makeSessionLifecycleFixture, scannedEntry, trashMock } from './helpers/session-lifecycle-fixture.js'
import { fireDeathDisposition, setBtwCascadeOps, subscribeSessionDeathDisposition } from '../src/services/session/session-lifecycle.js'
import { ArchiveService, type ArchiveServiceDeps } from '../src/services/archive/archive-service.js'
import { encodeCwd } from '@taiji/shared/paths'
import type { IPiEngine } from '../src/services/ports/pi-engine.js'

/** 捕获到的一次死亡处置 fire（detail.hasDestroySink 是本文件的断言本体） */
interface DispositionFire {
  sessionId: string
  disposition: 'delete' | 'suppress' | 'archive'
  hasDestroySink: boolean
}

let fires: DispositionFire[] = []
let unsubscribe: () => void = () => {}
let tmpDir: string
let tmpFile: string

describe('delete 立标判据 hasDestroySink（unreasonable#3 回归防线）', () => {
  beforeEach(() => {
    trashMock.mockReset().mockResolvedValue(undefined)
    fires = []
    // 组合根同款订阅侧（本文件是唯一 fire 源消费者；afterEach 退订防跨用例串音）
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
    const { lifecycle, svc } = makeSessionLifecycleFixture()
    await lifecycle.registerSession('s-active', {} as unknown as IPiEngine, '/p', 'label', tmpFile)

    await lifecycle.delete('s-active')

    expect(fires).toEqual([{ sessionId: 's-active', disposition: 'delete', hasDestroySink: true }])
    // 消费点存在性与判据同向：在册分支确实走到 removeSessionEntry（销毁回调扇出宿主）
    expect(svc.removeSessionEntry).toHaveBeenCalledWith('s-active')
  })

  it('scanned（非在册 ⇒ 无销毁回调）→ hasDestroySink false，且不走 removeSessionEntry', async () => {
    const { lifecycle, svc } = makeSessionLifecycleFixture()
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(scannedEntry('s-scanned', tmpFile))

    await lifecycle.delete('s-scanned')

    expect(fires).toEqual([{ sessionId: 's-scanned', disposition: 'delete', hasDestroySink: false }])
    expect(svc.removeSessionEntry).not.toHaveBeenCalled()
  })

  it('not-found throw：fire 在 throw 之前已发且判据为 false（发声 latch 不因失败路径丢失、标不立）', async () => {
    const { lifecycle, svc } = makeSessionLifecycleFixture()
    ;(svc.findScannedSession as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

    await expect(lifecycle.delete('s-missing')).rejects.toThrow('Session s-missing not found')

    // 关键断言：即便方法以 throw 收场，fire 已在入口发出（检查点①）且未立标（无滞留源）
    expect(fires).toEqual([{ sessionId: 's-missing', disposition: 'delete', hasDestroySink: false }])
    expect(svc.removeSessionEntry).not.toHaveBeenCalled()
  })

  it('btw 活线（在册线 session id + ops 注入 → closeLine 终结扇出的销毁回调存在）→ hasDestroySink true，走 closeLine 不落主会话清理侧', async () => {
    const { lifecycle, svc } = makeSessionLifecycleFixture()
    // 组合根同款注入点（setBtwCascadeOps，官方「测试注入 fake / 置 null 复位」语义）：
    // 本用例钉审查 finding 1 的回退形态——判据若改回 `session !== undefined && !isBtwLine`
    //（btw 活线在册被错判无 sink），既有 3 用例全绿测不出，唯本象限红。真实装配下
    // hasDestroySink true 的消费点 = closeLine → fireLineTerminated → onLineTerminated →
    // removeSessionEntry（组合根镜像主会话 delete 收尾序），fake ops 只钉 delete 分支形态。
    const closeLine = vi.fn().mockResolvedValue(true)
    const closeAllForMain = vi.fn().mockResolvedValue(undefined)
    // W4a：判别器 = registry 成员查询（getLine 注入；键 = 线 session id = piId）
    const getLine = vi.fn((id: string) => (id === 's-line' ? { mainSid: 's-main' } : undefined))
    setBtwCascadeOps({ closeLine, closeAllForMain, getLine })
    try {
      await lifecycle.registerSession('s-line', {} as unknown as IPiEngine, '/p', 'label', tmpFile)

      await lifecycle.delete('s-line')

      expect(fires).toEqual([{ sessionId: 's-line', disposition: 'delete', hasDestroySink: true }])
      // btw 直删分支形态：单入口 closeLine（删线文件），不落主会话 trash/sidecar 清理侧，
      // 也不经 lifecycle 直调 removeSessionEntry（那是 onLineTerminated 扇出的事）
      expect(closeLine).toHaveBeenCalledWith('s-line', { deleteSessionFile: true })
      expect(closeAllForMain).not.toHaveBeenCalled()
      expect(trashMock).not.toHaveBeenCalled()
      expect(svc.removeSessionEntry).not.toHaveBeenCalled()
    } finally {
      setBtwCascadeOps(null)
    }
  })
})

describe("'archive' 处置登记（条目 28：GUI 归档路径的收尾触发点）", () => {
  let archiveFires: DispositionFire[] = []
  let unsubscribeArchive: () => void = () => {}
  let archiveRoot: string

  beforeEach(() => {
    trashMock.mockReset().mockResolvedValue(undefined)
    archiveFires = []
    // 组合根同款订阅侧（index.ts subscribeSessionDeathDisposition 消费 'archive' →
    // speakSessionDeath('exit')；本文件只记录，收尾三步的闭环在 session-manager-handler
    // 与 archive-service 两侧测试锚定）。
    unsubscribeArchive = subscribeSessionDeathDisposition((sessionId, disposition, detail) => {
      archiveFires.push({ sessionId, disposition, hasDestroySink: detail.hasDestroySink })
    })
    archiveRoot = mkdtempSync(join(tmpdir(), 'archive-disposition-'))
  })

  afterEach(() => {
    unsubscribeArchive()
    rmSync(archiveRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('GUI 归档路径（session.archive → ArchiveService.archive）触发 disposition=archive、hasDestroySink=true，且先于杀进程（检查点①）', async () => {
    // GUI 侧栏归档按钮的唯一 runtime 半边 = handleSessionArchive 薄调
    // archiveService.archive()——收尾触发点全在归档执行体内，本用例直驱真实
    // ArchiveService（deps 面 fake，处置登记经真实登记器 fireDeathDisposition）。
    const calls: string[] = []
    const sid = 'sess-gui-arch'
    const sessionsRoot = join(archiveRoot, 'agent', 'sessions')
    const cwd = join(archiveRoot, 'proj') // 真实存在（realpath 可解析）
    const bucket = join(sessionsRoot, encodeCwd(cwd))
    mkdirSync(bucket, { recursive: true })
    const mainPath = join(bucket, `2026-10-23T00-00-00-000Z_${sid}.jsonl`)
    writeFileSync(mainPath, `${JSON.stringify({ type: 'session', id: sid, cwd, timestamp: '2026-10-23T00:00:00.000Z' })}\n`)
    const deps: ArchiveServiceDeps = {
      isGenerating: () => false,
      getActiveSession: (s) => (s === sid ? { cwd, sessionFilePath: mainPath } : undefined),
      findScannedSession: () => undefined,
      disposeUserStopped: () => {},
      // 生产接线同款（index.ts：fireArchiveDisposition → fireDeathDisposition('archive')）
      fireArchiveDisposition: (s, hasDestroySink) => { calls.push(`archive-disp:${s}`); fireDeathDisposition(s, 'archive', { hasDestroySink }) },
      closeAllBtwLines: async () => [],
      detachSession: (s) => { calls.push(`detach:${s}`) },
      destroyPiSession: async (s) => { calls.push(`destroy:${s}`) },
      removeSessionEntry: () => {},
      reapBackgroundTasks: async () => {},
      clearRemovedSessionData: () => {},
      unbindCanvas: () => {},
      trash: async () => {},
      trashDirectory: async () => {},
      invalidateScanCache: () => {},
      broadcastSessionList: () => {},
      getSessionSummary: () => undefined,
      warn: () => {},
    }
    const service = new ArchiveService(deps, { dataDir: archiveRoot, archiveRoot: join(archiveRoot, 'agent', 'archive'), agentDir: join(archiveRoot, 'agent'), sessionsRoot })

    await service.archive(sid)

    // GUI 路径触发处置收尾：组合根订阅侧收到 'archive'（hasDestroySink=true——活跃在册，
    // 随后必有 removeSessionEntry 销毁回调消费抑制标）。
    expect(archiveFires).toEqual([{ sessionId: sid, disposition: 'archive', hasDestroySink: true }])
    // 检查点①：处置登记先于任何杀进程（detach/destroy）。
    expect(calls.indexOf(`archive-disp:${sid}`)).toBeLessThan(calls.indexOf(`detach:${sid}`))
    expect(calls.indexOf(`archive-disp:${sid}`)).toBeLessThan(calls.indexOf(`destroy:${sid}`))
  })
})
