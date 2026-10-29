import { getSessionsDir } from '../../infra/pi/pi-paths.js';
import { extractLatestModelFromJsonl } from '../../infra/pi/session-file-utils.js';
import type { IEventAdapter } from '../../interfaces.js';
import { collectStderrTail, deliverRespondTargets, toWatchRespondPayload } from '../../transport/session-manager-handler.js';
import { MODEL_NOT_CONFIGURED } from '../../utils/errors.js';
import type { IConfigStore } from '../ports/config.js';
import type { IProcessManager, IPiEngine } from '../ports/pi-engine.js';
import type { ISessionStore } from '../ports/session.js';
import type { WorkspaceService } from '../workspace/workspace-service.js';
import { createClaimLedger, type ClaimLedger, type SettleOutcome } from './notify-claims.js';
import { createSessionDeliveryRegistry } from './session-delivery-registry.js';
import type { ILifecycleSessionOps, ISessionRegisterDeps } from './session-internal.js';
import { SessionLifecycle, getMigrationGate, setMigrationGate } from './session-lifecycle.js';
import type { IManagedSessionView } from './types.js';
import type { SessionSummary } from '@taiji/shared';
import type { SessionManagerWatchRespondPayload } from '@zhushanwen/extension-protocol';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// [session-cold-switch-perf §3.3-2] restoreSession 消费预热槽：槽空回退现状 spawn 链时
// 「顺带补位」会经同一构造链再调一次 pm.createSession（后台），干扰本文件 restore 主链的
// spawn 计数断言（gate pending 放行后应为 1 次）。槽本体由
// src/__tests__/warmup-pi-slot.test.ts 覆盖，此处 mock 恒空槽（take 恒 empty、零补位）。
vi.mock('./warmup-pi-slot.js', () => {
  return {
    WARMUP_SLOT_SESSION_ID: 'warmup-pi-slot',
    WarmupPiSlot: class {
      take(): { kind: 'empty' } { return { kind: 'empty' } }
      warm(): void {}
    },
  }
})

// ======================================================================
// ← src/services/session/completion-backflow.test.ts
// ======================================================================

import type { ScannedSession } from './types.js';
const PARENT = 'parent-1'

const CHILD = 'child-1'

const NID = 'sm-11111111-2222-3333-4444-555555555555'

const NID2 = 'sm-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const LIFETIME = 'sm-99999999-8888-7777-6666-555555555555'

const FILE = `/tmp/${CHILD}.jsonl`


interface RespondRecord {  // oe-exempt:20261027:test:
  parentSid: string
  watchId: string
  payload: SessionManagerWatchRespondPayload
}


/** 桥接测试床：真 ledger + 记录型 respond（boolean 传导恒 true = 写入成功） */
function makeBed(now?: () => number) {
  const ledgers: ClaimLedger[] = []
  const ledger = createClaimLedger(now ? { now } : {})
  ledgers.push(ledger)
  const responds: RespondRecord[] = []
  const respond = (parentSid: string, watchId: string, payload: SessionManagerWatchRespondPayload): boolean => {
    responds.push({ parentSid, watchId, payload })
    return true
  }
  return { ledger, responds, respond, ledgers }
}


let bed: ReturnType<typeof makeBed>


