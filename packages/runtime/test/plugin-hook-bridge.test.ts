import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventAdapter, type WsSender, type EventAdapterOptions } from './helpers/event-adapter-test-fixture.js'
import { PluginService } from '../src/services/plugin-service/plugin-service.js'
import type { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'
import type { HookResult, HookContext } from '../src/services/plugin-service/plugin-types.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiMessage } from '../src/infra/pi/rpc-client.js'

/**
 * FR-8 Hook Bridge tests.
 *
 * Covers:
 * 1. EventAdapter onHookExecute callback — blocked, transformedData, passthrough
 * 2. PluginService registerSendMessageHook — blocked returns { blocked, reason }, passthrough returns null
 */

type PiTestEvent = PiMessage & Record<string, unknown>

function piEvent(fields: PiTestEvent): PiTestEvent {
  return fields
}

// ── EventAdapter onHookExecute ────────────────────────────────

// 模块级测试 configDir：PluginService 的 configDir 缺省回退 process.cwd()（仅供单测的
// 兜底），不注入会在包目录 mkdirSync plugins 目录——vitest fs-guard 白名单外被拦。
const TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'plugin-hook-bridge-cfg-'))


describe('EventAdapter: onHookExecute callback', () => {
  let sent: ServerMessage[]
  let send: WsSender

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  it('calls onHookExecute with correct hookType and context for tool_execution_start', async () => {
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-1', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-100',
          toolName: 'read_file',
          args: { path: '/tmp/a.txt' },
        }))
        return () => {}
      },
    })

    // Wait for async handleEvent
    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled())

    expect(hookFn).toHaveBeenCalledWith('onBeforeToolCall', {
      toolName: 'read_file',
      input: { path: '/tmp/a.txt' },
    })
  })

  it('calls onHookExecute for tool_execution_end with onAfterToolResult', async () => {
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-2', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_end',
          toolCallId: 'tc-200',
          result: 'file contents here',
          isError: false,
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled())

    expect(hookFn).toHaveBeenCalledWith('onAfterToolResult', {
      toolCallId: 'tc-200',
      output: 'file contents here',
    })
  })

  it('blocks event when hookResult.blocked === true', async () => {
    const hookFn = vi.fn().mockResolvedValue({
      blocked: true,
      reason: 'Plugin blocked this tool',
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-3', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-blocked',
          toolName: 'dangerous_tool',
          args: {},
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(hookFn).toHaveBeenCalled())

    // Event is blocked — no message forwarded to frontend
    expect(sent).toHaveLength(0)
  })

  it('replaces input with transformedData when hook returns it', async () => {
    const transformedInput = { path: '/safe/path.txt', sanitized: true }
    const hookFn = vi.fn().mockResolvedValue({
      blocked: false,
      transformedData: transformedInput,
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-4', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-transform',
          toolName: 'write_file',
          args: { path: '/unsafe/path.txt' },
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(sent[0].type).toBe('message.tool_call_start')
    // [w21] hook 改写同步回 entry.arguments（payload 换 entry 形态）
    const payload = sent[0].payload as { entry: { arguments?: unknown } }
    expect(payload.entry.arguments).toEqual(transformedInput)
  })

  it('replaces output with transformedData for tool_execution_end', async () => {
    const hookFn = vi.fn().mockResolvedValue({
      blocked: false,
      transformedData: 'REDACTED OUTPUT',
    }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-5', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_end',
          toolCallId: 'tc-trans-end',
          result: 'sensitive data',
          isError: false,
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(sent[0].type).toBe('message.tool_call_end')
    // [w21] hook 改写同步回 entry.message.content（text block 数组，pi 持久化形态）
    const payload = sent[0].payload as { entry: { message: { content?: unknown } } }
    expect(payload.entry.message.content).toEqual([{ type: 'text', text: 'REDACTED OUTPUT' }])
  })

  // ── type-safety 守卫（interpreter handleToolCallStart / handleToolCallEnd 靶子）──
  // hook 是第三方插件代码（不可信源）：畸形 transformedData 不得以谎报类型进 wire 帧 /
  // 持久化 entry 契约（arguments/content text block）。守卫在「裸赋值透传」形态下会红。

  it('guards: onBeforeToolCall 返回非对象 transformedData → 丢弃改写保原始 input（不透传进 entry.arguments）', async () => {
    for (const bad of ['string-rewrite', 42, ['array']]) {
      sent = []
      const hookFn = vi.fn().mockResolvedValue({ blocked: false, transformedData: bad }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
      const adapter = createEventAdapter('sess-guard-in', send, { onHookExecute: hookFn })
      const original = { path: '/original.txt' }

      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({ type: 'tool_execution_start', toolCallId: 'tc-g1', toolName: 'write_file', args: original }))
          return () => {}
        },
      })
      await vi.waitFor(() => expect(sent).toHaveLength(1))

      const payload = sent[0].payload as { entry: { arguments?: unknown } }
      expect(payload.entry.arguments).toEqual(original) // 原始 input 保留
    }
  })

  it('guards: onAfterToolResult 返回非字符串 transformedData → 丢弃改写保原始 output（content 契约 string）', async () => {
    for (const bad of [{ obj: 1 }, ['array'], 7]) {
      sent = []
      const hookFn = vi.fn().mockResolvedValue({ blocked: false, transformedData: bad }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
      const adapter = createEventAdapter('sess-guard-out', send, { onHookExecute: hookFn })

      adapter.attach({
        onEvent: (listener) => {
          listener(piEvent({ type: 'tool_execution_end', toolCallId: 'tc-g2', result: 'original output', isError: false }))
          return () => {}
        },
      })
      await vi.waitFor(() => expect(sent).toHaveLength(1))

      const payload = sent[0].payload as { entry: { message: { content?: unknown } } }
      expect(payload.entry.message.content).toEqual([{ type: 'text', text: 'original output' }]) // 原始 output 保留
    }
  })

  it('guards: pi 契约外畸形 args（string）→ entry.arguments 归一 {}（wire 帧不携带谎报类型）', async () => {
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
    const adapter = createEventAdapter('sess-guard-args', send, { onHookExecute: hookFn })

    adapter.attach({
      onEvent: (listener) => {
        // pi 契约 args 恒为对象（ADR-0037）——畸形 string 经 isPlainRecord 守卫归一 {}
        listener(piEvent({ type: 'tool_execution_start', toolCallId: 'tc-g3', toolName: 'bash', args: 'not-an-object' }))
        return () => {}
      },
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    const payload = sent[0].payload as { entry: { arguments?: unknown } }
    expect(payload.entry.arguments).toEqual({})
  })

  it('锚点补挂：toolcall_end 先到 → tool_call_start 帧的 entry 携带 contentIndex + messageId', async () => {
    // toolcall_end（顺序锚点，contentIndex=1）先于 tool_execution_start 到达——
    // interpreter 从缓存补进 entry（§11 检查点 3：contentBlocks 有序插入依据）
    const hookFn = vi.fn().mockResolvedValue({ blocked: false }) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
    const adapter = createEventAdapter('sess-anchor', send, { onHookExecute: hookFn })

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'message_start',
          message: undefined, // assistant turn 开始（无 role）→ turn-start 产 messageId
        }))
        listener(piEvent({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'toolcall_end',
            contentIndex: 1,
            toolCall: { type: 'toolCall', id: 'tc-anchor', name: 'bash', arguments: {} },
          },
        }))
        listener(piEvent({ type: 'tool_execution_start', toolCallId: 'tc-anchor', toolName: 'bash', args: {} }))
        return () => {}
      },
    })
    await vi.waitFor(() => {
      const start = sent.find((m) => m.type === 'message.tool_call_start')
      expect(start).toBeDefined()
    })

    const start = sent.find((m) => m.type === 'message.tool_call_start')!
    const payload = start.payload as { entry: { contentIndex?: number; messageId?: string } }
    expect(payload.entry.contentIndex).toBe(1)
    expect(payload.entry.messageId).toMatch(/^a-/)
  })

  it('forwards event normally when onHookExecute is undefined', async () => {
    const adapter = createEventAdapter('sess-6', send) // no options

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-no-hook',
          toolName: 'read_file',
          args: { path: '/tmp/x' },
        }))
        return () => {}
      },
    })

    // handleEvent is async even without hook — wait for it
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].type).toBe('message.tool_call_start')
    expect((sent[0].payload as { entry: { toolName?: string } }).entry.toolName).toBe('read_file')
  })

  it('proceeds with original data when hook throws', async () => {
    const hookFn = vi.fn().mockRejectedValue(new Error('hook crash')) as unknown as (hookType: string, context: Record<string, unknown>) => Promise<HookResult>

    const options: EventAdapterOptions = { onHookExecute: hookFn }
    const adapter = createEventAdapter('sess-7', send, options)

    adapter.attach({
      onEvent: (listener) => {
        listener(piEvent({
          type: 'tool_execution_start',
          toolCallId: 'tc-err',
          toolName: 'read_file',
          args: { path: '/tmp/y' },
        }))
        return () => {}
      },
    })

    await vi.waitFor(() => expect(sent).toHaveLength(1))

    // Hook error → proceed with original data
    expect(sent[0].type).toBe('message.tool_call_start')
    const payload = sent[0].payload as { entry: { arguments?: unknown } }
    expect(payload.entry.arguments).toEqual({ path: '/tmp/y' })
  })
})

