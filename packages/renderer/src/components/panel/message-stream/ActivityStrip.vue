<!--
  展示组件 · ActivityStrip 对话流尾部活动条（session-occupancy u6a / D7 展示统一）。
  数据源 = chat store 的 sessionPhase（occupancy 投影，runtime session.occupancy state topic
  驱动的单一权威）+ executingBash 瞬时态（props 注入，core bash-effects 分区）。

  收编三处分散的「进行中」指示（原 compacting 浮层 / TurnMeta dispatching 思考占位 /
  executing bash 行），按优先级纵向堆叠（compacting > bash > thinking / settling）：

  bash 双数据源语义分工（occupancy OCC-7 登记，2026-09-07）：「bash 占用」在系统内有两
  条帧路、语义不同不合并——① session.occupancy 帧（state topic 三维快照的 bash 布尔，
  runtime dispatcher sendBash 置位 / bashResult 复位）是**占用判定权威**，发送分流器
  （composer-shell effectivePhase → D6 路由表 bash 行）与发送位四态消费它；②
  message.bashStart / message.bashResult 事件帧 → core bash-effects ephemeral 分区
  （executingBash，本组件 bash 行展示源）是**瞬时展示态**（「正在执行 + 命令」，终态即清）。
  两路帧同源同生命周期（dispatcher 同批广播），但消费域不同：本组件不读 occupancy bash
  维（展示靠 executingBash 拿命令文本），发送位不读 bashStart 帧（判定靠 occupancy 权威
  快照，避免事件帧丢失即误判可发）——语义分工维持，非重复实现。
  - compacting：手动 →「压缩中」；threshold/overflow（reason 文案源 = setCompactingReason
    通路，u5b 保留）→「正在自动压缩上下文」
  - bash：「正在执行」+ mono 命令
  - thinking：turn=dispatching（prompt 已发、message_start 未到）→「思考中…」；或
    subagentThinking prop=true（subagent-drawer-blank §6.3：虚拟 session 收不到 occupancy
    帧，思考行由 MessageStream 的 subagent forceWorking 补充驱动，文案同复用 dispatching key）
  - settling：turn=settling（turn-end→agent_settled 收尾窗口，D6 表行 4 活动条列）且无
    compacting/bash 时渲染一行——文案暂复用 dispatching key「思考中…」；P-1 探针（V8）
    校准点：若 settling P95 > 2s 常态化，换「收尾中…」专用 key（zh/en 同步）
  - turn=generating 不渲染行：streaming 本体由末位 turn 的 TurnMeta「工作中」行承担
    （D6 活动条列「streaming 本体」，不重复指示）；全部 idle 渲染 nothing。

  视觉（[compact-defer-composer-queue §2.2]）：compacting 行升级为通栏活动带——accent-soft
  底 + border-y hairline + py-[14px] 居中，副文案联动待发队列未提交计数（count===0 时副文案
  与「·」不渲染）；bash/thinking/settling 行维持 system-notice 形态（左右 hairline +
  Loader2 spinner + --text-xs，太极纯灰 tokens，无 emoji 无硬编码颜色）。文档流 block
  （Virtualizer 之后），fork notice 等后续文档流内容自然堆叠在其后（ForkNotice 为文档流
  block，无 absolute 定位——定位链已随 D6 死路径清理删除）。
  dev 断言：COMPACTING_NOTICE_HEIGHT / EXECUTING_BASH_NOTICE_HEIGHT 常量漂移检测随行迁入
  （useConstantHeightAssert，生产裁剪零开销）。
-->
<template>
  <div v-if="rows.length > 0" class="flex flex-col" data-testid="activity-strip">
    <template v-for="row in rows" :key="row.kind">
      <!-- compacting 行：[compact-defer-composer-queue §2.2] 通栏活动带——摘除 content-col /
           system-notice（hairline 视觉由 border-y 承担，notice-in 动画不再复用），accent-soft 底 +
           上下 hairline；-mx-5 抵消滚动容器 px-5，任意面板宽（含 >720px）下通栏到面板边缘。 -->
      <div
        v-if="row.kind === 'compacting'"
        :ref="(el) => bindRowRef(row.kind, el)"
        class="-mx-5 flex items-center justify-center gap-2 border-y border-hairline bg-[var(--accent-soft)] px-5 py-[14px]"
        :data-testid="`activity-strip-row-${row.kind}`"
      >
        <Loader2 class="size-3.5 shrink-0 animate-spin text-accent" />
        <span
          class="text-[length:var(--text-sm)] text-neutral-fg"
          :data-testid="`activity-strip-text-${row.kind}`"
        >{{ row.text }}</span>
        <template v-if="flushCount > 0">
          <span class="text-neutral-faint">·</span>
          <span
            class="text-[length:var(--text-xs)] text-neutral-mid"
            :data-testid="`activity-strip-flush-hint-${row.kind}`"
          >{{ t('panel.message.compactingFlushHint', { count: flushCount }) }}</span>
        </template>
      </div>
      <!-- bash / thinking / settling 行：维持原 system-notice + content-col 形态（左右 hairline） -->
      <div
        v-else
        :ref="(el) => bindRowRef(row.kind, el)"
        class="system-notice content-col flex min-w-0 items-center gap-2 py-1"
        :data-testid="`activity-strip-row-${row.kind}`"
      >
        <span class="h-px flex-1 bg-border" />
        <Loader2 class="size-3 shrink-0 animate-spin text-neutral-mid" />
        <span
          class="flex min-w-0 items-center gap-1 text-[length:var(--text-xs)] leading-snug text-neutral-mid"
          :data-testid="`activity-strip-text-${row.kind}`"
        >
          <span class="shrink-0">{{ row.text }}</span>
          <span v-if="row.command" class="min-w-0 truncate font-mono">{{ row.command }}</span>
        </span>
        <span class="h-px flex-1 bg-border" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from '@lucide/vue'
