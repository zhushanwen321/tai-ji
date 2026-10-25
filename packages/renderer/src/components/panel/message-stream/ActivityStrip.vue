<!--
  展示组件 · ActivityStrip 对话流尾部活动条（session-occupancy u6a / D7 展示统一）。
  数据源 = chat store 的 sessionPhase（occupancy 派生视图，runtime session.occupancy state topic
  驱动的单一权威）+ executingBash 瞬时态（props 注入，core bash-effects 分区）。

  收编三处分散的「进行中」指示（原 compacting 浮层 / TurnMeta dispatching 思考占位 /
  executing bash 行），按优先级纵向堆叠（compacting > bash > thinking / settling）：

  bash 双数据源语义分工（occupancy OCC-7 登记，2026-09-07）：「bash 占用」在系统内有两
  条帧路、语义不同不合并——① session.occupancy 帧（state topic 四维快照的 bash 布尔，
  runtime dispatcher sendBash 置位 / bashResult 复位）是**占用判定权威**，发送分流器
  （composer-shell effectivePhase → D6 路由表 bash 行）与发送位四态消费它；②
  message.bashStart / message.bashResult 事件帧 → core bash-effects ephemeral 分区
  （executingBash，本组件 bash 行展示源）是**瞬时展示态**（「正在执行 + 命令」，终态即清）。
  两路帧同源同生命周期（dispatcher 同批广播），但消费域不同：本组件不读 occupancy bash
  维（展示靠 executingBash 拿命令文本），发送位不读 bashStart 帧（判定靠 occupancy 权威
  快照，避免事件帧丢失即误判可发）——语义分工维持，非重复实现。
  - compacting：手动 →「压缩中」；threshold/overflow（reason 文案源 = setCompactingReason
    通路，u5b 保留）→「正在自动压缩上下文」
  - bash：「正在执行」+ elapsed mono meta（方案 A：命令原文在悬停详情，不内联）
  - thinking：turn=dispatching（prompt 已发、message_start 未到）→「思考中…」；或
    subagentThinking prop=true（subagent-drawer-blank §6.3：虚拟 session 收不到 occupancy
    帧，思考行由 MessageStream 的 subagent forceWorking 补充驱动，文案同复用 dispatching key）
  - settling：turn=settling（turn-end→agent_settled 收尾窗口，D6 表行 4 活动条列）且无
    compacting/bash 时渲染一行——文案暂复用 dispatching key「思考中…」；P-1 探针（V8）
    校准点：若 settling P95 > 2s 常态化，换「收尾中…」专用 key（zh/en 同步）
  - turn=generating 不渲染行：streaming 本体由末位 turn 的 TurnMeta「工作中」行承担
    （D6 活动条列「streaming 本体」，不重复指示）；全部 idle 渲染 nothing。

  视觉（M3c demo 复刻运行态摘要行）：compacting 行自「通栏 accent-soft 活动带」降级回归
  本族（2026-09-16 裁决，design §3.3 D4）——摘除 -mx-5 通栏 / bg-[var(--accent-soft)] 底 /
  border-y，与 bash/thinking/settling 行共用一套 DOM 结构：两端渐隐横线（transparent→
  --border-strong 18%→82%→transparent）+ 15px accent 呼吸弧（demo .run-ic 规格，
  animate-loader-spin 三重动画；M3c 起替换 Loader2 spinner）+ text-base(14px)/mid/fw-mid
  主文案（demo .think .t-name）+ 可选 mono meta（text-2xs/500/tabular-nums/neutral-dim）+
  可选「待发 N」chip（mono text-3xs + border-strong 描边，计数口径不变：未提交全量条数，
  count===0 时 chip 不渲染）。system-notice + content-col 保留（居中 720 内容列）。
  demo 运行态文字扫光（N13 shine）不在本行落：扫光机制宿主 = Block 族行文本
  （text-sweep，M3b 域），ActivityStrip 为会话级活动条不复制该形态（M3c 报告登记）。
  [notice-family-phrase-detail 2026-09-18 方案 A] bash 行短语化：命令原文不再内联（长命令
  会把 flex-1 横线挤成残端/归零），移入 HoverCard 悬停详情（只读 + 复制）；行内补 elapsed
  mono meta（「已 Ns」，1s tick 仅 executingBash 存在期间挂载）维持执行期观察。文档流
  block（Virtualizer 之后），fork notice 等后续文档流内容自然堆叠在其后（ForkNotice
  为文档流 block，无 absolute 定位——定位链已随 D6 死路径清理删除）。
  dev 断言：COMPACTING_NOTICE_HEIGHT / EXECUTING_BASH_NOTICE_HEIGHT 常量漂移检测随行迁入
  （useConstantHeightAssert，生产裁剪零开销）；两常量随降级同批重测（D4 连带面）。
