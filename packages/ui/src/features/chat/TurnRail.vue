<template>
  <!--
    展示组件 · turn 导航 rail（IF4，w2 灰阶化重写）。
    功能：
    - 常驻右侧窄条，hover 弹出全 turn 列表浮层（mini-map + 快速跳转）
    - 窄条上有 viewport indicator 标记当前 turn 在窄条上的纵向位置
    - 浮层内每个节点两行：user 行（User 图标 + user 文本）+ agent 行（Bot 图标 + agent 摘要）
    - 状态融入 Bot 图标颜色（失败 danger 红常驻 / 进行中 accent + 呼吸弧 / 完成中性灰 ico）
    - toggle 按钮 hover 浮出（渐进披露），active 节点常驻可见，垂直居中于节点右侧

    状态与选中形态（M3a demo 权威，workbench.css .rail 族 + 文件尾「选中态单一范式」）：
    - spine 常驻 surface-hover 窄条；viewport indicator = fg-2 左描边 + fg 14% 底（中性，
      demo .rail-viewport——原 accent 形态被 demo 权威覆盖）
    - 浮层面板 = bg-elevated + 1px border-strong 硬边界 + shadow-2（demo .rail-panel）
    - 节点 = 6px 圆角（--radius-sm）4×6 padding，行 12px 字号 1.35 行高（demo .rail-row）
    - 节点 hover = surface-hover 底（全节点统一——demo .rail-node:hover 无条件命中，
      选中项 hover 同样给临时反馈底；Tier B 选中规则只管文字提亮，与 hover 底不冲突）
    - 选中节点（.on）= demo Tier B 行类范式：无底无框仅文字提亮（workbench.css:749
      .si.on,.frow.sel,.rail-node.on{color:var(--fg)} + :291 收编注释），节点文字提为
      text-neutral-fg；图标提为 fg-2（demo .rail-node.on .rail-row svg——呼吸弧行图标
      同为 fg-2，非 accent）
    - failed 图标常驻 text-danger（real 超集语义 §5.6B，优先于选中提色）

    设计约束：
    - 纯展示组件，turns/activeTurnIndex/sessionActive/expandedTurns 全由父组件传入
    - 用 @taiji/ui Button，禁止原生 button（项目硬规范，pre-commit 检查）
    - 用 @lucide/vue 图标（User/Bot/ChevronDown/ChevronUp），禁止 emoji
    - 用 Tailwind 语义类 / CSS var，禁止硬编码颜色
  -->
  <div
    v-if="turns.length > 0"
    data-testid="turn-rail"
    class="turn-rail group absolute top-1/2 right-2 z-[var(--z-sticky)] h-[340px] w-[6px] -translate-y-1/2 transition-[width] duration-[var(--duration)] ease-[var(--ease)] hover:w-[224px] before:absolute before:-left-[6px] before:top-0 before:bottom-0 before:w-[12px] before:content-['']"
  >
    <!-- 常驻窄条 spine：未 hover 时唯一可见区域。bg-surface-hover 保证在 bg 上明确可见（L1 入口可发现性）。 -->
    <div class="rail-spine absolute bottom-0 left-0 top-0 w-[6px] rounded-full bg-surface-hover" />

    <!-- viewport indicator：标记当前视口在窄条上的纵向位置（mini-map 高亮）。
         中性配色（demo .rail-viewport）：fg-2 左描边 + fg 14% 弱底，不占用 accent 信号。 -->
    <div
      class="rail-viewport absolute left-0 w-[6px] rounded-full border-l-2 border-[color:var(--neutral-fg-2)] bg-[color-mix(in_oklch,var(--neutral-fg)_14%,transparent)]"
      :style="viewportStyle"
    />

    <!-- hover 展开浮层（常驻 DOM，靠 group-hover 切换可见性，避免 SSR/动画抖动）。
         2026-10-13 用户裁决 demo 方案 A 全族迁移：bg-bg（composer 同源档，旧 elevated
         浮层档退役）+ 1px border 边 + shadow-2。去掉 backdrop-blur（不透明底上零效果）。 -->
    <div
      class="rail-panel absolute bottom-0 left-[12px] right-0 top-0 translate-x-2 rounded-lg border border-border bg-bg p-2 opacity-0 shadow-2 pointer-events-none transition-[transform,opacity] group-hover:translate-x-0 group-hover:opacity-100 group-hover:pointer-events-auto"
    >
      <!-- 节点列表（铺满 rail 浮层，超出靠浮层自身高度滚动） -->
      <div class="rail-list flex max-h-full flex-col gap-[2px] overflow-y-auto">
        <div
          v-for="(turn, idx) in turns"
          :key="turnStableId(turn)"
          data-testid="rail-node"
          class="group/rail-node rail-node relative flex cursor-pointer select-none flex-col gap-[2px] rounded-sm px-[6px] py-[4px] transition-colors hover:bg-surface-hover"
          :class="idx === activeTurnIndex ? 'active text-neutral-fg' : ''"
          @click="emit('jump', idx)"
        >
          <!-- user 行：User 图标 + user 文本（text-neutral-fg）。
               无 user 时整行省略（首条 assistant 边缘 turn）。
               图标色（demo .rail-node.on .rail-row svg）：选中节点提为 fg-2，否则 neutral-ico。 -->
          <div v-if="turn.user" class="flex min-w-0 items-center gap-[6px]">
            <User class="size-[12px] shrink-0" :class="idx === activeTurnIndex ? 'text-[color:var(--neutral-fg-2)]' : 'text-neutral-ico'" />
            <span class="flex-1 truncate pr-6 text-[length:var(--text-xs)] leading-[1.35] text-neutral-fg">
              {{ railMemoFor(turn).userSummary || ' ' }}
            </span>
          </div>
          <!-- agent 行：状态图标（failed=danger 常驻 / 选中=fg-2 呼吸弧或 Bot / 其余=neutral-ico Bot）+ agent 摘要。
               failed 文本未选中时 text-neutral-mid（hover 升 text-neutral-fg）；选中节点提
               text-neutral-fg（demo Tier B）；其余未选中 text-neutral-mid。
               agent 摘要文本优先（content 截断），空则 fallback 计数（N thoughts · M tools）。
               摘要全空时只在占位门开（isPlaceholderVisible = sessionActive ∧ 真末位）显「进行中…」——
               本意覆盖 pending turn（streaming 刚起 / ask-user 表单等待）；原裸判据「无 agent 内容」
               把已完结 user-only turn（命令取消 / 纯 notify 命令）也算进来致永久占位，故加门收敛；
               门关的 user-only turn 走空格 fallback（D2，与 user 行同款 `|| ' '`），不谎报进行中。 -->
          <div class="flex min-w-0 items-center gap-[6px]">
            <!-- active 态：呼吸弧（微缩，复用 Block.vue 的 RUNNING_LOADER_SVG）。
                 图标色随选中节点提为 fg-2（demo .rail-node.on .rail-row svg 对弧同样生效）。
                 loader 判据 isActiveTurn = sessionActive ∧ 视口位（activeTurnIndex），与占位判据
                 （sessionActive ∧ 真末位）有意分离：上滑时占位留在末位节点、loader 随视口走，
                 两判据同门反而错（占位会被视口态压空串，streaming/ask-user 等待击穿）。 -->
            <!-- eslint-disable-next-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
            <span v-if="isActiveTurn(turn, idx)" data-testid="rail-agent-icon" class="inline-flex size-[12px] shrink-0 items-center justify-center text-[color:var(--neutral-fg-2)] animate-loader-spin" v-html="RUNNING_LOADER_SVG" />
            <!-- 非 active 态：Bot 图标（failed=danger 常驻 / 其余 neutral-ico；选中提 fg-2） -->
            <Bot
              v-else
              data-testid="rail-agent-icon"
              class="size-[12px] shrink-0 transition-colors"
              :class="agentRowIconClass(turn, idx)"
            />
            <span
              class="flex-1 truncate pr-6 text-[length:var(--text-xs)] leading-[1.35] transition-colors"
              :class="agentSummaryClass(turn, idx)"
            >
              {{ railMemoFor(turn).agentSummary || (isPlaceholderVisible(turn, idx) ? t('panel.message.railInProgress') : ' ') }}
            </span>
          </div>
          <!-- 折展 toggle 按钮：hover/focus 浮出（渐进披露），active 节点常驻可见（用户决策）。
               图标语义：ChevronDown=折叠态（向下展开）/ ChevronUp=展开态（向上收起），直观不混语义。
               chevron 用 text-neutral-dim（中性灰，不抢视觉）。
               「当前位置」标记不再借用 chevron 方向，选中态由 demo Tier B 文字提亮承担
               （节点 text-neutral-fg + 图标 fg-2，无底无框）。 -->
          <Button
            variant="ghost"
            size="icon"
            class="absolute right-1 top-1/2 h-5 w-5 shrink-0 -translate-y-1/2 text-neutral-dim opacity-0 transition-opacity group-hover/rail-node:opacity-100 group-focus-within/rail-node:opacity-100"
            :class="idx === activeTurnIndex ? '!opacity-100' : ''"
            data-testid="rail-toggle"
            :data-expanded="isTurnExpanded(idx)"
            :disabled="sessionActive"
            @click.stop="emit('toggle', idx)"
          >
            <ChevronUp v-if="isTurnExpanded(idx)" class="size-[12px]" />
            <ChevronDown v-else class="size-[12px]" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * script：纯 props/emit + 派生 class 计算，无副作用（模块级 WeakMap memo 除外——
 * 只读缓存，不产生可观测副作用）。用 computed 缓存 style 对象避免每次 render 重算字符串。
 */
