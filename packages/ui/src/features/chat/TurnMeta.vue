<template>
  <!--
    TurnMeta：回合状态条（demo workbench.css .workmeta 轮头形态，M3a 视觉复刻对齐）。
    从 Turn.vue 拆出。demo 权威形态：mono + 12px（--text-xs）+ dim 单行，段间 10px gap，
    内容左缘 x=0（Button px-1.5 的占位由 -mx-1.5 抵消——ghost hover 背景左右各留 6px
    内边距，文字对齐不变）；「已工作」的时长值 = mid 色 + fw-mid 强调（demo .workmeta b）；
    思考/工具计数 = chipn chips（hairline 边框 + 6px 圆角 + 1×8 padding + mid 字 + bg-input 底，
    demo .workmeta .chipn）；轮头行下方补全宽分隔横线（同 SystemNotice / ActivityStrip
    分隔行族 gradient，用户裁决 2026-10-11 参考「后台命令已完成」分割线设计——demo
    「轮次分隔 = 纯留白无 hr」形态由该裁决覆盖）。
    （原「纯文本段无底色无边框」形态 = 用户裁决 2026-10-06，被 M3a demo 权威覆盖，登记于
    .tmp/ui-replica/reports/m3a-turn-skeleton.md 决策清单）
    [bg-notice-fold specs/chat/system-notices.md §3] settle 收纳态：落成轮头行状态字换为
    折叠分段标签「已处理后台任务 · Subagent · Workflow」（发生序去重，各类型词悬停出解释卡，
    §3.5）+ 跨类型失败词标「N 项失败」；数据源 foldedRows = Turn.vue 经 core
    deriveFoldedNoticeRows 单点派生。工作态维持「工作中」（临时外部行/聚合行由 Turn 承担，
    外部行与收纳态不重复出现）。托管会话折叠词待用户裁决（spec §6），暂用 demo 提案值。
  -->
  <!-- turn-meta wrapper（sticky 已移除：负 margin 覆盖 scrollEl padding-top 的技巧不可靠——
       working 态贴顶时与 scrollEl 顶部有间隔，滚过来的文字从 gap 漏出。改回正常文档流）。
       [u6a] v-if 收窄回 assistants.length > 0：dispatching 空窗期的空 turn（user 已发、
       assistant 未到）不再渲染 TurnMeta 占位——「思考中」指示已迁对话流尾部 ActivityStrip
       thinking 行（sessionPhase occupancy 派生视图驱动，D7 展示统一）。 -->
  <div
    v-if="turn.assistants.length > 0"
    :data-testid="`turn-meta-${turnIndex}`"
  >
    <!-- 轮头行：flex 容器承载运行态呼吸弧 + Button。呼吸弧悬挂在 Button 外（v-html 注入的
         svg 无 class 可竞争，尺寸只能由容器 span 承载，弧规格 = demo run-ic 15px accent）。 -->
    <div class="flex items-center gap-[10px]">
      <!-- eslint-disable-next-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
      <span v-if="isStreaming" class="inline-block size-[15px] shrink-0 text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" />
      <Button
        variant="ghost"
        size="sm"
        class="turn-meta -mx-1.5 h-auto w-fit flex-wrap items-center justify-start gap-[10px] self-start px-1.5 py-[4px] font-mono font-normal text-[length:var(--text-xs)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
        :class="[
          !turn.hasFoldable
            ? 'cursor-default hover:text-neutral-mid'
            : 'cursor-pointer hover:text-neutral-fg',
        ]"
        :disabled="isWorkingTurn || !turn.hasFoldable"
        @click="toggle(turnKey)"
      >
        <!-- 运行态指示 = 外层呼吸弧（demo run-ic 规格）；原 Loader2 spinner 已换（wave3 起
             chat 域 loader 统一呼吸弧，TurnMeta 是最后一处 Loader2 残留） -->
        <!-- 状态段（状态字 + elapsed）：状态字恒 text-neutral-dim；elapsed = demo .workmeta b
             强调档（mid 色 + fw-mid）。settle 收纳态（specs/chat/system-notices.md §3.3）状态字
             换为折叠分段标签「已处理后台任务 · Subagent · Workflow」——分段按发生序去重，
             各类型词悬停出解释卡（§3.5，HoverCard 复用 SystemNotice 悬停详情原语）；落成瞬间
             （justDone）播一次性 notice-in 高亮。工作态与无收纳轮维持原状态字。 -->
        <span
          class="tm-status font-mono text-[length:var(--text-xs)] text-neutral-dim tabular-nums"
          :class="justDone && foldedSegments.length > 0 ? 'animate-notice-in' : ''"
        >
          <span v-if="foldedSegments.length > 0" class="lbl inline-flex flex-wrap items-center gap-x-1">
            <template v-for="(seg, i) in foldedSegments" :key="seg.type">
              <span v-if="i > 0" class="text-neutral-faint">·</span>
              <HoverCard>
                <HoverCardTrigger as-child>
                  <span
                    class="cursor-default underline decoration-dotted decoration-neutral-faint underline-offset-[3px]"
                    :data-testid="`turn-meta-folded-type-${seg.type}`"
                  >{{ seg.label }}</span>
                </HoverCardTrigger>
                <HoverCardContent :side="hoverSide" class="w-[264px] px-3 py-2.5">
                  <div :data-testid="`turn-meta-folded-pop-${seg.type}`">
                    <div class="flex items-center gap-1.5 pb-0.5 text-[length:var(--text-xs)] [font-weight:var(--fw-mid)] text-neutral-mid">
                      <component :is="seg.icon" class="size-3.5 shrink-0" stroke-width="1.6" />
                      <span>{{ seg.typeLabel }}</span>
                    </div>
                    <p class="text-[length:var(--text-xs)] leading-relaxed text-neutral-mid">{{ seg.desc }}</p>
                    <p
                      class="pt-1 font-mono text-[length:var(--text-xs)] tabular-nums text-neutral-dim"
                      data-testid="turn-meta-folded-pop-summary"
                    >{{ seg.summary }}</p>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </template>
          </span>
          <span v-else class="lbl">{{ statusLabel }}</span>
          <span class="elapsed ml-1 text-neutral-mid [font-weight:var(--fw-mid)]">{{ elapsed }}</span>
        </span>
        <!-- Turn 区间（整个 agent-turn 起止时刻）：进行中右端显「（进行中）」，
             定格后显末次产出结束时刻 -->
        <span v-if="startedAt > 0" class="tm-range ml-1.5 font-mono text-[length:var(--text-xs)] text-neutral-dim tabular-nums">
          · {{ formatClock(startedAt) }} → {{ isLive ? t('panel.message.inProgress') : formatClock(endedAt) }}
        </span>
        <!-- 已生成 token 数（B1 完成态定格常驻；口径 = 本 turn 已上报的真实 usage.outputTokens
             之和，含正文 + 思考 + 工具参数——pi usage 原语义，无需按 block 分类）：
             TurnMeta 是 per-turn 事实聚合位，tokens 与 elapsed/时刻区间同族事实。
             流式期的当前调用尚无 usage → 显示已完成段的真实累计（收尾时跳到完整值）；
             全程无近似值（用户裁决 A：不在真值之外显示估算）。0 不渲染（零内容 turn 不占行宽）。
             [MF-1-37]（demo TurnList.vue:63 `已生成 <b>7,705</b> tokens` + workbench.css
             .workmeta b）：数值段强调档 mid 色 + fw-mid——i18n 单串 {tokens} 占位无法局部
             包 span，经 generatedTokensParts 哨兵拆段渲染（key 与 locale 零改动）。 -->
        <span
          v-if="generatedTokens > 0"
          data-testid="turn-meta-tokens"
          class="tm-tokens ml-1.5 font-mono text-[length:var(--text-xs)] text-neutral-dim tabular-nums"
        >· {{ generatedTokensParts.before }}<span class="text-neutral-mid [font-weight:var(--fw-mid)]">{{ generatedTokens.toLocaleString() }}</span>{{ generatedTokensParts.after }}</span>
        <!-- 收纳失败词标（specs/chat/system-notices.md §3.3）：warn 色胶囊「N 项失败」，不展开
             也可扫到异常终态；段位在 chevron 之前（demo has-nt 行序：标签 → tokens → 词标 → chevron） -->
        <span
          v-if="foldedFailCount > 0"
          class="inline-flex shrink-0 items-center rounded-sm bg-[color-mix(in_oklch,var(--warn)_12%,transparent)] px-2 py-px font-mono text-[length:var(--text-xs)] text-warn tabular-nums"
          data-testid="turn-meta-folded-failed"
        >{{ t('panel.message.noticeFoldFailedTag', { count: foldedFailCount }) }}</span>
        <!-- [chat-flow-consistency U9 / S2] 交接文档标签：turn 锚是交接指令提示行时，
             其后 assistant 回合（交接文档）挂此标签——文档照常展示，标签只标注来源
             （chipn 形态对齐思考/工具计数 chip，中性不染色）。 -->
        <span
          v-if="isHandoffDoc"
          data-testid="turn-meta-handoff-doc"
          class="badge inline-flex shrink-0 items-center rounded-sm border border-hairline bg-bg-input px-2 py-px font-mono text-[length:var(--text-xs)] text-neutral-mid tabular-nums"
        >{{ t('panel.message.handoffDocTag') }}</span>
        <!-- chevron 紧跟耗时（展开/收起 trace 入口），在 badge 之前 -->
        <ChevronRight
          v-if="turn.hasFoldable && !isWorkingTurn"
          class="chev size-[9px] text-neutral-dim transition-transform duration-[var(--duration)] ease-[var(--ease)]"
          :class="isExpanded(turnKey) ? 'rotate-90 text-accent' : ''"
        />
        <!-- 思考/工具计数段：chipn chips（demo .workmeta .chipn：hairline 边框 + 6px 圆角 +
             1×8 padding + mid 字 + bg-input 底），段间距由外层 flex gap 10px 承担（无 ml） -->
        <span v-if="thinkCount > 0" class="badge badge-think inline-flex items-center gap-[5px] rounded-sm border border-hairline bg-bg-input px-2 py-px font-mono text-[length:var(--text-xs)] text-neutral-mid tabular-nums">{{ t('panel.message.thinkCount', { count: thinkCount }) }}</span>
        <span v-if="toolCount > 0" class="badge badge-tool inline-flex items-center gap-[5px] rounded-sm border border-hairline bg-bg-input px-2 py-px font-mono text-[length:var(--text-xs)] text-neutral-mid tabular-nums">{{ t('panel.message.toolCount', { count: toolCount }) }}</span>
      </Button>
    </div>
    <!-- 轮头底部全宽分隔横线：分隔轮头行与本轮正文（trace），两端渐隐 gradient 与 SystemNotice /
         ActivityStrip 分隔行族同款（用户裁决 2026-10-11，见头注）。mt-[6px] 与轮头行脱开，
         下方接 trace 容器的 mt-[12px]（Turn.vue），合计约一轮界档 -->
    <span class="mt-[6px] block h-px w-full bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会封住一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card'
