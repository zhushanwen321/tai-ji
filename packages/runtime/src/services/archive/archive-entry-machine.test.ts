import { describe, expect, it } from 'vitest'
import { generateTableTests } from '@zhushanwen/state-machine/testing'
import { archiveEntryMachine } from './archive-entry-machine.js'

/**
 * 归档单元状态机穷举组（session-archive D9 / state-machine-infrastructure V1）：
 * generateTableTests 生成全状态 × 全事件组合——合法行断言次态（含消亡行
 * `state === null`）、表外断言 errorPolicy: 'throw' 抛出（fail-fast）。
 * 声明行的 outputs 本单元未声明（D9 表无 outputs 列——动作编排在
 * u-archive-service 服务层），planned 断言按空名单核。
 */

// 必须在收集阶段（模块顶层）调用——describe/it 不能在测试回调内注册
const cases = generateTableTests(archiveEntryMachine)

describe('archive-entry 机器声明与穷举覆盖对账', () => {
  it('创建行由 initial 承载（D9 首行：archive 动作创建实体，初始态 = staging）', () => {
    expect(archiveEntryMachine.definition.initial).toBe('staging')
  })

  it('全组合 18（3 态 × 6 事件）= 合法 8 + 表外 10 + 不变量破坏 0', () => {
    // 覆盖数对账防生成器静默漏覆盖；期望分布按 D9 表独立数出：
    // staging 3 合法（compress_done/unarchive/purge）、archived 2 合法
    // （unarchive/purge）、restoring 3 合法（restore_done/两回滚行）
    expect(cases).toHaveLength(18)
    expect(cases.filter((c) => c.expectation === 'transition')).toHaveLength(8)
    expect(cases.filter((c) => c.expectation === 'rejected')).toHaveLength(10)
    expect(cases.filter((c) => c.expectation === 'invariant-broken')).toHaveLength(0)
  })
})
