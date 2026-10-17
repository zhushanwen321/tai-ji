<!--
  展示组件 · 思考行（trace 块 thinking 类型行组件，W1 壳化拆分自 Block.vue）。
  壳根类名契约（.trace-blk / .trace-blk--text）与 data-testid 留在 Block 壳，本组件根 =
  原 thinking 分支根 div（.trace-think），无新 DOM 层。
  职责：折叠状态机（useThinkingCollapse：折叠/手动置位/working 回落/收起预览/尾行视口一体）
  + 思考时长（N6）+ 文字扫光（决策 10，块级生命周期随思考完结熄灭）+ 展开区（copy 按钮 +
  BlockScrollBox 240px 限高滚动 + 行区间信息条，fade=false 不渲染渐隐条）。
  Demo H 视觉：lightbulb ICON + header 可点击 toggle，长块独立再折叠（本地折叠态，不进
  store 不持久化）。
-->
<template>
  <!-- thinking 块：同行展开（float 布局——第一行环绕 label，第二行起从最左侧开始） -->
  <div class="trace-think">
    <div
      class="group/think relative cursor-pointer select-none"
      :title="thinkingExpanded ? t('panel.message.collapseReasoning') : t('panel.message.expandReasoning')"
      @click="toggleThinking"
    >
      <!-- 摘要行：flex 布局，min-h 锁定高度避免展开时跳动。
           [M3b demo 复刻]（workbench.css .line/.think）：行内间距 gap-[8px]（demo 8px）；
           图标染色经显式类替换 BLOCK_ICON_CLASS（两者 text 色工具类同特异性，追加不构成
           可靠覆盖）：静止态染 --neutral-ico（2026-10-15 裁决 ②A 去紫——原 --reasoning 紫
           退役，token 本体不动，ANSI magenta / 摘要标题 / skill 徽标等其余消费点不受影响）；
           行字号随 trace 容器定档（Turn.vue .trace 的 text-md = 15px，行主体统一档）。
           [MF-1-28]（demo TurnList.vue:72-73）：running 态 = 呼吸弧 accent（同工具行
           :237 形态，信号源 = thinkingSweeping）；静止态 = lightbulb 15px stroke1.6 染
           --neutral-ico。行 hover 反馈（MF-1-4，demo workbench.css:355 .line:hover 只压
           文字段 opacity .8——图标与显形时间戳不参与，hover 类挂行内文字 span 而非行
           容器，同 tool/bash-group/workflow 行）；行内垂直对齐
           baseline（MF-1-34，workbench.css:348 align-items:baseline），图标保持
           self-center（demo .sicon align-self:center）。 -->
      <div class="flex items-baseline gap-[8px] min-h-[1.5rem]">
        <!-- 运行→完成图标切换：[HISTORICAL] 曾用 Vue Transition 的 out-in 模式（过渡名 tico）
             做交叉切换（动效裁决 2A 出半），2026-10 移除：Vue 3.5.39 下 out-in leave 完成后
             enter 不触发（调度 bug，内容永久空白），vue_rules_checker 已禁该写法，同构踩坑
             见 DrawerPanel/Sidebar/SettingsModal 三处先例（稳定性优先，瞬时切换）。scoped
             尾部 tico 过渡类随本移除删除。reduced-motion 语义随之自然成立（无动画可停）。 -->
        <RunningBlockIcon v-if="thinkingSweeping" kind="thinking" />
        <component :is="BLOCK_ICON_LUCIDE.thinking" v-else class="size-[15px] shrink-0 self-center text-neutral-ico [stroke-width:1.6]" />
        <!-- 状态词 label：思考进行中跑文字扫光（决策 10）。生命周期 = 块级（thinkingEnd 未填），
             非消息级 working——思考完结后消息仍在流式（工具执行中），扫光随思考完结熄灭。
             base 覆盖为 mid 档对齐 BLOCK_LABEL_CLASS 常态字色（reduced-motion 停帧态 = 常态色，
             构造性回退）。:key 绑定预览形态：预览分支切换（单行预览 ↔ 尾行视口）时预览元素
             重建重启动画，状态词同帧重建使两处扫光同一动画相位（整体一起闪）。 -->
        <span :key="thinkingSweepPhase" :class="[BLOCK_LABEL_CLASS, 'transition-opacity duration-[var(--duration-fast)] group-hover/think:opacity-80', thinkingSweeping ? 'text-sweep [--sweep-base:var(--neutral-mid)]' : '']">{{ t('panel.message.thinkingBlock') }}</span>
        <!-- 分隔点常驻（demo 思考行运行/完成两态都有「·」）；展开态仅当其后无时长段时随
             预览一起隐（防悬挂点；展开且有时长 =「思考 · 22s」句式保留分隔） -->
        <span class="text-neutral-dim" :class="thinkingExpanded && !thinkingDuration ? 'invisible' : ''">·</span>
        <!-- N6 思考行时长（ui-optimize-unified 决策 8）：startTime/endTime 双有值才渲染（实时链路
             thinking_start/end 效果器填充；持久化重载链路 thinking part 无时间戳数据源 → 缺值
             维持现状展示 = 设计「推导不出则降级」分支按块级生效）。
             [M3b demo 复刻] 时长常驻显形 + 位置贴状态词（demo「· 持续了 22 秒 ·」在预览前，
             .think 同行 14px sans dim）——原 D2 悬停化 + mono 11px 形态被 demo 权威覆盖；
             行尾时刻槽（thinking-time-slot）保留 D2 悬停化（demo .ts 即 hover 显形）。 -->
        <span v-if="thinkingDuration" class="shrink-0 text-neutral-dim" data-testid="thinking-duration">{{ t('panel.message.thinkingDuration', { duration: thinkingDuration }) }}</span>
        <span v-if="thinkingDuration && messageTimestamp" class="shrink-0 text-neutral-faint opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/think:opacity-100 group-focus-within/think:opacity-100">·</span>
        <!-- working 态：单行尾行视口（2026-08 抖动修复重写）。横向钉右 = viewport flex
             justify-end + 行右对齐 + mr-auto（溢出裁左纯 CSS 无 scrollLeft 时序；mr-auto
             短行左贴 label、长行溢出时钉右）；纵向换行 = useTailScroll settled/sliding
             状态机 translateY(-50%) 滑入（-50% 基于自身 2 行高度，与行高数值解耦）；
             h-[1lh] 视口高度 = 1 行行高。leading-normal（无单位）必需：normal 行高下
             行盒高度随内容 fallback 字体变（实测 system-ui 16px / PingFang 18px /
             emoji 21px，CJK 行被裁 2-5px）；无单位系数使行盒恒 = 系数×字号，字体无关。 -->
        <span
          v-if="working && thinkingTailLines.length > 0"
          class="flex h-[1lh] min-w-0 flex-1 self-center justify-end overflow-hidden leading-normal text-neutral-dim transition-opacity duration-[var(--duration-fast)] group-hover/think:opacity-80"
          :class="thinkingExpanded ? 'invisible' : ''"
        >
          <span :class="[thinkingSweeping ? 'text-sweep' : '', 'mr-auto flex flex-col items-end self-start']" :style="thinkScrollStyle">
            <span v-for="(line, i) in thinkDisplayLines" :key="i" class="whitespace-nowrap">{{ line }}</span>
          </span>
        </span>
        <span v-else class="flex-1 min-w-0 truncate text-neutral-dim transition-opacity duration-[var(--duration-fast)] group-hover/think:opacity-80" :class="[thinkingSweeping ? 'text-sweep' : '', thinkingExpanded ? 'invisible' : '']">{{ previewText }}</span>
        <!-- thinking 块行尾时刻（D2 悬停化：常驻改按需——悬停该行 / 键盘焦点进入该行才显现） -->
        <span v-if="messageTimestamp" class="ml-auto shrink-0 self-center font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/think:opacity-100 group-focus-within/think:opacity-100" data-testid="thinking-time-slot">{{ formatClock(messageTimestamp) }}</span>
      </div>
      <!-- 展开内容区：copy 按钮浮在左上角（BlockScrollBox 外层，层级不动）。按钮常驻 DOM 且
           层级固定，可见度由悬停控制（opacity-0 + group-hover/result:opacity-100）——
           「始终可见」指常驻 DOM 与层级，非视觉常显。 -->
      <Transition name="block-expand">
      <div v-if="thinkingExpanded" class="group/result relative mt-1 pl-4 text-[length:var(--text-sm)] leading-[1.8] text-neutral-mid">
        <Button
          variant="ghost"
          size="icon"
          class="absolute top-0 left-0 size-5 rounded-sm text-neutral-dim opacity-0 transition-opacity hover:text-neutral-fg group-hover/result:opacity-100"
          :title="t('panel.message.copy')"
          @click.stop="content && copy(content, `thinking-${thinkingId ?? 'block'}`)"
        >
          <Check v-if="copied === `thinking-${thinkingId ?? 'block'}`" class="size-3 text-success" />
          <CopyIcon v-else class="size-3" />
        </Button>
        <!-- G5/D6：thinking 展开区统一块内滚动（240px 限高 + 行区间信息条 + streaming 吸底；
             渐隐关闭：思考块上下不叠渐隐遮罩，fade=false 两渐隐条不渲染） -->
        <BlockScrollBox :fade="false">
          <MarkdownRenderer v-if="!working" :content="content ?? ''" :session-id="sessionId ?? undefined" variant="thinking" />
          <span v-else class="whitespace-pre-wrap">{{ content ?? '' }}</span>
        </BlockScrollBox>
      </div>
      </Transition>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy as CopyIcon } from '@lucide/vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import BlockScrollBox from './BlockScrollBox.vue'