import type { FoldedNoticeRow, FoldedNoticeType, MessageTurn } from '@taiji/core/domain/chat'
import { isHandoffDocTurn } from '@taiji/core/domain/chat'
import {
  FOLDED_TYPE_DESC_KEY,
  FOLDED_TYPE_ICON,
  FOLDED_TYPE_LABEL_KEY,
  FOLDED_TYPE_WORD_KEY,
} from './folded-notice'
import { RUNNING_LOADER_SVG } from './block-icon'
import { useChatViewDeps } from './chat-view-deps'
import { formatClock } from './format-utils'

const props = withDefaults(
  defineProps<{
    turn: MessageTurn
    isWorkingTurn: boolean
    isStreaming: boolean
    thinkCount: number
    toolCount: number
    elapsed: string
    /** 当前 turn 在 session 内的序列下标（仅展示/testid 用） */
    turnIndex: number
    /** 当前 turn 的稳定 key（turnStableId(turn)，M5 stable-key：展开态查询按此，不随消息插删漂移） */
    turnKey: string
    /** session id（透传保留） */
    sessionId: string
    /** turn 起点时刻（epoch ms；user 消息 / 首条 assistant，core deriveTurnAggregates） */
    startedAt: number
    /** turn 终点时刻（epoch ms；最后一次产出结束；进行中 = 当下已发生活动的结束时刻） */
    endedAt: number
    /** 本 turn 是否仍在进行（未定格，= 工作 turn）——驱动「（进行中）」与 live 语义 */
    isLive: boolean
    /** 本 turn 已上报的真实生成 token 总量（Σ usage.outputTokens）；0 不渲染。
     *  可选 + 默认 0：非可选类型经 withDefaults 会编译出 required:true，漏传即 Vue warn */
    generatedTokens?: number
    /** 被收纳完成通知明细行（Turn.vue 经 core deriveFoldedNoticeRows 单点派生后下发；
     *  specs/chat/system-notices.md §3.3 折叠分段标签 + §3.5 解释卡的数据源） */
    foldedRows?: FoldedNoticeRow[]
    /** 落成瞬间一次性信号（Turn.vue justDone）——收纳标签切换时播一次 notice-in 高亮 */
    justDone?: boolean
  }>(),
  { generatedTokens: 0, foldedRows: () => [], justDone: false },
)

