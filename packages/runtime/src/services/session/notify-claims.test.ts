/**
 * ClaimLedger 单测 —— D10 语义矩阵全 32 case（notify-once 设计附A 逐条）+ P9 事件序用例。
 *
 * 每条 it 对应附A 一行（名称含 case id，★ = 设计标注的专项断言）。矩阵的「通知?」列在
 * 本层投影为 **respond 素材 → 送达通知数**：
 *   - 桥接/扩展的生产词形映射在 u-bridge / u-ext；本文件按设计 D4（outcome→status）与
 *     D3（settled/death 送达、aborted/orphaned 静默例外1、死亡新闻槽 (sessionId,deathSeq)
 *     首条发声、settled 按 (sessionId,reason,settleSeq) 合批）复刻最小投影，断言矩阵期望。
 *   - 矩阵中纯 extension/renderer 侧的行为（50ms 攒批、文案、register 落盘）不在本层，
 *     断言其 ledger 前置（批身份 seq / fulfills N / 零材料 ⇒ 零通知），由 u-ext 用例承接其余。
 *
 * 材料形态：零 I/O 纯状态机 + 注入手动时钟；vitest fake timers（文件头规则）保证工厂内的
 * TTL 清扫 setInterval 不落真实事件循环。状态机腿/TTL/计数器/幂等不变量见
 * notify-claims-state.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createClaimLedger,
  type ClaimLedger,
  type ClaimLedgerDeps,
  type RespondTarget,
  type SettleOutcome,
} from './notify-claims.js'

const P = 'parent-1' // 主 session（债权持有方/被 respond 方）
const S = 'child-1' // 被管理子会话
const TTL = 10 * 60_000

let clock = 0
let open: ClaimLedger[] = []

function makeLedger(deps: ClaimLedgerDeps = {}): ClaimLedger {
  const l = createClaimLedger({ now: () => clock, ...deps })
  open.push(l)
  return l
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 0
  open = []
})

afterEach(() => {
  for (const l of open) l.dispose()
  open = []
  vi.useRealTimers()
})

// ─── 测试侧投影（复刻设计 D4/D3 口径；生产映射在 u-bridge / u-ext）──────────

/** D4 outcome → 通知 status（词形同 completion-backflow outcomeToStatus：error→failed、stopped→stopped、其余 completed）。 */
function outcomeStatus(o: SettleOutcome): 'completed' | 'failed' | 'stopped' {
  if (o === 'error') return 'failed'
  if (o === 'stopped') return 'stopped'
  return 'completed'
}

/** D3 例外1：settled/death 产送达通知；aborted（→cancelled）/orphaned 静默。 */
function deliveredCount(targets: RespondTarget[]): number {
  const settled = new Set<string>()
  const deaths = new Set<string>()
  for (const t of targets) {
    if (t.payload.type === 'settled') {
      settled.add(`${t.sessionId}|${outcomeStatus(t.payload.outcome)}|${t.payload.settleSeq}`)
    } else if (t.payload.type === 'death') {
      deaths.add(`${t.sessionId}|${t.payload.deathSeq}`) // 死亡新闻槽：同 (sessionId,deathSeq) 只发声一次
    }
  }
  return settled.size + deaths.size
}

// ─── 场景脚本 helper ────────────────────────────────────────────────────────

/** send 路径形态：arm → 受理回执（envelope meta → markInjected）→ extension 开表。 */
function armSent(l: ClaimLedger, notifyId: string, opts?: { parent?: string; session?: string }): void {
  const parent = opts?.parent ?? P
  const session = opts?.session ?? S
  expect(l.arm({ parentSid: parent, notifyId, kind: 'claim', sessionId: session })).toEqual({ ok: true })
  expect(l.markInjected(parent, notifyId)).toBe(true)
  l.openWatch(parent, notifyId, `w-${notifyId}`)
}

/** create 路径形态：arm claim + 自动 arm lifetime（各带 watch —— 每 session 一个终身 watch）。 */
function armCreated(l: ClaimLedger, claimId: string, lifetimeId: string, withPrompt: boolean): void {
  if (withPrompt) {
    expect(l.arm({ parentSid: P, notifyId: claimId, kind: 'claim', sessionId: S })).toEqual({ ok: true })
    expect(l.markInjected(P, claimId)).toBe(true) // sendDirect 受理回执
    l.openWatch(P, claimId, `w-${claimId}`)
  }
  expect(l.arm({ parentSid: P, notifyId: lifetimeId, kind: 'lifetime', sessionId: S })).toEqual({ ok: true })
  l.openWatch(P, lifetimeId, `w-${lifetimeId}`)
}

