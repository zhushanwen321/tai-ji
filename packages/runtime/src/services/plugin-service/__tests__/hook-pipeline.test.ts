/**
 * HookPipeline 注入透传单测（git `7a3797d0b` 版 plugin-intercept-injection §3.3-D2/D5、
 * §5-I2，文档已退役于 `fadd8b8b4`）。
 *
 * 覆盖矩阵：
 * - 逐插件形状守卫（D5 行 1/2）：非数组整体丢弃（Array.isArray 在 push 前——字符串
 *   不被 spread 拆条）/ 非 string 条目丢弃，warn 含 pluginId（条目级含序号+形状摘要）
 * - 累积拼接（D2）：多插件合法注入按管线顺序累积，与 transformedData「链上最后一个」
 *   覆盖语义显式分叉
 * - 统一处理序（D2，r3 MF 定案）：校验 → push → block 判定——block×畸形照样 warn、
 *   block×合法注入随 blocked 回包透传、block 前已累积注入保留
 * - 非 onBeforeAgentStart 的 intercept hookType 返回非空注入 → 误用 warn（D5 行 3）
 * - observe 链路不受影响：onPiEvent 走 notifyObservers 零往返，响应 Worker 侧丢弃
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/hook-pipeline.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HookPipeline } from '../hook-pipeline.js'
import type { HookPipelineDeps } from '../hook-pipeline.js'
import type { PluginHost } from '../plugin-host.js'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { HookEntry, HookContext, HookResult, HookType } from '../plugin-types.js'

// ── Helpers ────────────────────────────────────────────────────

const spyConsoleWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

let warnSpy: ReturnType<typeof spyConsoleWarn>

beforeEach(() => {
  warnSpy = spyConsoleWarn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** warn 首参文本聚合（断言日志内容用） */
function warnTexts(): string {
  return warnSpy.mock.calls.map((call) => String(call[0])).join('\n')
}

function makeContext(hookType: HookType, data: unknown = {}): HookContext {
  return { pluginId: '', hookType, data, timestamp: Date.now() }
}

/**
 * 构造 deps 全 mock 的 HookPipeline：entries 按注册序（priority 保序在注册侧，D2-5），
 * responses 按 invoke 调用序出队（耗尽后默认放行 {proceed:true}）。
 */
function setup(
  hookType: HookType,
  entries: HookEntry[],
  responses: Array<Record<string, unknown>>,
): { pipeline: HookPipeline; deps: HookPipelineDeps } {
  const hookRegistry = new Map<string, HookEntry[]>([[hookType, entries]])
  const host = {
    getWorkerHandle: vi.fn().mockReturnValue({ workerId: 'worker-1', postMessage: vi.fn() }),
  }
  const rpcServer = {
    invoke: vi.fn(),
    notify: vi.fn(),
  }
  rpcServer.invoke.mockImplementation(async () => responses.shift() ?? { proceed: true })
  const deps = {
    hookRegistry,
    host: host as unknown as PluginHost,
    rpcServer: rpcServer as unknown as PluginRpcServer,
  }
  return { pipeline: new HookPipeline(deps), deps }
}

const entry = (pluginId: string, handlerId: string, priority: number): HookEntry => ({
  pluginId,
  handlerId,
  priority,
})

// ══════════════════════════════════════════════════════════════════
// 形状守卫（D5 行 1/2：消费 hookType = onBeforeAgentStart）
// ══════════════════════════════════════════════════════════════════

