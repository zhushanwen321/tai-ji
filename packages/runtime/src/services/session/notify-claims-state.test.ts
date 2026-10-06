/**
 * ClaimLedger 单测 —— 状态机腿 / TTL 清扫 / seq 计数器 / session 清理 / 幂等不变量。
 *
 * 与 notify-claims.test.ts（D10 矩阵 32 case + P9 事件序）互补：本文件覆盖矩阵行之外的
 * 状态机边角（重复 arm、投递失败腿作用域、单 watch 槽覆盖、orphan 双触发器细节、
 * TTL 下界钳制与三类扫描、per-session 计数器、clearSession 边界、贯穿不变量）。
 *
 * 材料形态：零 I/O 纯状态机 + 注入手动时钟（__tests__/helpers/notify-claims-harness.ts
 * 的 setClock/advance）；vitest fake timers 保证工厂内 TTL 清扫 setInterval 不落真实
 * 事件循环（规则：timer 测试用 fake timers）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimLedger, RespondTarget } from './notify-claims.js'
import { createLedgerHarness, P, S, TTL } from './__tests__/helpers/notify-claims-harness.js'

const h = createLedgerHarness()
const { makeLedger } = h

beforeEach(() => {
  vi.useFakeTimers()
  h.reset()
})

afterEach(() => {
  h.disposeAll()
  vi.useRealTimers()
})

/** 送达投影（设计 D3：settled/death 发声，aborted/orphaned 静默——生产映射在 u-bridge）。 */
function delivered(t: RespondTarget): number {
  if (t.payload.type === 'settled') return 1
  if (t.payload.type === 'death') return 1
  return 0
}

function armClaim(l: ClaimLedger, notifyId: string, opts?: { parent?: string; session?: string }): void {
  expect(
    l.arm({
      parentSid: opts?.parent ?? P,
      notifyId,
      kind: 'claim',
      sessionId: opts?.session ?? S,
    }),
  ).toEqual({ ok: true })
}

// ─── 状态机腿 ───────────────────────────────────────────────────────────────