// ═══ A 族：主发起（A1-A8）═════════════════════════════════════════════════

describe('D10-A 主发起（附A A1-A8）', () => {
  it('A1★ create(+prompt) → S 跑完 settle → 恰一条（fulfills 1）', () => {
    const l = makeLedger()
    armCreated(l, 'sm-a1', 'sm-a1-lt', true)
    const b = l.settle(S, 'done')
    expect(b.settleSeq).toBe(1)
    expect(b.fulfilled).toHaveLength(1)
    expect(b.targets).toHaveLength(1)
    expect(b.targets[0]!.payload).toEqual({ type: 'settled', outcome: 'done', settleSeq: 1, fulfills: 1 })
    expect(deliveredCount(b.targets)).toBe(1)
    expect(l.onRespond(P, 'sm-a1', true)).toBe('deleted')
    expect(l.count()).toBe(1) // lifetime 仍在册
  })

  it('A2 create(+prompt) → error/settle(failed) → 一条 failed', () => {
    const l = makeLedger()
    armCreated(l, 'sm-a2', 'sm-a2-lt', true)
    const b = l.settle(S, 'error')
    expect(b.targets).toHaveLength(1)
    expect(b.targets[0]!.payload).toEqual({ type: 'settled', outcome: 'error', settleSeq: 1, fulfills: 1 })
    expect(outcomeStatus((b.targets[0]!.payload as { outcome: SettleOutcome }).outcome)).toBe('failed')
    expect(deliveredCount(b.targets)).toBe(1)
  })

  it('A3 create 无 prompt → S idle → 不通知（willNotify:false；无债权）', () => {
    const l = makeLedger()
    armCreated(l, 'sm-a3', 'sm-a3-lt', false) // 无 prompt → 只有 lifetime，无 claim
    expect(l.getClaim(P, 'sm-a3')).toBeUndefined()
    const b = l.settle(S, 'done') // idle 轮次即便有 settle 也零兑现
    expect(b.fulfilled).toHaveLength(0)
    expect(b.targets).toHaveLength(0)
    expect(deliveredCount(b.targets)).toBe(0)
    expect(l.count()).toBe(1) // 仅 lifetime 在册
  })

  it('A4 create 无 prompt → 用户续聊 settle → 不通知（lifetime 不被 settle 兑现）', () => {
    const l = makeLedger()
    armCreated(l, 'sm-a4', 'sm-a4-lt', false)
    for (let i = 0; i < 3; i++) {
      const b = l.settle(S, 'done')
      expect(b.fulfilled).toHaveLength(0)
      expect(deliveredCount(b.targets)).toBe(0)
    }
    expect(l.getClaim(P, 'sm-a4-lt')?.state).toBe('armed') // lifetime 仅在死亡时发声
  })

  it('A5 A1 后 P 再 send → settle → 再一条（settleSeq 递增跨批）', () => {
    const l = makeLedger()
    armCreated(l, 'sm-a5-1', 'sm-a5-lt', true)
    expect(l.settle(S, 'done').settleSeq).toBe(1)
    l.onRespond(P, 'sm-a5-1', true)
    armSent(l, 'sm-a5-2')
    const b = l.settle(S, 'done')
    expect(b.settleSeq).toBe(2)
    expect(deliveredCount(b.targets)).toBe(1)
  })

  it('A6★ 连发 2 send 同轮消费 → 一次 settle → 一条 fulfills 2（批身份同 seq；至多一条、总数守恒）', () => {
    const l = makeLedger()
    armSent(l, 'sm-a6-1')
    armSent(l, 'sm-a6-2')
    const b = l.settle(S, 'done')
    expect(b.fulfilled).toHaveLength(2)
    expect(b.targets).toHaveLength(2)
    // 同批身份（同一 settleSeq）+ 合并口径 fulfills 2 → 扩展合批后恰一条
    expect(deliveredCount(b.targets)).toBe(1)
    for (const t of b.targets) {
      expect(t.payload).toEqual({ type: 'settled', outcome: 'done', settleSeq: 1, fulfills: 2 })
    }
    expect(l.onRespond(P, 'sm-a6-1', true)).toBe('deleted')
    expect(l.onRespond(P, 'sm-a6-2', true)).toBe('deleted')
    expect(l.count()).toBe(0)
  })

  it('A7 连发 2 send 分两轮消费 → 两条（各自 fulfill、seq 边界排除跨轮合流）', () => {
    const l = makeLedger()
    armSent(l, 'sm-a7-1')
    const b1 = l.settle(S, 'done')
    l.onRespond(P, 'sm-a7-1', true)
    armSent(l, 'sm-a7-2')
    const b2 = l.settle(S, 'done')
    expect(b1.settleSeq).toBe(1)
    expect(b2.settleSeq).toBe(2)
    expect(deliveredCount([...b1.targets, ...b2.targets])).toBe(2)
  })

  it('A8 read/status/list 只读 → 不碰债权（无入口即无转移）', () => {
    const l = makeLedger()
    l.arm({ parentSid: P, notifyId: 'sm-a8', kind: 'claim', sessionId: S })
    // 只读 action 在桥接层不接任何 ledger 入口（不 inject、不 settle、不 arm）——
    // 读窗口内记录状态原样，且只读不诱发任何兑现
    expect(l.getClaim(P, 'sm-a8')?.state).toBe('armed')
    const b = l.settle(S, 'done')
    expect(b.fulfilled).toHaveLength(0) // armed 不被兑
    expect(deliveredCount(b.targets)).toBe(0)
    expect(l.count()).toBe(1)
  })
})

