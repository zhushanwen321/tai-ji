#!/usr/bin/env node
/**
 * check-animation-source-guards.mjs —— 动画源码静态守卫（12 条判据）。
 *
 * 拦什么（判据来源：plan 04 删除常驻装饰性动画 / plan 05 reduced-motion 兜底细化
 * + TaijiLogo 检查生效 / plan 06 pending 死类修复）：
 *   - 常驻装饰性动画零残留（pulse-dot / steer-breathe / wiggle）与死类 animate-bounce-small
 *   - pending / retrying / streaming / compacting / working / waiting 各状态 animation 字段形态
 *   - SegmentedTab 文字 tab 形态（无 badge / 无 count 数字 / 无 motion-reduce 动画类）
 *   - SessionItem running 态 animate-spin 保留
 *   - composer-shell isActive 分支静态 ring（无动画装饰）
 *   - TaijiLogo 静态类 + inline 时长覆盖形态（Tailwind JIT 可生成），SVG 几何未变
 *   - style.css reduced-motion 块 !important 白名单 + @keyframes 定义存在
 *
 * 为什么是脚本而不是 vitest 用例：整套判据都是「读源码字符串断言」，不验证任何运行时
 * 行为，也不构造模块图；放测试套件里每个用例只为 per-file 装载付固定成本。判据与阈值
 * 逐条原样承接（原 `.test.ts` 的 12 条断言一一对应本文件的 12 条检查）。
 *
 * 用法：node scripts/check-animation-source-guards.mjs
 * 退出码：0 = 全部通过；1 = 命中违规；2 = 环境错误（被读文件缺失）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(ROOT, 'packages/renderer')

const read = (rel) => readFileSync(resolve(RENDERER, rel), 'utf-8')

const sessionStatus = read('src/composables/logic/sessionStatus.ts')
const tailwindConfig = read('tailwind.config.ts')
const styleCss = read('src/style.css')
const taijiLogo = read('src/components/icons/TaijiLogo.vue')
const segmentedTab = read('src/components/sidebar/SegmentedTab.vue')
// SessionItem 按职责块拆子组件（session-item/ 子目录），旋转 icon 实现物理在
// SessionItemDisplay.vue——断言对象聚合「主组件 + 子组件目录」，跟随实现位置。
const sessionItem = [
  read('src/components/sidebar/SessionItem.vue'),
  ...readdirSync(resolve(RENDERER, 'src/components/sidebar/session-item')).map((f) =>
    read(`src/components/sidebar/session-item/${f}`),
  ),
].join('\n')
const composerShell = read('src/composables/panel/composer-shell.ts')

const PULSE_ANIM = 'animate-[pulse-dot_1.8s_ease-in-out_infinite]'

/** 递归收集 src/components 下所有 .vue 文件（reduced-motion 局部检查扫描用） */
function collectVueFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collectVueFiles(full, acc)
    else if (entry.endsWith('.vue')) acc.push(full)
  }
  return acc
}

const problems = []
/** 单条判据：cond=false 时记一条违规（带判据名与期望说明） */
function check(id, cond, expectation) {
  if (!cond) problems.push(`${id}：${expectation}`)
}

