/**
 * activation-manager.test.ts —— ActivationManager 契约（IF7，TC-3/TC-5）。
 *
 * TC-3：重复 ensureActivated 幂等（mock trigger 只调一次）+ 注入 isActivated 短路
 * TC-5：未声明事件 no-op / 未注册 pluginId no-op / 注册表覆盖
 * 另覆盖：命中触发 + isActivated 断言
 */
import { describe, it, expect, vi } from 'vitest'
import { ActivationManager, type ActivationTrigger } from '../activation-manager'

function setup(isActivated?: (pluginId: string) => boolean) {
  const trigger = vi.fn<ActivationTrigger['ensureActivated']>().mockResolvedValue(undefined)
  const triggerObj: ActivationTrigger = { ensureActivated: trigger }
  const manager = new ActivationManager({ trigger: triggerObj, isActivated })
  return { trigger, manager }
}

describe('ActivationManager.ensureActivated（TC-3 幂等 + 命中触发）', () => {
  it('TC-3a: 命中声明事件 → mock trigger 被调一次 + isActivated 变 true', async () => {
    const { trigger, manager } = setup()
    manager.registerActivationEvents('p1', ['onCommand'])
    await manager.ensureActivated('p1', 'onCommand')
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(trigger).toHaveBeenCalledWith('p1', 'onCommand')
    expect(manager.isActivated('p1')).toBe(true)
  })

  it('TC-3b: 重复 ensureActivated（同 pluginId 同 event）→ mock trigger 只调一次（本地 Set 幂等）', async () => {
    const { trigger, manager } = setup()
    manager.registerActivationEvents('p1', ['onCommand'])
    await manager.ensureActivated('p1', 'onCommand')
    await manager.ensureActivated('p1', 'onCommand')
    await manager.ensureActivated('p1', 'onCommand')
    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it('TC-3c: 注入 isActivated 返回 true → ensureActivated 不触发（外部已激活短路）', async () => {
    const { trigger, manager } = setup(() => true)
    manager.registerActivationEvents('p1', ['onCommand'])
    await manager.ensureActivated('p1', 'onCommand')
    expect(trigger).not.toHaveBeenCalled()
    expect(manager.isActivated('p1')).toBe(true)
  })
})

describe('ActivationManager 边界（TC-5）', () => {
  it('TC-5a: 声明 onCommand 但 ensureActivated(\'p1\',\'onView\') → no-op 不触发（事件不匹配）', async () => {
    const { trigger, manager } = setup()
    manager.registerActivationEvents('p1', ['onCommand'])
    await manager.ensureActivated('p1', 'onView')
    expect(trigger).not.toHaveBeenCalled()
    expect(manager.isActivated('p1')).toBe(false)
  })

  it('TC-5b: 未注册任何 activationEvents 的 pluginId → ensureActivated no-op', async () => {
    const { trigger, manager } = setup()
    await manager.ensureActivated('ghost', 'onCommand')
    expect(trigger).not.toHaveBeenCalled()
    expect(manager.isActivated('ghost')).toBe(false)
  })

  it('TC-5c: registerActivationEvents 重复调用覆盖 → 新集合生效', async () => {
    const { trigger, manager } = setup()
    manager.registerActivationEvents('p1', ['onView'])
    await manager.ensureActivated('p1', 'onView')
    expect(trigger).toHaveBeenCalledTimes(1)
    // 覆盖注册表：onView 失效，onCommand 生效
    manager.registerActivationEvents('p1', ['onCommand'])
    // 已激活（onView 触发过）→ 短路
    await manager.ensureActivated('p1', 'onCommand')
    expect(trigger).toHaveBeenCalledTimes(1)
    // 新 plugin 验证覆盖语义
    manager.registerActivationEvents('p2', ['onView'])
    await manager.ensureActivated('p2', 'onCommand')
    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it('TC-5d: 触发失败上抛（不静默吞）', async () => {
    const { manager } = setup()
    manager.registerActivationEvents('p1', ['onCommand'])
    const failing: ActivationTrigger = {
      ensureActivated: vi.fn().mockRejectedValue(new Error('activate failed')),
    }
    const m2 = new ActivationManager({ trigger: failing })
    m2.registerActivationEvents('p2', ['onCommand'])
    await expect(m2.ensureActivated('p2', 'onCommand')).rejects.toThrow('activate failed')
    expect(m2.isActivated('p2')).toBe(false)
  })
})
