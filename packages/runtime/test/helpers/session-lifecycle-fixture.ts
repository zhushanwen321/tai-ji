/**
 * session-lifecycle delete 链路测试共享脚手架（真实实例 + 最小 spy 面）。
 *
 * [import 即生效 mock] 本模块被 import 即注册 infra trash mock（vi.mock 经 vitest
 * hoist 到本模块顶层，先于下方 session-store 等求值），测试文件无须各自声明 vi.mock。
 * 约束：测试文件须把本 helper 的 import 保持为第一个本地 import——ESM 按序求值，
 * 其后的本地 import 若先拉起 session-store/trash 会捕获到未 mock 的真实 trash。
 *
 * 适用形态：唯一 mock = infra trash 故障注入（防真移文件）；PiSessionStore /
 * SessionLifecycle 用真实实例，仅 spy 目录列举与刷新面，错误传播链不被 mock 截断。
 * svc/pm/configStore/workspace 按 session-lifecycle-deletebycwd.test.ts 范式 mock
 * 最小字段集。
 */
import { vi } from 'vitest'
import { trash } from '../../src/infra/system/trash.js'
import { PiSessionStore } from '../../src/infra/pi/session-store.js'
import { SessionLifecycle } from '../../src/services/session/session-lifecycle.js'
import type { ILifecycleSessionOps } from '../../src/services/session/session-internal.js'
import type { ScannedSession } from '../../src/services/session/types.js'
import type { IEventAdapter } from '../../src/interfaces.js'
import type { IProcessManager } from '../../src/services/ports/pi-engine.js'
import type { IConfigStore } from '../../src/services/ports/config.js'
import type { WorkspaceService } from '../../src/services/workspace/workspace-service.js'
import type { SessionSummary } from '@taiji/shared'

vi.mock('../../src/infra/system/trash.js', () => ({ trash: vi.fn() }))

/** 已 mock 的 infra trash（vi.mocked 视图，测试经它注入故障/断言调用）。 */
export const trashMock = vi.mocked(trash)

export interface SessionLifecycleFixture { // oe-exempt:20260930:test:测试 fixture 的装配契约形状，makeSessionLifecycleFixture 返回值与消费方解构共用同一类型标注
  lifecycle: SessionLifecycle
  svc: ILifecycleSessionOps
  store: PiSessionStore
  pm: IProcessManager
}

/**
 * 构造真实 SessionLifecycle 与四类协作对象。
 *
 * S3 迁移跟移（原 MERGE_HEAD 版按旧 ISessionServiceInternal + 5 参构造书写）：
 * sessions Map 所有权已入 SessionLifecycle（this.get 判 active），构造多第 6 参 registerDeps。
 */
export function makeSessionLifecycleFixture(): SessionLifecycleFixture {
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

/** findScannedSession 的在册扫描项桩（id 由调用方给，delete/deleteByCwd 按它路由）。 */
export function scannedEntry(id: string, filePath: string): ScannedSession {
  return { id, cwd: '/p', filePath } as unknown as ScannedSession
}