// ═══ B 族：用户与第三方发起（B1-B4）═══════════════════════════════════════

describe('D10-B 用户与第三方发起（附B B1-B4）', () => {
  it('B1★ A1 后用户 UI 续聊 N 轮 → 全部静默（UI 通道不建债）', () => {
    const l = makeLedger()
    armCreated(l, 'sm-b1', 'sm-b1-lt', true)
    expect(deliveredCount(l.settle(S, 'done').targets)).toBe(1)
    l.onRespond(P, 'sm-b1', true)
    for (let i = 0; i < 3; i++) {
      const b = l.settle(S, 'done') // 用户续聊轮：UI 不 arm → 零兑现
      expect(b.fulfilled).toHaveLength(0)
      expect(deliveredCount(b.targets)).toBe(0)
    }
    expect(l.count()).toBe(1) // 仅 lifetime
  })

  it('B2 用户 run 中再插话 → 不通知（无主请求）', () => {
    const l = makeLedger()
    const b = l.settle(S, 'done') // 插话轮结束的 settle：账本无任何债权
    expect(b.fulfilled).toHaveLength(0)
    expect(deliveredCount(b.targets)).toBe(0)
    expect(l.count()).toBe(0)
  })

  it('B3 scheduler 唤醒 S → settle → 不通知（非主发起，不变量推导）', () => {
    const l = makeLedger()
    armCreated(l, 'sm-b3', 'sm-b3-lt', true)
    expect(deliveredCount(l.settle(S, 'done').targets)).toBe(1)
    l.onRespond(P, 'sm-b3', true)
    // scheduler 唤醒轮（不产生主请求）→ 零兑现
    expect(deliveredCount(l.settle(S, 'done').targets)).toBe(0)
  })

  it('B4 孙会话完成唤醒 S 跑一轮 → 对 P 不通知（异 session 结算不串台；S 自己的债另计）', () => {
    const l = makeLedger()
    armSent(l, 'sm-b4') // P 对 S 的在挂债权
    const g = l.settle('grandchild-1', 'done') // 孙会话的 settle（异 sessionId）
    expect(g.fulfilled).toHaveLength(0)
    expect(deliveredCount(g.targets)).toBe(0)
    expect(l.getClaim(P, 'sm-b4')?.state).toBe('injected') // S 的债权未被孙结算触碰
  })
})

// ═══ C 族：混合插话（C1-C4）═══════════════════════════════════════════════

