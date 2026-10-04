// ack 反馈纯逻辑测试（dev-flow u-ack-fallback 单元）。
//
// 覆盖三块，全为零 FS / 零 pi 依赖的纯函数断言：
//   1. shouldNotifyUnpersisted 四组合真值表（重点：慢速真实轮 >30s 不得误报）；
//   2. dedup 记账语义（同键一次 / 异键各一次 / clear 全清）；
//   3. i18n 两组 key 在 zh/en 双侧存在且可渲染（含插值），并负向断言文案不含
//      「已持久化 / persisted to disk」之类越界承诺。
//
// 通知分类已不在本模块：可通知形态由 `AckNotifyReason` 类型本身收窄（两种），其余 E 形态
// 在类型层就进不了通知路径（见 types.ts 与 ack-turn.notifyHonest 的调用点）。

import { describe, expect, it } from 'vitest'

import { createAckNotifyDedup, shouldNotifyUnpersisted } from '../ack-notify.js'
import { ACK_CONFIRM_KEY, ACK_NOT_PERSISTED_KEY, dictionaryKeys, t } from '../i18n.js'
import type { UiLocale } from '../i18n.js'

/** 双侧 locale 字面量（显式类型标注，避免散落的 `as const` / 断言）。 */
const LOCALES: readonly UiLocale[] = ['zh-CN', 'en-US']

// ── 1. 30s 写盘自检判定 ──

describe('shouldNotifyUnpersisted：文件存在 × ack 轮启动', () => {
  const WRITE_CHECK_TABLE: readonly {
    sessionFileExists: boolean
    ackTurnStarted: boolean
    expected: boolean
  }[] = [
    { sessionFileExists: true, ackTurnStarted: true, expected: false },
    { sessionFileExists: true, ackTurnStarted: false, expected: false },
    { sessionFileExists: false, ackTurnStarted: true, expected: false },
    { sessionFileExists: false, ackTurnStarted: false, expected: true },
  ]

  for (const { sessionFileExists, ackTurnStarted, expected } of WRITE_CHECK_TABLE) {
    it(`file=${String(sessionFileExists)} turnStarted=${String(ackTurnStarted)} ⇒ ${String(expected)}`, () => {
      expect(shouldNotifyUnpersisted({ sessionFileExists, ackTurnStarted })).toBe(expected)
    })
  }

  it('慢速真实轮 >30s：文件未落盘但 ack 轮已启动 ⇒ 不误报', () => {
    // 30s 是自检窗口不是写盘期限；ackTurnStarted=true 时「文件不存在」不构成未落盘证据。
    expect(shouldNotifyUnpersisted({ sessionFileExists: false, ackTurnStarted: true })).toBe(false)
  })

  it('两个条件都为真才通知（德摩根等价锚定）', () => {
    for (const sessionFileExists of [true, false]) {
      for (const ackTurnStarted of [true, false]) {
        expect(shouldNotifyUnpersisted({ sessionFileExists, ackTurnStarted })).toBe(
          !sessionFileExists && !ackTurnStarted,
        )
      }
    }
  })
})

// ── 2. 去重 ──

describe('createAckNotifyDedup：同 key 只发一次', () => {
  it('同 key 第二次返回 false', () => {
    const dedup = createAckNotifyDedup()
    expect(dedup.shouldNotify('s1:t1')).toBe(true)
    expect(dedup.shouldNotify('s1:t1')).toBe(false)
    expect(dedup.shouldNotify('s1:t1')).toBe(false)
  })

  it('不同 key 各自首次 true（互不串扰）', () => {
    const dedup = createAckNotifyDedup()
    expect(dedup.shouldNotify('s1:t1')).toBe(true)
    expect(dedup.shouldNotify('s1:t2')).toBe(true)
    expect(dedup.shouldNotify('s2:t1')).toBe(true)
    // 各键二次调用各自 false
    expect(dedup.shouldNotify('s1:t1')).toBe(false)
    expect(dedup.shouldNotify('s1:t2')).toBe(false)
    expect(dedup.shouldNotify('s2:t1')).toBe(false)
  })

  it('clear() 全清后可再发全部 key', () => {
    const dedup = createAckNotifyDedup()
    dedup.shouldNotify('s1:t1')
    dedup.shouldNotify('s1:t2')

    dedup.clear()
    expect(dedup.shouldNotify('s1:t1')).toBe(true)
    expect(dedup.shouldNotify('s1:t2')).toBe(true)
  })

  it('每次 create 相互独立（无模块级共享状态）', () => {
    const first = createAckNotifyDedup()
    first.shouldNotify('s1:t1')
    const second = createAckNotifyDedup()
    expect(second.shouldNotify('s1:t1')).toBe(true)
  })
})

// ── 3. i18n 文案（存在性 + 可渲染 + 负向承诺边界）──

const ACK_KEYS: readonly string[] = [
  ACK_CONFIRM_KEY,
  ACK_NOT_PERSISTED_KEY,
]

/** 越界承诺词表：本机制只保证「写入会话文件」，不得声称存储级持久化。 */
const FORBIDDEN_CLAIMS: readonly string[] = ['持久化', 'persisted', '磁盘', 'disk', 'durably']

describe('i18n：ack 文案 zh/en 双侧', () => {
  it('两组 key 在 zh-CN / en-US 词典中均存在（非回落键名）', () => {
    for (const locale of LOCALES) {
      const keys = new Set(dictionaryKeys(locale))
      for (const key of ACK_KEYS) {
        expect(keys.has(key), `${locale} 缺 ${key}`).toBe(true)
      }
    }
  })

  it('ack.confirm 渲染含 name / schedule 且按 locale 出对应句式', () => {
    expect(t(ACK_CONFIRM_KEY, { name: 'water', schedule: 'every 5m' }, 'zh-CN')).toBe(
      '已保存任务：water（every 5m）。',
    )
    expect(t(ACK_CONFIRM_KEY, { name: 'water', schedule: 'every 5m' }, 'en-US')).toBe(
      'Task saved: water (every 5m).',
    )
  })

  it('ack.notPersisted 渲染含 name 且不留未插值占位符', () => {
    for (const locale of LOCALES) {
      const text = t(ACK_NOT_PERSISTED_KEY, { name: 'water' }, locale)
      expect(text).toContain('water')
      expect(text).not.toContain('{name}')
      expect(text).not.toBe(ACK_NOT_PERSISTED_KEY)
    }
  })


  it('缺参时保留占位符原样（既有插值机制：不静默丢字段）', () => {
    expect(t(ACK_NOT_PERSISTED_KEY, undefined, 'zh-CN')).toContain('{name}')
  })

  it('负向：两组文案均不含「已持久化 / persisted to disk」类越界承诺', () => {
    const params: Record<string, string> = { name: 'water', schedule: 'every 5m' }
    for (const locale of LOCALES) {
      for (const key of ACK_KEYS) {
        const text = t(key, params, locale)
        for (const claim of FORBIDDEN_CLAIMS) {
          expect(text.toLowerCase(), `${locale} ${key} 出现越界承诺「${claim}」`).not.toContain(
            claim.toLowerCase(),
          )
        }
      }
    }
  })
})