-->
<template>
  <div v-if="rows.length > 0" class="flex flex-col" data-testid="activity-strip">
    <!-- 四行同构（D3 增强规格 + 方案 A）：左渐隐线 / spinner / 主文案（+ 可选 meta + 可选
         chip）/ 右渐隐线。两端渐隐用 Tailwind 任意值声明 background-image（bg-[image:…]，
         h-px 高度由 class 承担）。主体 span 即悬停详情 trigger（as-child 零额外 DOM；无
         detail 的行受控 open 恒 false）。 -->
    <div
      v-for="row in rows"
      :key="row.kind"
      :ref="(el) => bindRowRef(row.kind, el)"
      class="system-notice content-col flex min-w-0 items-center gap-2 py-1.5"
      :data-testid="`activity-strip-row-${row.kind}`"
    >
      <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
      <!-- waiting 行（裁决 3A）：三点等待（accent 4px 圆点 ×3，900ms 周期错峰 120ms）；
           其余行保持呼吸弧（M3c demo 复刻 .run-ic 规格：15px accent + animate-loader-spin
           三重动画）。内联 SVG 结构复制自 block-icon.ts RUNNING_LOADER_SVG（该常量消费模式 =
           v-html 注入，需行内豁免注释；本组件按红线改取静态模板内联、零豁免；弧动画类
           .ld-track/.ld-arc 由 style.css 全局层持有，改动两处须同步）。 -->
      <span
        v-if="row.kind === 'waiting'"
        class="wait-dots inline-flex h-[22px] shrink-0 items-center gap-[5px]"
        aria-hidden="true"
        data-testid="activity-strip-dots-waiting"
      >
        <i class="block size-[6px] rounded-full bg-accent opacity-30"></i><i class="block size-[6px] rounded-full bg-accent opacity-30"></i><i class="block size-[6px] rounded-full bg-accent opacity-30"></i>
      </span>
      <svg
        v-else
        class="size-[15px] shrink-0 text-accent animate-loader-spin"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle class="ld-track" cx="12" cy="12" r="10" opacity="0.16" />
        <circle class="ld-arc" cx="12" cy="12" r="10" pathLength="100" />
      </svg>
      <HoverCard
        :open="openDetailKind === row.kind"
        :open-delay="DETAIL_OPEN_DELAY_MS"
        @update:open="row.detail && onDetailToggle(row.kind, $event)"
      >
        <HoverCardTrigger as-child>
          <span
            class="flex min-w-0 items-center gap-1"
            :data-testid="`activity-strip-text-${row.kind}`"
          >
            <!-- 主文案（M3c demo 复刻 .think .t-name：mid 色 + fw-mid 600 + 14px/--text-base 档） -->
            <span
              class="shrink-0 text-[length:var(--text-base)] text-neutral-mid [font-weight:var(--fw-mid)]"
              :class="row.detail ? DETAIL_HINT_CLASS : ''"
            >{{ row.text }}</span>
            <!-- elapsed mono meta（方案 A）：bash 行计时观察——命令移入悬停详情后行内保留 -->
            <span
              v-if="row.meta"
              class="shrink-0 font-mono text-[length:var(--text-2xs)] font-medium tabular-nums text-neutral-dim"
            >{{ row.meta }}</span>
            <!-- 待发 chip（compacting 行专属形态）：计数口径与 composer 队列区 defer 行归一规则同源 -->
            <span
              v-if="row.chipCount"
              class="shrink-0 rounded-[4px] border border-border-strong px-1.5 font-mono text-[length:var(--text-3xs)] font-medium leading-[1.8] text-neutral-mid"
              :data-testid="`activity-strip-flush-hint-${row.kind}`"
            >{{ t('panel.message.compactingQueueChip', { count: row.chipCount }) }}</span>
          </span>
        </HoverCardTrigger>
        <!-- 悬停详情（方案 A）：bash 行命令原文完整呈现（只读 + 复制）；portal 挂 body
             不参与对话流布局。testid 落内层实元素（Teleport 根不 fallthrough 非 prop attrs） -->
        <HoverCardContent v-if="row.detail" side="top" class="w-[min(520px,85vw)] px-3 py-2.5">
          <div :data-testid="`activity-strip-detail-${row.kind}`">
            <div class="flex items-center justify-between gap-2 pb-1.5">
              <span class="font-mono text-[length:var(--text-2xs)] font-medium uppercase tracking-wider text-neutral-dim">{{ row.detail.label }}</span>
              <Button
                variant="ghost"
                class="h-auto cursor-default px-1.5 py-0.5 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
                :data-testid="`activity-strip-detail-copy-${row.kind}`"
                @click="copyDetailBody(row.kind)"
              >{{ copiedKind === row.kind ? t('common.copied') : t('common.copy') }}</Button>
            </div>
            <p
              class="max-h-[180px] overflow-y-auto font-mono text-[length:var(--text-xs)] leading-relaxed text-neutral-fg"
              :data-testid="`activity-strip-detail-body-${row.kind}`"
            >{{ row.detail.body }}</p>
          </div>
        </HoverCardContent>
      </HoverCard>
      <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExecutingBash } from '@taiji/core'