describe('D10-C 混合插话（附C C1-C4）', () => {
  it('C1★ P 的 run 中用户插话 S → settle → 一条（用户通道不取消债权）', () => {
    const l = makeLedger()
    armSent(l, 'sm-c1')
    // 用户插话不入 ledger（UI 通道零入口）
    const b = l.settle(S, 'done')
    expect(deliveredCount(b.targets)).toBe(1)
    expect(b.targets[0]!.payload).toEqual({ type: 'settled', outcome: 'done', settleSeq: 1, fulfills: 1 })
  })

  it('C2 用户 run 中 P send（steer 入本轮）→ settle → 一条', () => {
    const l = makeLedger()
    armSent(l, 'sm-c2')
    expect(deliveredCount(l.settle(S, 'done').targets)).toBe(1)
  })

  it('C3★ 消息在消费轮才消化 → 在消费轮 settle 通知（P9：受理回执先行 → 首次 settle 即兑现）', () => {
    const l = makeLedger()
    expect(l.arm({ parentSid: P, notifyId: 'sm-c3', kind: 'claim', sessionId: S })).toEqual({ ok: true })
    // sendChecked 不经 busy gate：run 进行中即受理（回执帧先于 settled 帧，P9 FIFO）
    expect(l.markInjected(P, 'sm-c3')).toBe(true)
    expect(l.openWatch(P, 'sm-c3', 'w-sm-c3').action).toBe('wait') // extension 随工具结果开表
    const b = l.settle(S, 'done') // 消费轮的 settle = 兑现锚
    expect(b.fulfilled).toHaveLength(1)
    expect(deliveredCount(b.targets)).toBe(1)
    // 已知边界（设计登记）：turn 末梢 injected 且 pi 不续跑 → 提前兑现，升级路径 = 生效回执锚
  })

  it('C4 P send 后用户插话先到 → 同轮 settle → 恰一条（不叠加）', () => {
    const l = makeLedger()
    armSent(l, 'sm-c4')
    // 用户插话先于 P 消息被消化（同轮）——插话不入 ledger
    const b = l.settle(S, 'done')
    expect(b.targets).toHaveLength(1)
    expect(deliveredCount(b.targets)).toBe(1)
    // 该轮后续不再有兑现源（claim 已 fulfilled 回收）
    expect(l.onRespond(P, 'sm-c4', true)).toBe('deleted')
    expect(deliveredCount(l.settle(S, 'done').targets)).toBe(0)
  })
})

// ═══ D 族：生命周期（D1-D7b）══════════════════════════════════════════════

