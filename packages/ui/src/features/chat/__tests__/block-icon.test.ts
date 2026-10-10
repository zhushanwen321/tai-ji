/**
 * block-icon.ts 单测（w6 从 renderer message-stream/__tests__ 迁入 ui）。
 *
 * 纯函数测试（getBlockIcon 决策 + BLOCK_ICON_LUCIDE 映射 + RUNNING_LOADER_SVG 占位），
 * 零 mock，仅改 import path（@/components/.../block-icon → @taiji/ui）。
 */
import { describe, it, expect } from 'vitest'
import { Lightbulb, BookOpen, SquareTerminal, Pencil, SquareFunction, Users, ListChecks, ArrowRight } from '@lucide/vue'
import { getBlockIcon, BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG } from '@taiji/ui'

describe('block-icon.ts', () => {
  it('getBlockIcon: running 覆盖一切（无论 toolName/isSubagent/isWorkflow）', () => {
    expect(getBlockIcon('bash', 'running', false, false)).toBe('running')
    expect(getBlockIcon('subagent', 'running', true, false)).toBe('running')
    expect(getBlockIcon('workflow', 'running', false, true)).toBe('running')
  })

  it('getBlockIcon: error 不换形（demo TurnList.vue:86-89：图标名不随失败态变，失败信号由消费方染 danger）', () => {
    expect(getBlockIcon('read', 'error', false, false)).toBe('tool-read')
    expect(getBlockIcon('bash', 'error', false, false)).toBe('tool-bash')
    expect(getBlockIcon('subagent', 'error', true, false)).toBe('subagent')
    expect(getBlockIcon('workflow', 'error', false, true)).toBe('workflow')
  })

  it('getBlockIcon: isSubagent → subagent（非 running 时）', () => {
    expect(getBlockIcon('subagent', 'completed', true, false)).toBe('subagent')
  })

  it('getBlockIcon: isWorkflow → workflow（非 running/subagent 时）', () => {
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

  it('BLOCK_ICON_LUCIDE: 图标映射（subagent=Users, thinking=Lightbulb 等；failed 已删——failed 不换形）', () => {
    expect(BLOCK_ICON_LUCIDE.subagent).toBe(Users)
    expect(BLOCK_ICON_LUCIDE.thinking).toBe(Lightbulb)
    expect(BLOCK_ICON_LUCIDE['tool-read']).toBe(BookOpen)
    expect(BLOCK_ICON_LUCIDE['tool-bash']).toBe(SquareTerminal)
    expect(BLOCK_ICON_LUCIDE['tool-edit']).toBe(Pencil)
    expect(BLOCK_ICON_LUCIDE['tool-other']).toBe(SquareFunction)
    expect(BLOCK_ICON_LUCIDE.workflow).toBe(ListChecks)
    expect(BLOCK_ICON_LUCIDE.text).toBe(ArrowRight)
    // D1 语义变更：bash-group 组头图标 = bash 语义（SquareTerminal，与 tool-bash 同源），
    // 组身份由「×N」计数前缀承载；组内含 running 成员时图标位由渲染层 RUNNING_LOADER_SVG 顶替
    expect(BLOCK_ICON_LUCIDE['bash-group']).toBe(SquareTerminal)
  })

  it('RUNNING_LOADER_SVG: 呼吸弧 loader（淡轨整圈 .ld-track + accent 弧段 .ld-arc pathLength=100，r=10）', () => {
    expect(RUNNING_LOADER_SVG).not.toBe('')
    expect(RUNNING_LOADER_SVG).toContain('<svg')
    expect(RUNNING_LOADER_SVG).toContain('circle')
    // 淡轨整圈（stroke 16% 透明度）+ 弧段（pathLength=100 归一，dasharray 呼吸/摆动由
    // 全局 .ld-arc 类驱动——style.css 动画 SSOT 区）
    expect(RUNNING_LOADER_SVG).toContain('class="ld-track"')
    expect(RUNNING_LOADER_SVG).toContain('opacity="0.16"')
    expect(RUNNING_LOADER_SVG).toContain('class="ld-arc"')
    expect(RUNNING_LOADER_SVG).toContain('pathLength="100"')
    expect(RUNNING_LOADER_SVG).toContain('r="10"')
    expect(RUNNING_LOADER_SVG).toContain('stroke-width="1.7"')
  })
})