import RunningBlockIcon from './RunningBlockIcon.vue'
import { BLOCK_ICON_LUCIDE, BLOCK_LABEL_CLASS } from './block-icon'
import { formatClock, formatDuration } from './format-utils'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { useCopy } from './composables/useCopy'
import { useThinkingCollapse } from './composables/useThinkingCollapse'

const { t } = useI18n()
const { copied, copy } = useCopy()

const props = defineProps<{
  /** thinking 内容 */
  content?: string
  /** thinking 块 id（copy 键锚定 `thinking-<id>`；壳层 data-testid 锚定由 Block 壳承担） */
  thinkingId?: string
  /** thinking 起止毫秒时间戳（ThinkingBlock.startTime/endTime 透传，N6 思考行时长数据源；
   *  任一缺失不渲染时长——持久化重载链路 thinking part 无时间戳，维持现状展示） */
  thinkingStart?: number
  thinkingEnd?: number
  /** thinking 块初始折叠态（来自 ThinkingBlock.collapsed，默认收起） */
  collapsed?: boolean
  /** working 态（turn 进行中）：thinking 各态默认折叠（collapsed 初值 true），working→false
   *  未手动操作过的块回落收起（SSOT §3.3.3）。
   *  折叠态 working=true 时渲染尾部行窗口 + 双轴尾部追踪（W4 D4），
   *  working=false 保持头部 60 字符静态预览。 */
  working?: boolean
  /** 所属 assistant message 时刻（epoch ms，行尾时刻显示） */
  messageTimestamp?: number
  /** 所属 session（透传给 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
}>()

/* ── thinking 折叠（streaming-trace-window 验收修正）：working 态也默认折叠（60 字符预览），
 *    与过程块收编理念一致（收编减体积 + thinking 折叠 = 视觉体积最小）；用户可手动展开，展开后保持。
 *    原 SSOT §3.3.3「working→false 展开」导致 streaming 中所有 thinking 全展开，与收编减体积冲突。──
 *    状态机拆至 useThinkingCollapse（折叠/手动置位/working 回落/预览/尾行视口一体）。 */
const { thinkingExpanded, toggleThinking, previewText, thinkingTailLines, thinkDisplayLines, thinkScrollStyle } =
  useThinkingCollapse({
    content: computed(() => props.content),
    working: computed(() => props.working),
    collapsed: props.collapsed,
  })

/** N6 思考行时长：startTime/endTime 双有值才推导（end<=start 视为数据缺口，守卫与
 *  useLiveToolDuration 终态分支同构）；口径 formatDuration 与工具行行尾耗时一致。 */
const thinkingDuration = computed(() => {
  const start = props.thinkingStart
  if (typeof start !== 'number') return ''
  const end = props.thinkingEnd
  if (typeof end !== 'number' || end <= start) return ''
  return formatDuration(end - start)
})

/** 思考是否已完结：endTime 晚于 startTime（实时链路 thinking_end 效果器填充；重载链路
 *  双 undefined → false，但历史块 working 恒 false，扫光判定不受影响）。守卫与
 *  thinkingDuration 同构。 */
const thinkingEnded = computed(() => {
  const start = props.thinkingStart
  const end = props.thinkingEnd
  return typeof start === 'number' && typeof end === 'number' && end > start
})

/** 思考扫光进行中（决策 10 生命周期修正）：消息级 working（assistant 仍在流式）不足以判
 *  块级扫光——思考完结后消息继续流式（工具执行中），扫光必须随思考完结熄灭，否则思考行
 *  与工具行同时闪。实时链路主路径：有 start 无 end = 进行中扫、end 有值 = 完结熄。
 *  重载链路双时间戳缺失（进程恢复中的进行中会话）无数据可判 → 跟随消息级 working
 *  （错闪成本低于进行中活性信号丢失）。 */
const thinkingSweeping = computed(() => props.working === true && !thinkingEnded.value)

/** 扫光相位键：预览形态（单行预览 ↔ 尾行视口）切换时预览元素重建重启动画，状态词以同
 *  key 同帧重建，使两处扫光同一动画相位——整体一起闪，不做两处各闪。 */
const thinkingSweepPhase = computed(() =>
  thinkingSweeping.value ? (thinkingTailLines.value.length > 0 ? 'tail' : 'preview') : 'idle',
)
</script>

<style scoped>
/* 块展开/收起过渡（chat-flow-polish P0-2）：消除 v-if 瞬时切换的生硬感。
   opacity + 轻微 translateY（从 header 方向淡入），120ms；保持 v-if 卸载折叠块的长输出
   （不做 grid 恒渲染，避免 streaming 中折叠块长输出恒挂载的性能代价）。
   escape hatch：Vue Transition 类用 scoped 表达（enter-from/leave-to 同时设 opacity+transform）。
   与 Block.vue 壳内 tool/run-group 展开区各持一份同款规则——scoped 样式只作用于本组件
   模板元素，Row 拆分后壳内副本不再命中思考行。 */
.block-expand-enter-active,
.block-expand-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease),
    transform var(--duration-fast) var(--ease);
}
.block-expand-enter-from,
.block-expand-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 执行中文字扫光（ui-optimize-unified 决策 10 / N13）：扫光对象 = 思考行正在发生的
   内容文字（状态词 + 预览流/尾行视口），稳定标识（时长/时间戳）不扫。机制 =
   background-clip:text + 透明字色，base（--sweep-base，缺省 dim 档 = 预览流常态字色；
   label 处经任意属性类覆盖为 mid 档）与 peak（--neutral-fg）全令牌化，六主题免逐个定值。
   周期 2.6s：前 55% 扫程（peak 自元素左外 -25% 移至右外 125%），后 45% 停帧。
   keyframes（text-sweep）在 renderer style.css 动画区全局定义——scoped 内定义会被
   编译器哈希改名而失效（同全局动画区先例理由）。
   prefers-reduced-motion 由 style.css 全局兜底（duration 0.01ms 停终态帧 position 0%，
   元素内恒 base 段 = 常态字色，「退回常态字色」构造性成立，无需额外覆盖）。
   escape hatch 理由：多属性组合类 + 变量参数化 + 停帧几何推导，Tailwind 任意值
   内联需 6 类 × 5 消费点且 motion-reduce 变体逐点易漏。与 Block.vue 壳内工具行副本
   各持一份同款规则——scoped 样式只作用于本组件模板元素。 */
.text-sweep {
  --sweep-base: var(--neutral-dim);
  background-image: linear-gradient(100deg, var(--sweep-base) 42%, var(--neutral-fg) 50%, var(--sweep-base) 58%);
  background-size: 250% 100%;
  background-repeat: no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: text-sweep 2.6s cubic-bezier(0.45, 0, 0.25, 1) infinite;
}
</style>
