/**
 * 局部表面 Esc 消费方两档登记（§6.7 R6 更正判据轴：按**相对编排器执行序**分档，非按监听级别标签）。
 *
 * 编排器监听 = window keydown bubble（AppShell 根 setup 首位注册，§6.7 编排器监听规格）。
 * 第 5 层（焦点在宿主壳）先过局部表面 Esc 消费方，两档契约不同：
 *
 * - **先行档**（执行序先于编排器 → preventDefault 时序可达）= window capture 监听
 *   （CommandPopover / AmbiguousFilePopover）、document 级监听（树序先于 window bubble，
 *   与注册序无关——ScheduleForm document capture / PlanCommentPopover document bubble）、
 *   元素级监听（useFlatListNav，冒泡先达）。**契约 = 消费即 preventDefault**（defaultPrevented
 *   约定——编排器动作前查 defaultPrevented 已置位则不动作）。
 * - **后行档**（window bubble 且注册晚于编排器 → preventDefault 不可达）= **聚合让位登记**
 *   （yieldsEsc ✓，读 modal-surface-registry）。**开合态绑定源 = 消费方的状态本体**
 *   （SessionList：N 个 SessionItem 后代确认态 / folderConfirmingCwd 的聚合谓词），
 *   **非 escCount 广播计数器**（单调递增非状态本体，误绑 = 全局 Esc 死键）。
 *
 * 本清单 = §8.2「局部表面两档对照基线」的机器形态（z-surface-baseline.test.ts /
 * local-esc-two-tier.test.ts 对账）：新增局部表面 Esc 消费方必须在此登记并落实对应契约，
 * 否则对照基线测试红。**护栏机器承载（2026-10-03 F1-15 补）**：基线测试含 z-scan-helper
 * `scanEscConsumers` 全仓重扫（三形态：@keydown.esc / @keydown.escape / 'Escape' 字面量——
 * 早期仅扫字面量，结构性漏模板修饰符形态，ProjectSwitcher 漏登即此盲区），未登记且不在
 * 测试侧豁免清单的命中即红。**不在此列**的 Esc 消费方（各有归宿，勿登记，豁免清单见测试）：
 * - 模态内消费方（SystemShortcutSection 改键录制）：仅模态开着时可达，编排器经聚合让位不参与；
 * - 输入编辑态消费方（core staging-mode handleEsc / 浮层浏览器地址栏）：§6.7 所有权第 2 层；
 * - xterm 终端（node_modules 内 stopPropagation，编排器 bubble 天然收不到）：第 3 层；
 * - 浮层浏览器页面内：第 4 层（Esc 不入转发键清单，归页面语义）；
 * - node_modules 内 reka DismissableLayer 族：结构性不含（§6.7 R4 carve-out）——
 *   键盘可感知的 reka 托管弹层归聚合让位档（modal-surface-registry 登记表弹出层族行）。
 */
export interface LocalEscConsumerEntry { // oe-exempt:20261003:framework:类型契约先行——容器/编排/注册表契约层，D1 下游单元即为消费面
  /** 消费方 id */
  id: string
  /** 仓库根相对路径（对照基线扫描锚） */
  file: string
  /** 档位：'first' 先行档 / 'second' 后行档 */
  tier: 'first' | 'second'
  /** 契约：'prevent-default' 消费即 preventDefault / 'aggregate-yield' 入聚合让位 */
  contract: 'prevent-default' | 'aggregate-yield'
  /** §6.7 执行序依据（人读） */
  basis: string
}

export const LOCAL_ESC_CONSUMERS = [
  {
    id: 'command-popover',
    file: 'packages/renderer/src/composables/panel/command-popover-keyboard.ts',
    tier: 'first',
    contract: 'prevent-default',
    basis: 'window capture（主入口）；空态路径注记：候选为空时放行 Esc 交 reka 兜底——「有候选开着」才消费，空态 = 未开无消费，聚合让位由弹出层族登记天然覆盖',
  },
  {
    id: 'ambiguous-file-popover',
    file: 'packages/ui/src/features/chat/AmbiguousFilePopover.vue',
    tier: 'first',
    contract: 'prevent-default',
    basis: 'window capture',
  },
  {
    id: 'schedule-form',
    file: 'packages/renderer/src/components/extension/form/ScheduleForm.vue',
    tier: 'first',
    contract: 'prevent-default',
    basis: 'document capture（源码注释自述元素级不可行——根 div 不可聚焦）',
  },
  {
    id: 'plan-comment-popover',
    file: 'packages/renderer/src/components/panel/plan/PlanCommentPopover.vue',
    tier: 'first',
    contract: 'prevent-default',
    basis: 'document 级监听（树序先于 window bubble）——R6 更正 R5 误判：document 监听先 dismiss 并同步清 sel，聚合旗标直读会读到「已关」进层级序，双动作击穿点复活；故回先行档走 defaultPrevented 约定',
  },
  {
    id: 'flat-list-nav',
    file: 'packages/ui/src/features/new-task/composables/useFlatListNav.ts',
    tier: 'first',
    contract: 'prevent-default',
    basis: '元素级监听（冒泡先达）',
  },
  {
    id: 'project-switcher-create-input',
    file: 'packages/renderer/src/components/sidebar/ProjectSwitcher.vue',
    tier: 'first',
    contract: 'prevent-default',
    basis: '元素级监听（@keydown.esc.prevent 新建项目输入 Esc 取消，冒泡先达；.prevent 即 defaultPrevented 约定已落实）——2026-10-03 终态同步补登：模板修饰符形态不在早期 Escape 字面量扫描面（F1-15 盲区），scanEscConsumers 三形态扫描补收',
  },
  {
    id: 'session-list-confirm',
    file: 'packages/renderer/src/components/sidebar/SessionList.vue',
    tier: 'second',
    contract: 'aggregate-yield',
    basis: 'window bubble 注册晚于编排器（escCount 广播）→ preventDefault 不可达；入聚合让位（yieldsEsc ✓），开合态绑定删除确认态本体',
  },
] as const satisfies readonly LocalEscConsumerEntry[]