// turn 展开/折叠经 ChatViewDeps inject（renderer 壳绑 useTurnExpansion store）
const { isExpanded, toggleExpand: toggle } = useChatViewDeps()

const { t } = useI18n()

/**
 * working 态文案（SSOT §3.3.4）：working（assistant 已到、仍在生成）显示「工作中」；
 * 完成态「已工作」。[u6a] dispatching 空窗占位分支已删除——空 turn 不再渲染 TurnMeta
 * （v-if 收窄 assistants.length > 0），「思考中」指示迁对话流尾部 ActivityStrip thinking 行
 * （sessionPhase occupancy 派生视图驱动，D7 展示统一）。
 */
const statusLabel = computed(() => {
  if (!props.isWorkingTurn) return t('panel.message.worked')
  return t('panel.message.working')
})

/** 交接文档回合（chat-flow-consistency U9 / S2）：判定 SSOT 在 core isHandoffDocTurn
 *  （turn 锚是交接指令提示行）——纯派生值，随 turn 对象引用不变而稳定。 */
const isHandoffDoc = computed(() => isHandoffDocTurn(props.turn))

// ── settle 收纳态（specs/chat/system-notices.md §3.3 / §3.5）────────────────────────
// 折叠分段标签只在落成态渲染：工作态维持「工作中」（临时外部行/聚合行由 Turn.vue 按工作态
// 渲染，外部行与收纳态不重复出现）。分段 = 发生序去重的类型词序列；失败词标跨类型累计。
// 图标表 / i18n 键表 = ./folded-notice 展示映射单点（Turn 明细行同源）。

