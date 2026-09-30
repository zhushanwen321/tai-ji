// @vitest-environment node

/**
 * state-tone-lock —— 状态→色档映射全集锁测试（[W2 D8] UI 全集锁）。
 *
 * 锁的分工（锁本体在源码，本文件是全集锚 + 行为锚）：
 * - **编译层锁**：WORKFLOW_TONE_BY_OUTCOME / SUBAGENT_DOT_RULES 的 `satisfies
 *   Record<词表, …>`（词表扩值漏配 = 源码行编译红）；WorkflowTab.vue 内
 *   aggregatePhaseStatus / phaseDotClass / callDotClass 的 default-never 穷尽
 *   switch（.vue 由 vue-tsc 全量 typecheck 承载，`pnpm -C packages/renderer
 *   run typecheck`）。本文件下方 @ts-expect-error 锚为「锁存在」的活性证明：
 *   词表外键索引必须编译红，映射锁被拆（键型放宽成索引签名）后该行变为
 *   「未使用的 @ts-expect-error」→ 类型检查红。
 * - **运行层锚（本文件，普通 vitest run 即验证）**：映射键域 ⊆ 词表快照（下方
 *   OUTCOME_SNAPSHOT——词表扩值而映射漏配时权威拦截是 satisfies 编译红，本文件
 *   快照比对为第二道）；四值 tone 三分行为（completed 绿 / failed 红 /
 *   cancelled+interrupted 同中性——用词区分由 shared WORKFLOW_RUN_OUTCOME_LABELS
 *   承载，文案断言段见「中文显示名词表单源」describe）；reopened 中性色修正锚。
 *
 * 运行：cd packages/renderer && pnpm vitest run src/__tests__/state-tone-lock.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  SUBAGENT_STATUS_ALL,
  WORKFLOW_RUN_OUTCOME_LABELS,
  type SubagentRecord,
  type WorkflowRunOutcome,
  type WorkflowRunRecord,
} from '@taiji/shared'
import { SUBAGENT_DOT_RULES, subagentDotClass } from '@/lib/subagent-bucket'
import { WORKFLOW_TONE_BY_OUTCOME, workflowStatusLabel, workflowToneClass } from '@/components/panel/tray/tray-tone'

/**
 * WorkflowRunOutcome 词表快照（与 shared/src/workflow.ts:92 四值联合同步的本地锚）：
 * 词表真扩值时 satisfies 编译红先行；此处快照同步扩值后与映射键域比对即恢复双向覆盖。
 */
const OUTCOME_SNAPSHOT = ['done', 'failed', 'cancelled', 'time_limited'] as const satisfies readonly WorkflowRunOutcome[]

const sorted = (values: readonly string[]): string[] => [...values].sort()

function subagent(overrides: Partial<SubagentRecord> & { subagentId: string }): SubagentRecord {
  return {
    sessionFile: null,
    agent: 'reviewer',
    slug: 'rv',
    task: 'review it',
    status: 'idle',
    ...overrides,
  }
}

function workflowRecord(outcome: WorkflowRunOutcome | undefined, status: 'running' | 'done' = 'done'): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'flow',
    status,
    startedAt: new Date(0).toISOString(),
    agentCalls: [],
    stateFilePath: '',
    outcome,
  }
}

describe('WORKFLOW_TONE_BY_OUTCOME 全集锁（[W2 D8] workflow tone 三分）', () => {
  it('映射键域 ≡ outcome 词表快照（词表扩值漏配 → satisfies 编译红；快照比对为第二道）', () => {
    expect(sorted(Object.keys(WORKFLOW_TONE_BY_OUTCOME))).toEqual(sorted(OUTCOME_SNAPSHOT))
  })

  it('四值三分行为（[D2] 后）：done 绿 / failed 红 / cancelled 与 time_limited 同落中性暗', () => {
    expect(WORKFLOW_TONE_BY_OUTCOME.done).toBe('bg-success')
    expect(WORKFLOW_TONE_BY_OUTCOME.failed).toBe('bg-danger')
    expect(WORKFLOW_TONE_BY_OUTCOME.cancelled).toBe('bg-neutral-dim opacity-50')
    expect(WORKFLOW_TONE_BY_OUTCOME.time_limited).toBe('bg-neutral-dim opacity-50')
  })

  it('workflowToneClass：done 读 outcome 四值驱动，running 恒 accent（不读 reason）；[D2] interrupted 暂停态走中性暗专属条目', () => {
    expect(workflowToneClass(workflowRecord('done'))).toBe('bg-success')
    expect(workflowToneClass(workflowRecord('failed'))).toBe('bg-danger')
    expect(workflowToneClass(workflowRecord('cancelled'))).toBe('bg-neutral-dim opacity-50')
    expect(workflowToneClass(workflowRecord('time_limited'))).toBe('bg-neutral-dim opacity-50')
    expect(workflowToneClass(workflowRecord('failed', 'running'))).toBe('bg-accent')
    // [D2] status 三态 interrupted（暂停态，非终局）：中性暗（不占 accent / 不作成败断言）
    expect(workflowToneClass(workflowRecord(undefined, 'interrupted'))).toBe('bg-neutral-dim opacity-50')
  })

  it('workflowToneClass：done + outcome 缺省（v1 存量快照）→ 中性暗（数据缺口不作成败断言）', () => {
    expect(workflowToneClass(workflowRecord(undefined))).toBe('bg-neutral-dim opacity-50')
  })

  it('词表外键索引 = 编译红（全集锁活性锚；运行层无该键）', () => {
    // @ts-expect-error 词表外键不在映射键域（satisfies Record 锁——词表扩值漏配即此形态的编译红）
    expect(WORKFLOW_TONE_BY_OUTCOME['phantom' as string]).toBeUndefined()
  })
})

