<template>
  <!--
    展示组件 · system 提示行（W07-C）。
    渲染 compactionSummary / branchSummary 两类 system 消息 + subagent 定向气泡（U2b）。
    不冒充 user/assistant：弱化样式（居中、小字、图标 + 一行摘要），
    作流转过程的元信息提示（压缩 / 分支）。
  -->
  <!-- subagent 定向气泡（U2b）：`@` 定向消息的「可见去向」形态（composer-symbol-system
       §3.3.3a「→ @slug：text」）。左对齐轻量样式区别于 user/assistant 气泡——定向消息
       不是对话回合（无主 agent turn），是元信息记录；live / reload 两链路产出同形态
       Message（store.appendSubagentDirective 注释），本组件是唯一渲染点。 -->
  <div
    v-if="directive"
    class="content-col flex min-w-0 items-start gap-1.5 py-1"
    data-testid="subagent-directive-bubble"
  >
    <ArrowRight class="mt-0.5 size-3 shrink-0 text-accent" />
    <p class="min-w-0 break-words text-[length:var(--text-xs)] leading-snug text-neutral-mid">
      <span class="font-mono font-medium text-accent" data-testid="subagent-directive-slug">@{{ directive.slug }}</span>
      <span>：{{ directive.text }}</span>
    </p>
  </div>
  <!-- [u8-pi-respawn] pi 崩溃恢复提示条分支（D7）：customType 匹配且
       variant 可解析时渲染 RespawnNoticeBar（restored=T4 文案 / restoreFailed=失败态+重试
       按钮，retry 事件透传壳层）。解析失败 → respawn 为 null → 降级走兜底 system 行
       （消息仍在流中，不静默消失——subagent 定向气泡同款降级语义）。 -->
  <RespawnNoticeBar
    v-else-if="respawn"
    data-testid="respawn-notice-bar-slot"
    :variant="respawn"
    @retry="emit('respawnRetry')"
  />
  <!-- 横线分隔行族（D3 增强规格 + [notice-family-phrase-detail 2026-09-18 方案 A]）：compaction /
       branch / background-bash 结构化行 / 兜底原文行共用一套 DOM 结构——两端渐隐横线
       （transparent → --border-strong 18% → 82% → transparent）+ 13px/stroke 2.2 图标 +
       主体（短语 text-sm/fg/550）+ 可选钉右 mono meta（text-2xs/500/tabular-nums），行距
       py-1.5。三段 flex 居中结构 / content-col 宽度 / animate-notice-in 动效三项不动。
       方案 A 增补（主体有界 + 悬停详情）：主体只承载有界短语——无界载荷（background-bash
       命令原文 / 超 40 字符的兜底 system 原文）移入 HoverCard 悬停详情（只读 + 复制），
       行内不再渲染命令/长文原文。根治长载荷把 flex-1 横线挤成几像素残端或零宽的形态塌缩
       （横线长度自此不随载荷波动）；「后台」chip 随短语语义并入退役；族「静态无交互」判据
       收窄为「无点击交互入口」——悬停只读详情为唯一例外。 -->
  <div v-else class="system-notice content-col flex min-w-0 animate-notice-in items-center gap-2 py-1.5">
    <!-- 两端渐隐横线：Tailwind 任意值声明 background-image（h-px 高度由 class 承担） -->
    <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
    <!-- 图标 D3 规格：13px + stroke 2.2（与 ActivityStrip / Turn 起点行同规格） -->
    <component
      :is="notice.icon"
      class="size-[13px] shrink-0"
      :class="notice.iconClass"
      stroke-width="2.2"
    />
    <!-- 主体 span 即悬停详情 trigger（as-child 零额外 DOM）；无 detail 的行受控 open 恒 false -->
    <HoverCard :open="detailOpen" :open-delay="DETAIL_OPEN_DELAY_MS" @update:open="onDetailToggle">
      <HoverCardTrigger as-child>
        <span class="flex min-w-0 items-center gap-1" data-testid="system-notice-body">
          <span
            class="min-w-0 truncate"
            :class="[TEXT_BODY_CLASS, notice.detail ? DETAIL_HINT_CLASS : '']"
            data-testid="system-notice-text"
          >{{ notice.text }}</span>
          <span
            v-if="notice.meta"
            class="shrink-0 font-mono text-[length:var(--text-2xs)] font-medium tabular-nums text-neutral-dim"
            :class="notice.metaClass"
            data-testid="system-notice-meta"
          >{{ notice.meta }}</span>
        </span>
      </HoverCardTrigger>
      <!-- 悬停详情（方案 A）：短语让出的无界载荷在此完整呈现——标题 + mono/自然语言全文 +
           事实片段（exit/耗时/终态）+ 复制按钮。portal 挂 body，不参与对话流布局。
           注：testid 落在内层实元素——组件根是 Teleport，非 prop attrs 不穿越（class 是
           prop 显式转发不受影响）。 -->
      <HoverCardContent v-if="notice.detail" side="top" class="w-[min(520px,85vw)] px-3 py-2.5">
        <div data-testid="system-notice-detail">
          <div class="flex items-center justify-between gap-2 pb-1.5">
            <span class="font-mono text-[length:var(--text-2xs)] font-medium uppercase tracking-wider text-neutral-dim">{{ notice.detail.label }}</span>
            <Button
              variant="ghost"
              class="h-auto cursor-default px-1.5 py-0.5 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
              data-testid="system-notice-detail-copy"
              @click="copyDetailBody"
            >{{ copied ? t('common.copied') : t('common.copy') }}</Button>
          </div>
          <p
            class="max-h-[180px] overflow-y-auto font-mono text-[length:var(--text-xs)] leading-relaxed text-neutral-fg"
            data-testid="system-notice-detail-body"
          >{{ notice.detail.body }}</p>
          <div
            v-if="notice.detail.facts?.length"
            class="flex flex-wrap gap-x-3 pt-1.5 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
            data-testid="system-notice-detail-facts"
          >
            <span v-for="fact in notice.detail.facts" :key="fact">{{ fact }}</span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
    <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
  </div>
