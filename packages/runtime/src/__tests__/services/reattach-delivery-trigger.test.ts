/**
 * reattach 投递对账触发测试（u4 追加项；A5/V5 缺口锁定）。
 *
 * 锁定三条：
 * 1. **触发序**：`runStartupReattach` 的 restore 包装执行序 = restore → 建投递运行时 →
 *    对账（'pi-restored'）——reconcile 无运行时即 no-op，顺序反了等于没修。
 * 2. **无提交活动下的收养重建**（真 registry + fake pi）：滚动重启后 renderer 只重连
 *    resync、用户不发消息的形态下，pi 槽位滞留文本经该触发点被 clear_queue 收回并重新
 *    投递（无标记外来文本收养路径 / 带标记路径共用 disposeCleared）。
 * 3. **回归对照（缺口本体）**：不建运行时直接 reconcile = no-op（滞留文本原地不动）——
 *    锁定「必须先建运行时」这一硬约束（本测试是该缺口的回归防线）。
 *
 * 材料：真 createDelivery 内核 + 真 registry（fake pi client / fake session view）；
 * 编排腿用真 runStartupReattach + fake checkpoint（tmp 目录，fs-guard 白名单内）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/services/reattach-delivery-trigger.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionDeliveryRegistry,
  resetActiveDeliveryRegistryForTest,
  type SessionDeliveryDeps,
} from '../../services/session/session-delivery-registry.js'
import { createReattachRestore } from '../../services/session/reattach-delivery-trigger.js'
import { runStartupReattach } from '../../services/startup-reattach.js'
import type { RuntimeCheckpointStore } from '../../services/session/runtime-checkpoint.js'
import type { IManagedSessionView } from '../../services/session/types.js'
import type { IPiEngine } from '../../services/ports/pi-engine.js'
import type { IMessageBus } from '../../services/message-bus/message-bus.js'
import type { SkillInjectionResult, SkillInjector, SkillNotice } from '../../services/session/skill-injector.js'

const SID = 's-reattach-1'

/** 滞留文本（无标记外来文本形态：subagent notifyDone / scheduler 提醒存量注入面）。 */
const STRANDED_TEXT = '滞留的外来通知文本'

function makeView(): IManagedSessionView {
  return {
    id: SID,
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false },
  }
}

/** fake pi client：槽位滞留 STRANDED_TEXT，clear_queue 一次性返回（与真实现同语义）。 */
function makeRegistryHarness() {
  const view = makeView()
  const eventListeners: Array<(e: unknown) => void> = []
  const promptCalls: string[] = []
  let cleared = { steering: [STRANDED_TEXT], followUp: [] as string[] }

  const client = {
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text)
      return {}
    }),
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => {
      const out = cleared
      cleared = { steering: [], followUp: [] }
      return out
    }),
    onEvent: vi.fn((cb: (e: unknown) => void) => {
      eventListeners.push(cb)
      return () => {
        const i = eventListeners.indexOf(cb)
        if (i >= 0) eventListeners.splice(i, 1)
      }
    }),
  }
  const injector = {
    inject: vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
      text,
      notices: [] as SkillNotice[],
    })),
  } as unknown as SkillInjector
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => (sid === SID ? view : undefined),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => ({ publish: vi.fn() }) as unknown as IMessageBus,
  }
  const registry = createSessionDeliveryRegistry(deps, injector)
  /** flush 异步链（对账与投递各 await 段）。 */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  return { registry, deps, client, promptCalls, flush, clearQueue: client.clearQueue }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetActiveDeliveryRegistryForTest()
})

afterEach(() => {
  vi.useRealTimers()
  resetActiveDeliveryRegistryForTest()
})

