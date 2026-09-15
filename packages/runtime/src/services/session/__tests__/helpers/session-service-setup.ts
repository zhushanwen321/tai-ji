/**
 * SessionService checkpoint 域测试共享装置（session-service-checkpoint / mirror-preset
 * 两文件逐字同款 createSetup 收敛为单源；plugin-data-clear / background-task 有 pm/store
 * 定制差异，不在此列）。
 *
 * 真 SessionService（构造期零 fs 触点），pm 只桩本域触达的方法；configStore/sessionStore
 * 真实实例（构造期零 IO）。client.lastActivityAt 与 checkpoint 断言常量 CLIENT_ACTIVITY_AT
 * 同值（1_700_000_500_000）。
 */
import { vi } from 'vitest'
import { tmpdir } from 'node:os'

import { SessionService } from '../../session-service.js'
import { PiConfigStore } from '../../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../../infra/pi/session-store.js'
import type { IProcessManager, IPiEngine } from '../../../ports/pi-engine.js'
import type { IExtensionService } from '../../../../interfaces.js'
import type { WorkspaceService } from '../../../workspace/workspace-service.js'

export interface SessionServiceSetup {
  service: SessionService
  pm: {
    getClient: ReturnType<typeof vi.fn>
    hasClient: ReturnType<typeof vi.fn>
    destroySession: ReturnType<typeof vi.fn>
  }
}

/** 最小装置：真 SessionService，pm/broker/extService/gitInfo/workspace 全桩。 */
export function createSetup(): SessionServiceSetup {
  const client = { lastActivityAt: 1_700_000_500_000, exited: false } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client),
    hasClient: vi.fn(() => false),
    destroySession: vi.fn(async () => undefined),
    destroyAll: vi.fn(async () => undefined),
  }
  const pmStub = pm as unknown as IProcessManager
  const service = new SessionService(
    pmStub,
    { broadcast: vi.fn(), send: vi.fn(), sendError: vi.fn() },
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
  return { service, pm }
}
