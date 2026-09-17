/**
 * W5 reload-orchestrator 单测（红灯阶段）。
 * 断言未实现的 reload-orchestrator → import 失败 → fail（TDD 红灯）。
 */
import { describe, it, expect, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('reload-orchestrator (W5)', () => {
  it('U10: builtin extension 注册 __taiji_reload__', async () => {
    // 读 extensions/taiji/agent-ext/src/index.ts 源码断言注册
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../extensions/taiji/agent-ext/src/index.ts'),
      'utf-8',
    )
    expect(src).toContain("registerCommand('__taiji_reload__'")
    expect(src).toContain('ctx.reload()')
  })

  it('U11: idle session skill 变更立即 promptReload', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockResolvedValue(undefined)
    const handleSessionReloaded = vi.fn()
    const isIdle = vi.fn().mockResolvedValue(true)
    const orch = new ReloadOrchestrator({
      sessionService: { isSessionIdle: isIdle, promptReload, handleSessionReloaded } as never,
    } as never)
    await orch.onSkillChange(['sid-a'])
    expect(promptReload).toHaveBeenCalledWith('sid-a')
  })

  it('U12: running session 排队 + message.complete 触发 reload 清 flag', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockResolvedValue(undefined)
    const handleSessionReloaded = vi.fn()
    const isIdle = vi.fn().mockReturnValue(false)
    const orch = new ReloadOrchestrator({
      sessionService: { isSessionIdle: isIdle, promptReload, handleSessionReloaded } as never,
    } as never)
    await orch.onSkillChange(['sid-a'])
    expect(promptReload).not.toHaveBeenCalled() // running 不立即发
    await orch.onMessageComplete('sid-a')
    expect(promptReload).toHaveBeenCalledWith('sid-a') // message.complete 后发
  })

  it('U3: reload 成功后失效 commands 快照（handleSessionReloaded 被调）', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockResolvedValue(undefined)
    const handleSessionReloaded = vi.fn()
    const isIdle = vi.fn().mockResolvedValue(true)
    const orch = new ReloadOrchestrator({
      sessionService: { isSessionIdle: isIdle, promptReload, handleSessionReloaded } as never,
    } as never)
    await orch.onSkillChange(['sid-a'])
    // 成功路径：promptReload resolve = reload 完成（F8），随后失效 commands 快照
    expect(handleSessionReloaded).toHaveBeenCalledTimes(1)
    expect(handleSessionReloaded).toHaveBeenCalledWith('sid-a')
    // 调用顺序：先 reload 完成后失效（失效过早会重拉到 reload 前旧列表）
    expect(promptReload.mock.invocationCallOrder[0]).toBeLessThan(
      handleSessionReloaded.mock.invocationCallOrder[0],
    )
  })

  it('U3: 排队路径 message.complete 消费后同样失效 commands 快照', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockResolvedValue(undefined)
    const handleSessionReloaded = vi.fn()
    const isIdle = vi.fn().mockReturnValue(false)
    const orch = new ReloadOrchestrator({
      sessionService: { isSessionIdle: isIdle, promptReload, handleSessionReloaded } as never,
    } as never)
    await orch.onSkillChange(['sid-a'])
    expect(handleSessionReloaded).not.toHaveBeenCalled() // running 期不发也不失效
    await orch.onMessageComplete('sid-a')
    expect(handleSessionReloaded).toHaveBeenCalledWith('sid-a')
  })

  it('U13: 降级 - reload 失败清 flag 不重试', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockRejectedValue(new Error('pi reload failed'))
    const handleSessionReloaded = vi.fn()
    const isIdle = vi.fn().mockReturnValue(true)
    const orch = new ReloadOrchestrator({
      sessionService: { isSessionIdle: isIdle, promptReload, handleSessionReloaded } as never,
    } as never)
    await orch.onSkillChange(['sid-a']) // 抛错
    // 二次变更不应因 flag 残留被忽略（flag 已清）
    await orch.onSkillChange(['sid-a'])
    expect(promptReload).toHaveBeenCalledTimes(2) // 两次都尝试（flag 每次清）
    // 失败路径（catch 分支）：reload 未完成，不失效快照（保留旧 commands 列表）
    expect(handleSessionReloaded).not.toHaveBeenCalled()
  })
})