// ── PluginService registerSendMessageHook ──────────────────────

describe('PluginService: registerSendMessageHook', () => {
  /** Minimal mock to construct PluginService without touching fs/workers */
  function createMocks() {
    const registry = {
      getAllDescriptors: vi.fn().mockReturnValue([]),
      scan: vi.fn().mockResolvedValue([]),
    } as unknown as PluginRegistry

    const broker = { broadcast: vi.fn() }
    const setSendMessageHook = vi.fn()
    const sessionService = {
      setSendMessageHook,
      listPersistedSessions: vi.fn().mockReturnValue([]),
      getSummary: vi.fn().mockReturnValue(undefined),
      sendMessage: vi.fn(),
      // S3-W2：session 生命周期事件接线（registerSendMessageHook 内挂）
      setOnSessionCreated: vi.fn(),
      setOnSessionDestroyed: vi.fn(),
    }

    return { registry, broker, sessionService, setSendMessageHook }
  }

  it('registers setSendMessageHook during initialize()', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    await service.initialize()

    expect(setSendMessageHook).toHaveBeenCalledTimes(1)
    expect(setSendMessageHook).toHaveBeenCalledWith(expect.any(Function))

    await service.shutdown()
  })

  it('hook returns { blocked: true, reason } when executeHooks blocks', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    // Mock executeHooks to return blocked
    const executeHooksSpy = vi.spyOn(service, 'executeHooks').mockResolvedValue({
      blocked: true,
      reason: 'Content policy violation',
      blockedBy: 'plugin-safety',
    })

    await service.initialize()

    // Extract the hook function that was registered
    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string } | null>

    const result = await hookFn('sess-1', 'some dangerous content')

    expect(executeHooksSpy).toHaveBeenCalledWith(
      'onBeforeSendMessage',
      expect.objectContaining({
        sessionId: 'sess-1',
        content: 'some dangerous content',
        hookType: 'onBeforeSendMessage',
      }),
    )

    expect(result).toEqual({ blocked: true, reason: 'Content policy violation' })

    await service.shutdown()
  })

  it('hook returns null when executeHooks does not block', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    // Mock executeHooks to return not blocked
    vi.spyOn(service, 'executeHooks').mockResolvedValue({ blocked: false })

    await service.initialize()

    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string } | null>

    const result = await hookFn('sess-2', 'normal message')

    expect(result).toBeNull()

    await service.shutdown()
  })

  // Fix-1：transform 语义透传——executeHooks 返回 transformedData（D2-3 映射层产出的
  // Worker modifiedData）时，hook 以 modifiedContent 出口交给 message-dispatcher 消费
  it('hook returns modifiedContent when executeHooks yields transformedData {content}', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    vi.spyOn(service, 'executeHooks').mockResolvedValue({
      blocked: false,
      transformedData: { content: 'hello IMPORTANT world' },
    })

    await service.initialize()

    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null>

    const result = await hookFn('sess-3', 'hello !important world')

    expect(result).toEqual({ blocked: false, modifiedContent: 'hello IMPORTANT world' })

    await service.shutdown()
  })

  it('hook ignores transformedData whose content is not a string', async () => {
    const { registry, broker, sessionService, setSendMessageHook } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      { sessionService: sessionService as never, configDir: TEST_CONFIG_DIR },
    )

    vi.spyOn(service, 'executeHooks').mockResolvedValue({
      blocked: false,
      transformedData: { content: { nested: true } },
    })

    await service.initialize()

    const hookFn = setSendMessageHook.mock.calls[0][0] as (
      sessionId: string,
      content: string,
    ) => Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null>

    const result = await hookFn('sess-4', 'plain')

    // 非字符串 content 不构成改写，按「无 hook 结果」透传（不猜形状）
    expect(result).toBeNull()

    await service.shutdown()
  })

  it('does not register hook when sessionService is absent', async () => {
    const { registry, broker } = createMocks()

    const service = new PluginService(
      registry as PluginRegistry,
      broker as never,
      // No sessionService（configDir 注入 tmp，防包目录 mkdir plugins——fs-guard）
      { configDir: TEST_CONFIG_DIR },
    )

    await service.initialize()

    // setSendMessageHook was never called (no sessionService)
    expect(broker.broadcast).toHaveBeenCalled() // initialize still broadcasts plugin list

    await service.shutdown()
  })
})