describe('ClaimLedger 状态机腿', () => {
  it('同键重复 arm 拒绝（armed/injected/fulfilled 任意既有态；键 = (parentSid, notifyId)）', () => {
    const l = makeLedger()
    const p = { parentSid: P, notifyId: 'sm-dup', kind: 'claim' as const, sessionId: S }
    expect(l.arm(p)).toEqual({ ok: true })
    expect(l.arm(p)).toEqual({ ok: false, reason: 'duplicate' }) // armed 态
    expect(l.markInjected(P, 'sm-dup')).toBe(true)
    expect(l.arm(p)).toEqual({ ok: false, reason: 'duplicate' }) // injected 态
    l.settle(S, 'done')
    expect(l.arm(p)).toEqual({ ok: false, reason: 'duplicate' }) // fulfilled 态
    expect(l.count()).toBe(1)
    // 异 parentSid 同 notifyId = 不同键（键含 parentSid，D2 结构）
    expect(l.arm({ parentSid: 'other-parent', notifyId: 'sm-dup', kind: 'claim', sessionId: S })).toEqual({ ok: true })
  })

  it('armed --delivery-failed--> 删除腿只作用 armed（受理后不得静默抹除；重复 disarm 幂等）', () => {
    const l = makeLedger()
    armClaim(l, 'sm-df-1')
    expect(l.disarmDeliveryFailed(P, 'sm-df-1')).toBe(true)
    expect(l.getClaim(P, 'sm-df-1')).toBeUndefined()
    expect(l.disarmDeliveryFailed(P, 'sm-df-1')).toBe(false) // 已删
    armClaim(l, 'sm-df-2')
    expect(l.markInjected(P, 'sm-df-2')).toBe(true)
    expect(l.disarmDeliveryFailed(P, 'sm-df-2')).toBe(false) // 已受理 → 腿不适用
    expect(l.getClaim(P, 'sm-df-2')?.state).toBe('injected')
    expect(l.disarmDeliveryFailed(P, 'sm-missing')).toBe(false)
  })

  it('markInjected 只转移 armed→injected（重复回执 / 终态回执 / 查无 → false）', () => {
    const l = makeLedger()
    armClaim(l, 'sm-inj')
    expect(l.markInjected(P, 'sm-inj')).toBe(true)
    expect(l.markInjected(P, 'sm-inj')).toBe(false) // 已 injected
    l.settle(S, 'done')
    expect(l.markInjected(P, 'sm-inj')).toBe(false) // fulfilled
    expect(l.markInjected(P, 'sm-none')).toBe(false)
  })

  it('单 watch 槽：新 watch 覆盖旧（coveredWatchId 回报）、runtime 只 respond 最新', () => {
    const l = makeLedger()
    armClaim(l, 'sm-slot')
    expect(l.markInjected(P, 'sm-slot')).toBe(true)
    expect(l.openWatch(P, 'sm-slot', 'w1')).toEqual({ action: 'wait' })
    expect(l.openWatch(P, 'sm-slot', 'w2')).toEqual({ action: 'wait', coveredWatchId: 'w1' })
    const b = l.settle(S, 'done')
    expect(b.targets).toHaveLength(1) // 单槽 → 恰一条 respond，指向最新 watch
    expect(b.targets[0]!.watchId).toBe('w2')
  })

  it('watch 路由三态：查无 fail-closed / 未兑现 wait / 已终结（aborted）立即 respond', () => {
    const l = makeLedger()
    expect(l.openWatch(P, 'sm-none', 'w')).toEqual({ action: 'fail-closed' })
    armClaim(l, 'sm-wait')
    expect(l.openWatch(P, 'sm-wait', 'w1')).toEqual({ action: 'wait' })
    // aborted（主 abort 挂 watch 保留至 onRespond）→ 迟到 watch 立即应答终态素材
    const ab = l.abortClaims(S)
    expect(ab.targets).toHaveLength(1)
    const again = l.openWatch(P, 'sm-wait', 'w2')
    expect(again.action).toBe('respond')
    expect((again as { target: RespondTarget }).target.payload).toEqual({ type: 'aborted' })
    expect(delivered((again as { target: RespondTarget }).target)).toBe(0) // 静默
    expect(l.onRespond(P, 'sm-wait', true)).toBe('deleted')
  })

  it('abort 无 watch 的 claim 当场静默删除；lifetime 不受 abort 触碰', () => {
    const l = makeLedger()
    armClaim(l, 'sm-ab-1') // claim，无 watch
    expect(l.arm({ parentSid: P, notifyId: 'sm-ab-lt', kind: 'lifetime', sessionId: S })).toEqual({ ok: true })
    const ab = l.abortClaims(S)
    expect(ab.aborted.map((v) => v.notifyId)).toEqual(['sm-ab-1']) // 快照含无 watch 者
    expect(ab.targets).toHaveLength(0) // 均无 watch → 零 respond
    expect(l.getClaim(P, 'sm-ab-1')).toBeUndefined() // 当场删除
    expect(l.getClaim(P, 'sm-ab-lt')?.state).toBe('armed') // lifetime 健在（D1 债权定义不入 abort）
  })
})

// ─── orphan 双触发器 ────────────────────────────────────────────────────────

describe('ClaimLedger orphan 双触发器', () => {
  it('触发器① respond 失败 → orphaned + 计数；重复失败 noop 不双计；成功即删', () => {
    const l = makeLedger()
    armClaim(l, 'sm-rf')
    expect(l.markInjected(P, 'sm-rf')).toBe(true)
    l.openWatch(P, 'sm-rf', 'w-rf')
    const b = l.settle(S, 'done')
    expect(b.targets).toHaveLength(1)
    expect(l.onRespond(P, 'sm-rf', false)).toBe('orphaned') // 触发器①
    expect(l.getClaim(P, 'sm-rf')?.state).toBe('orphaned')
    expect(l.undeliveredCount(S)).toBe(1)
    expect(l.onRespond(P, 'sm-rf', false)).toBe('noop') // 吸收态不双计
    expect(l.undeliveredCount(S)).toBe(1)
    // 迟到 watch → orphaned 应答（静默），成功回执即删
    const late = l.openWatch(P, 'sm-rf', 'w-late')
    expect((late as { target: RespondTarget }).target.payload).toEqual({ type: 'orphaned' })
    expect(l.onRespond(P, 'sm-rf', true)).toBe('deleted')
    expect(l.count()).toBe(0)
    expect(l.onRespond(P, 'sm-rf', true)).toBe('absent')
  })

  it('触发器② 父死亡批量：仅未终结记录参与（orphaned/aborted 终结态排除），计数按子会话分桶', () => {
    const l = makeLedger()
    // claimA（session SA）：abort 后保留为 aborted（终结态）
    armClaim(l, 'sm-ob-a', { session: 'child-a' })
    expect(l.markInjected(P, 'sm-ob-a')).toBe(true)
    l.openWatch(P, 'sm-ob-a', 'w-a')
    expect(l.abortClaims('child-a').targets).toHaveLength(1)
    // claimB（session SB）：armed 在挂
    armClaim(l, 'sm-ob-b', { session: 'child-b' })
    const ob = l.orphanByParent(P)
    expect(ob.orphaned.map((v) => v.notifyId)).toEqual(['sm-ob-b']) // aborted 不参与
    expect(l.getClaim(P, 'sm-ob-a')?.state).toBe('aborted')
    expect(l.undeliveredCount('child-a')).toBe(0)
    expect(l.undeliveredCount('child-b')).toBe(1) // 分桶：计数落 claim 所属子会话
  })
})