describe('D10-D 生命周期（附D D1-D7b）', () => {
  it('D1★ 有债权时 S 进程死亡 → 恰一条 exited（同 deathSeq 不叠加；fulfills = claim 数）', () => {
    const l = makeLedger()
    armSent(l, 'sm-d1')
    armCreated(l, 'sm-d1-x', 'sm-d1-lt', false) // 同 session 的 lifetime（带 watch）
    const d = l.onSessionDeath(S, 'exit')
    expect(d.deathSeq).toBe(1)
    expect(d.fulfills).toBe(1) // claim 数（lifetime 不计入 fulfills）
    expect(d.targets).toHaveLength(2) // claim watch + lifetime watch 同批
    for (const t of d.targets) {
      expect(t.payload).toEqual({ type: 'death', cause: 'exit', deathSeq: 1, fulfills: 1 })
    }
    expect(deliveredCount(d.targets)).toBe(1) // 死亡新闻槽：同 (sessionId,deathSeq) 一条
    expect(l.count()).toBe(0) // 即时删除
    // 迟到 exit 腿查无记录自然静默（设计 D5）
    expect(l.onSessionDeath(S, 'exit').targets).toHaveLength(0)
  })

  it('D2★ 无债权时 S 终局死亡 → 恰一条 exited/deleted（裁决2 无条件）', () => {
    const l = makeLedger()
    armCreated(l, 'sm-d2', 'sm-d2-lt', false) // create 无 prompt：只有 lifetime
    const d = l.onSessionDeath(S, 'delete')
    expect(d.deathSeq).toBe(1)
    expect(d.fulfills).toBe(0) // 无 claim 债
    expect(d.targets).toHaveLength(1)
    expect(d.targets[0]!.payload).toEqual({ type: 'death', cause: 'delete', deathSeq: 1, fulfills: 0 })
    expect(deliveredCount(d.targets)).toBe(1)
    expect(l.onRespond(P, 'sm-d2-lt', true)).toBe('absent') // 即时删除：死亡 respond 失败也无册可转
  })

  it('D3★ P abort_session 后 settle(stopped) → 静默销账（零注入零计数）', () => {
    const l = makeLedger()
    armSent(l, 'sm-d3')
    expect(l.arm({ parentSid: P, notifyId: 'sm-d3-lt', kind: 'lifetime', sessionId: S })).toEqual({ ok: true })
    const ab = l.abortClaims(S)
    expect(ab.aborted.map((v) => v.notifyId)).toEqual(['sm-d3']) // 只清 claim，lifetime 不入批
    expect(ab.targets).toHaveLength(1)
    expect(ab.targets[0]!.payload).toEqual({ type: 'aborted' })
    expect(deliveredCount(ab.targets)).toBe(0) // aborted → 静默（D3 例外1）
    expect(l.onRespond(P, 'sm-d3', true)).toBe('deleted')
    // abort 后 await 间隙的 settled('stopped') 不得抢先兑现
    const b = l.settle(S, 'stopped')
    expect(b.fulfilled).toHaveLength(0)
    expect(deliveredCount(b.targets)).toBe(0)
    expect(l.undeliveredCount(S)).toBe(0)
    expect(l.count()).toBe(1) // lifetime 不受 abort 影响
  })

  it('D4★ 用户 UI abort 掐断含债权轮 → settle(stopped) → 一条 stopped（用户干预不取消债权）', () => {
    const l = makeLedger()
    armSent(l, 'sm-d4')
    // 用户 UI 掐断 → pi 级联 settle('stopped')：不走 handleAbort，债权仍在
    const b = l.settle(S, 'stopped')
    expect(b.targets).toHaveLength(1)
    expect(b.targets[0]!.payload).toEqual({ type: 'settled', outcome: 'stopped', settleSeq: 1, fulfills: 1 })
    expect(outcomeStatus((b.targets[0]!.payload as { outcome: SettleOutcome }).outcome)).toBe('stopped')
    expect(deliveredCount(b.targets)).toBe(1)
  })

  it('D5 用户 abort 连带清掉未生效 P 消息 → abort 触发的 settle(stopped) 照常一条', () => {
    const l = makeLedger()
    armSent(l, 'sm-d5') // 消息未被消费（仍在 pi 队列）
    // 用户 UI abort 掐断 run → 级联 settled('stopped')（不经 handleAbort 入口）
    const b = l.settle(S, 'stopped')
    expect(b.fulfilled).toHaveLength(1)
    expect(deliveredCount(b.targets)).toBe(1)
  })

  it('D6 UI 删除 S（有债权）→ 恰一条 deleted（同场 claim/lifetime 同 deathSeq；先于杀进程立 latch）', () => {
    const l = makeLedger()
    armSent(l, 'sm-d6')
    armCreated(l, 'sm-d6-x', 'sm-d6-lt', false)
    const d = l.onSessionDeath(S, 'delete')
    expect(d.deathSeq).toBe(1)
    expect(d.fulfills).toBe(1)
    expect(d.targets.map((t) => t.payload.type)).toEqual(['death', 'death'])
    expect(deliveredCount(d.targets)).toBe(1)
    for (const t of d.targets) expect((t.payload as { cause: string }).cause).toBe('delete')
    // 汇聚点已删记录 → 并发迟到 exit 腿查无记录自然静默（防双事件竞态）
    const late = l.onSessionDeath(S, 'exit')
    expect(late.terminated).toHaveLength(0)
    expect(late.targets).toHaveLength(0)
    expect(l.clearSession(S)).toBe(0) // 全部已删，清剩余计数器
    expect(l.undeliveredCount(S)).toBe(0)
  })

  it('D7a 父 pi 死亡 → 批量 orphaned + warn 素材 + undeliveredResults 计数（触发器②）', () => {
    const l = makeLedger()
    armSent(l, 'sm-d7a-1')
    l.arm({ parentSid: P, notifyId: 'sm-d7a-2', kind: 'claim', sessionId: S }) // 无 watch（arm→watch 微窗）
    armCreated(l, 'sm-d7a-x', 'sm-d7a-lt', false) // lifetime 同批
    const ob = l.orphanByParent(P)
    expect(ob.orphaned).toHaveLength(3) // 该父全部未终结记录
    expect(ob.orphaned.every((v) => v.state === 'orphaned')).toBe(true)
    // warn 素材（notifyId/sessionId）齐备；触发器② 不产 respond（父进程已死）
    expect(ob.orphaned.map((v) => v.notifyId).sort()).toEqual(['sm-d7a-1', 'sm-d7a-2', 'sm-d7a-lt'])
    expect(l.undeliveredCount(S)).toBe(3)
    // 父重启收口腿：迟到 watch → 精确 orphaned 应答（记录在 TTL ≥10min 窗口内仍在）
    const routing = l.openWatch(P, 'sm-d7a-1', 'w-restart')
    expect(routing.action).toBe('respond')
    expect((routing as { target: RespondTarget }).target.payload).toEqual({ type: 'orphaned' })
    expect(deliveredCount([(routing as { target: RespondTarget }).target])).toBe(0) // 静默
    expect(l.onRespond(P, 'sm-d7a-1', true)).toBe('deleted')
  })

  it('D7b runtime 重启账本全失 → 退出时点可读非零计数（shutdown warn 材料）', () => {
    const l = makeLedger()
    armSent(l, 'sm-d7b-1')
    armSent(l, 'sm-d7b-2')
    expect(l.count()).toBe(2) // 非零 claim 退出 → bridge warn 含计数（D7b 裁决：做）
    l.dispose() // dispose 不丢记录（warn 读数在 dispose 前后均在）
    expect(l.count()).toBe(2)
    // 内存态语义（D8 v1）：新实例全新空账本
    const fresh = makeLedger()
    expect(fresh.count()).toBe(0)
    expect(fresh.settle(S, 'done').targets).toHaveLength(0)
  })
})

