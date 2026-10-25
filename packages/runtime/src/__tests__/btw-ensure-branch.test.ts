/**
 * ensureActive 的 btw 分支（btw-question B3 裁决，M2-b）——回收后续问的附着入口。
 *
 * 锁定语义：
 * - btw 线 session id + 已注入 BtwService → 转 ensureProcess（自建附着编排：alive → markActivity
 *   直返 / 回收死亡 → spawn→switch→附着断言 reattach，D1⑥/V5），分支先于既有
 *   pm.getClient / restore 链（restore 路径 findScannedSession 只扫 sessions/，对 btw 线
 *   构造性失败——V5 核实结论）；
 * - 非 btw sid + 已注入 → 分支不命中，既有链零变更；
 * - btw 线 session id + 未注入 BtwService（存量测试构造）→ fall through 零变更；
 * - 附着失败 BtwError 原样上抛（code 保留）——message.send 路径由
 *   dispatcher.ensureActiveOrBroadcast 统一处理 message.error（错误文案带恢复指引）。
 *
 * 构造模式：session-service-ensure-active.test.ts 的 makeEnv 轻量桩（mock pm/broker/
 * adapterFactory，未被测路径的依赖给最小桩）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/btw-ensure-branch.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionService } from '../services/session/session-service.js'
import { BtwError } from '../services/session/btw-service.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'

/** btw 线 session id（W4a 键统一后 = pi 真实会话 id，与生产同形态）。 */
const LINE_ID = 'thread-para'

/** 最小假 client：ensureActive 分支只消费身份。 */
function makeClient(exited: boolean): IPiEngine {
  return { exited } as unknown as IPiEngine
}

function makeEnv(getClientImpl: (sessionId: string) => IPiEngine | undefined) {
  const broker = { broadcast: vi.fn((_: ServerMessage) => {}) } as unknown as IMessageBroker
  const getClient = vi.fn(getClientImpl)
  const pm = {
    onSessionExit: vi.fn(() => () => {}),
    getClient,
  } as unknown as IProcessManager
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
  )
  return { svc, pm, getClient }
}

describe('SessionService.ensureActive · btw 分支（B3 裁决，M2-b）', () => {
  it('btw 线 session id + 已注入 BtwService → 转 ensureProcess，不进 pm.getClient / restore 链', async () => {
    const attached = makeClient(false)
    const ensureProcess = vi.fn(async () => attached)
    const { svc, getClient } = makeEnv(() => {
      throw new Error('pm.getClient 不应被调用（btw 分支先于既有链）')
    })
    // W4a 判别器 = registry 成员查询（getLine 注入；旧 isBtwVirtualId 前缀判别已删）
    svc.setBtwService({ ensureProcess, getLine: ((id: string) => (id === LINE_ID ? { mainSid: 'main-x' } : undefined)) as never })
    const restoreSpy = vi.spyOn(svc, 'restoreSession')

    const got = await svc.ensureActive(LINE_ID)

    expect(got).toBe(attached)
    expect(ensureProcess).toHaveBeenCalledTimes(1)
    expect(ensureProcess).toHaveBeenCalledWith(LINE_ID)
    expect(getClient).not.toHaveBeenCalled()
    expect(restoreSpy).not.toHaveBeenCalled()
    restoreSpy.mockRestore()
  })

  it('非 btw sid + 已注入 BtwService → 分支不命中，既有链零变更', async () => {
    const live = makeClient(false)
    const ensureProcess = vi.fn()
    const { svc, getClient } = makeEnv(() => live)
    svc.setBtwService({ ensureProcess })
    // 快路径前提 = 完整注册态 [switch-race-window]：活 client + Map 缺条目 = 恢复窗口
    // 半成品，会走恢复内核而非快路径——initializeManagedSession 播种注册态
    await svc.initializeManagedSession('plain-session', live, '/test/cwd', 'label')

    const got = await svc.ensureActive('plain-session')

    expect(got).toBe(live)
    expect(ensureProcess).not.toHaveBeenCalled()
    expect(getClient).toHaveBeenCalledWith('plain-session')
  })

  it('btw 线 session id + 未注入 BtwService → fall through 既有链（存量构造零变更）', async () => {
    const live = makeClient(false)
    const { svc, getClient } = makeEnv(() => live)
    // 快路径前提 = 完整注册态 [switch-race-window]（同上）
    await svc.initializeManagedSession(LINE_ID, live, '/test/cwd', 'label')

    const got = await svc.ensureActive(LINE_ID)

    expect(got).toBe(live)
    expect(getClient).toHaveBeenCalledWith(LINE_ID)
  })

  it('附着失败：BtwError 原样上抛且 code 保留（message.error 收尾链的输入契约）', async () => {
    const ensureProcess = vi.fn(async () => {
      throw new BtwError('thread_file_missing', `[btw] thread session file missing (line had never flushed): /x/${LINE_ID}`)
    })
    const { svc } = makeEnv(() => undefined)
    // getLine 注入命中 = btw 线分支（W4a 判别器）
    svc.setBtwService({ ensureProcess, getLine: ((id: string) => (id === LINE_ID ? { mainSid: 'main-x' } : undefined)) as never })

    await expect(svc.ensureActive(LINE_ID)).rejects.toMatchObject({
      name: 'BtwError',
      code: 'thread_file_missing',
      message: expect.stringContaining('line had never flushed'),
    })
  })
})