</template>

<script setup lang="ts">
import { GitBranch, Archive, ArrowRight, SquareTerminal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { onUnmounted, ref, type Component } from 'vue'
import {
  normalizeContent,
  SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
  parseSubagentDirective,
  PI_RESPAWN_NOTICE_CUSTOM_TYPE,
  parseRespawnNoticeVariant,
  parseBackgroundBashDetails,
} from '@taiji/shared'
import type {
  Message,
  SubagentDirectiveData,
  PiRespawnNoticeVariant,
  BackgroundBashDetails,
} from '@taiji/shared'
import RespawnNoticeBar from './RespawnNoticeBar.vue'
import { Button } from '../../primitives/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card'
import { formatDurationHms } from './format-utils'

const { t } = useI18n()

const props = defineProps<{
  message: Message
}>()

const emit = defineEmits<{
  /** [u8] 重试按钮点击（仅 restoreFailed 形态渲染）——壳层接手动恢复 RPC */
  respawnRetry: []
}>()

/**
 * subagent 定向数据：customType 匹配且 details 可解析时非 null。
 * 解析失败（details 畸形）→ null → 不渲染定向气泡，降级走下方兜底 system 行
 * （消息 display:true 仍在流中，不静默消失——「渲染过滤不丢消息」规则 9）。
 * 一次性求值（对齐 resolveNotice 先例）：消息对象不可变，props.message 不会原地变更。
 */
const directive: SubagentDirectiveData | null =
  props.message.customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE
    ? parseSubagentDirective(props.message.content, props.message.details)
    : null

/** [u8] pi 恢复提示条形态：customType 匹配且 variant 合法时非 null（畸形降级同 directive）。 */
const respawn: PiRespawnNoticeVariant | null =
  props.message.customType === PI_RESPAWN_NOTICE_CUSTOM_TYPE
    ? parseRespawnNoticeVariant(props.message.details)
    : null

// ── D3 增强规格常量（横线分隔行族：本组件行与 ActivityStrip / Turn 起点行同一规格）────
// 规格槽位（主文案 / 语义色档）写成具名常量：D3 表逐项 → 类名的映射显式可查，
// 同一串 arbitrary class 不在多处漂移。Tailwind 扫描器按 SFC 原文匹配 class 字符串，
// 常量值即候选（renderer / mobile tailwind content 均含 ../ui/src/**）。

/** 主文案（D3）：text-sm + 550 字重 + fg 提色，主从分明 */
const TEXT_BODY_CLASS = 'text-[length:var(--text-sm)] font-[550] text-neutral-fg'
/** 可悬停详情的可发现性暗示（方案 A）：点状下划线，提示「此处有更多」 */
const DETAIL_HINT_CLASS = 'underline decoration-dotted decoration-neutral-faint underline-offset-[3px]'
/** 图标色档：中性（默认）/ accent（background-bash 结构化行） */
const ICON_NEUTRAL_CLASS = 'text-neutral-mid'
const ICON_ACCENT_CLASS = 'text-accent'
/** meta 语义色：全族仅 exit 结果两档（0 绿 / 非 0 与超时 warn） */
const META_SUCCESS_CLASS = 'text-success'
const META_WARN_CLASS = 'text-warn'

/**
 * 悬停详情（方案 A）：短语义让出的无界载荷的完整呈现。
 * 结构化行（background-bash）body = 命令原文；自然语言行（兜底/branch 超阈值）body = 全文。
 */
interface NoticeDetail {
  /** 面板标题（i18n 短语：「完整命令」/「通知全文」） */
  label: string
  /** 全文载荷（命令原文或通知全文） */
  body: string
  /** 钉底事实片段（mono 2xs dim）：exit 结果 / 耗时 / 终态 */
  facts?: string[]
}

/** 通知行视图：横线分隔行族的元素槽位（resolveNotice 纯函数产出） */
interface NoticeView {
  icon: Component
  /** 图标语义色 class */
  iconClass: string
  /** 主体短语（D3 主文案档；方案 A 后恒为有界短语，原文进 detail） */
  text: string
  /** 钉右 meta：压缩 tokens / exit 结果 · 耗时 */
  meta?: string
  /** meta 语义色 class（缺省 neutral-dim） */
  metaClass?: string
  /** 悬停详情（无界载荷存在时） */
  detail?: NoticeDetail
}

/** 按消息类型选图标 + 主体/meta（纯函数，props 不变则结果不变） */
const notice: NoticeView = finalizeDetail(resolveNotice(props.message))

function resolveNotice(message: Message): NoticeView {
  // background-bash 结构化行（D2 + 方案 A 短语化）：details 经 shared 单点防御解析命中 →
  // 终态短语主体 + exit/耗时 meta；命令原文只进悬停详情。解析 null（旧 session 无
  // details / 第三方写入畸形载荷）→ 落下方兜底原文行（content 原文含全部信息，无需恢复动作）。
  const bash = parseBackgroundBashDetails(message.details)
  if (bash) return bashNotice(bash)
  if (message.compactionSummary) {
    const tokens = message.compactionSummary.tokensBefore
    // tokens 从主文案拆出为钉右 meta（D3）：主文案只留短语，数字进等宽 meta 供扫读对齐
    return {
      icon: Archive,
      iconClass: ICON_NEUTRAL_CLASS,
      text: t('panel.message.compacted'),
      meta: tokens !== undefined ? t('panel.message.compactedTokens', { tokens: formatTokens(tokens) }) : undefined,
    }
  }
  if (message.branchSummary) {
    const from = message.branchSummary.fromId
    return {
      icon: GitBranch,
      iconClass: ICON_NEUTRAL_CLASS,
      text: from ? t('panel.message.branchCreated', { from }) : t('panel.message.branchCreatedNoFrom'),
    }
  }
  // 兜底：纯 system 文本（流健康警告 / scheduler 派发提示等 display:true custom 消息同族同规格）
  return { icon: Archive, iconClass: ICON_NEUTRAL_CLASS, text: normalizeContent(message.content) }
}

/**
 * 自然语言行的悬停详情兜底（方案 A 规则 3）：主体文本超阈值（截断大概率发生）→ 悬停
 * 可看全文；短文本不挂详情（行内已完整呈现，悬停无增益）。阈值按字符数近似（CJK 与
 * ASCII 视宽差异不区分——判定的是「是否需要详情」而非「是否截断」，宁多挂不漏挂）。
 * 结构化行自带 detail（命令），不经过本兜底。
 */
function finalizeDetail(view: NoticeView): NoticeView {
  if (view.detail || view.text.length <= TEXT_DETAIL_THRESHOLD) return view
  return { ...view, detail: { label: t('panel.message.noticeDetailLabel'), body: view.text } }
}

/** 自然语言主体挂悬停详情的字符数阈值（方案 A 规则 3，说明见 finalizeDetail） */
const TEXT_DETAIL_THRESHOLD = 40

/**
 * background-bash 结构化行（方案 A 短语优先）：主体 = 终态短语（完成 / 失败 / 超时），
 * 命令原文 + 事实片段进悬停详情。
 *
 * - `endReason === 'timeout'` → 「后台命令已超时」（终态结论进短语，无 meta——超时无
 *   退出码，行内无可钉右的语义数字；耗时在详情 facts 补足）；
 * - `endReason === 'natural'` 且 exitCode === 0 → 「后台命令已完成」+ `exit 0 · 耗时`（绿）；
 * - `endReason === 'natural'` 且 exitCode !== 0 → 「后台命令执行失败」+ `exit N · 耗时`（warn）；
 * - `endReason === 'natural'` 且 exitCode === null（D2 错误规格表「部分可选字段缺失」形态，
 *   生产路径不可达）→ 归中性完成档，无 meta。
 *
 * `exit N · 耗时` 为技术 token（与压缩 meta 的 `tokens` 同类），不进 i18n 键；自然语言短语
 * 走键。耗时格式消费共享单点 format-utils.formatDurationHms（与 Turn bg-notify 边界行
 * 同源；与 extension notify.ts 同口径，裁决记录见其头注）。
 */
function bashNotice(d: BackgroundBashDetails): NoticeView {
  const duration = formatDurationHms(d.durationMs)
  let text: string
  let meta: string | undefined
  let metaClass: string | undefined
  let facts: string[]
  if (d.endReason === 'timeout') {
    text = t('panel.message.bashTimedOut')
    facts = [t('panel.message.bashTimeout'), duration]
  } else if (d.exitCode === null || d.exitCode === 0) {
    // null（生产不可达形态）与 0 同归中性完成档：主体同为「已完成」，仅 0 有 exit meta
    text = t('panel.message.bashFinished')
    if (d.exitCode === 0) {
      meta = `exit 0 · ${duration}`
      metaClass = META_SUCCESS_CLASS
    }
    facts = d.exitCode === null ? [duration] : ['exit 0', duration]
  } else {
    text = t('panel.message.bashFinishedFailed')
    meta = `exit ${d.exitCode} · ${duration}`
    metaClass = META_WARN_CLASS
    facts = [`exit ${d.exitCode}`, duration]
  }
  return {
    icon: SquareTerminal,
    iconClass: ICON_ACCENT_CLASS,
    text,
    meta,
    metaClass,
    detail: { label: t('panel.message.bashCommandLabel'), body: d.command, facts },
  }
}

// ── 悬停详情交互态（方案 A）──────────────────────────────────────────────
/** 受控 open：reka HoverCardRoot 无 disabled prop，无 detail 的行经门控恒 false */
const detailOpen = ref(false)

function onDetailToggle(open: boolean): void {
  if (!notice.detail) return
  detailOpen.value = open
}

/** 悬停详情打开延迟：足够短（不迟滞）、足够长（扫过不误开） */
const DETAIL_OPEN_DELAY_MS = 150

/** 复制反馈复位时长 */
const COPIED_RESET_MS = 1200

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

/** 复制详情全文（命令/通知原文）。剪贴板不可用（权限/非安全上下文）静默降级——按钮无反馈 */
function copyDetailBody(): void {
  const body = notice.detail?.body
  if (!body || copied.value) return
  navigator.clipboard
    ?.writeText(body)
    .then(() => {
      copied.value = true
      if (copiedTimer) clearTimeout(copiedTimer)
      copiedTimer = setTimeout(() => {
        copied.value = false
      }, COPIED_RESET_MS)
    })
    .catch(() => {
      // 静默降级：不弹错不打断——详情面板内全文始终可手动选择复制
    })
}

onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})

/** K 格式阈值（>= 此值显示 K，如 237186 → 237.2K，< 此值显原数） */
const K_THRESHOLD = 1000

/** token 数 → K 格式：237186 → 237.2K，13400 → 13.4K，<1000 原数 */
function formatTokens(n: number): string {
  if (n < K_THRESHOLD) return String(n)
  const k = n / K_THRESHOLD
  return `${k.toFixed(1).replace(/\.0$/, '')}K`
}
</script>