// ═══ E 族：结构性（E1-E8）═════════════════════════════════════════════════

describe('D10-E 结构性（附E E1-E8）', () => {
  it('E1 嵌套（S 管理孙）逐层独立：各层各自的债权/watch 不串台', () => {
    const l = makeLedger()
    armSent(l, 'sm-e1-l1') // 层1：P → S
    expect(l.arm({ parentSid: S, notifyId: 'sm-e1-l2', kind: 'claim', sessionId: 'grandchild-1' })).toEqual({ ok: true })
    expect(l.markInjected(S, 'sm-e1-l2')).toBe(true)
    l.openWatch(S, 'sm-e1-l2', 'w-e1-l2')
    // 孙结算 → 只兑现层2
    const g = l.settle('grandchild-1', 'done')
    expect(g.fulfilled.map((v) => v.notifyId)).toEqual(['sm-e1-l2'])
    expect(l.getClaim(P, 'sm-e1-l1')?.state).toBe('injected') // 层1 未动
    // 子结算 → 只兑现层1
    const s = l.settle(S, 'done')
    expect(s.fulfilled.map((v) => v.notifyId)).toEqual(['sm-e1-l1'])
    // 父死亡批量也逐层：orphanByParent(S) 只动层2 记录
    expect(l.orphanByParent(S).orphaned.map((v) => v.notifyId)).toEqual(['sm-e1-l2'])
    expect(l.getClaim(P, 'sm-e1-l1')?.state).toBe('fulfilled')
  })

  it('E2 P busy 时通知到达 → ledger 材料产出与父运行状态无关（送达时机归 B-ledger courier）', () => {
    const l = makeLedger()
    armSent(l, 'sm-e2')
    // settle 输入面不含父 busy 状态（签名 = sessionId + outcome）：同一序列恒产出同一材料
    const b1 = l.settle(S, 'done')
    expect(b1.targets).toHaveLength(1)
    // 投递时机（父 settled 边沿 / 看门狗）是送达面职责，不在本状态机
    expect(deliveredCount(b1.targets)).toBe(1)
  })

  it('E3 watch 开表时 S 已 idle（超快完成）→ 立即 respond 快照（catch-up）', () => {
    const l = makeLedger()
    l.arm({ parentSid: P, notifyId: 'sm-e3', kind: 'claim', sessionId: S })
    l.markInjected(P, 'sm-e3')
    const b = l.settle(S, 'done') // settle 时尚无 watch（targets 空、记录保留）
    expect(b.targets).toHaveLength(0)
    expect(l.getClaim(P, 'sm-e3')?.state).toBe('fulfilled') // catch-up 布尔式查询
    const routing = l.openWatch(P, 'sm-e3', 'w-e3') // 迟到开表 → 立即应答快照
    expect(routing.action).toBe('respond')
    expect((routing as { target: RespondTarget }).target.payload).toEqual({
      type: 'settled',
      outcome: 'done',
      settleSeq: 1,
      fulfills: 1,
    })
    expect(l.onRespond(P, 'sm-e3', true)).toBe('deleted')
    expect(l.count()).toBe(0)
  })

  it('E4 旧 runtime 不识 watch → 台账级等价：查无 claim fail-closed + 零材料零通知', () => {
    // 旧 runtime 无本账本 = 任何 watch 查无 claim（bridge 折叠静默）；新账本零 arm 恒零材料
    const fresh = makeLedger()
    expect(fresh.openWatch(P, 'sm-e4', 'w-e4')).toEqual({ action: 'fail-closed' })
    expect(fresh.settle(S, 'done').targets).toHaveLength(0)
    expect(deliveredCount(fresh.settle(S, 'done').targets)).toBe(0)
  })

  it('E5★ watch 永不到达且 claim 已 fulfilled → TTL 清扫转 orphaned → undeliveredResults 提示', () => {
    const l = makeLedger()
    l.arm({ parentSid: P, notifyId: 'sm-e5', kind: 'claim', sessionId: S })
    l.markInjected(P, 'sm-e5')
    expect(l.settle(S, 'done').targets).toHaveLength(0) // extension 未开表
    clock += TTL - 1
    expect(l.sweep().orphaned).toHaveLength(0) // 未达 TTL
    clock += 1
    const s = l.sweep()
    expect(s.orphaned.map((v) => v.notifyId)).toEqual(['sm-e5'])
    expect(s.respondOrphaned).toHaveLength(0) // 无 watch：仅状态转移
    expect(l.getClaim(P, 'sm-e5')?.state).toBe('orphaned')
    expect(l.undeliveredCount(S)).toBe(1)
    expect(l.count()).toBe(1) // orphaned 保留供提示与迟到收口
  })

  it('E6★ orphaned 后迟到 watch → respond orphaned → 静默 unregister-only', () => {
    const l = makeLedger()
    armSent(l, 'sm-e6')
    l.orphanByParent(P) // 触发器② → orphaned
    const routing = l.openWatch(P, 'sm-e6', 'w-e6-late')
    expect(routing.action).toBe('respond')
    const target = (routing as { target: RespondTarget }).target
    expect(target.payload).toEqual({ type: 'orphaned' })
    expect(deliveredCount([target])).toBe(0) // 例外1：静默
    expect(l.onRespond(P, 'sm-e6', true)).toBe('deleted')
  })

  it('E7★ send 受理失败 → 零通知零 undelivered（armed 静默 disarm）', () => {
    const l = makeLedger()
    expect(l.arm({ parentSid: P, notifyId: 'sm-e7', kind: 'claim', sessionId: S })).toEqual({ ok: true })
    expect(l.disarmDeliveryFailed(P, 'sm-e7')).toBe(true)
    expect(l.count()).toBe(0)
    expect(l.disarmDeliveryFailed(P, 'sm-e7')).toBe(false) // 已删：重复 disarm 幂等拒绝
    const b = l.settle(S, 'done')
    expect(b.fulfilled).toHaveLength(0)
    expect(deliveredCount(b.targets)).toBe(0)
    expect(l.undeliveredCount(S)).toBe(0) // 不入 TTL→orphaned 幽灵提示
    expect(l.openWatch(P, 'sm-e7', 'w-e7')).toEqual({ action: 'fail-closed' }) // 迟到开表静默
    clock += TTL * 2
    const s = l.sweep()
    expect(s.orphaned).toHaveLength(0)
    expect(l.undeliveredCount(S)).toBe(0)
  })

  it('E8★ crash → 5s respawn 复活：无 lifetime 发声；在挂 claim TTL→orphaned 提示，lifetime 存活待终局', () => {
    const l = makeLedger()
    armSent(l, 'sm-e8-claim')
    armCreated(l, 'sm-e8-x', 'sm-e8-lt', false) // lifetime（watch 已挂）
    // respawn 链静默 = bridge 不调 onSessionDeath → 此处无死亡事件
    clock += TTL
    const s = l.sweep()
    expect(s.orphaned.map((v) => v.notifyId)).toEqual(['sm-e8-claim']) // 在挂 claim 提示
    expect(l.undeliveredCount(S)).toBe(1)
    expect(s.respondOrphaned.map((t) => t.notifyId)).toEqual(['sm-e8-claim']) // watch 已挂 → 同步 respond 信号
    expect(l.getClaim(P, 'sm-e8-lt')?.state).toBe('armed') // lifetime 豁免 TTL：健康稳态
    // 复活后再承新债、终局死亡仍发声（裁决2 存活）
    armSent(l, 'sm-e8-new')
    const d = l.onSessionDeath(S, 'exit')
    expect(d.targets.map((t) => t.notifyId).sort()).toEqual(['sm-e8-lt', 'sm-e8-new'])
    expect(deliveredCount(d.targets)).toBe(1) // 槽内一条（claim 债 + lifetime 同 deathSeq 不叠加）
    expect(d.fulfills).toBe(1)
  })
})