// ─── TTL 清扫 ───────────────────────────────────────────────────────────────

describe('ClaimLedger 计数器与 session 清理', () => {
  it('settleSeq/deathSeq per-session 递增：跨 session 独立、空批不占号', () => {
    const l = makeLedger()
    const other = 'child-2'
    expect(l.settle(S, 'done').settleSeq).toBe(0) // 空批不占号
    armClaim(l, 'sm-sq-1')
    expect(l.markInjected(P, 'sm-sq-1')).toBe(true)
    expect(l.settle(S, 'done').settleSeq).toBe(1)
    armClaim(l, 'sm-sq-2')
    expect(l.markInjected(P, 'sm-sq-2')).toBe(true)
    expect(l.settle(S, 'done').settleSeq).toBe(2)
    armClaim(l, 'sm-sq-3', { session: other })
    expect(l.markInjected(P, 'sm-sq-3')).toBe(true)
    expect(l.settle(other, 'done').settleSeq).toBe(1) // 独立计数
    expect(l.onSessionDeath(S, 'exit').deathSeq).toBe(1)
    expect(l.onSessionDeath(other, 'exit').deathSeq).toBe(1)
    expect(l.onSessionDeath('child-3', 'exit').deathSeq).toBe(0) // 无记录空批不占号
  })

  it('session 删除清理：记录 + settleSeq/deathSeq/undelivered 计数器全清（子会话侧）', () => {
    const l = makeLedger()
    armClaim(l, 'sm-cl-1')
    expect(l.markInjected(P, 'sm-cl-1')).toBe(true)
    expect(l.settle(S, 'done').settleSeq).toBe(1) // 兑现 seq 已占 1 号
    armClaim(l, 'sm-cl-2') // armed 在挂
    // 父死亡批量：fulfilled（未终结）与 armed 均入批 → 两条 orphaned、计数 2
    expect(l.orphanByParent(P).orphaned).toHaveLength(2)
    expect(l.undeliveredCount(S)).toBe(2)
    expect(l.arm({ parentSid: P, notifyId: 'sm-cl-lt', kind: 'lifetime', sessionId: S })).toEqual({ ok: true })
    expect(l.clearSession(S)).toBe(3) // sm-cl-1 + sm-cl-2 + lifetime
    expect(l.count()).toBe(0)
    expect(l.undeliveredCount(S)).toBe(0) // 计数器随 session 消亡清零
    // seq 清零：同 sessionId 再建债（生产中 sessionId 不复用，此处断言计数器确已重置）
    armClaim(l, 'sm-cl-3')
    expect(l.markInjected(P, 'sm-cl-3')).toBe(true)
    expect(l.settle(S, 'done').settleSeq).toBe(1)
  })

  it('clearSession 只清子会话侧（parent 角色记录由 orphanByParent 负责，不越权）', () => {
    const l = makeLedger()
    // S 作为 parent 持有的子债（sessionId = other-child）
    armClaim(l, 'sm-pr', { parent: S, session: 'other-child' })
    // other-child 自己的债（sessionId = other-child，parent = P）
    armClaim(l, 'sm-oc', { parent: P, session: 'other-child' })
    expect(l.clearSession(S)).toBe(0) // S 作为子会话侧零记录
    expect(l.getClaim(S, 'sm-pr')).toBeDefined() // parent 角色不动
    expect(l.getClaim(P, 'sm-oc')).toBeDefined()
    expect(l.clearSession('other-child')).toBe(2) // 子会话侧两键全清（含 parent=S 的那条）
    expect(l.count()).toBe(0)
    expect(l.orphanByParent(S).orphaned).toHaveLength(0) // 已随子会话清理
  })
})

