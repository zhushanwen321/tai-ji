/**
 * W4 tool/hook 统一（FR8 tool/hook 列项）——测试
 *
 * 覆盖：
 * - TC-w4-1: PI_HOOK_EVENT_MAP 条目完整且合法（10 个 pi 事件全覆盖、hookType 合法、
 *   kind 合法、before_agent_start 保持 intercept + onBeforeAgentStart）
 * - TC-w4-2: handleBridgeIntercept 按映射表判定 intercept/observe/未知（翻译后 hookType
 *   传递、observe 不 block、未知事件返回空响应 ERR2）
 * - TC-w4-3: bridge:tool_execute 是唯一 tool 执行入口（静态断言：业务代码无直连
 *   worker plugin.tool.execute 调用）
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PI_HOOK_EVENT_MAP, handleBridgeIntercept } from '../src/services/plugin-service/bridge-interop.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { IMessageBroker } from '../src/interfaces.js'
import type { HookResult } from '../src/services/plugin-service/plugin-types.js'

function createMockBroker(): IMessageBroker {
  return {
    send: vi.fn(),
    broadcast: vi.fn(),
    sendError: vi.fn(),
  }
}

// ── 常量：pi 侧 bridge extension 转发的事件全集（extensions/taiji/plugin-bridge/src/index.ts 的 pi.on 注册段，select+BRIDGE_MARKER 通道） ──

const PI_BRIDGE_EVENTS = [
  'agent_start',
  'agent_end',
  'tool_call',
  'tool_result',
  'turn_end',
  'message_end',
  'session_start',
  'session_compact',
  'session_tree',
  'before_agent_start',
]

/** 合法 HookType 全集（plugin-types/hook-types.ts：InterceptorHookType + ObserverHookType；Fix-6 删除三个死字面量后 ObserverHookType 仅剩 onPiEvent） */
const VALID_HOOK_TYPES = new Set([
  'onToolCall',
  'onSlashCommand',
  'onMessageSend',
  'onBeforeSendMessage',
  'onBeforeToolCall',
  'onBeforeAgentStart',
  'onAfterToolResult',
  'onPiEvent',
])

// ══════════════════════════════════════════════════════════════════
// TC-w4-1: PI_HOOK_EVENT_MAP 条目完整且合法
// ══════════════════════════════════════════════════════════════════

describe('PI_HOOK_EVENT_MAP', () => {
  it('TC-w4-1a: 覆盖 pi bridge 转发的全部 10 个事件', () => {
    for (const evt of PI_BRIDGE_EVENTS) {
      expect(PI_HOOK_EVENT_MAP[evt], `missing mapping for ${evt}`).toBeDefined()
    }
  })

  it('TC-w4-1b: 每个条目 hookType 是合法 HookType、kind 是合法枚举', () => {
    for (const [eventName, entry] of Object.entries(PI_HOOK_EVENT_MAP)) {
      expect(VALID_HOOK_TYPES.has(entry.hookType), `${eventName} hookType ${entry.hookType} 非法`).toBe(true)
      expect(['intercept', 'observe']).toContain(entry.kind)
    }
  })

  it('TC-w4-1c: before_agent_start 保持 intercept + onBeforeAgentStart', () => {
    expect(PI_HOOK_EVENT_MAP['before_agent_start']).toEqual({ hookType: 'onBeforeAgentStart', kind: 'intercept' })
  })

  it('TC-w4-1d: 观察型事件（tool_call/agent_start 等）kind=observe 且不拦截', () => {
    expect(PI_HOOK_EVENT_MAP['tool_call'].kind).toBe('observe')
    expect(PI_HOOK_EVENT_MAP['agent_start'].kind).toBe('observe')
    expect(PI_HOOK_EVENT_MAP['turn_end'].kind).toBe('observe')
  })

  it('TC-w4-1e: observe 组 7 事件挂泛型 onPiEvent（R-01），tool 两项保持 onAfterToolResult（D2-2 分流）', () => {
    // observe 组走 notify（零往返），唯一可注册 observe 通道是泛型 onPiEvent
    for (const evt of ['agent_start', 'agent_end', 'message_end', 'turn_end', 'session_start', 'session_compact', 'session_tree']) {
      expect(PI_HOOK_EVENT_MAP[evt].hookType, `${evt} 应挂泛型 onPiEvent`).toBe('onPiEvent')
    }
    // tool_call/tool_result 保持 request 腿（transform 语义需同步回传）
    expect(PI_HOOK_EVENT_MAP['tool_call'].hookType).toBe('onAfterToolResult')
    expect(PI_HOOK_EVENT_MAP['tool_result'].hookType).toBe('onAfterToolResult')
  })
})

// ══════════════════════════════════════════════════════════════════
// TC-w4-2: handleBridgeIntercept 按映射表判定 intercept/observe/未知
// ══════════════════════════════════════════════════════════════════

