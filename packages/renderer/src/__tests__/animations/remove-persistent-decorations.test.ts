import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Plan 04 — 删除常驻装饰性动画（pulse-dot / steer-breathe / wiggle）回归测试。
 * 源码字符串断言：4 处常驻动画已删除（TC1-TC4）+ 边界保留（TC5：streaming spin、pulse-dot keyframes 保留）。
 */
const rendererSrc = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(resolve(rendererSrc, rel), 'utf-8')

const segmentedTab = read('src/components/sidebar/SegmentedTab.vue')
const sessionItem = read('src/components/sidebar/SessionItem.vue')
const composerShell = read('src/composables/panel/composer-shell.ts')
const sessionStatus = read('src/composables/logic/sessionStatus.ts')
const styleCss = read('src/style.css')

const PULSE_ANIM = 'animate-[pulse-dot_1.8s_ease-in-out_infinite]'

describe('plan 04 删除常驻装饰性动画', () => {
  it('TC1: SegmentedTab 无 pulse-dot / motion-reduce 动画 class，badge 本体已移除，count 数字渲染存在', () => {
    // [HISTORICAL] badge 本体断言随 sidebar-tab-count-restore 决策 1 改写：原断言守护的
    // 静态 badge 蓝点已被该设计显式移除（docs/design/sidebar-tab-count-restore.md §3.3
    // 决策 1），改为守护「badge 已移除 + count 数字渲染存在」。
    expect(segmentedTab).not.toContain(PULSE_ANIM)
    expect(segmentedTab).not.toContain('motion-reduce:animate-none')
    // badge 本体已移除（静态蓝点随数字恢复设计一并删除）
    expect(segmentedTab).not.toContain('absolute right-1 top-1 size-[7px] rounded-full bg-accent')
    // count 数字渲染存在
    expect(segmentedTab).toContain('v-if="tab.count > 0"')
  })

  it('TC2: SessionItem running 态保留旋转动画（7px spinning icon 范式）', () => {
    // 新范式：running 状态由 7px 旋转箭头 icon 表达（animate-spin），
    // 替代旧版右侧 pulse-dot badge（已移除）。SegmentedTab（TC1）静态化仍有效。
    expect(sessionItem).toContain('animate-spin')
  })

  it('TC3: composer-shell isActive 分支为静态 ring（无 steer-breathe，border+shadow 保留）', () => {
    expect(composerShell).not.toContain('animate-steer-breathe')
    // M2a-01：活跃态外环 token 化（--shadow-glow 随主题，替代旧硬编码冷蓝 rgba）
    expect(composerShell).toContain('border-[var(--accent)] shadow-[var(--shadow-glow)]')
  })

  it('TC4: sessionStatus waiting 对齐静态范式（animation 为空串，无 animate-wiggle）', () => {
    expect(sessionStatus).toContain("waiting: { icon: 'Wrench', color: 'text-warn', animation: '' }")
    expect(sessionStatus).not.toContain('animate-wiggle')
  })

  it('TC5 边界: streaming/compacting/working 的 spin 保留，pulse-dot keyframes 保留', () => {
    // 有「正在产出」语义的动画保留
    expect(sessionStatus).toContain("streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    expect(sessionStatus).toContain("compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' }")
    expect(sessionStatus).toContain("working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    // pulse-dot keyframes 仍被 SystemShortcutSection 消费
    // （wiggle/steer-breathe/working-pulse/pulse-warn/shimmer/imp-fill 已在死定义清理中删除）
    expect(styleCss).toContain('@keyframes pulse-dot')
  })
})
