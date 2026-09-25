/**
 * notify-once U6 验收迁移测试（原 completion-backflow.test.ts 六组的迁移改写）。
 *
 * [HISTORICAL] 迁移说明：CompletionBackflow（settled/exit 无条件文本回流）已随 notify-once
 * 废弃删除（设计 U3），原六组验收按下表迁移到 ClaimLedger + 桥接助手（session-manager-handler
 * 导出的词形映射/respond 回执循环）形态——通知文案构造（U6_UNIT）随 buildBackflowContent
 * 迁至 extension 侧（extensions/universal/session-manager 的 notify-content.test.ts）：
 * - U6_SETTLED_CHAIN → settle 兑现 → respond payload（reason 映射 / settleSeq / fulfills / transcript）
 * - U6_NO_PARENT_SKIP → 无债权 settle 零 respond + armed 未受回执不兑现（B 族不变量）
 * - U6_EXIT_FAILBACK → 终局死亡 respond（exitCode / stderr 400 截尾 / transcript / cause 两词形）
 * - U6_SINGLETON_REUSE → delivery 单例 handle 上 envelope meta notifyId per-message 不串键，
 *   各 claim 的受理回执各自锚定（P9 事件序的注册表面）
 * - U6_MULTI_RUN → 两次 settled 两次 respond（settleSeq 1→2 递增，批身份分离）
 * - U6_UNIT → [已删除] 随迁 extension notify-content.test.ts
 *
 * 材料形态：真 ClaimLedger（时钟注入）+ 真桥接助手（toWatchRespondPayload /
 * deliverRespondTargets / collectStderrTail），respond 写回通道 = 记录型 spy。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/completion-backflow.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createClaimLedger,
  type ClaimLedger,
  type SettleOutcome,
} from './notify-claims.js'
import {
  collectStderrTail,
  deliverRespondTargets,
  runClaimSweep,
  toWatchRespondPayload,
} from '../../transport/session-manager-handler.js'
import type { SessionManagerWatchRespondPayload } from '@zhushanwen/extension-protocol'
import { createSessionDeliveryRegistry } from './session-delivery-registry.js'
import type { IManagedSessionView } from './types.js'

const PARENT = 'parent-1'
const CHILD = 'child-1'
const NID = 'sm-11111111-2222-3333-4444-555555555555'
const NID2 = 'sm-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const LIFETIME = 'sm-99999999-8888-7777-6666-555555555555'
const FILE = `/tmp/${CHILD}.jsonl`

interface RespondRecord {
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

beforeEach(() => {
  bed = makeBed()
})

afterEach(() => {
  for (const l of bed.ledgers) l.dispose()
})

/** arm + 受理回执（send 路径形态） */
function armInjected(ledger: ClaimLedger, notifyId = NID): void {
  expect(ledger.arm({ parentSid: PARENT, notifyId, kind: 'claim', sessionId: CHILD })).toEqual({ ok: true })
  expect(ledger.markInjected(PARENT, notifyId)).toBe(true)
}

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
    // 即时删除 + clearSession 兜底（latch 语义：迟到 exit 腿查无记录自然静默）
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
    await handle.sendChecked({ payload: { kind: 'text', content: 'one' }, meta: { notifyId: NID2, parentSid: PARENT } })
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

// ─── TTL 清扫腿（设计 D7；handler watch describe 消费同一助手）───────────────

describe('TTL 清扫：已挂 watch 的悬挂 claim 转 orphaned → 同步 respond orphaned（防孤儿 promise）', () => {
  it('runClaimSweep 在 TTL 到达时对已挂 watch 同步应答 reason orphaned + onRespond 回执', () => {
    let clock = 1_000_000
    const { ledger, responds, respond, ledgers } = makeBed(() => clock)
    try {
      armInjected(ledger)
      expect(ledger.openWatch(PARENT, NID, 'w-orphan').action).toBe('wait')
      // 未到 TTL：清扫无转移
      clock += 60_000
      runClaimSweep(ledger, respond)
      expect(responds).toHaveLength(0)
      // 到达 TTL 下界：armed/injected 悬挂 → orphaned + respond
      clock += 600_000
      const result = runClaimSweep(ledger, respond)
      expect(result.respondOrphaned).toHaveLength(1)
      expect(responds).toHaveLength(1)
      expect(responds[0].watchId).toBe('w-orphan')
      expect(responds[0].payload).toEqual({ reason: 'orphaned', sessionId: CHILD })
      expect(ledger.getClaim(PARENT, NID)).toBeUndefined() // onRespond(true) 已删
      // 事实计数不回退（D6：转入 orphaned 即 +1，随记录回收不清——clearSession 才清零）
      expect(ledger.undeliveredCount(CHILD)).toBe(1)
    } finally {
      for (const l of ledgers) l.dispose()
    }
  })
})

// ─── 词形映射单点（toWatchRespondPayload 纯函数）────────────────────────────

describe('toWatchRespondPayload 词形映射（u-bridge 承载协议 SSOT 消费点）', () => {
  it('aborted → cancelled 携 sessionId（静默收口数据源不回带不消费）', () => {
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