describe('createReattachRestore：restore → 建运行时 → 对账（顺序硬约束）', () => {
  it('调用序 = restore → ensureDeliveryRuntime → reconcile（一次性触发，不轮询）', async () => {
    const order: string[] = []
    const restore = createReattachRestore({
      restore: async (sid: string) => { order.push(`restore:${sid}`); return { ok: true } },
      ensureDeliveryRuntime: (sid: string) => { order.push(`ensure:${sid}`) },
      reconcile: async (sid: string) => { order.push(`reconcile:${sid}`) },
    })
    const result = await restore(SID)
    // reconcile 是 fire-and-forget（restore 契约不得被对账拖慢/污染），排空微任务后核对全序
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(order).toEqual([`restore:${SID}`, `ensure:${SID}`, `reconcile:${SID}`])
    expect(result).toEqual({ ok: true })
  })

  it('对账失败不改变 restore 成功语义（编排不得按 restore-failed 跳过该 session）', async () => {
    const logged: string[] = []
    const restore = createReattachRestore({
      restore: async () => ({ ok: true }),
      ensureDeliveryRuntime: () => {},
      reconcile: async () => { throw new Error('clear_queue timeout') },
      log: (message) => logged.push(message),
    })
    await expect(restore(SID)).resolves.toEqual({ ok: true })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(logged.some((l) => l.includes('clear_queue timeout'))).toBe(true)
  })

  it('restore 自身失败照常上抛（编排的逐 session 容错路径不变）', async () => {
    const restore = createReattachRestore({
      restore: async () => { throw new Error('spawn failed') },
      ensureDeliveryRuntime: () => { throw new Error('must not run') },
      reconcile: async () => {},
    })
    await expect(restore(SID)).rejects.toThrow('spawn failed')
  })
})

describe('无提交活动下的 reattach 收养重建（A5/V5）', () => {
  it('缺口本体：不建运行时直接 reconcile = no-op（槽位滞留原地不动）', async () => {
    const h = makeRegistryHarness()
    await h.registry.reconcile(SID, 'pi-restored')
    expect(h.clearQueue).not.toHaveBeenCalled()
    expect(h.promptCalls).toHaveLength(0)
  })

  it('经 createReattachRestore 触发：建运行时后 reconcile 收回槽位 → 滞留文本重新投递（无丢失）', async () => {
    const h = makeRegistryHarness()
    const trigger = createReattachRestore({
      restore: async () => undefined,
      ensureDeliveryRuntime: (sid) => { h.registry.getOrCreateDelivery(sid) },
      reconcile: (sid) => h.registry.reconcile(sid, 'pi-restored'),
    })
    await trigger(SID)
    await h.flush()
    expect(h.clearQueue).toHaveBeenCalledTimes(1)
    // 收养 = 以新 id 入内核 FIFO 正常投递（空闲 → 立即出站 prompt，带裸标记身份）
    expect(h.promptCalls.some((t) => t.includes(STRANDED_TEXT))).toBe(true)
    const entries = h.registry.entries(SID)
    expect(entries).toBeDefined()
    expect(entries!.active.length + entries!.tombstones.length).toBeGreaterThan(0)
  })

  it('端到端编排腿：runStartupReattach（checkpoint 单候选）→ restore 包装被调 → 收养路径触发', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'u4-reattach-trigger-'))
    try {
      // 只写 session.jsonl（restoreOne staleness guard 依赖 fileExists(entry.filePath)）。
      // runtime-checkpoint.json 磁盘文件不写：checkpoint 读面被下方 mock store 覆盖，
      // 真文件不进任何断言；deleteCheckpointFile 对不存在路径走 ENOENT 容错（返回 false）。
      writeFileSync(join(runDir, 'session.jsonl'), '{}\n')
      const h = makeRegistryHarness()
      const restoreCalls: string[] = []
      const report = await runStartupReattach(
        {
          restore: createReattachRestore({
            restore: async (sid: string) => { restoreCalls.push(sid); return undefined },
            ensureDeliveryRuntime: (sid) => { h.registry.getOrCreateDelivery(sid) },
            reconcile: (sid) => h.registry.reconcile(sid, 'pi-restored'),
          }),
          waitForOrphanReap: async () => {},
          onDeferredBroadcast: () => {},
        },
        {
          checkpoint: { read: () => ({
            checkpointPath: join(runDir, 'runtime-checkpoint.json'),
            sessions: [{
              piSessionId: SID,
              filePath: join(runDir, 'session.jsonl'),
              lastActivityAt: Date.now(),
              lastViewedAt: Date.now(),
              occupancy: 'idle',
              backgroundTasks: false,
              relayChildren: false,
            }],
          }), checkpointPath: join(runDir, 'runtime-checkpoint.json') } as unknown as RuntimeCheckpointStore,
          queryMemPressure: async () => ({ freeRatio: 0.9 } as never),
          now: () => Date.now(),
        },
      )
      await h.flush()
      expect(report.restored).toContain(SID)
      expect(restoreCalls).toEqual([SID])
      expect(h.clearQueue).toHaveBeenCalledTimes(1)
      expect(h.promptCalls.some((t) => t.includes(STRANDED_TEXT))).toBe(true)
    } finally {
      rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