import type { ExecutingBash } from '@xyz-agent/core'
import { useChatStore } from '@/stores/chat'
import { useConstantHeightAssert } from '@/composables/panel/useConstantHeightAssert'
import { useCompactQueue } from '@/composables/panel/useCompactQueue'
import { COMPACTING_NOTICE_HEIGHT, EXECUTING_BASH_NOTICE_HEIGHT } from '@/composables/panel/message-stream-layout'

const props = defineProps<{
  /** session id（occupancy 投影 / compacting reason 的查询键） */
  sessionId: string
  /** 执行中 bash 瞬时态（core bash-effects 分区，MessageStream computed 注入；无则 undefined） */
  executingBash?: ExecutingBash
  /** subagent 虚拟 session 思考中（u3-thinking / §6.3，MessageStream computed 注入：
   *  forceWorking 且末位 turn 无 assistant 产出；默认 false） */
  subagentThinking?: boolean
}>()

const chat = useChatStore()
const { t } = useI18n()

/** 活动条行（单一变化轴：行类型 + 文案）。优先级 = 数组序（compacting > bash > thinking / settling，
 *  thinking 与 settling 互斥不并存——turn 单值，同一档位）。 */
interface ActivityRow {
  kind: 'compacting' | 'bash' | 'thinking' | 'settling'
  text: string
  /** bash 行专属：mono 命令文本 */
  command?: string
}

const rows = computed<ActivityRow[]>(() => {
  const list: ActivityRow[] = []
  const compacting = chat.isCompacting(props.sessionId)
  const turn = chat.sessionPhase(props.sessionId).turn
  // compacting 行（manual → 压缩中；threshold/overflow → 自动压缩中；未知/空 reason 兜底手动文案，
  // 与原 useMessageStreamNotices.compactingText 判定逐字一致——reason==='manual' 不特判即落此分支）
  if (compacting) {
    const reason = chat.getCompactingReason(props.sessionId)
    list.push({
      kind: 'compacting',
      text: reason === 'threshold' || reason === 'overflow'
        ? t('panel.message.autoCompressing')
        : t('panel.message.compressing'),
    })
  }
  // bash 行（`!` 命令执行期瞬时反馈；与 compacting 可并存——threshold turn 内压缩 + bash）
  if (props.executingBash) {
    list.push({ kind: 'bash', text: t('panel.message.executingBash'), command: props.executingBash.command })
  }
  // thinking 行：无 compacting/bash 且（turn=dispatching（occupancy 权威投影，替代原 TurnMeta
  // isPendingPlaceholder 占位）或 subagentThinking（§6.3：虚拟 session 收不到 occupancy 帧，
  // 思考行由 subagent forceWorking 补充驱动））——「无以上但有思考信号」才显示，避免与压缩/命令行重复堆叠
  if (!compacting && !props.executingBash && (turn === 'dispatching' || props.subagentThinking)) {
    list.push({ kind: 'thinking', text: t('panel.message.dispatching') })
  }
  // settling 行（D6 表行 4 活动条列前半，修复一致性审查 R3-U1）：无 compacting/bash 且
  // turn=settling（turn-end→agent_settled 收尾窗口，设计 §2.1 失败 C 的「有提示无状态」
  // 窗口之一）。文案复用 dispatching key「思考中…」，P-1 校准点见组件头注；与 thinking
  // 同档位互斥；settling+compacting 命中上方 compacting 行，不重复渲染。
  if (!compacting && !props.executingBash && turn === 'settling') {
    list.push({ kind: 'settling', text: t('panel.message.dispatching') })
  }
  return list
})

const queue = useCompactQueue()

/** 待发队列未提交条目计数（副文案口径，[compact-defer-composer-queue §2.2]）：只计
 *  mode === undefined 的未提交条目，与 composer 队列区 defer 行归一规则（§2.1）同源——
 *  flush 提交后已提交条目（mode 已写）不计入（承接面分通道：steer 镜像行 / send 无行）。
 *  count === 0 时副文案与「·」不渲染（活动带仍在，压缩状态本身独立成立）。 */
const flushCount = computed(() => queue.peek(props.sessionId).filter((m) => m.mode === undefined).length)

// dev-only 像素常量漂移检测（随行迁入本组件；compacting 行升级通栏带后 COMPACTING_NOTICE_HEIGHT
// 已随 §2.2 同步 24 → 50，bash 行结构不变 EXECUTING_BASH_NOTICE_HEIGHT 不动）
const [compactingEl, executingBashEl] = useConstantHeightAssert([
  { name: 'COMPACTING_NOTICE_HEIGHT', expected: COMPACTING_NOTICE_HEIGHT },
  { name: 'EXECUTING_BASH_NOTICE_HEIGHT', expected: EXECUTING_BASH_NOTICE_HEIGHT },
]).els

/** v-for 行的函数 ref 分发（thinking / settling 行不参与高度断言，el 丢弃） */
function bindRowRef(kind: ActivityRow['kind'], el: unknown): void {
  const node = el instanceof HTMLElement ? el : null
  if (kind === 'compacting') compactingEl.value = node
  else if (kind === 'bash') executingBashEl.value = node
}
</script>