describe('reload-orchestrator D8-b decision 归因日志', () => {
  // G4/S4：skill 变更 → orchestrator 决策必须可从日志行读出（immediate/queued/
  // skipped-deleted + queued 的消费点），与 skill-registry 的 dir/event 行串因果。

  it('idle → decision=immediate；running → decision=queued + 消费点 queued-consumed', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      // idle 分支（独立 mock：勿与 running 分支共用，防调用计数串扰）
      const idlePromptReload = vi.fn().mockResolvedValue(undefined)
      const idleOrch = new ReloadOrchestrator({
        sessionService: {
          isSessionIdle: vi.fn().mockResolvedValue(true),
          promptReload: idlePromptReload,
          handleSessionReloaded: vi.fn(),
        } as never,
      } as never)
      await idleOrch.onSkillChange(['sid-idle'])
      expect(idlePromptReload).toHaveBeenCalledWith('sid-idle')
      expect(logSpy.mock.calls.map(c => c.join(' '))).toContainEqual(
        expect.stringContaining('sessionId=sid-idle decision=immediate'),
      )

      logSpy.mockClear()

      // running 分支：入队日志 + message.complete 消费日志（同一 sessionId 串因果）
      const busyPromptReload = vi.fn().mockResolvedValue(undefined)
      const busyOrch = new ReloadOrchestrator({
        sessionService: {
          isSessionIdle: vi.fn().mockReturnValue(false),
          promptReload: busyPromptReload,
          handleSessionReloaded: vi.fn(),
        } as never,
      } as never)
      await busyOrch.onSkillChange(['sid-busy'])
      expect(busyPromptReload).not.toHaveBeenCalled()
      await busyOrch.onMessageComplete('sid-busy')
      expect(busyPromptReload).toHaveBeenCalledWith('sid-busy')
      const lines = logSpy.mock.calls.map(c => c.join(' '))
      expect(lines).toContainEqual(expect.stringContaining('sessionId=sid-busy decision=queued'))
      expect(lines).toContainEqual(
        expect.stringContaining('sessionId=sid-busy decision=queued-consumed'),
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it('排队期 session 已删除 → decision=skipped-deleted 且不发 reload', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockResolvedValue(undefined)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const orch = new ReloadOrchestrator({
        sessionService: {
          isSessionIdle: vi.fn().mockResolvedValue(true),
          promptReload,
          handleSessionReloaded: vi.fn(),
          hasSession: vi.fn().mockReturnValue(false),
        } as never,
      } as never)
      await orch.onSkillChange(['sid-gone'])
      expect(promptReload).not.toHaveBeenCalled() // 假跳过：session 已离开，reload 无对象
      expect(logSpy.mock.calls.map(c => c.join(' '))).toContainEqual(
        expect.stringContaining('sessionId=sid-gone decision=skipped-deleted'),
      )
    } finally {
      logSpy.mockRestore()
    }
  })

  it('排队 session 被删除（clearPending）→ 终态 skipped-deleted 留痕；未入队 sid 不打噪音行', async () => {
    const { ReloadOrchestrator } = await import('../src/services/session/reload-orchestrator.js')
    const promptReload = vi.fn().mockResolvedValue(undefined)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const orch = new ReloadOrchestrator({
        sessionService: {
          isSessionIdle: vi.fn().mockReturnValue(false),
          promptReload,
          handleSessionReloaded: vi.fn(),
        } as never,
      } as never)
      await orch.onSkillChange(['sid-queued-gone']) // decision=queued 入队
      expect(promptReload).not.toHaveBeenCalled()
      // session 被删除：queued 行必须有终态留痕，归因链 queued → 终态闭合
      orch.clearPending('sid-queued-gone')
      expect(logSpy.mock.calls.map(c => c.join(' '))).toContainEqual(
        expect.stringContaining(
          'sessionId=sid-queued-gone decision=skipped-deleted (session deleted while queued)',
        ),
      )
      expect(promptReload).not.toHaveBeenCalled() // 删除清理不发 reload

      // 从未入队的 sid 删除（常态路径）：无 decision 行噪音
      logSpy.mockClear()
      orch.clearPending('sid-never-queued')
      expect(logSpy).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }
  })
})