// ── plan 06 pending 死类修复 ────────────────────────────────────────────────
check(
  'plan06/TC1 pending 改用 animate-pulse-strong',
  sessionStatus.includes("pending: { icon: 'ArrowUpCircle', color: 'text-accent', animation: 'animate-pulse-strong' }"),
  "sessionStatus.ts 的 pending 应为 animate-pulse-strong（ArrowUpCircle / text-accent）",
)
check(
  'plan06/TC2 死类 animate-bounce-small 零残留',
  !sessionStatus.includes('animate-bounce-small'),
  'sessionStatus.ts 不得含 animate-bounce-small（死类已清理）',
)
check(
  'plan06/TC3 其他状态 animation 字段不受影响',
  sessionStatus.includes("streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    && sessionStatus.includes("compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' }")
    && sessionStatus.includes("working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    && sessionStatus.includes("retrying: { icon: 'Zap', color: 'text-warn', animation: 'animate-pulse-strong' }")
    && sessionStatus.includes("waiting: { icon: 'Wrench', color: 'text-warn', animation: '' }")
    && !tailwindConfig.includes('bounce-small')
    && !styleCss.includes('bounce-small'),
  'streaming/compacting/working 的 animate-spin、retrying 的 pulse-strong、waiting 的空串须保留；config/style 不得新增 bounce-small',
)

// ── plan 05 reduced-motion 兜底 + TaijiLogo ────────────────────────────────
check(
  'plan05/TC1 logo spin 静态类 + inline 时长覆盖',
  taijiLogo.includes(":class=\"spin ? 'animate-taiji-spin' : ''\"")
    && taijiLogo.includes(":style=\"spin ? { animationDuration: `${duration}s`, transformOrigin: 'center' } : undefined\"")
    && !taijiLogo.includes('animate-[taiji-spin_${duration}')
    && !taijiLogo.includes('animation: `taiji-spin')
    && tailwindConfig.includes("'taiji-spin': 'taiji-spin 8s linear infinite'")
    && taijiLogo.includes('class="block shrink-0 motion-reduce:animate-none"'),
  'TaijiLogo 须用静态类 animate-taiji-spin + inline animationDuration 覆盖，config 注册 taiji-spin 简写，布局类保留',
)
check(
  'plan05/TC2 style.css reduced-motion 白名单保留',
  styleCss.includes('transition-property: opacity, color, background-color, border-color, fill, stroke, box-shadow, filter !important')
    && styleCss.includes('transition-duration: var(--duration-fast) !important')
    && styleCss.includes('animation-duration: 0.01ms !important')
    && styleCss.includes('animation-iteration-count: 1 !important')
    && styleCss.includes('transition-duration: 0.01ms !important')
    && styleCss.includes('transition-delay: 0ms !important'),
  'reduced-motion 块的 !important 过渡白名单与瞬切兜底须完整保留',
)
{
  const otherGuards = collectVueFiles(resolve(RENDERER, 'src/components'))
    .filter((f) => !f.endsWith('TaijiLogo.vue'))
    .filter((f) => readFileSync(f, 'utf-8').includes('motion-reduce:animate-none'))
  check(
    'plan05/TC3 spin 默认值 + SVG 几何 + 其他组件局部检查保留',
    taijiLogo.includes('spin: true')
      && taijiLogo.includes('duration: 8')
      && taijiLogo.includes('viewBox="0 0 1200 1200"')
      && taijiLogo.includes('d="M3655 9803 c-107 -15 -300 -61 -489 -118')
      && (taijiLogo.match(/<path d="/g) ?? []).length === 6
      && otherGuards.length > 0,
    'TaijiLogo 默认 spin=true / duration=8 / viewBox 与 6 条 path 不得变；其他组件须至少保留一处 motion-reduce:animate-none',
  )
}
check(
  'plan05/TC4 @keyframes taiji-spin 定义存在',
  styleCss.includes('@keyframes taiji-spin'),
  'style.css 须保留 @keyframes taiji-spin（animate-taiji-spin 引用有效）',
)

// ── plan 04 删除常驻装饰性动画 ──────────────────────────────────────────────
check(
  'plan04/TC1 SegmentedTab 文字 tab 形态',
  !segmentedTab.includes(PULSE_ANIM)
    && !segmentedTab.includes('motion-reduce:animate-none')
    && !segmentedTab.includes('absolute right-1 top-1 size-[7px] rounded-full bg-accent')
    && !segmentedTab.includes('v-if="tab.count > 0"')
    && segmentedTab.includes('{{ tab.label }}'),
  'SegmentedTab 须无 pulse-dot / motion-reduce 动画类 / badge / count 数字，label 直出',
)
check(
  'plan04/TC2 SessionItem running 态保留旋转动画',
  sessionItem.includes('animate-spin'),
  'SessionItem（含 session-item/ 子组件）须保留 running 态 animate-spin',
)
check(
  'plan04/TC3 composer-shell isActive 静态 ring',
  !composerShell.includes('animate-steer-breathe')
    && composerShell.includes('border-[var(--accent)] shadow-[0_0_0_2px_var(--accent-ring)]'),
  'composer-shell isActive 分支须无动画装饰，保留 accent 边 + accent-ring 静态环',
)
check(
  'plan04/TC4 sessionStatus waiting 静态范式',
  sessionStatus.includes("waiting: { icon: 'Wrench', color: 'text-warn', animation: '' }")
    && !sessionStatus.includes('animate-wiggle'),
  "waiting 的 animation 须为空串且无 animate-wiggle",
)
check(
  'plan04/TC5 spin 保留 + pulse-dot keyframes 保留',
  sessionStatus.includes("streaming: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    && sessionStatus.includes("compacting: { icon: 'Hourglass', color: 'text-accent', animation: 'animate-spin' }")
    && sessionStatus.includes("working: { icon: 'RefreshCw', color: 'text-accent', animation: 'animate-spin' }")
    && styleCss.includes('@keyframes pulse-dot'),
  'streaming/compacting/working 的 spin 与 @keyframes pulse-dot 须保留',
)

if (problems.length > 0) {
  console.error(`[check-animation-source-guards] 命中 ${problems.length} 条静态守卫违规：`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('[FIX] 上述判据来自 plan 04/05/06 的显式裁决；改实现前先确认裁决是否仍然有效（改裁决须同步本脚本）')
  process.exit(1)
}

console.log('[check-animation-source-guards] OK（12 条判据全部通过）')
