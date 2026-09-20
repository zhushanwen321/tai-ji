// ack 确认轮编排测试（dev-flow u-ack-turn 单元）。
//
// 覆盖范围（任务书 D 节 9 组）：
//   1. 调用序列（sendMessage → message_start 同步 registerProvider → streamSimple 自撤
//      → turn_end 幂等）；2. 武装判别四输入；3. 落盘判据三分支；4. isIdle=false no-op；
//   5. 可用性不可用（toggle-disabled / no-base / 无 model）同步如实通知 + dedup；
//   6. E3 30s 写盘自检（含「ack 轮已启动 ⇒ 不通知」防误报）；7. E6 注销失败重试；
//   8. session 边界（写盘判定 + 全量清理 + 定时器取消）；9. resetAckState 用例间隔离。
//
// 纯 fake pi 注入（不 mock 框架）：假 backend 记录调用序列，假 notify 记录通知。
// 可用性 loader 注入使判据不读真实 models.json；唯一 FS 是 mkdtempSync 临时文件。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ackState,
  ACK_WRITE_CHECK_MS,
  createAckTurnController,
  resetAckState,
  type AckTurnDeps,
} from '../ack-turn.js'
import type { SchedulerBackend } from '../backend.js'
import type { SchedulerEntryLike } from '../replay.js'
import {
  ACK_CUSTOM_TYPE,
  type SchedulerCurrentModel,
  type SchedulerProviderOverride,
} from '../types.js'

// ── 夹具 ──

const MODEL: SchedulerCurrentModel = {
  provider: 'anthropic',
  api: 'anthropic-messages',
  id: 'claude-x',
}

/** 触发器的任务输入（name/scheduleText 用于渲染确认文案）。 */
const TASK = { id: 't1', name: 'backup', scheduleText: 'every 5m' }

/** 不存在的会话文件路径（落盘判据第三分支用真实存在的临时文件对照）。 */
const MISSING_SESSION_FILE = join(tmpdir(), 'sched-ack-nonexistent-dir', 'session.json')

/** streamSimple 实参（工厂忽略实参，仅需类型合法）。 */
const CALL_MODEL: Model<Api> = {
  id: 'call-model',
  name: 'call-model',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
}
const CALL_CONTEXT: Context = { messages: [] }

interface Captured {
  sent: Array<{
    msg: { content: string; customType: string; display: boolean }
    opts?: { deliverAs?: 'steer'; triggerTurn?: boolean }
  }>
  registered: Array<{ providerId: string; config: SchedulerProviderOverride }>
  unregistered: string[]
}

interface HarnessOptions {
  entries?: SchedulerEntryLike[]
  sessionFile?: string | undefined
  idle?: boolean
  unregisterFailures?: number
  builtinIds?: Set<string>
  modelsJsonIds?: Set<string>
}

/** 组装假 backend + 假 notify + controller；默认全可用、无 entries、会话文件不存在。 */
function makeHarness(options: HarnessOptions = {}) {
  const captured: Captured = { sent: [], registered: [], unregistered: [] }
  let unregisterFailures = options.unregisterFailures ?? 0

  const backend: SchedulerBackend = {
    async sendMessage(msg, opts) {
      captured.sent.push({ msg, opts })
    },
    appendEntry() {},
    getSessionFile: () =>
      'sessionFile' in options ? options.sessionFile : MISSING_SESSION_FILE,
    now: () => 1_000,
    registerProvider(providerId, config) {
      captured.registered.push({ providerId, config })
    },
    unregisterProvider(providerId) {
      if (unregisterFailures > 0) {
        unregisterFailures -= 1
        throw new Error('unregister failed')
      }
      captured.unregistered.push(providerId)
    },
    getEntries: () => options.entries ?? [],
    isIdle: () => options.idle ?? true,
    getCurrentModel: () => MODEL,
  }

  const notifyCalls: Array<{ message: string; level: string }> = []
  const warns: string[] = []
  const deps: AckTurnDeps = {
    backend,
    now: () => 1_000,
    log: {
      warn: (msg: string) => warns.push(msg),
      debug: (msg: string) => warns.push(msg),
    },
    render: (key, params) => `${key}|${params.name ?? ''}`,
    notify: (message, level) => notifyCalls.push({ message, level }),
    loadBuiltinProviderIds: async () => options.builtinIds ?? new Set(['anthropic']),
    loadModelsJsonProviderIds: async () => options.modelsJsonIds ?? new Set(),
  }
  const controller = createAckTurnController(deps)
  return { controller, backend, captured, notifyCalls, warns }
}

/** 默认 maybeStartAck 调用（可按需覆盖字段）。 */
async function startAck(
  controller: ReturnType<typeof createAckTurnController>,
  overrides: Partial<{
    model: SchedulerCurrentModel | undefined
    isIdle: boolean
    isToggleDisabled: boolean
  }> = {},
): Promise<void> {
  await controller.maybeStartAck({
    task: TASK,
    model: MODEL,
    isIdle: true,
    isToggleDisabled: false,
    ...overrides,
  })
}