/** arm + 受理回执（send 路径形态） */
function armInjected(ledger: ClaimLedger, notifyId = NID): void {
  expect(ledger.arm({ parentSid: PARENT, notifyId, kind: 'claim', sessionId: CHILD })).toEqual({ ok: true })
  expect(ledger.markInjected(PARENT, notifyId)).toBe(true)
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('completion-backflow', () => {
beforeEach(() => {
  bed = makeBed()
})
afterEach(() => {
  for (const l of bed.ledgers) l.dispose()
})
// ─── U6_SETTLED_CHAIN（迁移）────────────────────────────────────────────────

describe('U6_SETTLED_CHAIN 迁移：settled → ClaimLedger 兑现 → watch respond（词形映射单点）', () => {
  it('injected claim + 已挂 watch 的 settle → respond reason completed 携 settleSeq/fulfills/transcript', () => {
    const { ledger, responds, respond } = bed
    armInjected(ledger)
    expect(ledger.openWatch(PARENT, NID, 'watch-1').action).toBe('wait')

    const batch = ledger.settle(CHILD, 'done')
    expect(batch.settleSeq).toBe(1)
    deliverRespondTargets(ledger, batch.targets, respond, { sessionFilePath: FILE })

    expect(responds).toHaveLength(1)
    expect(responds[0].watchId).toBe('watch-1')
    expect(responds[0].payload).toEqual({
      reason: 'completed',
      sessionId: CHILD,
      settleSeq: 1,
      fulfillsN: 1,
      sessionFilePath: FILE,
    })
    // onRespond(true) → 记录删除（回收策略）
    expect(ledger.getClaim(PARENT, NID)).toBeUndefined()
  })

  it('status 词形固化：session_end outcome error→failed / stopped→stopped / done·null→completed', () => {
    const cases: Array<{ outcome: SettleOutcome; reason: string }> = [
      { outcome: 'error', reason: 'failed' },
      { outcome: 'stopped', reason: 'stopped' },
      { outcome: 'done', reason: 'completed' },
      { outcome: null, reason: 'completed' },
    ]
    for (const { outcome, reason } of cases) {
      const { ledger, responds, respond } = makeBed()
      try {
        armInjected(ledger)
        ledger.openWatch(PARENT, NID, 'w')
        const batch = ledger.settle(CHILD, outcome)
        deliverRespondTargets(ledger, batch.targets, respond, { sessionFilePath: FILE })
        expect(responds[0].payload.reason, `outcome=${String(outcome)} 应映射 reason "${reason}"`).toBe(reason)
      } finally {
        ledger.dispose()
      }
    }
  })

  it('sessionFilePath 缺失（查不到不填）→ payload 不携该字段（整行省略语义）', () => {
    const { ledger, responds, respond } = bed
    armInjected(ledger)
    ledger.openWatch(PARENT, NID, 'w')
    deliverRespondTargets(ledger, ledger.settle(CHILD, 'done').targets, respond)
    expect(responds[0].payload.sessionFilePath).toBeUndefined()
    expect('sessionFilePath' in responds[0].payload).toBe(false)
  })
})
// ─── U6_NO_PARENT_SKIP（迁移）───────────────────────────────────────────────

describe('U6_NO_PARENT_SKIP 迁移：不满足兑现条件的 settle 零 respond（无债权 settle 必零通知）', () => {
  it('无任何 claim 的 settle → targets 空、零 respond、seq 不占号', () => {
    const { ledger, responds, respond } = bed
    const batch = ledger.settle(CHILD, 'done')
    deliverRespondTargets(ledger, batch.targets, respond)
    expect(responds).toHaveLength(0)
    expect(batch.settleSeq).toBe(0) // 空批不占号（u-claims D-f）
  })

  it('armed（受理回执未达）的 claim 不被 settle 兑现 → 零 respond，记录仍 armed', () => {
    const { ledger, responds, respond } = bed
    ledger.arm({ parentSid: PARENT, notifyId: NID, kind: 'claim', sessionId: CHILD })
    ledger.openWatch(PARENT, NID, 'w')
    deliverRespondTargets(ledger, ledger.settle(CHILD, 'done').targets, respond)
    expect(responds).toHaveLength(0)
    expect(ledger.getClaim(PARENT, NID)?.state).toBe('armed')
  })

  it('lifetime 记录豁免 settle（A4：lifetime 仅在死亡时发声）', () => {
    const { ledger, responds, respond } = bed
    ledger.arm({ parentSid: PARENT, notifyId: LIFETIME, kind: 'lifetime', sessionId: CHILD })
    ledger.openWatch(PARENT, LIFETIME, 'w-lt')
    deliverRespondTargets(ledger, ledger.settle(CHILD, 'done').targets, respond)
    expect(responds).toHaveLength(0)
    expect(ledger.getClaim(PARENT, LIFETIME)?.state).toBe('armed')
  })
})
// ─── U6_EXIT_FAILBACK（迁移）────────────────────────────────────────────────

describe('U6_EXIT_FAILBACK 迁移：终局死亡 respond 携 exitCode/stderrTail/transcript（诊断通路复刻）', () => {
  it('cause exit → reason exited，携 exitCode + stderr 尾部 + transcript 指针', () => {
    const { ledger, responds, respond } = bed
    armInjected(ledger)
    ledger.arm({ parentSid: PARENT, notifyId: LIFETIME, kind: 'lifetime', sessionId: CHILD })
    ledger.openWatch(PARENT, NID, 'w-claim')
    ledger.openWatch(PARENT, LIFETIME, 'w-lifetime')

    const batch = ledger.onSessionDeath(CHILD, 'exit')
    deliverRespondTargets(ledger, batch.targets, respond, {
      exitCode: 1,
      stderrTail: collectStderrTail('FATAL: oom'),
      sessionFilePath: FILE,
    })

    expect(responds).toHaveLength(2) // claim + lifetime 同批终结
    expect(responds.map((r) => r.watchId).sort()).toEqual(['w-claim', 'w-lifetime'])
    for (const r of responds) {
      expect(r.payload.reason).toBe('exited')
      expect(r.payload.sessionId).toBe(CHILD)
      expect(r.payload.deathSeq).toBe(1) // 同 deathSeq（D3 死亡新闻槽的键）
      expect(r.payload.fulfillsN).toBe(1) // death 的 fulfills = 同批 claim 数（lifetime 不计）
      expect(r.payload.exitCode).toBe(1)
      expect(r.payload.stderrTail).toBe('FATAL: oom')
      expect(r.payload.sessionFilePath).toBe(FILE)
    }
    // 即时删除 + clearSession 兜底（latch 语义：迟到 exit 路径查无记录自然静默）
    expect(ledger.count()).toBe(0)
    expect(ledger.clearSession(CHILD)).toBe(0)
  })

  it('有债权死亡不叠加：两 claim 同批 → 各携同 deathSeq、fulfillsN=2，仍各一次 respond', () => {
    const { ledger, responds, respond } = bed
    armInjected(ledger, NID)
    armInjected(ledger, NID2)
    ledger.openWatch(PARENT, NID, 'w1')
    ledger.openWatch(PARENT, NID2, 'w2')
    deliverRespondTargets(ledger, ledger.onSessionDeath(CHILD, 'exit').targets, respond, { exitCode: null })
    expect(responds).toHaveLength(2)
    expect(new Set(responds.map((r) => r.payload.deathSeq))).toEqual(new Set([1]))
    expect(responds[0].payload.fulfillsN).toBe(2)
    expect(responds[1].payload.fulfillsN).toBe(2)
  })

  it('cause delete → reason deleted（词形分派）；exitCode 缺席不携该字段', () => {
    const { ledger, responds, respond } = bed
    armInjected(ledger)
    ledger.openWatch(PARENT, NID, 'w')
    deliverRespondTargets(ledger, ledger.onSessionDeath(CHILD, 'delete').targets, respond, {})
    expect(responds[0].payload.reason).toBe('deleted')
    expect('exitCode' in responds[0].payload).toBe(false)
    expect('stderrTail' in responds[0].payload).toBe(false)
  })

  it('无债权纯死亡（D5 裁决2）：无 claim 但 lifetime 在册 → 仍发一条 exited（fulfillsN=0）', () => {
    const { ledger, responds, respond } = bed
    ledger.arm({ parentSid: PARENT, notifyId: LIFETIME, kind: 'lifetime', sessionId: CHILD })
    ledger.openWatch(PARENT, LIFETIME, 'w-lt')
    deliverRespondTargets(ledger, ledger.onSessionDeath(CHILD, 'exit').targets, respond, {
      exitCode: null,
      stderrTail: collectStderrTail(''),
    })
    expect(responds).toHaveLength(1)
    expect(responds[0].payload.reason).toBe('exited')
    expect(responds[0].payload.fulfillsN).toBe(0)
    expect(responds[0].payload.exitCode).toBeNull()
    expect('stderrTail' in responds[0].payload).toBe(false) // 空 stderr 不填
  })

  it('stderr 超长截尾（保留尾部 400 字符，诊断价值在末段）', () => {
    const tail = collectStderrTail(`${'x'.repeat(1000)}-END`)
    expect(tail).toBeDefined()
    expect(tail!.length).toBeLessThanOrEqual(400)
    expect(tail!.endsWith('-END')).toBe(true)
    expect(collectStderrTail('')).toBeUndefined()
  })
})
// ─── U6_SINGLETON_REUSE（迁移）──────────────────────────────────────────────

describe('U6_SINGLETON_REUSE 迁移：单例 delivery handle 上 envelope meta notifyId 逐条不串键', () => {
  it('同父/子 session 复用同一 handle，两条带 meta 的投递各自回执 → 两 claim 各自 markInjected', async () => {
    const { ledger } = bed
    armInjected(ledger, NID) // 会随回执再次 markInjected（已 injected → no-op false，不破坏）
    // 第二笔债权（尚未受回执）
    ledger.arm({ parentSid: PARENT, notifyId: NID2, kind: 'claim', sessionId: CHILD })

    // 真 registry + onSettledMessage → markInjected 接线（组合根同款消费形态）
    const views = new Map<string, { id: string; isGenerating: boolean; isCompacting: boolean; isBashRunning: boolean }>([
      [CHILD, { id: CHILD, isGenerating: false, isCompacting: false, isBashRunning: false }],
    ])
    const client = { prompt: vi.fn(async () => ({})) }
    const registry = createSessionDeliveryRegistry({
      getSession: (sid) => (views.get(sid) as unknown as IManagedSessionView | undefined),
      ensureActive: async () => client as unknown as never,
      subscribeAgentSettled: () => () => {},
      recordWorkspace: () => {},
      getMessageBus: () => null,
      onSettledMessage: (_sid, msg, outcome) => {
        const meta = msg.meta
        if (typeof meta?.notifyId !== 'string' || typeof meta?.parentSid !== 'string') return
        if (outcome === 'delivered') ledger.markInjected(meta.parentSid, meta.notifyId)
        else ledger.disarmDeliveryFailed(meta.parentSid, meta.notifyId)
      },
    })

    const handle = registry.getOrCreateDelivery(CHILD)
    // receiptAnchor 'acceptance' 申报（V2 D1 申报制义务）：缺省 'marker' 条目受理后挂
    // in-flight 等回执，mock 场景无确认路径 → onSettled('delivered') 永不触发
    await handle.sendChecked(
      { payload: { kind: 'text', content: 'one' }, meta: { notifyId: NID2, parentSid: PARENT } },
      { receiptAnchor: 'acceptance' },
    )
    expect(ledger.getClaim(PARENT, NID2)?.state).toBe('injected') // 单例 handle 上 per-message 回执各自锚定
    expect(ledger.getClaim(PARENT, NID)?.state).toBe('injected') // 既有记录不被串改
    expect(client.prompt).toHaveBeenCalledTimes(1)
    expect(handle).toBe(registry.getOrCreateDelivery(CHILD)) // 单例约束
  })
})
// ─── U6_MULTI_RUN（迁移）────────────────────────────────────────────────────

describe('U6_MULTI_RUN 迁移：两次 settled 两次 respond（settleSeq 批身份递增）', () => {
  it('同子 session 两个 run 各自兑现 → 两条 respond、settleSeq 1 与 2', () => {
    const { ledger, responds, respond } = bed
    // run 1：arm → 回执 → catch-up 开表（watch 晚于兑现到达）
    armInjected(ledger)
    deliverRespondTargets(ledger, ledger.settle(CHILD, 'done').targets, respond, { sessionFilePath: FILE })
    expect(responds).toHaveLength(0) // 无 watch：fulfilled-no-watch，等 catch-up
    const catchUp1 = ledger.openWatch(PARENT, NID, 'w1')
    expect(catchUp1.action).toBe('respond')
    if (catchUp1.action === 'respond') {
      deliverRespondTargets(ledger, [catchUp1.target], respond, { sessionFilePath: FILE })
    }
    // run 2：新债权 → settle 已挂 watch 即时 respond
    armInjected(ledger, NID2)
    ledger.openWatch(PARENT, NID2, 'w2')
    deliverRespondTargets(ledger, ledger.settle(CHILD, 'error').targets, respond, { sessionFilePath: FILE })

    expect(responds).toHaveLength(2)
    expect(responds[0].payload.settleSeq).toBe(1)
    expect(responds[0].payload.reason).toBe('completed')
    expect(responds[1].payload.settleSeq).toBe(2)
    expect(responds[1].payload.reason).toBe('failed') // status 逐 run 取终值
    expect(ledger.count()).toBe(0)
  })
})
// ─── TTL 清扫路径（设计 D7；handler watch describe 消费同一助手）───────────────

describe('TTL 清扫：已挂 watch 的悬挂 claim 转 orphaned → 同步 respond orphaned（防孤儿 promise）', () => {
    it('aborted → cancelled 携 sessionId（静默收尾数据源不回带不消费）', () => {
    const payload = toWatchRespondPayload({ type: 'aborted' }, CHILD)
    expect(payload).toEqual({ reason: 'cancelled', sessionId: CHILD })
  })

  it('orphaned → orphaned 携 sessionId', () => {
    const payload = toWatchRespondPayload({ type: 'orphaned' }, CHILD, { sessionFilePath: FILE })
    expect(payload).toEqual({ reason: 'orphaned', sessionId: CHILD, sessionFilePath: FILE })
  })

  it('settled meta：settleSeq/fulfillsN 直供 + outcome 三词形', () => {
    expect(toWatchRespondPayload({ type: 'settled', outcome: 'done', settleSeq: 3, fulfills: 2 }, CHILD))
      .toEqual({ reason: 'completed', sessionId: CHILD, settleSeq: 3, fulfillsN: 2 })
    expect(toWatchRespondPayload({ type: 'settled', outcome: 'error', settleSeq: 1, fulfills: 1 }, CHILD).reason).toBe('failed')
    expect(toWatchRespondPayload({ type: 'settled', outcome: 'stopped', settleSeq: 1, fulfills: 1 }, CHILD).reason).toBe('stopped')
  })

  it('death meta：cause 两词形 + deathSeq/fulfillsN + 诊断字段仅在提供时携带', () => {
    const base = { type: 'death', cause: 'exit', deathSeq: 2, fulfills: 1 } as const
    expect(toWatchRespondPayload(base, CHILD, { exitCode: null, stderrTail: 'boom' })).toEqual({
      reason: 'exited',
      sessionId: CHILD,
      deathSeq: 2,
      fulfillsN: 1,
      exitCode: null,
      stderrTail: 'boom',
    })
    expect(toWatchRespondPayload({ ...base, cause: 'delete' }, CHILD).reason).toBe('deleted')
  })
})
});

// ======================================================================
// ← src/services/session/session-lifecycle-gate.test.ts
// ======================================================================

function makeSummary(id: string): SessionSummary {
  return { id, label: 'test', cwd: '/tmp', status: 'idle', lastActiveAt: Date.now() }
}


/** fake EventAdapter（S3 迁移后 registerSession 真实现经 registerDeps.adapterFactory 装配 adapter）。 */
function makeFakeAdapter(): IEventAdapter {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter
}


/**
 * 构造最小 lifecycle 环境：svc/pm/configStore/sessionStore/workspaceService 全 mock。
 * S2 ISP 化（设计 §4.2 场景 B 主验收点）：svc 结构性满足 lifecycle 窄接口，svc stub 强转彻底消失。
 * S3 写点归位：initializeManagedSession 从 svc stub 移除（接口已删）——注册走真
 * registerSession（sessions Map 所有权在 lifecycle），装配依赖经 registerDeps 注入
 * fake adapterFactory；svc stub 面收窄为 10 方法 = 现接口实际消费方。
 */
function makeEnv() {
  const svc: ILifecycleSessionOps = {
    getExtensionPaths: vi.fn(async () => []),
    getSkillPaths: vi.fn(() => []),
    getReplaceSystemPrompt: vi.fn(() => undefined),
    getLaunchPresetOptions: vi.fn(async () => undefined),
    toSummary: vi.fn((s: IManagedSessionView) => makeSummary(s.id)),
    // S3-W2：创建入口收敛点（lifecycle 三处 return 前调用）
    notifySessionCreated: vi.fn(),
    findScannedSession: vi.fn(() => undefined),
    fetchAndBroadcastContext: vi.fn(async () => undefined),
    removeSessionEntry: vi.fn(),
    getActiveSummaries: vi.fn(() => []),
  }
  const client = {
    getState: vi.fn(async () => ({ sessionId: 'sess-1', sessionFile: undefined })),
    switchSession: vi.fn(async () => undefined),
  }
  const pm = {
    createSession: vi.fn(async () => client),
    rekey: vi.fn(),
    destroySession: vi.fn(async () => undefined),
    // D5② 短路预检读点（session-dead-structural-fixes）：undefined = 无 client → 不短路 → 全流程。
    getClient: vi.fn(() => undefined),
  } as unknown as IProcessManager
  const configStore = {
    getDefaultModel: vi.fn(() => ({ provider: 'test-provider', modelId: 'test-model' })),
  } as unknown as IConfigStore
  const sessionStore = {
    refreshAll: vi.fn(),
    invalidateScanCache: vi.fn(),
    persistPresetBinding: vi.fn(),
    persistProjectBinding: vi.fn(),
    // D5 整树软删通道（ISessionStore.trashDirectory）：本文件断言面 = sidecar 四后缀
    // unlink 家族，树删 no-op 即可（落盘效果由 cascade 测试族真跑覆盖）。
    trashDirectory: vi.fn(async () => {}),
  } as unknown as ISessionStore
  const workspaceService = { record: vi.fn() } as unknown as WorkspaceService
  const registerDeps: ISessionRegisterDeps = {
    adapterFactory: () => makeFakeAdapter(),
    getMessageBus: () => null,
    broadcastGlobal: () => {},
  }

  const lifecycle = new SessionLifecycle(svc, pm, configStore, sessionStore, workspaceService, registerDeps)
  return { svc, pm, configStore, sessionStore, workspaceService, client, lifecycle, registerDeps }
}


/** 让当前微任务/宏任务队列排空（gate pending 断言前用）。 */
async function flushTicks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-lifecycle-gate', () => {
beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  // 重置模块级 gate——防测试间串扰（默认 resolved = 无 gate 语义）。
  setMigrationGate(Promise.resolve())
})
describe('SessionLifecycle × migration gate（D8-3）', () => {
  describe('create', () => {
    it('gate pending 时 create 挂起（pm.createSession 不被调用），resolve 后放行', async () => {
      const { lifecycle, pm, configStore } = makeEnv()
      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const cwd = mkdtempSync(join(tmpdir(), 'w29-gate-create-'))
      const pending = lifecycle.create(cwd, 't')
      await flushTicks()
      // gate 未 resolve：spawn 未发生，create 仍在挂起
      expect(pm.createSession).not.toHaveBeenCalled()
      expect(configStore.getDefaultModel).toHaveBeenCalledTimes(1)

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('sess-1')
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    it('gate 未注入（默认 resolved）时 create 不等待（与旧版一致）', async () => {
      const { lifecycle, pm } = makeEnv()
      // afterEach 已重置 gate；此处显式再设默认
      setMigrationGate(Promise.resolve())
      const cwd = mkdtempSync(join(tmpdir(), 'w29-gate-create-nogate-'))
      const summary = await lifecycle.create(cwd, 't')
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('sess-1')
      rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
  })

  describe('restoreSession', () => {
    it('gate pending 时 restore 挂起，resolve 后放行', async () => {
      const { lifecycle, pm, svc } = makeEnv()
      const dir = mkdtempSync(join(tmpdir(), 'w29-gate-restore-'))
      const filePath = join(dir, 'session.jsonl')
      writeFileSync(filePath, [
        { type: 'session', version: 3, id: 's-restore', timestamp: '2026-08-16T01:00:00.000Z', cwd: dir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const target: ScannedSession = { id: 's-restore', cwd: dir, filePath, name: 'restored', launchPresetId: undefined } as ScannedSession
      svc.findScannedSession = vi.fn(() => target) as never
      // S3 迁移：注册走真 registerSession（id = sessionId），makeEnv 的透传 toSummary
      // stub 保留 summary.id = 真 session.id 的行为绑定。

      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const pending = lifecycle.restoreSession('s-restore')
      await flushTicks()
      expect(pm.createSession).not.toHaveBeenCalled()

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      expect(summary.id).toBe('s-restore')
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
  })

  describe('forkSession', () => {
    it('gate pending 时 fork 挂起，resolve 后放行', async () => {
      const { lifecycle, pm, svc } = makeEnv()
      // createForkedSessionFile 写入 getSessionsDir()（测试数据目录 sessions 子目录需先建）
      mkdirSync(getSessionsDir(), { recursive: true })
      const dir = mkdtempSync(join(tmpdir(), 'w29-gate-fork-'))
      const sourceFile = join(dir, 'source.jsonl')
      writeFileSync(sourceFile, [
        { type: 'session', version: 3, id: 's-fork-src', timestamp: '2026-08-16T01:00:00.000Z', cwd: dir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-16T01:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const source: ScannedSession = { id: 's-fork-src', cwd: dir, filePath: sourceFile, launchPresetId: undefined } as ScannedSession
      svc.findScannedSession = vi.fn(() => source) as never

      let resolveGate!: (v: unknown) => void
      setMigrationGate(new Promise((res) => { resolveGate = res }))

      const pending = lifecycle.forkSession('s-fork-src', 'a1', true, 'forked')
      await flushTicks()
      expect(pm.createSession).not.toHaveBeenCalled()

      resolveGate(undefined)
      const summary = await pending
      expect(pm.createSession).toHaveBeenCalledTimes(1)
      // S3 迁移：fork 新 session 由真 registerSession 注册（id = createForkedSessionFile
      // 生成的 forkedId，非固定值）——断言 summary 对应已入 Map 的新 session。
      expect(summary.id).not.toBe('s-fork-src')
      expect(lifecycle.has(summary.id)).toBe(true)
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })
    // [U8a W5 fork 锚迁移] 原 create-fork-anchor 的「fork 继承 sidecar 落盘」断言对象
    // 随写点退役消失，重设计为反向读可见断言——本文件 fork 走真实 createForkedSessionFile
    //（anchor 测试 mock 了 session-fork，无法承载产物内容断言）。fork 继承 = 源 path 上
    // 的 assistant entry 随产物进入新文件，extractLatestModelFromJsonl 反向读命中继承值
    //（与 pi 恢复读路径同源；thinkingLevel 无 entry → pi 默认 'off'）。
    it('fork 继承反向读可见：源 assistant entry 随产物继承，extractLatestModelFromJsonl 命中源模型', async () => {
      const { lifecycle, svc } = makeEnv()
      // createForkedSessionFile 写入 getSessionsDir()（测试数据目录 sessions 子目录需先建）
      mkdirSync(getSessionsDir(), { recursive: true })
      const dir = mkdtempSync(join(tmpdir(), 'u8a-fork-reverse-read-'))
      const sourceFile = join(dir, 'source.jsonl')
      writeFileSync(sourceFile, [
        { type: 'session', version: 3, id: 's-fork-src', timestamp: '2026-08-16T01:00:00.000Z', cwd: dir },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-08-16T01:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-16T01:00:02.000Z', message: { role: 'assistant', provider: 'src-provider', model: 'src-model', content: [{ type: 'text', text: 'hello' }] } },
      ].map((l) => JSON.stringify(l)).join('\n') + '\n')
      const source: ScannedSession = { id: 's-fork-src', cwd: dir, filePath: sourceFile, launchPresetId: undefined } as ScannedSession
      svc.findScannedSession = vi.fn(() => source) as never

      const summary = await lifecycle.forkSession('s-fork-src', 'a1', true, 'forked')

      const forked = lifecycle.get(summary.id)
      const forkedFilePath = forked?.sessionFilePath
      expect(forkedFilePath).toBeTruthy()
      expect(extractLatestModelFromJsonl(forkedFilePath!)).toEqual({
        modelId: 'src-provider/src-model',
        thinkingLevel: 'off',
      })
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    })

    // r2-S1：model 门禁优先级——configStore 无默认 model 且源 session 也不存在时，
    // 错误码必须是 MODEL_NOT_CONFIGURED（先于 source not found 报出），
    // 与 create/restore 的错误优先级一致（见 session-lifecycle.ts forkSession 头部 r5-S2 注释）。
    it('model 未配置且 source 不存在时报 MODEL_NOT_CONFIGURED（优先于 source not found）', async () => {
      const { lifecycle, configStore, pm, svc } = makeEnv()
      configStore.getDefaultModel = vi.fn(() => null)
      svc.findScannedSession = vi.fn(() => undefined) as never

      await expect(lifecycle.forkSession('no-such-src', 'a1', true, 'forked')).rejects.toMatchObject({
        code: MODEL_NOT_CONFIGURED,
      })
      // 源解析未发生（门禁在其之前）：spawn 更不可达
      expect(pm.createSession).not.toHaveBeenCalled()
    })
  })

  it('getMigrationGate 可读当前 gate（组合根注入后非默认）', () => {
    setMigrationGate(Promise.resolve())
    expect(getMigrationGate()).toBeInstanceOf(Promise)
    const deferred = new Promise(() => undefined)
    setMigrationGate(deferred)
    expect(getMigrationGate()).toBe(deferred)
  })
})
describe('SessionLifecycle.delete（W19：sidecar 四后缀全家族清理，W11 观察项收尾）', () => {
  it('active 与 scanned 两分支都 unlink .meta/.preset/.project/.handoff 全部四后缀', async () => {
    const { lifecycle, svc, sessionStore } = makeEnv()
    const suffixes = ['.meta.json', '.preset.json', '.project.json', '.handoff.json']
    const setup = (tag: string) => {
      const f = join(mkdtempSync(join(tmpdir(), `w19-del-${tag}-`)), 's.jsonl')
      writeFileSync(f, '{"type":"session"}\n')
      suffixes.forEach((s) => writeFileSync(f + s, '{}'))
      return f
    }
    Object.assign(sessionStore, { trash: vi.fn(async () => {}), invalidateMetaCache: vi.fn() })
    const scanned = setup('scanned')
    svc.findScannedSession = vi.fn(() => ({ id: 's1', filePath: scanned })) as never
    await lifecycle.delete('s1')
    suffixes.forEach((s) => expect(existsSync(scanned + s)).toBe(false))
    // S3 迁移：active 分支判定改读 lifecycle 自持 Map——真 registerSession 注册 s2
    // （delete 内 detachSession 走所有者自查 + fake adapter；removeSessionEntry 仍经
    // svc 编排 stub），不再 stub svc.getSession。
    const active = setup('active')
    svc.removeSessionEntry = vi.fn() as never
    await lifecycle.registerSession('s2', {} as unknown as IPiEngine, tmpdir(), 'active', active)
    await lifecycle.delete('s2')
    suffixes.forEach((s) => expect(existsSync(active + s)).toBe(false))
  })
})
});