describe('HookPipeline.execute — injectedMessages 形状守卫', () => {
  it('TC-I2-01: 合法注入 → HookResult.injectedMessages 透传，无 warn', async () => {
    const { pipeline } = setup('onBeforeAgentStart', [entry('p1', 'h1', 100)], [
      { proceed: true, injectedMessages: ['a'] },
    ])

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    expect(result).toEqual({ blocked: false, injectedMessages: ['a'] })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('TC-I2-02: 非数组（字符串值）整体丢弃 + warn 含 pluginId；字符串不被 spread 拆条', async () => {
    const { pipeline } = setup('onBeforeAgentStart', [entry('p-bad', 'h1', 100)], [
      { proceed: true, injectedMessages: 'abc' as never },
    ])

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    // 严格相等：既无 injectedMessages 键（空数组等价无注入），也未被 spread 拆成
    // ['a','b','c']（D5 行 1 的 Array.isArray 在 push 前定案）
    expect(result).toEqual({ blocked: false })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnTexts()).toContain('p-bad')
    expect(warnTexts()).toContain('expected array')
  })

  it('TC-I2-03: 混合条目 → 非法条目丢弃 + warn（含 pluginId+序号），合法条目照常累积', async () => {
    const { pipeline } = setup('onBeforeAgentStart', [entry('p-mixed', 'h1', 100)], [
      { proceed: true, injectedMessages: ['good', 42 as never, { x: 1 } as never, 'kept'] },
    ])

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    expect(result).toEqual({ blocked: false, injectedMessages: ['good', 'kept'] })
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnTexts()).toContain('p-mixed')
    expect(warnTexts()).toContain('entry 1')
    expect(warnTexts()).toContain('entry 2')
  })

  it('TC-I2-04: 空数组 → 等价无注入（无 injectedMessages 键），无日志（D5「空数组」格）', async () => {
    const { pipeline } = setup('onBeforeAgentStart', [entry('p1', 'h1', 100)], [
      { proceed: true, injectedMessages: [] },
    ])

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    expect(result).toEqual({ blocked: false })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('TC-I2-05: 全部条目非法 → 等价无注入 + 逐条 warn', async () => {
    const { pipeline } = setup('onBeforeAgentStart', [entry('p-all-bad', 'h1', 100)], [
      { proceed: true, injectedMessages: [42 as never, { x: 1 } as never] },
    ])

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    expect(result).toEqual({ blocked: false })
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnTexts()).toContain('p-all-bad')
  })

  it('TC-I2-06: null 注入值 → 按非数组整体丢弃 + warn（设计行 1 字面语义）', async () => {
    const { pipeline } = setup('onBeforeAgentStart', [entry('p-null', 'h1', 100)], [
      { proceed: true, injectedMessages: null as never },
    ])

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    expect(result).toEqual({ blocked: false })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnTexts()).toContain('p-null')
    expect(warnTexts()).toContain('expected array')
  })
})

// ══════════════════════════════════════════════════════════════════
// 统一处理序：校验 → push → block 判定（D2 r3 MF 定案）
// ══════════════════════════════════════════════════════════════════