/** 取捕获到的 streamSimple 并调用（触发 onCalled 自撤）；无注册则抛错。 */
function invokeStreamSimple(captured: Captured): void {
  const config = captured.registered[0]?.config
  const streamSimple = config?.streamSimple
  if (!streamSimple) throw new Error('registerProvider 未捕获到 streamSimple')
  streamSimple(CALL_MODEL, CALL_CONTEXT)
}

describe('ack-turn 编排', () => {
  beforeEach(() => {
    resetAckState()
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetAckState()
    vi.useRealTimers()
  })

  // ── 1. 调用序列 ──

  it('序列：sendMessage(triggerTurn) → message_start 同步注册 → streamSimple 同步自撤 → turn_end 幂等', async () => {
    const h = makeHarness()

    await startAck(h.controller)
    expect(h.captured.sent).toHaveLength(1)
    expect(h.captured.sent[0]!.msg.customType).toBe(ACK_CUSTOM_TYPE)
    expect(h.captured.sent[0]!.msg.display).toBe(false)
    expect(h.captured.sent[0]!.opts).toEqual({ triggerTurn: true })
    // 注入触发器时绝不注册覆写（注册只发生在 message_start 命中时）。
    expect(h.captured.registered).toHaveLength(0)

    // 同步性：handleMessageStart 返回时 registerProvider 已被调用。
    h.controller.handleMessageStart({ role: 'custom', customType: ACK_CUSTOM_TYPE, content: 'x' })
    expect(h.captured.registered).toHaveLength(1)
    expect(h.captured.registered[0]!.providerId).toBe('anthropic')
    expect(h.captured.registered[0]!.config.api).toBe('anthropic-messages')
    expect(ackState.window).toEqual({ registered: true })

    // 我们的 streamSimple 被调用 ⇒ 返回 stream 之前同步注销。
    invokeStreamSimple(h.captured)
    expect(h.captured.unregistered).toEqual(['anthropic'])
    expect(ackState.window).toBeNull()

    // turn_end 安全网幂等：window 已空，不再重复注销。
    h.controller.handleTurnEnd()
    expect(h.captured.unregistered).toEqual(['anthropic'])
  })

  // ── 2. 武装判别四输入 ──

  it('武装判别：assistant / 非 custom / 其它 customType 都不注册，仅我们的前缀注册', async () => {
    const h = makeHarness()
    await startAck(h.controller)

    h.controller.handleMessageStart({ role: 'assistant', content: [] })
    h.controller.handleMessageStart({ role: 'user', customType: ACK_CUSTOM_TYPE })
    h.controller.handleMessageStart({ role: 'custom', customType: 'pi-scheduler:dispatched' })
    expect(h.captured.registered).toHaveLength(0)
    // 中间态未被污染：未命中不改 pending / ackTurnStarted。
    expect(ackState.pending).not.toBeNull()
    expect(ackState.ackTurnStarted).toBe(false)

    h.controller.handleMessageStart({ role: 'custom', customType: ACK_CUSTOM_TYPE })
    expect(h.captured.registered).toHaveLength(1)
    expect(ackState.pending).toBeNull()
    expect(ackState.ackTurnStarted).toBe(true)
  })

  // ── 3. 落盘判据 ──

  it('已有 assistant entry ⇒ 跳过（不发 sendMessage）', async () => {
    const entries: SchedulerEntryLike[] = [
      { type: 'custom', customType: 'other' },
      Object.assign({ type: 'message' }, { role: 'assistant' }),
    ]
    const h = makeHarness({ entries })

    await startAck(h.controller)

    expect(h.captured.sent).toHaveLength(0)
    expect(h.captured.registered).toHaveLength(0)
    expect(h.notifyCalls).toHaveLength(0)
  })

  it('getSessionFile() 为 undefined ⇒ 跳过', async () => {
    const h = makeHarness({ sessionFile: undefined })

    await startAck(h.controller)

    expect(h.captured.sent).toHaveLength(0)
    expect(h.notifyCalls).toHaveLength(0)
  })

  it('会话文件已存在 ⇒ 跳过（落盘开关已开）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sched-ack-exists-'))
    try {
      const file = join(dir, 'session.json')
      writeFileSync(file, '')
      const h = makeHarness({ sessionFile: file })

      await startAck(h.controller)

      expect(h.captured.sent).toHaveLength(0)
      expect(h.notifyCalls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  // ── 4. isIdle=false ──

  it('isIdle=false ⇒ 不发 sendMessage / 不注册 / 不通知 / 不武装定时器', async () => {
    const h = makeHarness()

    await startAck(h.controller, { isIdle: false })

    expect(h.captured.sent).toHaveLength(0)
    expect(h.captured.registered).toHaveLength(0)
    expect(h.notifyCalls).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  // ── 5. 可用性不可用 ──

  it('isToggleDisabled=true ⇒ 同步如实通知（warning）+ 不发送 + dedup 只发一次', async () => {
    const h = makeHarness()

    await startAck(h.controller, { isToggleDisabled: true })
    await startAck(h.controller, { isToggleDisabled: true })

    expect(h.notifyCalls).toHaveLength(1)
    expect(h.notifyCalls[0]!.level).toBe('warning')
    expect(h.captured.sent).toHaveLength(0)
    expect(h.captured.registered).toHaveLength(0)
    expect(h.warns.some(msg => msg.includes('ack unavailable'))).toBe(true)
  })

  it('no-base（内置集合空 + models.json 空）⇒ 同步如实通知 + dedup', async () => {
    const h = makeHarness({ builtinIds: new Set(), modelsJsonIds: new Set() })

    await startAck(h.controller)
    await startAck(h.controller)

    expect(h.notifyCalls).toHaveLength(1)
    expect(h.notifyCalls[0]!.level).toBe('warning')
    expect(h.captured.sent).toHaveLength(0)
    expect(h.captured.registered).toHaveLength(0)
  })

  it('model=undefined ⇒ 视为不可用（同步通知 + log.warn，不注册）', async () => {
    const h = makeHarness()

    await startAck(h.controller, { model: undefined })

    expect(h.notifyCalls).toHaveLength(1)
    expect(h.notifyCalls[0]!.level).toBe('warning')
    expect(h.captured.sent).toHaveLength(0)
    expect(h.warns.some(msg => msg.includes('no current model'))).toBe(true)
  })

  // ── 6. E3 30s 写盘自检 ──

  it('30s 自检：未启动 ack 轮且文件不存在 ⇒ 补发通知；ack 轮已启动 ⇒ 不通知（防慢速轮误报）', async () => {
    // 分支 A：maybeStartAck 后不触发 message_start。
    const a = makeHarness()
    await startAck(a.controller)
    expect(a.notifyCalls).toHaveLength(0)
    vi.advanceTimersByTime(ACK_WRITE_CHECK_MS)
    expect(a.notifyCalls).toHaveLength(1)
    expect(a.notifyCalls[0]!.level).toBe('warning')
    expect(ackState.writeCheckTimer).toBeNull()

    resetAckState()

    // 分支 B：ack 轮已启动（message_start 命中）但文件仍未落盘 ⇒ 不通知。
    const b = makeHarness()
    await startAck(b.controller)
    b.controller.handleMessageStart({ role: 'custom', customType: ACK_CUSTOM_TYPE })
    vi.advanceTimersByTime(ACK_WRITE_CHECK_MS)
    expect(b.notifyCalls).toHaveLength(0)
  })

  // ── 7. E6 注销失败重试 ──

  it('E6：首次注销失败保留 window + needsRetry，turn_end 重试成功 ⇒ 清空', async () => {
    const h = makeHarness({ unregisterFailures: 1 })
    await startAck(h.controller)
    h.controller.handleMessageStart({ role: 'custom', customType: ACK_CUSTOM_TYPE })

    invokeStreamSimple(h.captured)
    expect(h.captured.unregistered).toEqual([])
    expect(ackState.window).toEqual({ registered: true })
    expect(ackState.needsRetry).toBe(true)

    h.controller.handleTurnEnd()
    expect(h.captured.unregistered).toEqual(['anthropic'])
    expect(ackState.window).toBeNull()
    expect(ackState.needsRetry).toBe(false)

    // 幂等：再调不再注销。
    h.controller.handleTurnEnd()
    expect(h.captured.unregistered).toEqual(['anthropic'])
  })

  it('E6：两次注销都失败 ⇒ log.warn 且状态保留', async () => {
    const h = makeHarness({ unregisterFailures: 2 })
    await startAck(h.controller)
    h.controller.handleMessageStart({ role: 'custom', customType: ACK_CUSTOM_TYPE })

    invokeStreamSimple(h.captured)
    h.controller.handleTurnEnd()

    expect(h.captured.unregistered).toEqual([])
    expect(ackState.window).toEqual({ registered: true })
    expect(ackState.needsRetry).toBe(true)
    expect(h.warns.filter(msg => msg.includes('ack unregister failed')).length).toBe(2)
  })

  // ── 8. session 边界 ──

  it('handleSessionBoundary：先写盘判定（未落盘发通知）再全量清理并取消定时器', async () => {
    const h = makeHarness()
    await startAck(h.controller)
    expect(vi.getTimerCount()).toBe(1)

    h.controller.handleSessionBoundary()

    // ① 写盘判定：未启动 ack 轮 + 文件不存在 ⇒ 如实通知。
    expect(h.notifyCalls).toHaveLength(1)
    expect(h.notifyCalls[0]!.level).toBe('warning')
    // ② 全量清理。
    expect(ackState.pending).toBeNull()
    expect(ackState.window).toBeNull()
    expect(ackState.ackTurnStarted).toBe(false)
    expect(ackState.taskId).toBeNull()
    // ③ 定时器已取消。
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handleSessionBoundary：从未发起 ack 的会话不发通知（避免新 session 误报）', () => {
    const h = makeHarness()

    h.controller.handleSessionBoundary()

    expect(h.notifyCalls).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
