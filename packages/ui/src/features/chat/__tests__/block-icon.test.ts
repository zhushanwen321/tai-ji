/**
 * block-icon.ts 单测（w6 从 renderer message-stream/__tests__ 迁入 ui）。
 *
 * 纯函数测试（getBlockIcon 决策 + BLOCK_ICON_LUCIDE 映射 + RUNNING_LOADER_SVG 占位），
 * 零 mock，仅改 import path（@/components/.../block-icon → @taiji/ui）。
 */
import { describe, it, expect } from 'vitest'
import { Lightbulb, BookOpen, ChevronRight, SquareTerminal, Pencil, SquareFunction, Search, Users, Workflow, ArrowRight } from '@lucide/vue'
import { getBlockIcon, BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG } from '@taiji/ui'

describe('block-icon.ts', () => {
  it('getBlockIcon: running 覆盖一切（无论 toolName/isSubagent/isWorkflow）', () => {
    expect(getBlockIcon('bash', 'running', false, false)).toBe('running')
    expect(getBlockIcon('subagent', 'running', true, false)).toBe('running')
    expect(getBlockIcon('workflow', 'running', false, true)).toBe('running')
  })

  it('getBlockIcon: error 不换形（demo TurnList.vue:86-89：图标名不随失败态变，失败信号由消费方染 danger）', () => {
    expect(getBlockIcon('read', 'error', false, false)).toBe('tool-read')
    expect(getBlockIcon('bash', 'error', false, false)).toBe('tool-cmd')
    expect(getBlockIcon('subagent', 'error', true, false)).toBe('subagent')
    expect(getBlockIcon('workflow', 'error', false, true)).toBe('workflow')
  })

  it('getBlockIcon: isSubagent → subagent（非 running 时）', () => {
    expect(getBlockIcon('subagent', 'completed', true, false)).toBe('subagent')
  })

  it('getBlockIcon: isWorkflow → workflow（非 running/subagent 时）', () => {
    expect(getBlockIcon('workflow', 'completed', false, true)).toBe('workflow')
  })

  it('getBlockIcon: toolName 映射（read→tool-read, bash→tool-cmd, edit/write→tool-edit, grep/find→tool-grep）', () => {
    expect(getBlockIcon('read', 'completed', false, false)).toBe('tool-read')
    expect(getBlockIcon('bash', 'completed', false, false)).toBe('tool-cmd')
    expect(getBlockIcon('edit', 'completed', false, false)).toBe('tool-edit')
    expect(getBlockIcon('write', 'completed', false, false)).toBe('tool-edit')
    expect(getBlockIcon('grep', 'completed', false, false)).toBe('tool-grep')
    expect(getBlockIcon('find', 'completed', false, false)).toBe('tool-grep')
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
    expect(BLOCK_ICON_LUCIDE['tool-cmd']).toBe(ChevronRight)
    expect(BLOCK_ICON_LUCIDE['tool-edit']).toBe(Pencil)
    expect(BLOCK_ICON_LUCIDE['tool-grep']).toBe(Search)
    expect(BLOCK_ICON_LUCIDE['tool-other']).toBe(SquareFunction)
    expect(BLOCK_ICON_LUCIDE.workflow).toBe(Workflow)
    expect(BLOCK_ICON_LUCIDE.text).toBe(ArrowRight)
    // run 组块不占独立档：组头图标 = 组类型的语义图标（Block.vue RUN_GROUP_ICON：
    // 探索→tool-read / 改动→tool-edit / 执行命令→tool-bash），组内含 running 成员时
    // 图标位由渲染层 RunningBlockIcon 动效款顶替——档位数恒 10（不含 running；
    // tool-grep 探索档 + workflow 统一到 composer Workflow 字形 + tool-cmd bash
    // 静态抽象档为历批新增）
    expect(Object.keys(BLOCK_ICON_LUCIDE)).toHaveLength(10)
  })

  it('RUNNING_LOADER_SVG: 呼吸弧 loader（浅色轨道整圈 .ld-track + accent 弧段 .ld-arc pathLength=100，r=10）', () => {
    expect(RUNNING_LOADER_SVG).not.toBe('')
    expect(RUNNING_LOADER_SVG).toContain('<svg')
    expect(RUNNING_LOADER_SVG).toContain('circle')
    // 浅色轨道整圈（stroke 16% 透明度）+ 弧段（pathLength=100 归一，dasharray 呼吸/摆动由
    // 全局 .ld-arc 类驱动——style.css 动画 SSOT 区）
    expect(RUNNING_LOADER_SVG).toContain('class="ld-track"')
    expect(RUNNING_LOADER_SVG).toContain('opacity="0.16"')
    expect(RUNNING_LOADER_SVG).toContain('class="ld-arc"')
    expect(RUNNING_LOADER_SVG).toContain('pathLength="100"')
    expect(RUNNING_LOADER_SVG).toContain('r="10"')
    expect(RUNNING_LOADER_SVG).toContain('stroke-width="1.7"')
  })
})
