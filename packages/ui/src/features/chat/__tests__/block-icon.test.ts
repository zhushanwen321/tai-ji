/**
 * block-icon.ts 单测（w6 从 renderer message-stream/__tests__ 迁入 ui）。
 *
 * 纯函数测试（getBlockIcon 决策 + BLOCK_ICON_LUCIDE 映射 + RUNNING_LOADER_SVG 占位），
 * 零 mock，仅改 import path（@/components/.../block-icon → @taiji/ui）。
 */
import { describe, it, expect } from 'vitest'
import { Brain, BookOpen, SquareTerminal, Pencil, SquareFunction, Users, ListChecks, AlertTriangle, ArrowRight } from '@lucide/vue'
import { getBlockIcon, BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG } from '@taiji/ui'

describe('block-icon.ts', () => {
  it('getBlockIcon: running 覆盖一切（无论 toolName/isSubagent/isWorkflow）', () => {
    expect(getBlockIcon('bash', 'running', false, false)).toBe('running')
    expect(getBlockIcon('subagent', 'running', true, false)).toBe('running')
    expect(getBlockIcon('workflow', 'running', false, true)).toBe('running')
  })

  it('getBlockIcon: error → failed（覆盖 toolName/isSubagent/isWorkflow）', () => {
    expect(getBlockIcon('read', 'error', false, false)).toBe('failed')
    expect(getBlockIcon('subagent', 'error', true, false)).toBe('failed')
  })

  it('getBlockIcon: isSubagent → subagent（非 running/error 时）', () => {
    expect(getBlockIcon('subagent', 'completed', true, false)).toBe('subagent')
  })

  it('getBlockIcon: isWorkflow → workflow（非 running/error/subagent 时）', () => {
    expect(getBlockIcon('workflow', 'completed', false, true)).toBe('workflow')
  })

  it('getBlockIcon: toolName 映射（read→tool-read, bash→tool-bash, edit/write→tool-edit）', () => {
    expect(getBlockIcon('read', 'completed', false, false)).toBe('tool-read')
    expect(getBlockIcon('bash', 'completed', false, false)).toBe('tool-bash')
    expect(getBlockIcon('edit', 'completed', false, false)).toBe('tool-edit')
    expect(getBlockIcon('write', 'completed', false, false)).toBe('tool-edit')
  })

  it('getBlockIcon: 未知 toolName → tool-other', () => {
    expect(getBlockIcon('unknown', 'completed', false, false)).toBe('tool-other')
  })

  it('getBlockIcon: end_not_received 态不触发 failed 分支（非 error，走 toolName 映射）', () => {
    expect(getBlockIcon('read', 'end_not_received', false, false)).toBe('tool-read')
  })

  it('BLOCK_ICON_LUCIDE: 图标映射（subagent=Users, thinking=Brain, failed=AlertTriangle 等）', () => {
    expect(BLOCK_ICON_LUCIDE.subagent).toBe(Users)
    expect(BLOCK_ICON_LUCIDE.thinking).toBe(Brain)
    expect(BLOCK_ICON_LUCIDE.failed).toBe(AlertTriangle)
    expect(BLOCK_ICON_LUCIDE['tool-read']).toBe(BookOpen)
    expect(BLOCK_ICON_LUCIDE['tool-bash']).toBe(SquareTerminal)
    expect(BLOCK_ICON_LUCIDE['tool-edit']).toBe(Pencil)
    expect(BLOCK_ICON_LUCIDE['tool-other']).toBe(SquareFunction)
    expect(BLOCK_ICON_LUCIDE.workflow).toBe(ListChecks)
    expect(BLOCK_ICON_LUCIDE.text).toBe(ArrowRight)
  })

  it('RUNNING_LOADER_SVG: 双环 loader（含 svg + circle，外环 r=10 + 内实心 r=3）', () => {
    expect(RUNNING_LOADER_SVG).not.toBe('')
    expect(RUNNING_LOADER_SVG).toContain('<svg')
    expect(RUNNING_LOADER_SVG).toContain('circle')
    expect(RUNNING_LOADER_SVG).toContain('r="10"')
    expect(RUNNING_LOADER_SVG).toContain('r="3"')
    expect(RUNNING_LOADER_SVG).toContain('stroke-width="1.7"')
  })
})
