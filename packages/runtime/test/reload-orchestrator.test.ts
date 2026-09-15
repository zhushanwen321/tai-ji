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