describe('HookPipeline.execute — 校验先于 block 判定', () => {
  it('TC-I2-07: block×畸形注入 → 畸形照样 warn + 丢弃，block 决策照常生效', async () => {
    const { pipeline } = setup('onBeforeAgentStart', [entry('p-block-bad', 'h1', 100)], [
      { proceed: false, reason: 'policy', injectedMessages: 'malformed' as never },
    ])

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    // 校验先于 block 判定：warn 已发生（G3 无组合限定）；blocked 回包无注入键
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnTexts()).toContain('p-block-bad')
    expect(result).toEqual({ blocked: true, reason: 'policy', blockedBy: 'p-block-bad' })
  })

  it('TC-I2-08: block×合法注入 → 注入进已累积并随 blocked 回包透传（阻止与留言互不吞没）', async () => {
    const { pipeline } = setup('onBeforeAgentStart', [entry('p-block-inject', 'h1', 100)], [
      { proceed: false, reason: 'need-context', injectedMessages: ['msg-b'] },
    ])

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    expect(result).toEqual({
      blocked: true,
      reason: 'need-context',
      blockedBy: 'p-block-inject',
      injectedMessages: ['msg-b'],
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('TC-I2-09: block 终止链 → block 前已累积注入保留（含跨插件），后续插件不执行', async () => {
    const { pipeline, deps } = setup(
      'onBeforeAgentStart',
      [entry('p-a', 'h-a', 100), entry('p-b', 'h-b', 200), entry('p-c', 'h-c', 300)],
      [
        { proceed: true, injectedMessages: ['a1'] },
        { proceed: false, reason: 'stop' },
        { proceed: true, injectedMessages: ['c1'] },
      ],
    )

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    expect(result).toEqual({
      blocked: true,
      reason: 'stop',
      blockedBy: 'p-b',
      injectedMessages: ['a1'], // 已累积保留（W4① 的单测格）
    })
    expect(deps.rpcServer.invoke).toHaveBeenCalledTimes(2) // p-c 未执行
  })
})

// ══════════════════════════════════════════════════════════════════
// 累积拼接 vs transformedData 覆盖（D2 语义分叉）
// ══════════════════════════════════════════════════════════════════

describe('HookPipeline.execute — 累积拼接与覆盖语义分叉', () => {
  it('TC-I2-10: 多插件注入按管线顺序累积，不被后续插件整体覆盖', async () => {
    const { pipeline } = setup(
      'onBeforeAgentStart',
      [entry('p-first', 'h1', 100), entry('p-second', 'h2', 200)],
      [
        { proceed: true, injectedMessages: ['a1', 'a2'] },
        { proceed: true, injectedMessages: ['b1'] },
      ],
    )

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    // 若误用「链上最后一个」覆盖语义，这里只会剩 ['b1']
    expect(result).toEqual({ blocked: false, injectedMessages: ['a1', 'a2', 'b1'] })
  })

  it('TC-I2-11: 同一插件/同链上 injectedMessages 累积 × transformedData 覆盖并存（语义分叉）', async () => {
    const { pipeline } = setup(
      'onBeforeAgentStart',
      [entry('p-x', 'h1', 100), entry('p-y', 'h2', 200)],
      [
        { proceed: true, injectedMessages: ['a'], modifiedData: 'X' },
        { proceed: true, injectedMessages: ['b'], modifiedData: 'Y' },
      ],
    )

    const result = await pipeline.execute('onBeforeAgentStart', makeContext('onBeforeAgentStart'))

    // 注入累积（['a','b']）与改写覆盖（链上最后一个 'Y'）在同一回包中各自成立
    expect(result).toEqual({
      blocked: false,
      injectedMessages: ['a', 'b'],
      transformedData: 'Y',
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// D1 契约边界：非消费 intercept hookType 误用（D5 行 3）
// ══════════════════════════════════════════════════════════════════

describe('HookPipeline.execute — 非消费 hookType 误用 warn', () => {
  it('TC-I2-12: onBeforeToolCall 返回非空注入 → 误用整体忽略 + warn 含 hookType 与 pluginId', async () => {
    const { pipeline } = setup('onBeforeToolCall', [entry('p-misuse', 'h1', 100)], [
      { proceed: true, injectedMessages: ['should-not-inject'] },
    ])

    const result = await pipeline.execute('onBeforeToolCall', makeContext('onBeforeToolCall'))

    // 误用整体忽略：回包无注入键（D5 行 3 不做形状校验，仅单条 warn）
    expect(result).toEqual({ blocked: false })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnTexts()).toContain('p-misuse')
    expect(warnTexts()).toContain('onBeforeToolCall')
  })

  it('TC-I2-13: 误用 hookType 返回空数组 → 等价无注入，无 warn（非空才 warn）', async () => {
    const { pipeline } = setup('onBeforeToolCall', [entry('p1', 'h1', 100)], [
      { proceed: true, injectedMessages: [] },
    ])

    const result = await pipeline.execute('onBeforeToolCall', makeContext('onBeforeToolCall'))

    expect(result).toEqual({ blocked: false })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('TC-I2-14: 无注入返回的既有回包形状不变（G4 不倒退：无 injectedMessages 键）', async () => {
    const { pipeline } = setup('onBeforeSendMessage', [entry('p1', 'h1', 100)], [
      { proceed: true, modifiedData: 'MODIFIED' },
    ])

    const result: HookResult = await pipeline.execute('onBeforeSendMessage', makeContext('onBeforeSendMessage'))

    expect(result).toEqual({ blocked: false, transformedData: 'MODIFIED' })
    expect('injectedMessages' in result).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════
// observe 链路不受影响（设计 D5 行 3 范围限定：observe 响应 Worker 侧丢弃）
// ══════════════════════════════════════════════════════════════════

describe('HookPipeline — observe 链路不受注入透传影响', () => {
  it('TC-I2-15: notifyObservers 保持零往返派发，不经 invoke / 注入逻辑', () => {
    const { pipeline, deps } = setup('onPiEvent', [entry('p-obs', 'h-obs', 100)], [])

    pipeline.notifyObservers('onPiEvent', makeContext('onPiEvent', { eventName: 'agent_start' }))

    expect(deps.rpcServer.notify).toHaveBeenCalledTimes(1)
    expect(deps.rpcServer.notify).toHaveBeenCalledWith(
      'worker-1',
      'plugin.hooks.invoke',
      expect.objectContaining({ handlerId: 'h-obs', hookType: 'onPiEvent' }),
    )
    expect(deps.rpcServer.invoke).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
