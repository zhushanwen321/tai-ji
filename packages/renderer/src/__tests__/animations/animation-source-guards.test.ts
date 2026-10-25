// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * 动画相关源码静态守卫（合并自 pending-status-class / reduced-motion-guard /
 * remove-persistent-decorations 三文件——同为「源码字符串断言」形态、共享同一批
 * 被读文件，合并以减少测试文件的 fork/装载固定开销；describe 与用例名保持原样）。
 *
 * - plan 04 删除常驻装饰性动画（pulse-dot / steer-breathe / wiggle）
 * - plan 05 reduced-motion 兜底细化 + TaijiLogo 检查生效
 * - plan 06 pending 状态死类 animate-bounce-small 修复
 */
const rendererSrc = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(resolve(rendererSrc, rel), 'utf-8')

const sessionStatus = read('src/composables/logic/sessionStatus.ts')
const tailwindConfig = read('tailwind.config.ts')
const styleCss = read('src/style.css')
const taijiLogo = read('src/components/icons/TaijiLogo.vue')
const segmentedTab = read('src/components/sidebar/SegmentedTab.vue')
// [R6 拆分适配 2026-09-14] SessionItem 按职责块拆子组件（session-item/ 子目录），spinning icon
// 实现物理迁至 SessionItemDisplay.vue——断言对象聚合「主组件 + 子组件目录」跟随实现位置，
// TC2 断言内容不变（仍锁 running 态 animate-spin 不被误删）。
const sessionItem = [
  read('src/components/sidebar/SessionItem.vue'),
  ...readdirSync(resolve(rendererSrc, 'src/components/sidebar/session-item')).map((f) =>
    read(`src/components/sidebar/session-item/${f}`),
  ),
].join('\n')
const composerShell = read('src/composables/panel/composer-shell.ts')

const PULSE_ANIM = 'animate-[pulse-dot_1.8s_ease-in-out_infinite]'

/** 递归收集 src/components 下所有 .vue 文件（plan 05 TC3 局部检查扫描用） */
function collectVueFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectVueFiles(full, acc)
    else if (entry.endsWith('.vue')) acc.push(full)
  }
  return acc
}

