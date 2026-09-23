<template>
  <!--
    展示组件 · turn 导航 rail（IF4，w2 灰阶化重写）。
    功能：
    - 常驻右侧窄条，hover 弹出全 turn 列表浮层（mini-map + 快速跳转）
    - 窄条上有 viewport indicator 标记当前 turn 在窄条上的纵向位置
    - 浮层内每个节点两行：user 行（User 图标 + user 文本）+ agent 行（Bot 图标 + agent 摘要）
    - 状态融入 Bot 图标颜色（失败 danger 红常驻 / 进行中 accent + loader-spin / 完成中性灰 ico）
    - toggle 按钮 hover 浮出（渐进披露），active 节点常驻可见，垂直居中于节点右侧

    状态色（W2，§13.2-C + §5.6B failed=danger）：
    - failed 图标常驻 text-danger（非 hover 渐显——rail 是全局导航，一眼可辨失败位置；§5.6B 统一 error=danger，推翻早期 CL5 的 warn 取舍）
    - failed 文本 text-neutral-mid（hover 升 text-neutral-fg）
    - active 图标 text-accent + 双环 loader-spin 微缩（复用 Block.vue 的 RUNNING_LOADER_SVG）
    - done 图标 text-neutral-ico；user 行图标 text-neutral-ico，文本 text-neutral-fg
    - chevron text-neutral-dim
    - spine/viewport/panel 的 bg-surface-hover/border-accent/bg-accent-soft 保留（中性灰+accent，不冲突）

    设计约束：
    - 纯展示组件，turns/activeTurnIndex/sessionActive/expandedTurns 全由父组件传入
    - 用 @taiji/ui Button，禁止原生 button（项目硬规范，pre-commit 检查）
    - 用 @lucide/vue 图标（User/Bot/ChevronDown/ChevronUp），禁止 emoji
    - 用 Tailwind 语义类 / CSS var，禁止硬编码颜色
  -->
  <div
    v-if="turns.length > 0"
    data-testid="turn-rail"
    class="turn-rail group fixed top-1/2 z-20 h-[340px] w-1.5 -translate-y-1/2 transition-[width] duration-[var(--duration)] ease-[var(--ease)] hover:w-56 before:absolute before:-left-1.5 before:top-0 before:bottom-0 before:w-3 before:content-['']"
    :style="railStyle"
  >
    <!-- 常驻窄条 spine：未 hover 时唯一可见区域。bg-surface-hover 保证在 bg 上明确可见（L1 入口可发现性）。 -->
    <div class="rail-spine absolute bottom-0 left-0 top-0 w-1.5 rounded-full bg-surface-hover" />

    <!-- viewport indicator：标记当前 turn 在窄条上的纵向位置（mini-map 高亮） -->
    <div
      class="rail-viewport absolute left-0 w-1.5 rounded-full border-l-2 border-accent bg-accent/20"
      :style="viewportStyle"
    />

    <!-- hover 展开浮层（常驻 DOM，靠 group-hover 切换可见性，避免 SSR/动画抖动）。
         区分度：bg-bg-elevated（浮起面板语义，与画布 bg 亮度差 Δ17）+ ring 硬边界（不依赖阴影方向）。
         去掉 backdrop-blur（不透明底上零效果）。 -->
    <div
      class="rail-panel absolute bottom-0 left-3 right-0 top-0 translate-x-2 rounded-lg bg-bg-elevated p-2 opacity-0 shadow-2 ring-1 ring-border-strong pointer-events-none transition-[transform,opacity] group-hover:translate-x-0 group-hover:opacity-100 group-hover:pointer-events-auto"
    >
      <!-- 节点列表（铺满 rail 浮层，超出靠浮层自身高度滚动） -->
      <div class="rail-list flex max-h-full flex-col gap-0.5 overflow-y-auto">
        <div
          v-for="(turn, idx) in turns"
          :key="turnStableId(turn)"
          data-testid="rail-node"
          class="group/rail-node rail-node relative flex cursor-pointer flex-col gap-0.5 rounded px-1.5 py-1 transition-colors hover:bg-surface-hover"
          :class="idx === activeTurnIndex ? 'active bg-accent-soft ring-1 ring-inset ring-accent-ring' : ''"
          @click="emit('jump', idx)"
        >
          <!-- user 行：User 图标（text-neutral-ico）+ user 文本（text-neutral-fg）。
               无 user 时整行省略（首条 assistant 边缘 turn）。 -->
          <div v-if="turn.user" class="flex min-w-0 items-center gap-1.5">
            <User class="size-3 shrink-0 text-neutral-ico" />
            <span class="flex-1 truncate pr-6 text-[length:var(--text-xs)] leading-tight text-neutral-fg">
              {{ railMemoFor(turn).userSummary || ' ' }}
            </span>
          </div>
          <!-- agent 行：状态图标（failed=danger 常驻 / active=accent loader-spin / done=neutral-ico）+ agent 摘要。
               failed 文本 text-neutral-mid（hover 升 text-neutral-fg），其余 text-neutral-mid。
               agent 摘要文本优先（content 截断），空则 fallback 计数（N thoughts · M tools）。
               摘要全空时只在占位门开（isPlaceholderVisible = sessionActive ∧ 真末位）显「进行中…」——
               本意覆盖 pending turn（streaming 刚起 / ask-user 表单等待）；原裸判据「无 agent 内容」
               把已完结 user-only turn（命令取消 / 纯 notify 命令）也算进来致永久占位，故加门收敛；
               门关的 user-only turn 走空格 fallback（D2，与 user 行同款 `|| ' '`），不谎报进行中。 -->
          <div class="flex min-w-0 items-center gap-1.5">
            <!-- active 态：双环 loader-spin（微缩，复用 Block.vue 的 RUNNING_LOADER_SVG，accent 蓝）。
                 loader 判据 isActiveTurn = sessionActive ∧ 视口位（activeTurnIndex），与占位判据
                 （sessionActive ∧ 真末位）有意分离：上滑时占位留在末位节点、loader 随视口走，
                 两判据同门反而错（占位会被视口态压空串，streaming/ask-user 等待击穿）。 -->
            <!-- eslint-disable-next-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
            <span v-if="isActiveTurn(turn, idx)" data-testid="rail-agent-icon" class="inline-flex size-3 shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" />
            <!-- 非 active 态：Bot 图标（failed=danger 常驻 / done=neutral-ico） -->
            <Bot
              v-else
              data-testid="rail-agent-icon"
              class="size-3 shrink-0 transition-colors"
              :class="railMemoFor(turn).iconClass"
            />
            <span
              class="flex-1 truncate pr-6 text-[length:var(--text-xs)] leading-tight transition-colors"
              :class="railMemoFor(turn).failed ? 'text-neutral-mid hover:text-neutral-fg' : 'text-neutral-mid'"
            >
              {{ railMemoFor(turn).agentSummary || (isPlaceholderVisible(turn, idx) ? t('panel.message.railInProgress') : ' ') }}
            </span>
          </div>
          <!-- 折展 toggle 按钮：hover/focus 浮出（渐进披露），active 节点常驻可见（用户决策）。
               图标语义：ChevronDown=折叠态（向下展开）/ ChevronUp=展开态（向上收起），直观不混语义。
               chevron 用 text-neutral-dim（中性灰，不抢视觉）。
               「当前位置」标记不再借用 chevron 方向，由节点底色 bg-accent-soft + ring 独立承担。 -->
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
            <ChevronUp v-if="isTurnExpanded(idx)" class="size-3" />
            <ChevronDown v-else class="size-3" />
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
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import type { MessageTurn } from '@taiji/core/domain/chat'
import { hasFailedTool, turnStableId } from '@taiji/core/domain/chat'
import { summarizeTurnForRail, summarizeAssistantForRail } from '@taiji/core/domain/chat'
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
  /** 面板右边缘 px（可选）：未传时 rail 贴视口右侧 8px */
  panelRightEdge?: number
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
 * 判断指定 turn 是否为「激活态」（sessionActive 且当前激活）。
 * 激活态用 loader-spin 双环图标（accent 蓝），非激活态用 Bot 图标按 agentIconClass 着色。
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
 * rail 横向定位：根据 panelRightEdge 算 right 偏移。
 * panelRightEdge 给定时 → 贴面板右侧（内缩 8px，与「右侧导航 rail」语义一致）；
 * 缺省 → 贴视口右侧 8px（CSS fallback 路径，用于独立预览/无 panel 场景）。
 */
