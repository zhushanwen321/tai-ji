/**
 * extension-filter.ts — 过滤管道纯函数测试
 *
 * 重写适配新 API：
 *   - resolveExtension / resolveExtensions（disabled 过滤 + tier 推导，一次读盘）
 *   - applyPresetMode（preset extensionMode 二次筛选）
 *
 * 核心保证（S2）：infrastructure 包在任何 preset mode 下都绝对存活；feature builtin 受 disabled 控制（可禁）。
 * S8：畸形 package.json name（非 string）用 basename fallback。
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveExtensions, resolveExtension, applyPresetMode, type ResolvedExtension } from '../src/services/extension-filter.js'
import type { DiscoveredExtension } from '../src/services/ports/installer.js'

// 拦截 node:fs readFileSync：按目录名返回 mock package.json（与旧测试同模式）
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readFileSync: vi.fn((path: string) => {
      const dir = typeof path === 'string' ? path : ''
      // infrastructure mandatory
      if (dir.includes('pi-pending-notifications')) {
        return JSON.stringify({ name: '@zhushanwen/pi-pending-notifications', version: '1.0.0' })
      }
      if (dir.includes('pi-structured-output')) {
        return JSON.stringify({ name: '@zhushanwen/pi-structured-output', version: '1.0.0' })
      }
      // feature mandatory
      if (dir.includes('pi-ask-user')) {
        return JSON.stringify({ name: '@zhushanwen/pi-ask-user', version: '1.0.0' })
      }
      if (dir.includes('pi-goal')) {
        return JSON.stringify({ name: '@zhushanwen/pi-goal', version: '1.0.0' })
      }
      // 普通包
      if (dir.includes('normal-ext')) {
        return JSON.stringify({ name: 'normal-ext', version: '1.0.0' })
      }
      if (dir.includes('disabled-ext')) {
        return JSON.stringify({ name: 'disabled-ext', version: '1.0.0' })
      }
      // S8：畸形 name（非 string）—— resolveExtension 用 typeof 守卫 fallback 到 basename
      if (dir.includes('malformed-name-ext')) {
        return JSON.stringify({ name: 123, version: '1.0.0' })
      }
      throw new Error(`ENOENT: ${dir}`)
    }),
  }
})

describe('resolveExtensions', () => {
  it('infrastructure 包无视 disabled 强加载（pi-pending-notifications）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-pending-notifications', source: 'npm' },
    ]
    const disabled = new Set(['npm:@zhushanwen/pi-pending-notifications'])
    const result = resolveExtensions(discovered, disabled)
    expect(result).toHaveLength(1)
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(false)
    expect(result[0]!.tier).toBe('infrastructure')
    expect(result[0]!.name).toBe('@zhushanwen/pi-pending-notifications')
  })

  it('infrastructure 包 pi-structured-output 同样强加载', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-structured-output', source: 'npm' },
    ]
    const disabled = new Set(['npm:@zhushanwen/pi-structured-output'])
    const result = resolveExtensions(discovered, disabled)
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(false)
    expect(result[0]!.tier).toBe('infrastructure')
  })

  it('feature builtin 包受 disabled 控制（pi-ask-user 可禁）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-ask-user', source: 'npm' },
    ]
    const disabled = new Set(['npm:@zhushanwen/pi-ask-user'])
    const result = resolveExtensions(discovered, disabled)
    // feature 现在可禁：disabled set 含 pi-ask-user → loadable=false
    expect(result[0]!.loadable).toBe(false)
    // feature 可被 preset 覆盖（与 infrastructure 的绝对强加载区分）
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[0]!.tier).toBe('feature')
  })

  it('feature builtin 包 pi-goal 可被 disabled', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-goal', source: 'npm' },
    ]
    const disabled = new Set(['npm:@zhushanwen/pi-goal'])
    const result = resolveExtensions(discovered, disabled)
    // feature 现在可禁：disabled set 含 pi-goal → loadable=false
    expect(result[0]!.loadable).toBe(false)
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[0]!.tier).toBe('feature')
  })

  it('普通包未 disabled 时加载', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/normal-ext', source: 'user' },
    ]
    const result = resolveExtensions(discovered, new Set())
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[0]!.tier).toBeUndefined()
  })

  it('普通包 disabled 时排除（loadable=false）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/disabled-ext', source: 'user' },
    ]
    const disabled = new Set(['npm:disabled-ext'])
    const result = resolveExtensions(discovered, disabled)
    expect(result[0]!.loadable).toBe(false)
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[0]!.tier).toBeUndefined()
  })

  it('混合批量保持输入顺序且各自判定正确', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-pending-notifications', source: 'npm' }, // infra
      { path: '/ext/pi-goal', source: 'npm' }, // feature
      { path: '/ext/normal-ext', source: 'user' }, // normal
      { path: '/ext/disabled-ext', source: 'user' }, // disabled normal
    ]
    const disabled = new Set(['npm:disabled-ext'])
    const result = resolveExtensions(discovered, disabled)
    expect(result).toHaveLength(4)
    // 保持输入顺序
    expect(result.map(r => r.path)).toEqual([
      '/ext/pi-pending-notifications',
      '/ext/pi-goal',
      '/ext/normal-ext',
      '/ext/disabled-ext',
    ])
    // [0] infra 强加载
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.tier).toBe('infrastructure')
    // [1] feature 强加载
    expect(result[1]!.loadable).toBe(true)
    expect(result[1]!.tier).toBe('feature')
    // [2] normal 未 disabled
    expect(result[2]!.loadable).toBe(true)
    expect(result[2]!.tier).toBeUndefined()
    // [3] normal 被 disabled
    expect(result[3]!.loadable).toBe(false)
    expect(result[3]!.tier).toBeUndefined()
  })

  it('空 discovered 返回空数组', () => {
    expect(resolveExtensions([], new Set())).toEqual([])
  })

  // S8：畸形 package.json name（非 string）fallback 到 basename
  it('S8: 畸形 package.json name（非 string）fallback 到 basename', () => {
    const dir = '/ext/malformed-name-ext'
    const result = resolveExtension(dir, 'user', new Set())
    // name 字段为 number（123），typeof 守卫失败 → fallback 到 basename(dir)
    expect(result.name).toBe('malformed-name-ext')
    // basename 不是 mandatory 包 → 普通处理：未 disabled 则 loadable
    expect(result.loadable).toBe(true)
    expect(result.tier).toBeUndefined()
    expect(result.presetOverridable).toBe(true)
  })

  // #2：disabled key 跨源隔离——同名 discovery 扩展与 npm 扩展互不影响
  it('#2: discovery 扩展用 discovery: 前缀 disabled key，与同名 npm 扩展不串扰', () => {
    // 同名 normal-ext 分属 discovery 源与 user 源
    const discovered: DiscoveredExtension[] = [
      { path: '/disc/normal-ext', source: 'discovery' },
      { path: '/npm/normal-ext', source: 'user' },
    ]
    // 只禁用 npm 源（npm: 前缀）
    const disabled = new Set(['npm:normal-ext'])
    const result = resolveExtensions(discovered, disabled)
    // discovery 源：disabled key 是 discovery:normal-ext，不在 disabled 集合 → loadable
    expect(result[0]!.source).toBe('discovery')
    expect(result[0]!.loadable).toBe(true)
    // user 源：disabled key 是 npm:normal-ext，在 disabled 集合 → 不 loadable
    expect(result[1]!.source).toBe('user')
    expect(result[1]!.loadable).toBe(false)
  })

  it('#2: discovery 扩展禁用用 discovery: 前缀（反向验证）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/disc/normal-ext', source: 'discovery' },
      { path: '/npm/normal-ext', source: 'user' },
    ]
    // 只禁用 discovery 源（discovery: 前缀）
    const disabled = new Set(['discovery:normal-ext'])
    const result = resolveExtensions(discovered, disabled)
    // discovery 源被禁用
    expect(result[0]!.source).toBe('discovery')
    expect(result[0]!.loadable).toBe(false)
    // user 源不受影响（npm: 前缀未在集合中）
    expect(result[1]!.source).toBe('user')
    expect(result[1]!.loadable).toBe(true)
  })

  // #4：mandatory 判定只对 npm 源生效——discovery 源扩展即使 name 命中 mandatory SSOT 也不当 mandatory
  it('#4: discovery 源扩展 name 命中 mandatory SSOT 不当 mandatory（tier undefined, presetOverridable true）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/disc/pi-pending-notifications', source: 'discovery' },
      { path: '/disc/pi-goal', source: 'discovery' },
    ]
    // 即使把它们加入 disabled（discovery: 前缀），也应当被排除（不当 mandatory 强加载）
    const disabled = new Set([
      'discovery:@zhushanwen/pi-pending-notifications',
      'discovery:@zhushanwen/pi-goal',
    ])
    const result = resolveExtensions(discovered, disabled)
    // discovery 源的 mandatory 命中扩展不当 mandatory → tier undefined
    expect(result[0]!.tier).toBeUndefined()
    expect(result[1]!.tier).toBeUndefined()
    // 非 mandatory → 受 disabled 控制（loadable=false）
    expect(result[0]!.loadable).toBe(false)
    expect(result[1]!.loadable).toBe(false)
    // 非 mandatory → presetOverridable=true（可被 preset 覆盖）
    expect(result[0]!.presetOverridable).toBe(true)
    expect(result[1]!.presetOverridable).toBe(true)
  })

  it('#4: 对比 npm 源同名扩展当 builtin（infrastructure 强加载, feature 受 disabled 控制）', () => {
    const discovered: DiscoveredExtension[] = [
      { path: '/npm/pi-pending-notifications', source: 'npm' }, // infrastructure
      { path: '/npm/pi-goal', source: 'npm' }, // feature
    ]
    const disabled = new Set([
      'npm:@zhushanwen/pi-pending-notifications',
      'npm:@zhushanwen/pi-goal',
    ])
    const result = resolveExtensions(discovered, disabled)
    // npm 源 infrastructure builtin 无视 disabled 强加载
    expect(result[0]!.tier).toBe('infrastructure')
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(false)
    // feature builtin 受 disabled 控制（disabled set 含它 → loadable=false）
    expect(result[1]!.tier).toBe('feature')
    expect(result[1]!.loadable).toBe(false)
    expect(result[1]!.presetOverridable).toBe(true)
  })

  it('#4: settings 源（packages[] 安装）builtin 包仍当 builtin（infrastructure 强加载, feature 受 disabled 控制）', () => {
    // 生产场景：内置的 builtin 包经 packages[] → resolver 标 source='settings'
    const discovered: DiscoveredExtension[] = [
      { path: '/settings/pi-pending-notifications', source: 'settings' }, // infrastructure
      { path: '/settings/pi-goal', source: 'settings' }, // feature
    ]
    const disabled = new Set([
      'npm:@zhushanwen/pi-pending-notifications',
      'npm:@zhushanwen/pi-goal',
    ])
    const result = resolveExtensions(discovered, disabled)
    // settings 源 infrastructure builtin 无视 disabled 强加载（disabled key 用 npm: 前缀）
    expect(result[0]!.tier).toBe('infrastructure')
    expect(result[0]!.loadable).toBe(true)
    expect(result[0]!.presetOverridable).toBe(false)
    // settings 源 feature builtin 受 disabled 控制
    expect(result[1]!.tier).toBe('feature')
    expect(result[1]!.loadable).toBe(false)
    expect(result[1]!.presetOverridable).toBe(true)
  })
})

describe('applyPresetMode', () => {
  // 共享 fixture：三类包各一个，均已 resolve（loadable=true）
  // - pi-pending-notifications（infrastructure，presetOverridable=false）
  // - pi-goal（feature mandatory，presetOverridable=true）
  // - normal-ext（普通包，presetOverridable=true）
  const makeResolvedFixture = (): ResolvedExtension[] => {
    const discovered: DiscoveredExtension[] = [
      { path: '/ext/pi-pending-notifications', source: 'npm' },
      { path: '/ext/pi-goal', source: 'npm' },
      { path: '/ext/normal-ext', source: 'user' },
    ]
    // 不 disable 任何包 → 三者 loadable 都 true
    return resolveExtensions(discovered, new Set())
  }

  it('none 模式只保留 infrastructure', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'none', [], [])
    expect(result).toHaveLength(1)
    expect(result[0]!.tier).toBe('infrastructure')
    expect(result[0]!.name).toBe('@zhushanwen/pi-pending-notifications')
    // 不含 feature / normal
    expect(result.some(r => r.name === '@zhushanwen/pi-goal')).toBe(false)
    expect(result.some(r => r.name === 'normal-ext')).toBe(false)
  })

  it('all 模式全保留', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'all', [], [])
    expect(result).toHaveLength(3)
    expect(result.map(r => r.name)).toEqual([
      '@zhushanwen/pi-pending-notifications',
      '@zhushanwen/pi-goal',
      'normal-ext',
    ])
  })

  it('allowlist 模式 infrastructure 存活即使不在 allowlist', () => {
    const resolved = makeResolvedFixture()
    // allowlist 只含 normal-ext（不含 infra 也不含 feature）
    const result = applyPresetMode(resolved, 'allowlist', ['normal-ext'], [])
    const names = result.map(r => r.name)
    // infra 存活（不在 allowlist 也留）
    expect(names).toContain('@zhushanwen/pi-pending-notifications')
    // normal-ext 在 allowlist 内
    expect(names).toContain('normal-ext')
    // feature（pi-goal）不在 allowlist → 被排除
    expect(names).not.toContain('@zhushanwen/pi-goal')
    expect(result).toHaveLength(2)
  })

  it('allowlist 模式 feature 在 allowlist 内时保留', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'allowlist', ['@zhushanwen/pi-goal', 'normal-ext'], [])
    expect(result).toHaveLength(3)
    expect(result.map(r => r.name)).toEqual([
      '@zhushanwen/pi-pending-notifications',
      '@zhushanwen/pi-goal',
      'normal-ext',
    ])
  })

  it('denylist 模式 infrastructure 存活即使被列入 denylist', () => {
    const resolved = makeResolvedFixture()
    // 三个都 deny
    const result = applyPresetMode(resolved, 'denylist', [], [
      '@zhushanwen/pi-pending-notifications',
      '@zhushanwen/pi-goal',
      'normal-ext',
    ])
    const names = result.map(r => r.name)
    // infra 扛住 denylist（即使被列入也留）
    expect(names).toContain('@zhushanwen/pi-pending-notifications')
    // feature / normal 被 deny
    expect(names).not.toContain('@zhushanwen/pi-goal')
    expect(names).not.toContain('normal-ext')
    expect(result).toHaveLength(1)
  })

  it('denylist 模式排除列出的 feature/normal', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'denylist', [], ['@zhushanwen/pi-goal'])
    const names = result.map(r => r.name)
    // infra + normal 留；feature 被 deny
    expect(names).toContain('@zhushanwen/pi-pending-notifications')
    expect(names).toContain('normal-ext')
    expect(names).not.toContain('@zhushanwen/pi-goal')
    expect(result).toHaveLength(2)
  })

  it('空 allowlist + allowlist 模式只留 infrastructure', () => {
    const resolved = makeResolvedFixture()
    const result = applyPresetMode(resolved, 'allowlist', [], [])
    expect(result).toHaveLength(1)
    expect(result[0]!.tier).toBe('infrastructure')
  })

  // 本次重构最关键的保证：infrastructure 在所有 4 种 preset mode 下都绝对存活
  it('infrastructure 包在任何 preset mode 下都绝对存活（核心保证）', () => {
    const resolved = makeResolvedFixture()
    const infraPath = '/ext/pi-pending-notifications'
    const modes = ['none', 'allowlist', 'denylist', 'all'] as const
    for (const mode of modes) {
      // denylist 故意把 infra 也列进去，验证它扛住
      const result = applyPresetMode(resolved, mode, [], ['@zhushanwen/pi-pending-notifications'])
      const paths = result.map(r => r.path)
      expect(paths).toContain(infraPath)
    }
  })

  // #6b：applyPresetMode 不过滤 loadable——disabled 普通包（loadable=false）在 all 模式下
  // 仍被 applyPresetMode 返回，靠下游消费端 .filter(r => r.loadable) 排除。
  // 这验证了 disabled 过滤与 preset mode 过滤的职责分离。
  it('#6b: all 模式返回含 loadable=false 的项（applyPresetMode 不过滤 loadable，靠下游 filter）', () => {
    // 构造一个 loadable=false 的 ResolvedExtension（disabled 普通包）
    const disabledExt: ResolvedExtension = {
      path: '/ext/disabled-ext',
      name: 'disabled-ext',
      source: 'user',
      tier: undefined,
      loadable: false,
      presetOverridable: true,
    }
    // all 模式：applyPresetMode 全保留，不过滤 loadable
    const result = applyPresetMode([disabledExt], 'all', [], [])
    expect(result).toHaveLength(1)
    expect(result[0]!.loadable).toBe(false)
    // 证明 disabled 过滤职责在下游：applyPresetMode 返回后消费端需自己 .filter(r => r.loadable)
    expect(result.filter(r => r.loadable)).toHaveLength(0)
  })

  it('#6b: allowlist 模式也保留 loadable=false 的 allowlist 内项（preset 过滤与 disabled 过滤正交）', () => {
    const disabledExt: ResolvedExtension = {
      path: '/ext/disabled-ext',
      name: 'disabled-ext',
      source: 'user',
      tier: undefined,
      loadable: false,
      presetOverridable: true,
    }
    // allowlist 含 disabled-ext name → preset 层放行（presetOverridable 且 name 在 allowlist）
    // 但 loadable=false（disabled 层排除），两者正交
    const result = applyPresetMode([disabledExt], 'allowlist', ['disabled-ext'], [])
    expect(result).toHaveLength(1)
    expect(result[0]!.loadable).toBe(false)
  })
})