import { computed } from 'vue'
import { Bot, ChevronDown, ChevronUp, User } from '@lucide/vue'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会封住一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import type { MessageTurn } from '@taiji/core/domain/chat'
import { turnStableId } from '@taiji/core/domain/chat'
// 相对路径同 Button 先例：chat 组件被 barrel 再导出，barrel 自引用会封住一族循环依赖环
import { railMemoFor } from './rail-turn-memo'
import { RUNNING_LOADER_SVG } from './block-icon'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  /** 全部 turns（rail 节点列表数据源） */
  turns: MessageTurn[]
  /** 当前激活 turn 的下标（viewport 位置 + 节点高亮依据） */
  activeTurnIndex: number
  /** 会话是否进行中（true 时禁用所有 toggle，避免 streaming 中 toggle 展开态） */
  sessionActive: boolean
  /** 已展开的 turn 稳定 key 集合（toggle 图标方向依据：展开=ChevronUp / 折叠=ChevronDown）。
   *  key = turnStableId(turn)（首条消息 id，M5 stable-key，不随消息插删漂移）。
   *  ReadonlySet：消费方只读（.has 查询），生产端 useMessageStreamRail 复用 EMPTY_SET 单例
   *  避免热路径无谓 new Set（W3 性能优化）。 */
  expandedTurns?: ReadonlySet<string>
}>()