const railStyle = computed(() => ({
  right: props.panelRightEdge ? `calc(100vw - ${props.panelRightEdge}px + 8px)` : '8px',
}))

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
 * agent 行 Bot 图标的着色 class（仅非 active 态调用；active 态走 loader-spin）：
 * - failed（hasFailedTool）→ text-danger（常驻红，§5.6B 统一 error=danger——rail 是全局导航，一眼可辨失败位置，
 *   不沿用 §6 Block 块的「hover 渐显」。早期 CL5 曾用 warn 哑光金克制，已被 §5.6B 状态色统一推翻）
 * - 其余（done 态）→ text-neutral-ico（中性灰 ICON 色，不抢视觉，区别于 user 行的 text-neutral-fg）
 *
 * 优先级：failed > ok —— 失败信息需要被注意到（即便 turn 正在 streaming，过往失败也要标记）。
 * active 态由 isActiveTurn 提前分流到 loader-spin，不进本函数。
 *
 * 保持普通函数形式（非 computed）：依赖循环变量 turn，转 computed 需引入按 turns 映射的数组，
 * 复杂度收益不成正比。开销可接受——调用次数 = rail 节点数（≤ turns 数，通常 <20）。
 */
function agentIconClass(turn: MessageTurn): string {
  if (hasFailedTool(turn)) return 'text-danger'
  return 'text-neutral-ico'
}