import { formatDurationHms } from '@taiji/ui'
import { useChatStore } from '@/stores/chat'
import { useConstantHeightAssert } from '@/composables/panel/useConstantHeightAssert'
// 待发 chip 计数谓词 = core 单一定义点（remote-use U20 下沉——与 composer 队列区/移动壳同源）
import { deliveryQueueEntries, getDeliveryProjectionRef } from '@taiji/core'
import { COMPACTING_NOTICE_HEIGHT, EXECUTING_BASH_NOTICE_HEIGHT } from '@/composables/panel/message-stream-layout'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'


const props = defineProps<{
  /** session id（occupancy 派生视图 / compacting reason 的查询键） */
  sessionId: string
  /** 执行中 bash 瞬时态（core bash-effects 分区，MessageStream computed 注入；无则 undefined） */
  executingBash?: ExecutingBash
  /** subagent 虚拟 session 思考中（u3-thinking / §6.3，MessageStream computed 注入：
   *  forceWorking 且末位 turn 无 assistant 产出；默认 false） */
  subagentThinking?: boolean
}>()

const chat = useChatStore()
const { t } = useI18n()

/** 活动条行（单一变化原因：行类型 + 文案）。优先级 = 数组序（compacting > bash > waiting / thinking /
 *  settling，waiting 与 thinking 同档互斥——dispatching 优先三点等待行，subagentThinking 才落呼吸弧行）。 */
interface ActivityRow {
  kind: 'compacting' | 'bash' | 'waiting' | 'thinking' | 'settling'
  text: string
  /** mono meta 钉右（text-2xs/500/tabular-nums）：bash 行 elapsed 计时（方案 A——命令移入
   *  悬停详情后，行内保留执行期观察） */
  meta?: string
  /** 悬停详情（方案 A）：bash 行命令原文完整呈现；其余行无无界载荷不挂 */
  detail?: { label: string; body: string }
  /** compacting 行专属：待发 chip 计数（>0 才渲染 chip——见 flushCount 口径） */
  chipCount?: number

}

/** 待发队列条目计数（chip 口径，[compact-defer-composer-queue §2.1 → u3c 内核化]）：
 *  数据源 = session.delivery 帧派生视图（内核权威），口径与 composer 队列区（useQueueRows）同源
 *  ——谓词 = core deliveryQueueEntries（U20 下沉唯一定义点），非 direct 投递路径且未 delivered
 *  的条目计待发。
 *  count === 0 时 chip 不渲染（活动行仍在，压缩状态本身独立成立）。 */