// ─── 贯穿不变量 ─────────────────────────────────────────────────────────────

describe('ClaimLedger 贯穿不变量（D10 尾注）', () => {
  it('任意混合序列：每个 notifyId 至多（且恰一）条送达通知；无债权 settle 零通知', () => {
    const l = makeLedger()
    const notified: string[] = []
    const deathSlots = new Set<string>()
    /** 模拟桥接：respond 全部素材 + 成功回执（death 批次记录已删 → absent 空转）；
     *  送达计数带死亡新闻槽（同 (sessionId,deathSeq) 首条发声，D3 例外2）。 */
    const respondAndConfirm = (targets: RespondTarget[]): void => {
      for (const t of targets) {
        if (t.payload.type === 'settled') {
          notified.push(t.notifyId)
        } else if (t.payload.type === 'death') {
          const slot = `${t.sessionId}|${t.payload.deathSeq}`
          if (!deathSlots.has(slot)) {
            deathSlots.add(slot)
            notified.push(t.notifyId)
          }
        }
        expect(l.onRespond(t.parentSid, t.notifyId, true)).not.toBe('orphaned')
      }
    }
    // ① send 兑现 + 确认
    armClaim(l, 'sm-i1')
    expect(l.markInjected(P, 'sm-i1')).toBe(true)
    l.openWatch(P, 'sm-i1', 'w-i1')
    respondAndConfirm(l.settle(S, 'done').targets)
    // ② catch-up 兑现（settle 无 watch，迟到开表）
    armClaim(l, 'sm-i2')
    expect(l.markInjected(P, 'sm-i2')).toBe(true)
    expect(l.settle(S, 'done').targets).toHaveLength(0)
    const catchup = l.openWatch(P, 'sm-i2', 'w-i2')
    respondAndConfirm([(catchup as { target: RespondTarget }).target])
    // ③ 死亡批量（claim + lifetime 同 deathSeq → 槽内一条）
    armClaim(l, 'sm-i3')
    expect(l.arm({ parentSid: P, notifyId: 'sm-i3-lt', kind: 'lifetime', sessionId: S })).toEqual({ ok: true })
    l.openWatch(P, 'sm-i3', 'w-i3')
    l.openWatch(P, 'sm-i3-lt', 'w-i3-lt')
    respondAndConfirm(l.onSessionDeath(S, 'exit').targets)
    // ④ 父死亡 + 迟到 watch → orphaned 静默（零送达）
    armClaim(l, 'sm-i4')
    l.orphanByParent(P)
    const late = l.openWatch(P, 'sm-i4', 'w-i4')
    expect(delivered((late as { target: RespondTarget }).target)).toBe(0)
    expect(l.onRespond(P, 'sm-i4', true)).toBe('deleted')
    // ⑤ 无债权 settle 恒零
    expect(l.settle(S, 'done').targets).toHaveLength(0)

    // 每 notifyId 至多一条（幂等）且恰一条（该送达的都送达了）
    const counts = new Map<string, number>()
    for (const id of notified) counts.set(id, (counts.get(id) ?? 0) + 1)
    expect([...counts.entries()].sort()).toEqual([
      ['sm-i1', 1],
      ['sm-i2', 1],
      ['sm-i3', 1],
      // lifetime（sm-i3-lt）与死亡槽共享一条 → 自身不单独计
    ])
    // 活跃集口径：全部素材确认完毕 → 在册仅剩已清状态（无悬挂记录）
    expect(l.count()).toBe(0)
    expect(l.undeliveredCount(S)).toBe(1) // 仅 ④ orphan 计数
  })

  it('无债权 settle 必零通知（B 族不变量跨形态）：空账本 / 仅 lifetime / 仅 armed 均零', () => {
    const l = makeLedger()
    expect(l.settle(S, 'done').targets).toHaveLength(0)
    expect(l.settle(S, 'error').targets).toHaveLength(0)
    expect(l.settle(S, 'stopped').targets).toHaveLength(0)
    expect(l.arm({ parentSid: P, notifyId: 'sm-lt-only', kind: 'lifetime', sessionId: S })).toEqual({ ok: true })
    expect(l.settle(S, 'done').targets).toHaveLength(0)
    armClaim(l, 'sm-armed-only') // armed 不兑现（D4）
    expect(l.settle(S, 'done').targets).toHaveLength(0)
    expect(l.settle(S, 'done').fulfilled).toHaveLength(0)
  })
})
