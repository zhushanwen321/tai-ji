// @vitest-environment node

/**
 * state-tone-lock —— 状态→色档映射全集锁测试（[W2 D8] UI 全集锁）。
 *
 * 锁的分工（锁本体在源码，本文件是全集锚 + 行为锚）：
 * - **编译层锁**：shared WORKFLOW_RUN_OUTCOME_LABELS 常量的词表键域（消费方零翻译——
 *   显示名取名单点在 shared，宿主/插件两域共用同一词表）。
 *   [容器扩展点统一 §6.6/U9+U10] 托盘宿主侧的 SUBAGENT_DOT_RULES 与 WORKFLOW_TONE_BY_OUTCOME
 *   全集锁已随托盘 subagent / workflow 两件迁移一并退役（宿主托盘行删，插件侧 widget 树
 *   承载状态表达）。
 * - **运行层锚（本文件，普通 vitest run 即验证）**：中文显示名词表逐值断言（成功/失败/
 *   已取消/已超时/部分成功）；「已取消」（主动）与「已超时」（预算超时）禁混用锚 =
 *   显示名两两互异。
 *
 * 运行：cd packages/renderer && pnpm vitest run src/__tests__/state-tone-lock.test.ts
 */
import { describe, it, expect } from 'vitest'
import { WORKFLOW_RUN_OUTCOME_LABELS } from '@taiji/shared'

const sorted = (values: readonly string[]): string[] => [...values].sort()

describe('中文显示名词表单源（[W2 D8] WORKFLOW_RUN_OUTCOME_LABELS 消费接线）', () => {
  it('逐值显示名断言（[D2] 后：成功/失败/已取消/已超时/部分成功——shared 常量为唯一权威，消费方零翻译）', () => {
    expect(WORKFLOW_RUN_OUTCOME_LABELS.done).toBe('成功')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.failed).toBe('失败')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.cancelled).toBe('已取消')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.time_limited).toBe('已超时')
    expect(WORKFLOW_RUN_OUTCOME_LABELS.partially_succeeded).toBe('部分成功')
  })

  it('「已取消」（主动）与「已超时」（预算超时）禁混用锚：显示名两两互异（[subagent-observability §3.3.8] 扩第五值后同锚）', () => {
    const labels = Object.values(WORKFLOW_RUN_OUTCOME_LABELS)
    expect(sorted(labels)).toEqual(sorted(['成功', '失败', '已取消', '已超时', '部分成功']))
    expect(new Set(labels).size).toBe(labels.length)
  })
})
