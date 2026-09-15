/**
 * mount-point-registry.test.ts —— MountPointRegistry 契约（TC-2，IF5/AC10 core 侧）。
 *
 * register → has/list / 重复 register 覆盖（幂等）/ unregister 消失 / unregister 不存在 no-op。
 */
import { describe, it, expect } from 'vitest'
import { MountPointRegistry } from '../mount-point-registry'

describe('MountPointRegistry', () => {
  it('TC-2a: register 后 has=true，list() 含该挂载点（AC10 core 侧）', () => {
    const reg = new MountPointRegistry()
    reg.register('sidebar.tab')
    expect(reg.has('sidebar.tab')).toBe(true)
    expect(reg.list()).toContain('sidebar.tab')
  })

  it('TC-2b: 重复 register 同名覆盖（幂等，不抛错）', () => {
    const reg = new MountPointRegistry()
    reg.register('statusbar', { id: 'host-1' })
    expect(() => reg.register('statusbar', { id: 'host-2' })).not.toThrow()
    expect(reg.has('statusbar')).toBe(true)
    expect(reg.list().filter((n) => n === 'statusbar')).toHaveLength(1) // 不翻倍
  })

  it('TC-2c: unregister 后 has=false 且 list() 消失', () => {
    const reg = new MountPointRegistry()
    reg.register('composer.toolbar')
    reg.unregister('composer.toolbar')
    expect(reg.has('composer.toolbar')).toBe(false)
    expect(reg.list()).not.toContain('composer.toolbar')
  })

  it('TC-2d: unregister 不存在的挂载点 no-op 不抛错', () => {
    const reg = new MountPointRegistry()
    expect(() => reg.unregister('nonexistent')).not.toThrow()
  })

  it('TC-2e: 初始 list() 为空；多个挂载点全部列出', () => {
    const reg = new MountPointRegistry()
    expect(reg.list()).toEqual([])
    reg.register('sidebar.tab')
    reg.register('statusbar')
    reg.register('slash')
    expect(reg.list().sort()).toEqual(['sidebar.tab', 'slash', 'statusbar'])
  })
})