describe('plan 06 pending 死类修复', () => {
  it('TC1: pending 改用 animate-pulse-strong', () => {
    expect(sessionStatus).toContain(
      "pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-pulse-strong' }",
    )
  })

  it('TC2: 死类 animate-bounce-small 零残留（生产源码不含）', () => {
    expect(sessionStatus).not.toContain('animate-bounce-small')
  })

  it('TC3 边界: 其他状态 animation 字段不受影响', () => {
    // streaming/compacting/working 的 spin 保留
    expect(sessionStatus).toContain("streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    expect(sessionStatus).toContain("compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' }")
    expect(sessionStatus).toContain("working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    // retrying 的 pulse-strong 保留
    expect(sessionStatus).toContain("retrying: { icon: 'Zap', color: 'text-warn', animation: 'animate-pulse-strong' }")
    // waiting 保持 ''（wave4 改动不得回退）
    expect(sessionStatus).toContain("waiting: { icon: 'Wrench', color: 'text-warn', animation: '' }")
    // 不新增 bounce-small 定义
    expect(tailwindConfig).not.toContain('bounce-small')
    expect(styleCss).not.toContain('bounce-small')
  })
})

describe('plan 05 reduced-motion 兜底 + TaijiLogo 检查', () => {
  it('TC1: logo spin 由静态类注入（Tailwind JIT 可生成）+ inline 覆盖时长', () => {
    // 静态类 animate-taiji-spin（config animation map 注册，非模板字面量——
    // 模板字面量 arbitrary 类 JIT 不生成，F1 修复前 logo 旋转整体失效）
    expect(taijiLogo).toContain(":class=\"spin ? 'animate-taiji-spin' : ''\"")
    // :style 用 inline animation-duration 覆盖时长（默认 8s 可变），transformOrigin 保留
    expect(taijiLogo).toContain(":style=\"spin ? { animationDuration: `${duration}s`, transformOrigin: 'center' } : undefined\"")
    expect(taijiLogo).not.toContain('animate-[taiji-spin_${duration}')
    expect(taijiLogo).not.toContain('animation: `taiji-spin')
    // config 注册静态简写，确保 Tailwind 构建产物含 .animate-taiji-spin
    expect(tailwindConfig).toContain("'taiji-spin': 'taiji-spin 8s linear infinite'")
    // 静态 class 保留（局部检查 + 布局类）
    expect(taijiLogo).toContain('class="block shrink-0 motion-reduce:animate-none"')
  })

  it('TC2: style.css reduced-motion 块白名单保留 opacity/color 等辅助过渡', () => {
    // transition-property 必须 !important（组件级类特异性 (0,1,0) > 元素选择器 (0,0,0)，
    // 无 !important 时 transform 仍在过渡属性 → 位移不瞬切，F2 修复）
    expect(styleCss).toContain(
      'transition-property: opacity, color, background-color, border-color, fill, stroke, box-shadow, filter !important',
    )
    expect(styleCss).toContain('transition-duration: var(--duration-fast) !important')
    // 瞬切兜底仍在（动画 + 位移过渡清零）
    expect(styleCss).toContain('animation-duration: 0.01ms !important')
    expect(styleCss).toContain('animation-iteration-count: 1 !important')
    expect(styleCss).toContain('transition-duration: 0.01ms !important')
    expect(styleCss).toContain('transition-delay: 0ms !important')
  })

  it('TC3 边界: spin 默认 true、duration 8、SVG path 几何未变、其他组件局部检查保留', () => {
    // prop 默认值未动（品牌旋转保留）
    expect(taijiLogo).toContain('spin: true')
    expect(taijiLogo).toContain('duration: 8')
    // SVG path 几何未变：viewBox + 6 条 path + 首条 path d 前缀与改动前一致
    expect(taijiLogo).toContain('viewBox="0 0 1200 1200"')
    expect(taijiLogo).toContain('d="M3655 9803 c-107 -15 -300 -61 -489 -118')
    expect(taijiLogo.match(/<path d="/g)?.length).toBe(6)
    // 其他组件文件的 motion-reduce:animate-none 局部检查保留（排除 TaijiLogo 自身）
    const otherGuards = collectVueFiles(resolve(rendererSrc, 'src/components'))
      .filter((f) => !f.endsWith('TaijiLogo.vue'))
      .filter((f) => readFileSync(f, 'utf-8').includes('motion-reduce:animate-none'))
    expect(otherGuards.length).toBeGreaterThan(0)
  })

  it('TC4: @keyframes taiji-spin 定义存在（animate-taiji-spin 引用有效）', () => {
    expect(styleCss).toContain('@keyframes taiji-spin')
  })
})

describe('plan 04 删除常驻装饰性动画', () => {
  it('TC1: SegmentedTab 无 pulse-dot / motion-reduce 动画 class，badge 与 count 数字均已移除（demo .vtab 文字 tab）', () => {
    // [HISTORICAL] badge 本体断言随 sidebar-tab-count-restore 决策 1 改写；2026-10 M1 视觉
    // 复刻随 demo .vtab 文字 tab 对齐，count 数字渲染一并退役，改为守护「无 badge/无数字 +
    // label 直出」形态。
    expect(segmentedTab).not.toContain(PULSE_ANIM)
    expect(segmentedTab).not.toContain('motion-reduce:animate-none')
    // badge 本体已移除（静态蓝点随数字恢复设计一并删除）
    expect(segmentedTab).not.toContain('absolute right-1 top-1 size-[7px] rounded-full bg-accent')
    // count 数字不再渲染（文字 tab 形态），label 直出
    expect(segmentedTab).not.toContain('v-if="tab.count > 0"')
    expect(segmentedTab).toContain('{{ tab.label }}')
  })

  it('TC2: SessionItem running 态保留旋转动画（7px spinning icon 范式）', () => {
    // 新范式：running 状态由 7px 旋转箭头 icon 表达（animate-spin），
    // 替代旧版右侧 pulse-dot badge（已移除）。SegmentedTab（TC1）静态化仍有效。
    expect(sessionItem).toContain('animate-spin')
  })

  it('TC3: composer-shell isActive 分支为静态 ring（无 steer-breathe，accent 边 + accent-ring 保留）', () => {
    expect(composerShell).not.toContain('animate-steer-breathe')
    // M2a-01 活跃态外环 token 化；[670f9086d glow 降档裁决 2026-10-11] steer 档由
    // --shadow-glow 3px/25% 降为 2px --accent-ring——断言跟随现行降档形态，
    // 锁定意图不变：isActive 分支无动画装饰、静态 accent ring（边 + 环）在场。
    expect(composerShell).toContain('border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-ring)]')
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