const flushCount = computed(() => deliveryQueueEntries(getDeliveryProjectionRef().value.get(props.sessionId) ?? []).length)

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
      chipCount: flushCount.value,
    })
  }
  // bash 行（`!` 命令执行期瞬时反馈；与 compacting 可并存——threshold turn 内压缩 + bash）。
  // 方案 A 短语化：命令原文只进悬停详情，行内补 elapsed meta 维持执行期观察
  if (props.executingBash) {
    list.push({
      kind: 'bash',
      text: t('panel.message.executingBash'),
      meta: t('panel.message.executingBashElapsed', {
        elapsed: formatDurationHms(nowTs.value - props.executingBash.startedAt),
      }),
      detail: { label: t('panel.message.bashCommandLabel'), body: props.executingBash.command },
    })
  }
  // 等待行（demo chat spec 裁决 3A）：turn=dispatching（prompt 已发、message_start 未到 =
  // 「已发送、等待首个 token」阶段）→ 三点等待行，消除发送后无任何反馈的死寂窗口；首包到达
  // （turn 翻 generating）后行消失，streaming 本体由末位 turn 的 TurnMeta「工作中」行承担。
  // subagentThinking（§6.3 虚拟 session 强制思考，非「等待首包」语义）保持呼吸弧 thinking 行。
  if (!compacting && !props.executingBash && turn === 'dispatching') {
    list.push({ kind: 'waiting', text: t('panel.message.waitingResponse') })
  } else if (!compacting && !props.executingBash && props.subagentThinking) {
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

// dev-only 像素常量漂移检测（随行迁入本组件）：compacting 行降级回归横线分隔行后两常量同批重测
// （COMPACTING 50 → 32 / EXECUTING_BASH 24 → 32，算式与实测校准位见 message-stream-layout.ts）
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

// ── 方案 A：悬停详情交互态 + bash 行 elapsed 计时 ──────────────────────

/** 可悬停详情的可发现性暗示：点状下划线（与 SystemNotice 同一暗示语言） */
const DETAIL_HINT_CLASS = 'underline decoration-dotted decoration-neutral-faint underline-offset-[3px]'

/** 悬停详情打开延迟：足够短（不迟滞）、足够长（扫过不误开） */
const DETAIL_OPEN_DELAY_MS = 150

/** 受控 open（按行 kind）：reka HoverCardRoot 无 disabled prop，无 detail 的行经模板门控恒 false */
const openDetailKind = ref<ActivityRow['kind'] | null>(null)

function onDetailToggle(kind: ActivityRow['kind'], open: boolean): void {
  openDetailKind.value = open ? kind : openDetailKind.value === kind ? null : openDetailKind.value
}

/** bash 行 elapsed 计时 tick 间隔（ms） */
const ELAPSED_TICK_MS = 1000

/** bash 行 elapsed 计时 tick：仅 executingBash 存在期间挂载，终态/卸载即清。
 *  nowTs 驱动 rows 重算（meta 变化）——秒级重算开销可忽略（对齐 useTurnElapsed 的节拍纪律）。 */
const nowTs = ref(Date.now())
let elapsedTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => props.executingBash != null,
  (active) => {
    if (active) {
      if (!elapsedTimer) {
        nowTs.value = Date.now()
        elapsedTimer = setInterval(() => {
          nowTs.value = Date.now()
        }, ELAPSED_TICK_MS)
      }
    } else if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
})

/** 复制反馈复位时长 */
const COPIED_RESET_MS = 1200

/** 已复制反馈归属行（null = 无反馈；同刻至多一行在反馈窗口） */
const copiedKind = ref<ActivityRow['kind'] | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

/** 复制详情全文（命令原文）。剪贴板不可用（权限/非安全上下文）静默降级——按钮无反馈 */
function copyDetailBody(kind: ActivityRow['kind']): void {
  const body = rows.value.find((row) => row.kind === kind)?.detail?.body
  if (!body || copiedKind.value === kind) return
  navigator.clipboard
    ?.writeText(body)
    .then(() => {
      copiedKind.value = kind
      if (copiedTimer) clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => {
        copiedKind.value = null
      }, COPIED_RESET_MS)
    })
    .catch(() => {
      // 静默降级：不弹错不打断——详情面板内全文始终可手动选择复制
    })
}

</script>

<style scoped>
/* 等待三点跳动（demo chat spec 裁决 3A，workbench.css .wait-dots 同参）：900ms 周期，
   35% 帧顶点（上浮 4px + 全亮），70% 归位——三点错峰 delay 0/120/240ms，accent 单色无发光。
   仅动画属性落 scoped（形态类在模板），keyframes scoped 内定义 + 同块引用自洽（Vue SFC
   编译器重写 scoped 动画名，仅本组件单消费点，Block.vue fchip-roll-x 同先例）。
   prefers-reduced-motion 由 style.css 全局兜底（duration 0.01ms + iteration 1 → 停 0% 帧
   静态常态色）。escape hatch：keyframes + nth-child 错峰延迟组合，Tailwind 无法表达。 */
.wait-dots i {
  animation: wait-dot 900ms var(--ease-out-soft, var(--ease-out)) infinite;
}
.wait-dots i:nth-child(2) { animation-delay: 120ms; }
.wait-dots i:nth-child(3) { animation-delay: 240ms; }
@keyframes wait-dot {
  0%, 70%, 100% { opacity: 0.3; transform: translateY(0); }
  35% { opacity: 1; transform: translateY(-4px); }
}
</style>