describe('handleBridgeIntercept 按 PI_HOOK_EVENT_MAP 判定', () => {
  it('TC-w4-2a: intercept 型事件（before_agent_start）调 executeHooks 且传翻译后 hookType', async () => {
    const executeHooks = vi.fn().mockResolvedValue({ blocked: false })
    const result = await handleBridgeIntercept('before_agent_start', { query: 'hello' }, 'session-1', executeHooks)
    expect(executeHooks).toHaveBeenCalledTimes(1)
    // 翻译后 hookType 必须传给 executeHooks（snake_case 事件名 → camelCase HookType，
    // 否则 hookRegistry 按 camelCase 注册的 handler 匹配不上）
    expect(executeHooks.mock.calls[0][0]).toBe('onBeforeAgentStart')
    expect(result).toEqual({ injectedMessages: [] })
  })

  it('TC-w4-2b: intercept 型事件 blocked 时返回 { blocked, reason }', async () => {
    const executeHooks = vi.fn().mockResolvedValue({ blocked: true, blockedBy: 'p1', reason: 'denied by policy' })
    const result = await handleBridgeIntercept('before_agent_start', { query: 'hello' }, 'session-1', executeHooks)
    expect(result).toEqual({ blocked: true, reason: 'denied by policy', injectedMessages: [] })
  })

  it('TC-w4-2c: 未知事件返回空响应且不调 executeHooks（ERR2）', async () => {
    const executeHooks = vi.fn()
    const result = await handleBridgeIntercept('unknown_event', {}, 'session-1', executeHooks)
    expect(result).toEqual({ injectedMessages: [] })
    expect(executeHooks).not.toHaveBeenCalled()
  })

  it('TC-w4-2d: PluginService.handleBridgeIntercept 对 observe 型事件走观察链路不 block', async () => {
    const service = new PluginService({} as never, createMockBroker())
    // agent_start 是 observe 型：应返回空响应（不 block），且不触发拦截语义
    const result = await service.handleBridgeIntercept('agent_start', {}, 'session-1')
    expect(result).toEqual({ injectedMessages: [] })
    // before_agent_start 是 intercept 型：无注册 handler 时也不抛错、返回空响应
    const result2 = await service.handleBridgeIntercept('before_agent_start', {}, 'session-1')
    expect(result2).toEqual({ injectedMessages: [] })
  })

  it('TC-w4-2e: PluginService.handleBridgeIntercept 对未知事件返回空响应（ERR2）', async () => {
    const service = new PluginService({} as never, createMockBroker())
    const result = await service.handleBridgeIntercept('unknown_event', {}, 'session-1')
    expect(result).toEqual({ injectedMessages: [] })
  })
})

// ══════════════════════════════════════════════════════════════════
// TC-w4-3: bridge:tool_execute 是唯一 tool 执行入口（静态断言）
// ══════════════════════════════════════════════════════════════════

describe('bridge:tool_execute 唯一 tool 执行入口', () => {
  const srcRoot = resolve(fileURLToPath(new URL('../src', import.meta.url)))

  function listTsFiles(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) out.push(...listTsFiles(full))
      else if (name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('TC-w4-3a: bridge-handler.ts 的 bridge:tool_execute case 经 sendBridgeToolExecute 委托 handleBridgeToolExecute（U07 case 体提取后形态）', () => {
    const content = readFileSync(join(srcRoot, 'transport/bridge-handler.ts'), 'utf-8')
    const caseBlock = content.slice(content.indexOf("case 'bridge:tool_execute'"), content.indexOf("case 'bridge:event'"))
    // 路由层经 sendBridgeToolExecute 私有方法委托（提取后 case 块仅保留委托调用）
    expect(caseBlock).toContain('sendBridgeToolExecute')
    // 委托目标仍是 plugin-service.handleBridgeToolExecute（唯一 tool 执行入口意图不变）
    expect(content).toContain('this.pluginService?.handleBridgeToolExecute')
    // 路由层不得直连 RPC 服务器（invoke 只在 service/adaptor 层）
    expect(caseBlock).not.toContain('rpcServer.invoke')
    expect(caseBlock).not.toContain('plugin.tool.execute')
  })

  it('TC-w4-3b: plugin-service.handleBridgeToolExecute 委托 bridge-interop（适配层唯一 invoke 点）', () => {
    const serviceContent = readFileSync(join(srcRoot, 'services/plugin-service/plugin-service.ts'), 'utf-8')
    const interopContent = readFileSync(join(srcRoot, 'services/plugin-service/bridge-interop.ts'), 'utf-8')
    // 域层委托适配器，不含 invoke 调用
    const methodBlock = serviceContent.slice(serviceContent.indexOf('handleBridgeToolExecute('), serviceContent.indexOf('handleBridgeEvent('))
    expect(methodBlock).toContain('handleBridgeToolExecute(request')
    expect(methodBlock).not.toContain('rpcServer.invoke')
    // 适配器持有唯一 invoke 发送点
    expect(interopContent).toContain("'plugin.tool.execute'")
  })

  it('TC-w4-3c: 业务代码无直连 worker plugin.tool.execute 调用（豁免：适配器/Worker 注册/注释）', () => {
    // 豁免文件：bridge-interop.ts（适配层唯一 invoke 发送点）、plugin-bootstrap.ts（Worker
    // 侧方法注册分发）、plugin-rpc-server.ts（注释描述 invoke 能力）
    const allowlist = [
      'bridge-interop.ts',
      'plugin-bootstrap.ts',
      'plugin-rpc-server.ts',
    ]
    const offenders: string[] = []
    for (const file of listTsFiles(srcRoot)) {
      const base = file.split('/').pop() ?? ''
      if (allowlist.includes(base)) continue
      const content = readFileSync(file, 'utf-8')
      if (content.includes('plugin.tool.execute')) {
        offenders.push(file.replace(srcRoot + '/', ''))
      }
    }
    expect(offenders).toEqual([])
  })
})

// ── 类型守卫：映射表 hookType 字段确实是 HookType（编译期验证） ──
// （运行期合法集合已由 TC-w4-1b 断言；此处仅确保类型连通）
const _typeCheck: Record<string, { hookType: import('../src/services/plugin-service/plugin-types.js').HookType; kind: 'intercept' | 'observe' }> = PI_HOOK_EVENT_MAP
void _typeCheck

// 防未使用告警（HookResult 类型在类型守卫中未直接使用）
export type { HookResult }