const emit = defineEmits<{
  /** 点击节点文本区 → 跳转到该 turn */
  jump: [turnIndex: number]
  /** 点击节点 toggle → 切换该 turn 的展开态 */
  toggle: [turnIndex: number]
}>()

/**
 * 查询指定 turn（按 railTurns 下标）是否处于用户态展开（由 expandedTurns prop 决定）。
 * [M5 stable-key] 集合 key 为 turnStableId(turn)（首条消息 id），非 MessageTurn.index。
 * expandedTurns 缺省时视为全折叠（默认折叠态，符合「默认极简」原则）。
 */
function isExpanded(idx: number): boolean {
  if (!props.expandedTurns) return false
  const turn = props.turns[idx]
  return turn != null && props.expandedTurns.has(turnStableId(turn))
}

/**
 * 查询指定 turn 的「实际渲染展开态」（toggle 图标 + data-expanded 依据）。
 * = 用户态展开 OR sessionActive 时的激活节点强制展开。
 *
 * sessionActive 时 trace 由父组件强制展开（不看 expandedTurns），激活节点必然展开，
 * toggle 此时禁用但图标方向需保持准确（ChevronUp=已展开），否则会出现「点不动的 ChevronDown」
 * 语义错误。非激活节点仍看 isExpanded（sessionActive 不强制展开非激活节点）。
 */
function isTurnExpanded(idx: number): boolean {
  return (props.sessionActive && idx === props.activeTurnIndex) || isExpanded(idx)
}

/**
 * agent 行 Bot 图标色（M3a demo 形态，workbench.css .rail-node.on .rail-row svg）：
 * 选中节点图标提为 fg-2；failed danger 常驻优先于选中提色（real 超集语义 §5.6B）。
 * 纯展示派生：只读 memo 与 activeTurnIndex，无副作用。
 */
function agentRowIconClass(turn: MessageTurn, idx: number): string {
  const memo = railMemoFor(turn)
  if (memo.failed) return memo.iconClass
  return idx === props.activeTurnIndex ? 'text-[color:var(--neutral-fg-2)]' : memo.iconClass
}

