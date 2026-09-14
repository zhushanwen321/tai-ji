/**
 * B5 removeSessionEntry 尾段直调接线测试（memory-leak-remediation §3.2-B5①）。
 *
 * 锁定：SessionService.removeSessionEntry（销毁汇聚点：主动删 / 进程退出 / forceQuit /
 * restore 清场全覆盖）尾部触发 plugin sessionData 清理——经模块级 clearRemovedSessionData
 * 分发到已注册的 SessionDataStore 实例：tombstone 登记 + 分区摘除 + trash 软删除。
 * 清理后插件 worker 迟到的 set() 被写守卫丢弃（didDestroy fire-and-forget 无完成屏障，
 * 本接线 + tombstone 共同封死异步复活）。
 *
 * 装置：真 SessionService（session-service-checkpoint.test.ts createSetup 同款轻量桩）+
 * 真 SessionDataStore（tmp configDir，自注册进分发表）。trash port 注入式 mock
 * （B5 port 化，禁触真实废纸篓）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service-plugin-data-clear.test.ts
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// trash port 注入式 mock（B5 port 化：SessionDataStore 构造参数注入，非模块 mock）；
// 同步移除文件模拟 trash 语义
const trashState = { calls: [] as string[] }
const mockTrashFile = async (filePath: string): Promise<void> => {
  trashState.calls.push(filePath)
  rmSync(filePath, { force: true })
}
// getPiAgentDir → tmp（removeSessionEntry 的 reapSessionBackgroundTasks fire-and-forget 腿
// 读该目录，session-service-background-task.test.ts 同款隔离）
const paths = vi.hoisted(() => ({ agentDir: '' }))
vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return { ...actual, getPiAgentDir: () => paths.agentDir }
})

import { SessionService } from '../session-service.js'
import { SessionDataStore, isSessionDataCleared } from '../../plugin-service/session-data-store.js'
import { initRuntimeCheckpointStore } from '../runtime-checkpoint.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import type { IProcessManager, IPiEngine } from '../../ports/pi-engine.js'
import type { IExtensionService } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

const SID = 'sid-plugin-data-clear'
const CLIENT_ACTIVITY_AT = 1_700_000_500_000

let runDir: string
let store: SessionDataStore

beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'session-service-plugin-data-clear-'))
  initRuntimeCheckpointStore({ dir: runDir })
  paths.agentDir = mkdtempSync(join(tmpdir(), 'session-service-plugin-data-clear-agent-'))
})

beforeEach(() => {
  // 每 case 独立 store（tombstone/分发表模块级共享态，sid 也唯一化由各 case 自带）
  store = new SessionDataStore(runDir, undefined, undefined, mockTrashFile)
  trashState.calls.length = 0
})

afterEach(() => {
  store.dispose()
})

afterAll(() => {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  rmSync(paths.agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 真 SessionService 最小装置（session-service-checkpoint.test.ts 同款，构造期零 fs 触点）。 */
function createSetup(): SessionService {
  const client = { lastActivityAt: CLIENT_ACTIVITY_AT, exited: false } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
    hasClient: vi.fn(() => false),
    destroySession: vi.fn(async () => undefined),
    destroyAll: vi.fn(async () => undefined),
  }
  return new SessionService(
    pm as unknown as IProcessManager,
    { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() },
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
}

describe('B5：removeSessionEntry 尾段直调 plugin sessionData 清理', () => {
  it('销毁汇聚点触发清理：tombstone 登记 + 文件进 trash + 迟到 set 被丢弃', async () => {
    const service = createSetup()
    await service.initializeManagedSession(SID, {} as unknown as IPiEngine, '/project', 'label')

    // session 存续期的插件数据（模拟 plugin worker 已写入）
    store.set(SID, 'k1', 'v1')
    store.flushSession(SID)
    expect(existsSync(join(runDir, 'session-data', `${SID}.json`))).toBe(true)

    service.removeSessionEntry(SID)

    // 分发内部 async（void…catch），trash 到达是微任务
    await vi.waitFor(() => expect(trashState.calls).toContain(join(runDir, 'session-data', `${SID}.json`)))
    expect(isSessionDataCleared(SID)).toBe(true)
    expect(existsSync(join(runDir, 'session-data', `${SID}.json`))).toBe(false)

    // didDestroy fire-and-forget 后插件 worker 迟到的 set：被写守卫丢弃，不复活文件
    store.set(SID, 'k2', 'late-write')
    store.flushAll()
    expect(existsSync(join(runDir, 'session-data', `${SID}.json`))).toBe(false)
    expect(store.keys(SID)).toEqual([])
  })

  it('未注册任何 store（无插件系统场景）时销毁不抛（分发空集 no-op）', () => {
    store.dispose() // 摘除唯一注册实例
    const service = createSetup()
    expect(() => service.removeSessionEntry('sid-no-store')).not.toThrow()
    expect(trashState.calls).toHaveLength(0)
  })
})