describe('中文显示名词表单源（[W2 D8] WORKFLOW_RUN_OUTCOME_LABELS 消费接线）', () => {
  it('逐值显示名断言（[D2] 后：成功/失败/已取消/已超时——shared 常量为唯一权威，消费方零翻译）', () => {
    expect(WORKFLOW_RUN_OUTCOME_LABELS.done).toBe('成功')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.failed).toBe('失败')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.cancelled).toBe('已取消')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.time_limited).toBe('已超时')
  })

  it('「已取消」（主动）与「已超时」（预算超时）禁混用锚：四值显示名两两互异', () => {
    const labels = Object.values(WORKFLOW_RUN_OUTCOME_LABELS)
    expect(sorted(labels)).toEqual(sorted(['成功', '失败', '已取消', '已超时']))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('workflowStatusLabel：done+outcome → 词表取名；running / interrupted / outcome 缺省 → undefined（不出 hover 文案）', () => {
    expect(workflowStatusLabel(workflowRecord('done'))).toBe('成功')
    expect(workflowStatusLabel(workflowRecord('failed'))).toBe('失败')
    expect(workflowStatusLabel(workflowRecord('cancelled'))).toBe('已取消')
    expect(workflowStatusLabel(workflowRecord('time_limited'))).toBe('已超时')
    expect(workflowStatusLabel(workflowRecord('failed', 'running'))).toBeUndefined()
    expect(workflowStatusLabel(workflowRecord(undefined))).toBeUndefined()
    // [D2] interrupted 暂停态非终局——不出终局 hover 文案（「已中断（可续跑）」显示归 status 徽标面）
    expect(workflowStatusLabel(workflowRecord(undefined, 'interrupted'))).toBeUndefined()
  })
})

describe('SUBAGENT_DOT_RULES 全集锁（[W2 D8] 状态点规则按 status 分组）', () => {
  it('分组键域 ≡ SubagentStatus 词表全集（词表扩值漏配 → 本断言红 + satisfies 编译红）', () => {
    expect(sorted(Object.keys(SUBAGENT_DOT_RULES))).toEqual(sorted(SUBAGENT_STATUS_ALL))
  })

  it('失败红先于完成绿兜底：running+failed 与 idle+failed 均红点', () => {
    expect(subagentDotClass(subagent({ subagentId: 'r1', status: 'running', stopReason: 'failed' }))).toBe('bg-danger')
    expect(subagentDotClass(subagent({ subagentId: 'r2', status: 'idle', stopReason: 'failed' }))).toBe('bg-danger')
  })

  it('中断族中性暗：cancelled / interrupted / interrupted-by-restart / interrupted-by-parent', () => {
    for (const stopReason of ['cancelled', 'interrupted', 'interrupted-by-restart', 'interrupted-by-parent']) {
      expect(subagentDotClass(subagent({ subagentId: `i-${stopReason}`, status: 'idle', stopReason }))).toBe('bg-neutral-dim opacity-50')
    }
  })

  it('[W2 D8] reopened 中性色修正：idle+reopened 是「已重开待续」非成功 → 中性暗（原绿点兜底退役）', () => {
    expect(subagentDotClass(subagent({ subagentId: 'r3', status: 'idle', stopReason: 'reopened' }))).toBe('bg-neutral-dim opacity-50')
  })

  it('正常收口绿兜底与 running 非死亡组合 accent 兜底', () => {
    expect(subagentDotClass(subagent({ subagentId: 'r4', status: 'idle' }))).toBe('bg-success')
    expect(subagentDotClass(subagent({ subagentId: 'r5', status: 'running', stopReason: 'cancelled' }))).toBe('bg-accent')
  })

  it('词表外 status 分组索引 = 编译红（全集锁活性锚；运行层无该组）', () => {
    // @ts-expect-error 词表外键不在规则表键域（satisfies Record 锁——词表扩值漏配即此形态的编译红）
    expect(SUBAGENT_DOT_RULES['phantom' as string]).toBeUndefined()
  })
})
