/**
 * SessionService.abortPlan 编排测试（plan 模式重设计 D5/E9/E10；MF-1-7 编排自 transport
 * handler 下沉至此，断言随被测代码迁移自 session-message-handler-plan.test.ts）。
 *
 * 覆盖：
 * - ensureActive（自动恢复，join 语义）先于 prompt——pi 未活窗口恢复完成后才直发
 * - prompt('/plan abort') 字面量：`/` 前缀 prompt 被 pi 先行执行为 extension command、
 *   不经 LLM（直发绕 dispatcher busy 预检，workflowAction 先例）
 * - prompt 成功 → onPlanAborted 回调上抛（sessionId 透传；失效链消费单一出口在 transport
 *   层 server.ts——service 只上抛，不持有失效链实现）
 * - prompt throw → 异常上抛 + 失效回调不上抛（恢复失败 / 直发失败都不触发失效链）
 * - 回调未注入（仅测试最小构造形态）→ abortPlan 正常完成不抛
 *
 * Mock 边界：ensureActive 经 vi.spyOn 桩掉（真实实现涉 lifecycle/pm 复杂链，非本域）；
 * SessionService 依赖桩仿 session-service-background-task.test.ts createSetup 最小集
 * （构造期零 fs 触点，子模块仅存引用）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service-abort-plan.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { tmpdir } from 'node:os'

import { SessionService } from '../session-service.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import type { IProcessManager } from '../../../services/ports/pi-engine.js'
import type { IExtensionService } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'

const SID = 'sess-abort-plan'

// ── SessionService 最小装置（仿 session-service-background-task.test.ts）────────

function createService(): SessionService {
  return new SessionService(
    // pm：构造期只注册 onSessionExit 回调（ensureActive 经 spy 桩掉，其余不触达）
    { onSessionExit: vi.fn(), getClient: vi.fn(), hasClient: vi.fn(() => false), destroyAll: vi.fn() } as unknown as IProcessManager,
    // broker
    { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() },
    // adapterFactory：桩（本域不附着 session）
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    // dataDir：os.tmpdir()（构造期零 IO，同 session-service-background-task.test.ts 装置）
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    // configStore / sessionStore：真实实例（构造期零 IO，同既有 session-service 测试范式）
    new PiConfigStore(),
    new PiSessionStore(),
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── abortPlan 编排 ───────────────────────────────────────────────

describe('SessionService.abortPlan（MF-1-7 下沉编排）', () => {
  it('ensureActive（自动恢复，join 语义）先于 prompt("/plan abort") 直发；成功后失效回调上抛', async () => {
    const service = createService()
    const prompt = vi.fn(async () => {
      // 顺序断言：恢复完成后才直发（pi 未活窗口 restoreSession spawn pi 先行）
      expect(ensureActiveSpy).toHaveBeenCalledTimes(1)
    })
    const ensureActiveSpy = vi.spyOn(service, 'ensureActive').mockResolvedValue({ prompt } as never)
    const onPlanAborted = vi.fn()
    service.setOnPlanAborted(onPlanAborted)

    await service.abortPlan(SID)

    expect(ensureActiveSpy).toHaveBeenCalledWith(SID)
    // 直发参数断言：extension command 字面量（pi 对 / 前缀 prompt 先行执行，不经 LLM）
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('/plan abort')
    expect(onPlanAborted).toHaveBeenCalledTimes(1)
    expect(onPlanAborted).toHaveBeenCalledWith(SID)
  })

  it('prompt throw（直发失败）→ 异常上抛 + 失效回调不上抛', async () => {
    const service = createService()
    vi.spyOn(service, 'ensureActive').mockResolvedValue({
      prompt: vi.fn(async () => {
        throw new Error('client gone')
      }),
    } as never)
    const onPlanAborted = vi.fn()
    service.setOnPlanAborted(onPlanAborted)

    await expect(service.abortPlan(SID)).rejects.toThrow('client gone')
    expect(onPlanAborted).not.toHaveBeenCalled()
  })

  it('ensureActive throw（恢复失败，E9）→ 异常上抛 + 失效回调不上抛', async () => {
    const service = createService()
    vi.spyOn(service, 'ensureActive').mockRejectedValue(new Error('Session file corrupted'))
    const onPlanAborted = vi.fn()
    service.setOnPlanAborted(onPlanAborted)

    await expect(service.abortPlan(SID)).rejects.toThrow('Session file corrupted')
    expect(onPlanAborted).not.toHaveBeenCalled()
  })

  it('回调未注入（仅测试最小构造形态）→ abortPlan 正常完成不抛', async () => {
    const service = createService()
    const prompt = vi.fn(async () => ({}))
    vi.spyOn(service, 'ensureActive').mockResolvedValue({ prompt } as never)

    await expect(service.abortPlan(SID)).resolves.toBeUndefined()
    expect(prompt).toHaveBeenCalledWith('/plan abort')
  })
})