// ═══ P9 事件序（prompt 回执帧先于 settled 帧的兑现时序）════════════════════

describe('P9 事件序（兑现锚时序）', () => {
  it('send 路径 FIFO：受理回执（onSettled delivered → markInjected）先于 settled 帧 → 首次 settle 即兑现', () => {
    const l = makeLedger()
    expect(l.arm({ parentSid: P, notifyId: 'sm-p9-a', kind: 'claim', sessionId: S })).toEqual({ ok: true })
    // 帧序（P9）：prompt 受理回执帧先写于其后 agent_settled 帧
    expect(l.markInjected(P, 'sm-p9-a')).toBe(true)
    expect(l.openWatch(P, 'sm-p9-a', 'w-p9-a').action).toBe('wait')
    const b = l.settle(S, 'done')
    expect(b.fulfilled).toHaveLength(1)
    expect(b.settleSeq).toBe(1)
    expect(deliveredCount(b.targets)).toBe(1)
  })

  it('逆序兜底：settled 先于回执到达 → armed 态不动（不假兑现），回执后下一次 settle 兑现', () => {
    const l = makeLedger()
    l.arm({ parentSid: P, notifyId: 'sm-p9-b', kind: 'claim', sessionId: S })
    const early = l.settle(S, 'done') // armed 窗内到达的 settle：不兑现（D4）
    expect(early.fulfilled).toHaveLength(0)
    expect(early.settleSeq).toBe(0) // 空批不占号
    expect(l.getClaim(P, 'sm-p9-b')?.state).toBe('armed')
    expect(l.markInjected(P, 'sm-p9-b')).toBe(true) // 回执晚到
    const b = l.settle(S, 'done')
    expect(b.fulfilled).toHaveLength(1)
    expect(b.settleSeq).toBe(1)
  })

  it('create 路径：arm(claim+lifetime) → sendDirect 受理回执 → settle 只兑现 claim、lifetime 不动', () => {
    const l = makeLedger()
    l.arm({ parentSid: P, notifyId: 'sm-p9-c', kind: 'claim', sessionId: S })
    l.arm({ parentSid: P, notifyId: 'sm-p9-c-lt', kind: 'lifetime', sessionId: S })
    // 桥接对两键都发受理回执（lifetime 进 injected 也无妨——kind 守卫双保险）
    expect(l.markInjected(P, 'sm-p9-c')).toBe(true)
    expect(l.markInjected(P, 'sm-p9-c-lt')).toBe(true)
    const b = l.settle(S, 'done')
    expect(b.fulfilled.map((v) => v.notifyId)).toEqual(['sm-p9-c'])
    expect(b.targets).toHaveLength(0) // 未开表时零 respond
    expect(l.getClaim(P, 'sm-p9-c-lt')?.state).toBe('injected') // lifetime 未被兑现（仅死亡终结）
    const d = l.onSessionDeath(S, 'exit')
    expect(d.targets).toHaveLength(0) // 均无 watch → 无应答对象（死亡批量仍即时删除）
    expect(d.terminated.map((v) => v.notifyId).sort()).toEqual(['sm-p9-c', 'sm-p9-c-lt'])
    expect(l.count()).toBe(0) // 任意未终结（含 fulfilled）全批终结删除
  })
})