/**
 * rail 节点摘要 per-turn memo（2026-08 streaming 性能优化）。
 *
 * 背景：模板每 render 对全部节点重跑 summarize*（summarizeAssistantForRail → stripMarkdown
 * 15+ 次全文正则 + truncate 码点展开），streaming 期间每 token 重渲时历史节点被反复重算。
 * WeakMap 按 turn 引用缓存是正确的：core toRenderItemsIncremental 对签名未变的历史 turn
 * 逐引用复用（message-turns.ts 增量分支），且消息体不可变替换（ADR-0039）——
 * 引用同 ⇒ 内容同 ⇒ 摘要同；内容变化必然走不可变替换产生新引用（miss 后重算一次）。
 * turn 对象被 GC 后 WeakMap 条目自动回收，无泄漏。
 * 模块级而非组件内：跨 TurnRail 实例共享（MessageStream 与 SubagentTab 内嵌 MessageStream
 * 多实例并存，同一 turn 引用只算一次）。
 */
interface RailTurnMemo {
  /** user 行摘要（summarizeTurnForRail，无 user turn 为空串——模板 `|| ' '` 兜底不变） */
  userSummary: string
  /** agent 行摘要（summarizeAssistantForRail，空串时模板经占位门判定「进行中…」或空格 fallback——判据不在 memo 内） */
  agentSummary: string
  /** hasFailedTool 结果（agent 行文本 hover 升色依据） */
  failed: boolean
  /** agent 行 Bot 图标着色 class（agentIconClass 产出，与 failed 同帧同源） */
  iconClass: string
}
const railMemo = new WeakMap<MessageTurn, RailTurnMemo>()

/** 取 turn 的 rail 摘要 memo（首见计算并缓存，命中零重算）。模板每 render 调用。 */
function railMemoFor(turn: MessageTurn): RailTurnMemo {
  let memo = railMemo.get(turn)
  if (memo === undefined) {
    memo = {
      userSummary: summarizeTurnForRail(turn),
      agentSummary: summarizeAssistantForRail(turn),
      failed: hasFailedTool(turn),
      iconClass: agentIconClass(turn),
    }
    railMemo.set(turn, memo)
  }
  return memo
}
</script>
