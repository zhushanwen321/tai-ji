import { trash } from '../src/infra/system/trash.js';
import { applyPresetMode, resolveExtension, resolveExtensions, type ResolvedExtension } from '../src/services/extension-filter.js';
import { ExtensionInstallError } from '../src/services/extension-service.js';
import { ExtensionTimeoutManager } from '../src/services/extension-timeout-manager.js';
import type { DiscoveredExtension } from '../src/services/ports/installer.js';
import { ExtensionMessageHandler } from '../src/transport/extension-message-handler.js';
import type { ClientMessage } from '@taiji/shared';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。


// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← test/extension-filter.test.ts
// ======================================================================

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
      // S8：畸形 name（非 string）—— resolveExtension 用 typeof 检查 fallback 到 basename
      if (dir.includes('malformed-name-ext')) {
        return JSON.stringify({ name: 123, version: '1.0.0' })
      }
      throw new Error(`ENOENT: ${dir}`)
    }),
  }
})


// ======================================================================
// ← test/extension-message-handler-dispatch.test.ts
// ======================================================================

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}


interface HandlerOpts {  // oe-exempt:20261027:test:
  extensionService?: Record<string, ReturnType<typeof vi.fn>> | undefined
  getRpcClient?: ReturnType<typeof vi.fn> | undefined
}


function makeHandler(opts: HandlerOpts = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const extensionTimeoutMgr = {
    removeRequest: vi.fn(),
    getPendingRequests: vi.fn().mockReturnValue([]),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    sessionService: { getRpcClient: opts.getRpcClient ?? vi.fn().mockReturnValue(undefined) },
    extensionService: opts.extensionService,
    extensionTimeoutMgr,
  }
  const handler = new ExtensionMessageHandler(ctx as unknown as ConstructorParameters<typeof ExtensionMessageHandler>[0])
  return { ctx, cap, handler, extensionTimeoutMgr }
}


function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}


const WS = {} as never


// ── extension.getPendingRequests 非破坏快照（自 extension-message-handler.test.ts 归并）──