/**
 * agent 行摘要文字色（demo Tier B 行类文字提亮 + real 超集语义）：
 * 选中节点 → text-neutral-fg（Tier B「无底无框仅文字提亮」，demo workbench.css:749
 * .rail-node.on{color:var(--fg)}——span 有自有 mid 色不吃节点继承，须显式提亮）；
 * 未选中 failed → text-neutral-mid + hover 提亮；未选中普通 → text-neutral-mid
 * （demo .rail-row span）。failed 状态信号由图标 danger 常驻承担，选中时文字照常提亮。
 * 纯展示派生：只读 memo 与 activeTurnIndex，无副作用。
 */
function agentSummaryClass(turn: MessageTurn, idx: number): string {
  if (idx === props.activeTurnIndex) return 'text-neutral-fg'
  return railMemoFor(turn).failed ? 'text-neutral-mid hover:text-neutral-fg' : 'text-neutral-mid'
}

/**
 * 判断指定 turn 是否为「激活态」（sessionActive 且当前激活）。
 * 激活态用呼吸弧图标（随选中节点 fg-2 提色），非激活态用 Bot 图标按 agentRowIconClass 着色。
 */
function isActiveTurn(_turn: MessageTurn, idx: number): boolean {
  return props.sessionActive && idx === props.activeTurnIndex
}

/**
 * 「进行中…」占位可见性判据（D1）：sessionActive ∧ 真末位（idx === props.turns.length - 1）。
 *
 * 与 isActiveTurn 有意分离：activeTurnIndex 是滚动视口派生（内容不超视口恒 0、上滑停在视口
 * 首项），复用它做占位门会在多轮/上滑时把末位 turn 的占位压成空串——streaming 刚起与
 * ask-user 表单等待（sessionActive=true 的 waiting 分支）都显示不出占位，目标击穿。
 * 判据语义从占位需求直接倒推：「进行中」= 会话在进行中且这是当前轮；turns.length - 1
 * 是组件内零依赖真末位。门关时（sessionActive=false 或非末位）已完结 user-only turn
 * 走空格 fallback，不谎报进行中。
 *
 * 禁入 railMemoFor：memo 是模块级 WeakMap，无实例/props 维度（双实例挂载真实存在——
 * 主 Panel + SubagentTab 内嵌），入 memo 即 props 盲区串态。
 */
function isPlaceholderVisible(_turn: MessageTurn, idx: number): boolean {
  return props.sessionActive && idx === props.turns.length - 1
}

/**
 * rail 横向定位（三卡化 2026-10-04）：absolute 于对话流容器右缘（right-2 class 恒定）。
 * 不再用 fixed + 视口坐标计算——fixed 垂直居中于视口、不感知底抽屉高度，窗口矮或底抽屉
 * 高时 rail 会叠进终端区（跨区缺陷根因）；absolute 后 rail 随对话流容器 overflow 裁剪，
 * 跨区在结构上不可能。
 */

/** 百分比基数（CSS top/height 用 % 单位，100 是百分比满分母） */
const PERCENT = 100

/**
 * viewport indicator 纵向定位：当前 turn 在窄条上的比例位置 + 比例高度。
 * 防御：turns 为空时本组件不渲染（v-if），但 computed 仍需兜底避免除零。
 */
const viewportStyle = computed(() => {
  const total = props.turns.length || 1
  const topPct = (props.activeTurnIndex / total) * PERCENT
  const heightPct = PERCENT / total
  return {
    top: `${topPct}%`,
    height: `${heightPct}%`,
  }
})

/**
 * rail 节点摘要 per-turn memo（2026-08 streaming 性能优化）：
 * WeakMap 按 turn 引用缓存（引用同 ⇒ 内容同 ⇒ 摘要同，论证见 rail-turn-memo.ts），
 * 模板每 render 调用 railMemoFor 命中零重算。实装已上移为共享导出
 * ./rail-turn-memo.ts（TurnRail 渲染 + useMessageStreamRail 派生视图恒等判定
 * 消费同一 WeakMap——判定与渲染同源，签名漂移结构性不可能），此处仅 re-import。
 * agentIconClass（failed=danger 常驻红 / done=neutral-ico，§5.6B）随 memo 一并迁入。
 */
</script>
