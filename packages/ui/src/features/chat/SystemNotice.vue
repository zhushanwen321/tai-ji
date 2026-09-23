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
  <!-- 横线分隔行族（D3 增强规格，2026-09-16 裁决）：compaction / branch / background-bash
       结构化行 / 兜底原文行共用一套 DOM 结构——两端渐隐横线（transparent → --border-strong
       18% → 82% → transparent）+ 13px/stroke 2.2 图标 + 主体（主文案 text-sm/fg/550，或
       background-bash 命令的 mono 形态）+ 可选「后台」chip（border-strong 描边）+ 可选钉右
       mono meta（text-2xs/500/tabular-nums），行距 py-1.5。三段 flex 居中结构 / content-col
       宽度 / animate-notice-in 动效 / 静态无交互（通知族二分判据）四项不动。 -->
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
    <span class="flex min-w-0 items-center gap-1">
      <span
        class="min-w-0 truncate"
        :class="notice.mono ? MONO_BODY_CLASS : TEXT_BODY_CLASS"
        data-testid="system-notice-text"
      >{{ notice.text }}</span>
      <span
        v-if="notice.chip"
        class="shrink-0 rounded-[4px] border border-border-strong px-1.5 font-mono text-[length:var(--text-3xs)] font-medium leading-[1.8] text-neutral-mid"
        data-testid="system-notice-chip"
      >{{ notice.chip }}</span>
      <span
        v-if="notice.meta"
        class="shrink-0 font-mono text-[length:var(--text-2xs)] font-medium tabular-nums text-neutral-dim"
        :class="notice.metaClass"
        data-testid="system-notice-meta"
      >{{ notice.meta }}</span>
    </span>
    <span class="h-px flex-1 bg-[image:linear-gradient(to_right,transparent,var(--border-strong)_18%,var(--border-strong)_82%,transparent)]" />
  </div>
</template>

<script setup lang="ts">
import { GitBranch, Archive, ArrowRight, SquareTerminal } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
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
// 规格槽位（主文案 / mono 主体 / 语义色档）写成具名常量：D3 表逐项 → 类名的映射显式可查，
// 同一串 arbitrary class 不在多处漂移。Tailwind 扫描器按 SFC 原文匹配 class 字符串，
// 常量值即候选（renderer / mobile tailwind content 均含 ../ui/src/**）。

/** 主文案（D3）：text-sm + 550 字重 + fg 提色，主从分明 */
const TEXT_BODY_CLASS = 'text-[length:var(--text-sm)] font-[550] text-neutral-fg'
/** mono 主体（background-bash 命令）：技术文本走等宽中号，与自然语言主文案分档 */
const MONO_BODY_CLASS = 'font-mono text-[length:var(--text-xs)] font-medium text-neutral-fg'
/** 图标色档：中性（默认）/ accent（background-bash 结构化行） */
const ICON_NEUTRAL_CLASS = 'text-neutral-mid'
const ICON_ACCENT_CLASS = 'text-accent'
/** meta 语义色：全族仅 exit 结果两档（0 绿 / 非 0 与超时 warn） */
const META_SUCCESS_CLASS = 'text-success'
const META_WARN_CLASS = 'text-warn'

/** 通知行视图：横线分隔行族的元素槽位（resolveNotice 纯函数产出） */
interface NoticeView {
  icon: Component
  /** 图标语义色 class */
  iconClass: string
  /** 主体文案（主文案，或 background-bash 结构化行的命令原文） */
  text: string
  /** true → 主体按 mono 形态渲染（background-bash 命令） */
  mono?: boolean
  /** chip（仅 background-bash 结构化行：「后台」） */
  chip?: string
  /** 钉右 meta：压缩 tokens / exit 结果 · 耗时 / 已超时 */
  meta?: string
  /** meta 语义色 class（缺省 neutral-dim） */
  metaClass?: string
}

/** 按消息类型选图标 + 主体/meta（纯函数，props 不变则结果不变） */
const notice: NoticeView = resolveNotice(props.message)

function resolveNotice(message: Message): NoticeView {
  // background-bash 结构化行（D2）：details 经 shared 单点防御解析命中 → 命令 + chip + exit/耗时；
  // 解析 null（旧 session 无 details / 第三方写入畸形载荷）→ 落下方兜底原文行（逐字节回到现状，
  // content 原文含全部信息，无需恢复动作）。
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
 * background-bash 结构化行：命令 mono 主体 + 「后台」chip + meta。
 *
 * meta 三形态（D2）：
 * - `endReason === 'timeout'` → 「已超时」（复用 bashTimeout 键；超时无退出码，终态结论即
 *   「已超时」，warn 色——与失败同档）；
 * - `endReason === 'natural'` 且有退出码 → `exit N · 耗时`（0 绿 / 非 0 warn）；
 * - `endReason === 'natural'` 且 exitCode 为 null（D2 错误规格表「部分可选字段缺失」形态，
 *   生产路径不可达）→ 不渲染 meta，降级只显命令 + chip。
 *
 * `exit N · 耗时` 为技术 token（与压缩 meta 的 `tokens` 同类），不进 i18n 键；自然语言短语
 * （「后台」/「已超时」）走键。耗时格式消费共享单点 format-utils.formatDurationHms
 * （与 Turn bg-notify 边界行同源；与 extension notify.ts 同口径，裁决记录见其头注）。
 */
function bashNotice(d: BackgroundBashDetails): NoticeView {
  let meta: string | undefined
  let metaClass: string | undefined
  if (d.endReason === 'timeout') {
    meta = t('panel.message.bashTimeout')
    metaClass = META_WARN_CLASS
  } else if (d.exitCode !== null) {
    meta = `exit ${d.exitCode} · ${formatDurationHms(d.durationMs)}`
    metaClass = d.exitCode === 0 ? META_SUCCESS_CLASS : META_WARN_CLASS
  }
  return {
    icon: SquareTerminal,
    iconClass: ICON_ACCENT_CLASS,
    text: d.command,
    mono: true,
    chip: t('panel.message.bashBackgroundChip'),
    meta,
    metaClass,
  }
}

/** K 格式阈值（>= 此值显示 K，如 237186 → 237.2K，< 此值显原数） */
const K_THRESHOLD = 1000

/** token 数 → K 格式：237186 → 237.2K，13400 → 13.4K，<1000 原数 */
function formatTokens(n: number): string {
  if (n < K_THRESHOLD) return String(n)
  const k = n / K_THRESHOLD
  return `${k.toFixed(1).replace(/\.0$/, '')}K`
}
</script>