// 模拟 getPendingRequests 解包后的样本数据（manager 已做 {...r, ...r.payload} 解包，
// renderer 的 ExtensionUIRequest 期望 title/message/options 等在顶层）
const sampleRequests = [
  { requestId: 'r1', sessionId: 's1', method: 'confirm', payload: { title: '确认操作？', confirmed: false }, receivedAt: 1_000, title: '确认操作？', confirmed: false },
  { requestId: 'r2', sessionId: 's1', method: 'ask-user', payload: { title: '选择一项', options: ['A', 'B'] }, receivedAt: 2_000, title: '选择一项', options: ['A', 'B'] },
]

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-bundle', () => {
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-filter', () => {
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
    // name 字段为 number（123），typeof 检查失败 → fallback 到 basename(dir)
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
});
// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-message-handler-dispatch', () => {
describe('ExtensionMessageHandler 分发路由（W1 表驱动重构回归锚定）', () => {
  describe('extension.ui_response 两路（无 client/正常转发）', () => {
    // [pi1-disposition-chat-flow D7②] bridge 请求短路用例随 plugin-bridge 退役删除（拦截分支已删）。

    it('无活跃 client → 清理 pending + sendError(handler_error, "No active session for extension response: s1")', async () => {
      const { ctx, cap, handler, extensionTimeoutMgr } = makeHandler({ getRpcClient: vi.fn().mockReturnValue(undefined) })
      await handler.handleExtensionMessage(msg('extension.ui_response', { sessionId: 's1', requestId: 'r1', method: 'confirm', result: true }), WS)
      expect(extensionTimeoutMgr.removeRequest).toHaveBeenCalledWith('r1')
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'handler_error',
        message: 'No active session for extension response: s1',
        details: { sessionId: 's1' },
      })
    })

    it('正常路径 → client.sendExtensionUiResponse(requestId, result, method) + 清理 pending；result undefined 时第二参为 null（?? null）', async () => {
      // RT-2#8 契约：sendExtensionUiResponse 返 boolean（false=写 pi 失败），
      // 正常路径 mock 返 true；false→sendError(extension_response_send_failed) 路径
      // 由 extension-message-handler-ui-response.test.ts 覆盖
      const client = { sendExtensionUiResponse: vi.fn().mockReturnValue(true) }
      const { ctx, cap, handler, extensionTimeoutMgr } = makeHandler({ getRpcClient: vi.fn().mockReturnValue(client) })
      await handler.handleExtensionMessage(msg('extension.ui_response', { sessionId: 's1', requestId: 'r1', method: 'confirm', result: true }), WS)
      expect(client.sendExtensionUiResponse).toHaveBeenCalledWith('r1', true, 'confirm')
      expect(extensionTimeoutMgr.removeRequest).toHaveBeenCalledWith('r1')
      expect(cap.replies).toHaveLength(0)
      expect(cap.errors).toHaveLength(0)

      await handler.handleExtensionMessage(msg('extension.ui_response', { sessionId: 's1', requestId: 'r2', method: 'select' }), WS)
      expect(client.sendExtensionUiResponse).toHaveBeenCalledWith('r2', null, 'select')
    })
  })

  describe('extension.list / extension.recommended 的 service 缺席空 reply（区别于 requireExt 报错路径）', () => {
    it('extension.list：service 未注入 → reply config.extensions { extensions: [] }（不报错）', async () => {
      const { cap, handler } = makeHandler({ extensionService: undefined })
      await handler.handleExtensionMessage(msg('extension.list', {}), WS)
      expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'config.extensions', payload: { extensions: [] } })
      expect(cap.errors).toHaveLength(0)
    })

    it('extension.list：service 注入 → reply scanExtensions() 结果', async () => {
      const scanExtensions = vi.fn().mockResolvedValue([{ id: 'e1' }])
      const { cap, handler } = makeHandler({ extensionService: { scanExtensions } })
      await handler.handleExtensionMessage(msg('extension.list', {}), WS)
      expect(cap.replies[0]).toMatchObject({ type: 'config.extensions', payload: { extensions: [{ id: 'e1' }] } })
    })

    it('extension.recommended：service 未注入 → reply { recommended: [] }（不报错）', async () => {
      const { cap, handler } = makeHandler({ extensionService: undefined })
      await handler.handleExtensionMessage(msg('extension.recommended', {}), WS)
      expect(cap.replies[0]).toMatchObject({ type: 'extension.recommended', payload: { recommended: [] } })
      expect(cap.errors).toHaveLength(0)
    })
  })

  describe('extension.toggle 错误透传', () => {
    it('领域错误 ExtensionInstallError → 透传 code + hint 进 details（如 infrastructure_cannot_disable）', async () => {
      const err = new ExtensionInstallError('infrastructure_cannot_disable', 'infra extension cannot be disabled', 'disable it in infrastructure group settings')
      const toggleExtension = vi.fn().mockRejectedValue(err)
      const { cap, handler } = makeHandler({ extensionService: { toggleExtension, scanExtensions: vi.fn() } })
      await handler.handleExtensionMessage(msg('extension.toggle', { name: 'system-prompt', enabled: false }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'infrastructure_cannot_disable',
        message: 'infra extension cannot be disabled',
        details: { hint: 'disable it in infrastructure group settings' },
      })
    })

    it('非领域错误 → fallback toggle_failed + toErrorMessage 文案，无 details', async () => {
      const toggleExtension = vi.fn().mockRejectedValue(new Error('fs exploded'))
      const { cap, handler } = makeHandler({ extensionService: { toggleExtension, scanExtensions: vi.fn() } })
      await handler.handleExtensionMessage(msg('extension.toggle', { name: 'x', enabled: true }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'toggle_failed', message: 'fs exploded' })
      expect(cap.errors[0].details).toBeUndefined()
    })
  })

  it('extension.installDir 空 path → sendError(invalid_payload, 文案逐字锚定)，不调 installLocalDirectory', async () => {
    const installLocalDirectory = vi.fn()
    const { cap, handler } = makeHandler({ extensionService: { installLocalDirectory } })
    await handler.handleExtensionMessage(msg('extension.installDir', { path: '' }), WS)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'invalid_payload',
      message: 'extension.installDir requires a non-empty "path" string',
    })
    expect(installLocalDirectory).not.toHaveBeenCalled()
  })

  describe('extension.setAutoUpgrade 校验与错误分支', () => {
    it('autoUpgrade 非布尔 → sendError(invalid_payload, 文案逐字锚定)，不调 setAutoUpgrade', async () => {
      const setAutoUpgrade = vi.fn()
      const { cap, handler } = makeHandler({ extensionService: { setAutoUpgrade, scanExtensions: vi.fn() } })
      await handler.handleExtensionMessage(msg('extension.setAutoUpgrade', { name: 'x', autoUpgrade: 'yes' }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({
        id: 'm1',
        code: 'invalid_payload',
        message: 'extension.setAutoUpgrade requires "autoUpgrade" to be a boolean',
      })
      expect(setAutoUpgrade).not.toHaveBeenCalled()
    })

    it('service reject → sendError(set_auto_upgrade_failed) + toErrorMessage 文案', async () => {
      const setAutoUpgrade = vi.fn().mockRejectedValue(new Error('disk full'))
      const { cap, handler } = makeHandler({ extensionService: { setAutoUpgrade, scanExtensions: vi.fn() } })
      await handler.handleExtensionMessage(msg('extension.setAutoUpgrade', { name: 'x', autoUpgrade: true }), WS)
      expect(cap.errors).toHaveLength(1)
      expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'set_auto_upgrade_failed', message: 'disk full' })
    })
  })

  it('未知 type → 查表落空：sendError(handler_not_registered)，不发 reply（RT-1#6 显形）', async () => {
    const { cap, handler } = makeHandler()
    await expect(handler.handleExtensionMessage(msg('extension.nonexistent', {}), WS)).resolves.toBeUndefined()
    expect(cap.replies).toHaveLength(0)
    // 落空不再静默（RT-1#6）：显式 error 信封让前端 pending Promise 立即失败，而非等到泛化超时。
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'handler_not_registered',
      message: expect.stringContaining('extension.nonexistent'),
    })
  })

  it('落空信封透传 payload.sessionId（session 隔离裁决：错误可归属）', async () => {
    const { cap, handler } = makeHandler()
    await handler.handleExtensionMessage(msg('extension.nonexistent', { sessionId: 's9' }), WS)
    expect(cap.errors[0]?.details).toEqual({ sessionId: 's9' })
  })
})
describe('ExtensionMessageHandler — extension.getPendingRequests（非破坏快照）', () => {
  it('调非破坏 getPendingRequests（不清缓存），reply extension.pendingRequests', async () => {
    const { cap, handler, extensionTimeoutMgr } = makeHandler()
    extensionTimeoutMgr.getPendingRequests.mockReturnValue(sampleRequests)

    await handler.handleExtensionMessage(msg('extension.getPendingRequests', { sessionId: 's1' }), WS)

    // 非破坏版被调一次，参数为 sessionId
    expect(extensionTimeoutMgr.getPendingRequests).toHaveBeenCalledTimes(1)
    expect(extensionTimeoutMgr.getPendingRequests).toHaveBeenCalledWith('s1')
    // reply 结构不变：type + { sessionId, requests }
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'extension.pendingRequests' })
    expect(cap.replies[0].payload).toEqual({ sessionId: 's1', requests: sampleRequests })
    expect(cap.errors).toHaveLength(0)
  })

  it('sessionId 缺失 → sendError(invalid_payload)，不调 extensionTimeoutMgr', async () => {
    const { cap, handler, extensionTimeoutMgr } = makeHandler()

    await handler.handleExtensionMessage(msg('extension.getPendingRequests', {}), WS)

    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({ id: 'm1', code: 'invalid_payload' })
    // 缺 sessionId 时不得触碰 extensionTimeoutMgr
    expect(extensionTimeoutMgr.getPendingRequests).not.toHaveBeenCalled()
    expect(cap.replies).toHaveLength(0)
  })

  it('session 无 pending → getPendingRequests 返回空数组，reply requests: []（非抛错）', async () => {
    const { cap, handler, extensionTimeoutMgr } = makeHandler()
    extensionTimeoutMgr.getPendingRequests.mockReturnValue([])

    await handler.handleExtensionMessage(msg('extension.getPendingRequests', { sessionId: 'empty-session' }), WS)

    expect(extensionTimeoutMgr.getPendingRequests).toHaveBeenCalledWith('empty-session')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'extension.pendingRequests' })
    expect(cap.replies[0].payload).toEqual({ sessionId: 'empty-session', requests: [] })
    expect(cap.errors).toHaveLength(0)
  })

  it('多消费者两次拉取都拿到完整 pending（核心回归：非破坏语义）', async () => {
    const { cap, handler, extensionTimeoutMgr } = makeHandler()
    // 模拟非破坏快照：两次调用都返回完整列表（非破坏版本身不删缓存）
    extensionTimeoutMgr.getPendingRequests.mockReturnValue(sampleRequests)

    // 模拟前端两个消费者（Panel + ExtensionUIDialog）各发一个 RPC 连续拉取
    await handler.handleExtensionMessage(msg('extension.getPendingRequests', { sessionId: 's1' }, 'panel-req'), WS)
    await handler.handleExtensionMessage(msg('extension.getPendingRequests', { sessionId: 's1' }, 'dialog-req'), WS)

    // 两次拉取都拿到完整列表（破坏版下第二次会拿到空 → 卡死，这是回归保护点）
    expect(cap.replies).toHaveLength(2)
    expect(cap.replies[0].payload.requests).toHaveLength(2)
    expect(cap.replies[1].payload.requests).toHaveLength(2)
    expect(cap.replies[0].payload.requests).toEqual(sampleRequests)
    expect(cap.replies[1].payload.requests).toEqual(sampleRequests)

    // 非破坏版被调两次（每个消费者各拉一次，都拿到完整列表）
    expect(extensionTimeoutMgr.getPendingRequests).toHaveBeenCalledTimes(2)
    expect(cap.errors).toHaveLength(0)
  })
})
});
// ======================================================================
// ← test/extension-timeout-manager.test.ts
// ======================================================================

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-timeout-manager', () => {
describe('ExtensionTimeoutManager', () => {
  it('registerRequest 登记挂起单表（extension-ui kind 交互式 method：select/confirm/input/editor/ask-user 无超时，block 等待）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select')
    mgr.registerRequest('s1', 'r2', 'confirm', {})
    expect(mgr.sessionRequestCount('s1')).toBe(2)
  })

  it('removeRequest 移除登记（ui_response 应答后调）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select')
    mgr.removeRequest('r1')
    expect(mgr.sessionRequestCount('s1')).toBe(0)
  })

  it('clearForSession 清掉该 session 的全部登记，不影响其他 session 的跟踪', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select')
    mgr.registerRequest('s1', 'r2', 'confirm')
    mgr.registerRequest('s2', 'r3', 'select')

    mgr.clearForSession('s1')

    expect(mgr.sessionRequestCount('s1')).toBe(0) // s1 已清
    expect(mgr.sessionRequestCount('s2')).toBe(1) // s2 跟踪不误伤
  })

  it('clearForSession 对无请求的 session 是 no-op', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(() => mgr.clearForSession('no-such-session')).not.toThrow()
  })

  it('invalidatePendingForSession：entry 摘除并出现在返回清单（payload 解包到顶层形态）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select', { askUser: true })
    mgr.registerRequest('s1', 'r2', 'confirm', {})
    mgr.registerRequest('s2', 'r3', 'select')

    const invalidated = mgr.invalidatePendingForSession('s1')

    // 全部摘除并出现在返回清单
    expect(invalidated.map((r) => r.requestId).sort()).toEqual(['r1', 'r2'])
    const r1 = invalidated.find((r) => r.requestId === 'r1')
    expect(r1?.sessionId).toBe('s1')
    expect(r1?.method).toBe('select')
    expect(r1?.askUser).toBe(true) // payload 解包到顶层
    expect(mgr.sessionRequestCount('s1')).toBe(0)
    expect(mgr.getPendingRequests('s1')).toEqual([])
    // 跨 session 隔离
    expect(mgr.sessionRequestCount('s2')).toBe(1)
  })

  it('invalidatePendingForSession 对无请求 session 返回空数组（非抛错）', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(mgr.invalidatePendingForSession('no-such-session')).toEqual([])
  })

  // B6（memory-leak-remediation §3.2-B6）应答即删：removeRequest 摘单表 entry
  //（挂起登记一体清理——只摘标记不删 entry 会留死条目驻留到 session 销毁）。
  it('B6：removeRequest 一体摘除——entry 归零且跨 session 隔离', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select')
    mgr.registerRequest('s1', 'r2', 'confirm')
    mgr.registerRequest('s2', 'r3', 'select')
    expect(mgr.sessionRequestCount('s1')).toBe(2)

    mgr.removeRequest('r1')
    expect(mgr.sessionRequestCount('s1')).toBe(1)

    mgr.removeRequest('r2')
    expect(mgr.sessionRequestCount('s1')).toBe(0) // entry 归零（A5 验收断言）
    expect(mgr.sessionRequestCount('s2')).toBe(1) // 跨 session 隔离不误伤

    // 幂等：重复摘除 no-op
    expect(() => mgr.removeRequest('r2')).not.toThrow()
    expect(mgr.sessionRequestCount('s1')).toBe(0)
  })

  it('getPendingRequests 非破坏性：多次 peek 不清缓存，payload 解包到顶层', () => {
    const mgr = new ExtensionTimeoutManager()
    // registerRequest 签名：(sessionId, requestId, method, payload?)
    mgr.registerRequest('s1', 'r1', 'select', { title: 'ask', askUser: true, askUserQuestions: [] })
    mgr.registerRequest('s1', 'r2', 'confirm', { title: 'cf', message: 'sure?' })

    const first = mgr.getPendingRequests('s1')
    const second = mgr.getPendingRequests('s1')

    // 两次都拿到完整列表（非破坏）
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    // requestId 集合一致
    const ids = (arr: { requestId: string }[]) => arr.map(r => r.requestId).sort()
    expect(ids(first)).toEqual(ids(second))

    // payload 解包到顶层
    const askReq = first.find(r => r.requestId === 'r1')
    expect(askReq?.title).toBe('ask') // payload.title 解包到顶层
    expect(askReq?.askUser).toBe(true) // payload.askUser 解包到顶层
    expect(askReq?.method).toBe('select')
    expect(typeof askReq?.receivedAt).toBe('number')
  })

  it('getPendingRequests 对未激活/无 pending 的 session 返回空数组（非抛错）', () => {
    const mgr = new ExtensionTimeoutManager()
    expect(mgr.getPendingRequests('never-active')).toEqual([])
  })

  it('removeRequest 后 getPendingRequests 快照收缩（respond 生命周期）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select', { askUser: true })
    mgr.registerRequest('s1', 'r2', 'confirm', {})

    mgr.removeRequest('r1') // 模拟 extension.ui_response 到达，r1 已 respond

    const pending = mgr.getPendingRequests('s1')
    expect(pending).toHaveLength(1)
    expect(pending[0].requestId).toBe('r2')
  })

  it('clearForSession 后 getPendingRequests 返回空数组（session 销毁清理）', () => {
    const mgr = new ExtensionTimeoutManager()
    mgr.registerRequest('s1', 'r1', 'select', { askUser: true })
    mgr.clearForSession('s1')
    expect(mgr.getPendingRequests('s1')).toEqual([])
  })
})
});
});