/** 折叠分段（发生序去重 + 每类汇总文案）；settle 门控——工作态不渲染折叠标签 */
const foldedSegments = computed(() => {
  if (props.isWorkingTurn) return []
  const seen = new Set<FoldedNoticeType>()
  const order: FoldedNoticeType[] = []
  for (const row of props.foldedRows) {
    if (!seen.has(row.type)) {
      seen.add(row.type)
      order.push(row.type)
    }
  }
  return order.map((type) => {
    const list = props.foldedRows.filter((r) => r.type === type)
    const failed = list.filter((r) => r.outcome === 'failed').length
    const ok = list.length - failed
    const summary =
      failed > 0
        ? `${t('panel.message.noticeTypeSummaryOk', { total: list.length, ok })} · ${t('panel.message.noticeTypeSummaryFail', { failed })}`
        : t('panel.message.noticeTypeSummaryOk', { total: list.length, ok })
    return {
      type,
      icon: FOLDED_TYPE_ICON[type],
      label: t(FOLDED_TYPE_LABEL_KEY[type]),
      typeLabel: t(FOLDED_TYPE_WORD_KEY[type]),
      desc: t(FOLDED_TYPE_DESC_KEY[type]),
      summary,
    }
  })
})

/** 失败词标计数（跨类型累计；0 不渲染）。settle 门控与折叠分段一致——工作态失败信息由
 *  临时外部行 / D5 聚合行承担，两形态不重复出现。 */
const foldedFailCount = computed(() =>
  props.isWorkingTurn
    ? 0
    : props.foldedRows.filter((r) => r.outcome === 'failed').length,
)

/** 解释卡默认朝下（轮头行贴近流顶部，朝上易越出滚动容器可视区） */
const hoverSide = 'bottom' as const

/**
 * [MF-1-37] tokens 文案前后段（demo TurnList.vue:63 数值段 `<b>` 强调档，workbench.css
 * .workmeta b = mid + fw-mid）：i18n 单串 {tokens} 占位无法局部包 span——以 NUL 哨兵
 * 占位求值后按哨兵拆前后段，数值段独立 span 承载强调档；语序（zh「已生成 X tokens」/
 * en「Generated X tokens」）由串自身承载，key 与 locale 文件零改动。
 */
const TOKENS_SENTINEL = '\u0000'
const generatedTokensParts = computed(() => {
  const parts = t('panel.message.generatedTokens', { tokens: TOKENS_SENTINEL }).split(TOKENS_SENTINEL)
  return { before: parts[0] ?? '', after: parts[1] ?? '' }
})
</script>
