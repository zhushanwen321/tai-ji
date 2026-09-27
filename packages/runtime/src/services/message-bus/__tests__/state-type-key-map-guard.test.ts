/**
 * TOPIC_TABLE ↔ STATE_TYPE_KEY_MAP 一致性守卫（code-harden RT-1#5）。
 *
 * 此前风险只在 message-bus.ts 注释里自认（「state 类未映射 typeKey 则静默不写快照，
 * 重连投影失效」），无机器守卫——新增 state 类型漏登记 STATE_TYPE_KEY_MAP 时零红灯、
 * 零日志。本文件把该风险变成测试期守卫：
 *
 * 不变量：TOPIC_TABLE 中每个 'state' 类 type，要么在 STATE_TYPE_KEY_MAP 有 typeKey 映射
 * （写快照、重连可回放），要么显式登记进 STATE_NO_KEY_TOPICS 例外白名单（带设计理由，
 * 现仅 session.subagentEntriesAppended 一例）。两者都不满足 = 漂移，本测试红。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/message-bus/__tests__/state-type-key-map-guard.test.ts
 */
import { describe, it, expect } from 'vitest'
import { TOPIC_TABLE, STATE_TYPE_KEY_MAP, STATE_NO_KEY_TOPICS } from '../message-bus.js'

describe('TOPIC_TABLE ↔ STATE_TYPE_KEY_MAP 一致性守卫（RT-1#5）', () => {
  it('每个 state 类 type 都有 typeKey 映射或在例外白名单（漏登记即红）', () => {
    const drift: string[] = []
    for (const [type, kind] of Object.entries(TOPIC_TABLE)) {
      if (kind !== 'state') continue
      if (STATE_NO_KEY_TOPICS.has(type)) continue
      if (!(type in STATE_TYPE_KEY_MAP)) drift.push(type)
    }
    expect(
      drift,
      `state 类 type 缺 STATE_TYPE_KEY_MAP 映射（重连投影将静默失效）：${drift.join(', ')}——补映射，或确属 state-no-key 形态时登记进 STATE_NO_KEY_TOPICS 并附理由`,
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

  it('已知例外 session.subagentEntriesAppended 在白名单内（锚定既有 state-no-key 形态）', () => {
    expect(STATE_NO_KEY_TOPICS.has('session.subagentEntriesAppended')).toBe(true)
  })
})