// ======================================================================
// ← trash-command-injection.test.ts
// ======================================================================

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: () => 'darwin' }
})
const execMock = vi.mocked(execFileSync)


/** 模拟 execFileSync 抛错并携带捕获的 stderr（child_process 真实行为：error.stderr）。 */
function childFailure(message: string, stderr: string): Error {
  const err = new Error(message)
  Object.defineProperty(err, 'stderr', { value: Buffer.from(stderr, 'utf-8') })
  return err
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('trash-command-injection', () => {
describe('RT-8#2: trash 数组参数形态（无 shell 解释面）', () => {
  beforeEach(() => {
    execMock.mockReset().mockReturnValue(Buffer.from(''))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['双引号', '/tmp/evil") && rm -rf ~ #.jsonl'],
    ['命令替换 $()', '/tmp/evil$(touch /tmp/pwned).jsonl'],
    ['空格', '/tmp/my session file.jsonl'],
    ['反引号', '/tmp/evil`touch /tmp/pwned`.jsonl'],
  ])('路径含 %s：trash 收到数组参数，filePath 是唯一元素且原样传入', async (_label, filePath) => {
    await trash(filePath)

    expect(execMock).toHaveBeenCalledTimes(1)
    const [cmd, args] = execMock.mock.calls[0]!
    expect(cmd).toBe('trash')
    // 数组形态 + filePath 作为单一元素原样传入（未被 shell 解释/重排）
    expect(Array.isArray(args)).toBe(true)
    expect(args).toEqual([filePath])
  })

  it('trash 成功即返回，不回落 osascript', async () => {
    await trash('/tmp/normal.jsonl')

    expect(execMock).toHaveBeenCalledTimes(1)
    expect(execMock.mock.calls[0]![0]).toBe('trash')
  })

  it.each([
    ['双引号', '/tmp/evil".jsonl'],
    ['命令替换 $()', '/tmp/evil$(id).jsonl'],
    ['空格', '/tmp/a b.jsonl'],
  ])('trash 失败回落 osascript：路径含 %s 时经 argv 注入、不进 AppleScript 源码', async (_label, filePath) => {
    execMock.mockReset()
    execMock.mockImplementationOnce(() => { throw childFailure('spawn ENOENT', '') })
      .mockReturnValue(Buffer.from(''))

    await trash(filePath)

    expect(execMock).toHaveBeenCalledTimes(2)
    const [fallbackCmd, fallbackArgs] = execMock.mock.calls[1]!
    expect(fallbackCmd).toBe('osascript')
    expect(Array.isArray(fallbackArgs)).toBe(true)
    const [eFlag, script, ...argv] = fallbackArgs as string[]
    // argv 注入形态：-e script + 路径作为独立参数（item 1 of argv），路径绝不拼进 script
    expect(eFlag).toBe('-e')
    expect(script).toContain('on run argv')
    expect(script).not.toContain(filePath)
    expect(argv).toEqual([filePath])
  })

  it('双失败：stderr 内容并入重抛错误消息（不再 2>/dev/null 吞真因），且消息含恢复动作', async () => {
    execMock.mockReset()
    execMock
      .mockImplementationOnce(() => { throw childFailure('trash: not found', '') })
      .mockImplementationOnce(() => {
        throw childFailure('osascript: execution failed', 'Finder got an error: -1728')
      })

    const failure = trash('/tmp/failed.jsonl')
    await expect(failure).rejects.toThrow('移入废纸篓失败')
    await expect(failure).rejects.toThrow('Finder got an error: -1728')
    await expect(failure).rejects.toThrow('文件已保留在原位置')
  })
})
});
