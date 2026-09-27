/**
 * TOPIC_TABLE ↔ STATE_TYPE_KEY_MAP 一致性守卫（code-harden RT-1#5）。
 *
 * 此前风险只在 message-bus.ts 注释里自认（「state 类未映射 typeKey 则静默不写快照，
 * 重连投影失效」），无机器守卫——新增 state 类型漏登记 STATE_TYPE_KEY_MAP 时零红灯、
 * 零日志。本文件把该风险变成测试期守卫：
 *
 * 不变量：TOPIC_TABLE 中每个 'state' 类 type 的 typeKey 出处必须三居其一（scheduler-widget-push
 * D3 扩展为两形态登记 + 例外白名单）：
 * ① 静态映射——STATE_TYPE_KEY_MAP 有 typeKey（type → 固定 key，写快照、重连可回放）；
 * ② 派生登记——STATE_TYPE_KEY_PAYLOAD_DERIVED 有派生函数（type → 从 payload 派生 key，
 *    widget 帧的 (session, widgetKey) 粒度去重）；派生 miss（如 widgetKey 缺失/空串）时
 *    运行时按 state-no-key 同款处理（不入快照 + warn 一次，live 不变）；
 * ③ 例外白名单——STATE_NO_KEY_TOPICS 显式登记（带设计理由，现仅
 *    session.subagentEntriesAppended 一例：增量流非 last-value，靠 reducer 幂等 + 快照拉取对账）。
 * 三者都不满足 = 漂移，本测试红。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/message-bus/__tests__/state-type-key-map-guard.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  TOPIC_TABLE,
  STATE_TYPE_KEY_MAP,
  STATE_TYPE_KEY_PAYLOAD_DERIVED,
  STATE_NO_KEY_TOPICS,
} from '../message-bus.js'

describe('TOPIC_TABLE ↔ STATE_TYPE_KEY_MAP 一致性守卫（RT-1#5）', () => {
  it('每个 state 类 type 都有 typeKey 出处（静态映射 / 派生登记 / 例外白名单三居其一，漏登记即红）', () => {
    const drift: string[] = []
    for (const [type, kind] of Object.entries(TOPIC_TABLE)) {
      if (kind !== 'state') continue
      if (STATE_NO_KEY_TOPICS.has(type)) continue
      if (type in STATE_TYPE_KEY_MAP) continue
      if (type in STATE_TYPE_KEY_PAYLOAD_DERIVED) continue
      drift.push(type)
    }
    expect(
      drift,
      `state 类 type 无 typeKey 出处（重连投影将静默失效）：${drift.join(', ')}——补静态映射 STATE_TYPE_KEY_MAP，或载荷派生形态登记进 STATE_TYPE_KEY_PAYLOAD_DERIVED，或确属 state-no-key 形态时登记进 STATE_NO_KEY_TOPICS 并附理由`,
    ).toEqual([])
  })

  it('例外白名单不空转：每项都真实登记为 state 类（例外清单自身不漂移）', () => {
    const stale: string[] = []
    for (const type of STATE_NO_KEY_TOPICS) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_NO_KEY_TOPICS 存在非 state 类条目（例外已失效，应移除）：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('STATE_TYPE_KEY_MAP 不含非 state 类条目（映射表自身不漂移）', () => {
    const stale: string[] = []
    for (const type of Object.keys(STATE_TYPE_KEY_MAP)) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_TYPE_KEY_MAP 存在 TOPIC_TABLE 未登记为 state 类的条目：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('STATE_TYPE_KEY_PAYLOAD_DERIVED 不含非 state 类条目（派生登记表自身不漂移）', () => {
    const stale: string[] = []
    for (const type of Object.keys(STATE_TYPE_KEY_PAYLOAD_DERIVED)) {
      if (TOPIC_TABLE[type] !== 'state') stale.push(type)
    }
    expect(
      stale,
      `STATE_TYPE_KEY_PAYLOAD_DERIVED 存在 TOPIC_TABLE 未登记为 state 类的条目：${stale.join(', ')}`,
    ).toEqual([])
  })

  it('已知例外 session.subagentEntriesAppended 在白名单内（锚定既有 state-no-key 形态）', () => {
    expect(STATE_NO_KEY_TOPICS.has('session.subagentEntriesAppended')).toBe(true)
  })

  it('widget 两类型在派生登记表内（锚定 scheduler-widget-push D3 的载荷派生形态）', () => {
    // 锚定意图：widget 帧的快照去重粒度是 (session, widgetKey)，必须走派生登记而非
    // 静态 key（静态 key 会让同 session 多个 widget 互相覆盖）。若未来改回静态映射
    // 或移除派生登记，本断言红——改动者须确认快照粒度语义后同步本文件。
    expect('extension:widget' in STATE_TYPE_KEY_PAYLOAD_DERIVED).toBe(true)
    expect('extension:widgetGui' in STATE_TYPE_KEY_PAYLOAD_DERIVED).toBe(true)
    // 不应同时出现在静态表（一 type 只一形态，防双源歧义）
    expect('extension:widget' in STATE_TYPE_KEY_MAP).toBe(false)
    expect('extension:widgetGui' in STATE_TYPE_KEY_MAP).toBe(false)
  })
})
