<!--
  展示组件 · 正文块（trace 块 text 类型行组件，W1 壳化拆分自 Block.vue）。
  壳根类名契约（.trace-blk / .trace-blk--text）与 data-testid 留在 Block 壳，本组件根 =
  原 text 分支根 div（data-testid="block-text"），无新 DOM 层。
  职责：markdown 正文渲染 + error 独立追加行 + 行尾时刻 + turn-actions 锚行（Turn 级
  hover actions 挂载位：壳层收到 #turn-actions 插槽时经 hasTurnActions 打开锚行，插槽
  经壳透传挂入，显隐由 opacity 门控）。
-->
<template>
  <!-- 正文 text 块：全 inline 统一正文样式（text-md/leading-[1.8]，D5 行类型定档 15px），颜色跟所属
       assistant 消息的文本活跃态（chat-flow-text-color D1：streaming→neutral-mid，定稿/缺省→
       neutral-fg）。streaming 由 Turn.unitBlockProps 按 textFinalized 逐消息派生（pi 回合级
       message.complete 才收口 mid-turn 气泡 status，直接跟 status 会让长工具回合中已写完
       的正文一直灰；单调不随兄弟 message 翻转）。group/text 命名分组承载行尾时刻的悬停/键盘聚焦两翼显现。
       streaming-tail 光标在 Turn.vue trace 容器末尾（跟在所有 block 后，不受 contentBlocks 时序影响）。
       [M2 形态统一] 唯一 error 形态 = 追加形态：content 崩溃前正文保持原色（可为空），
       msg.error 独立 danger 行（错误文本只住 error 字段，永不染红正文）。 -->
  <div data-testid="block-text" class="group/text relative flex flex-col text-[length:var(--text-md)] leading-[1.8]" :class="textColorClass">
    <!-- 正文行（原行容器原样下沉一层；textColorClass 上提到外层列容器，继承不变） -->
    <div class="flex items-start gap-[8px]">
      <div class="min-w-0 flex-1">
        <MarkdownRenderer v-if="content" :content="content ?? ''" :session-id="sessionId ?? undefined" :streaming="streaming" />
        <!-- error 独立 danger 行（AlertCircle + msg.error 文本） -->
        <div v-if="isAppendError" data-testid="block-text-error" class="mt-1 flex items-start gap-1.5 text-danger">
          <AlertCircle class="mt-1.5 size-3.5 shrink-0 text-danger" />
          <span class="min-w-0 flex-1 whitespace-pre-wrap">{{ error }}</span>
        </div>
      </div>
      <!-- text 块行尾时刻（D2 悬停化：原 w-28 固定占位列随悬停化一并移除，正文行恢复满宽；
           ml-auto 钉行尾，悬停/键盘焦点进入该行才显现） -->
      <span v-if="messageTimestamp" class="ml-auto shrink-0 self-center font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover/text:opacity-100 group-focus-within/text:opacity-100" data-testid="text-time-slot">{{ formatClock(messageTimestamp) }}</span>
    </div>
    <!-- [actions-anchor] turn 级 hover actions 挂载位（Turn.vue 经 #turn-actions 插槽注入，
         仅 trace 末单元为 text 块时本块携带——正文后跟了任何块则该 text 无锚，防占位行
         夹在正文与后续块之间撑出空洞）。2026-10-15 用户裁决：流内固定槽位 = text 块下部一行，
         与 UserBubble hover actions 同族形态（原「text 上方右侧」悬浮 chip 退役——
         透明底不再覆盖任何文字）。常驻 h-6 行占位（opacity 门控显隐，与 UserBubble
         mt-1+h-6 同参）；悬停区 = 外层 group/text（正文行 + 本行），按钮是本块 DOM
         子孙，移入按钮期间悬停态经 DOM 祖先传递不丢失。
         锚行开关 = hasTurnActions（Block 壳以 $slots 判空传入——壳收到插槽时锚行恒渲染，
         与拆分前 $slots 判空语义一致）。 -->
    <span
      v-if="hasTurnActions"
      class="mt-1 flex h-6 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-[var(--duration-fast)] group-hover/text:pointer-events-auto group-hover/text:opacity-100 group-focus-within/text:pointer-events-auto group-focus-within/text:opacity-100"
      data-testid="turn-actions-anchor"
    >
      <slot name="turn-actions" />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { AlertCircle } from '@lucide/vue'
import type { MessageStatus } from '@taiji/shared'
import MarkdownRenderer from './MarkdownRenderer.vue'
import { formatClock } from './format-utils'

const props = defineProps<{
  /** 正文内容 */
  content?: string
  /** streaming 态（所属 assistant 正在流式）：驱动正文颜色——streaming→text-neutral-mid，
   *  complete/缺省→text-neutral-fg（单调，不随兄弟 message 到达翻转）。
   *  由 Turn.vue 传 assistant.status === 'streaming'。 */
  streaming?: boolean
  /** 所属 assistant 消息终态（error 形态判定，SSOT §3.3.2）：
   *  status==='error' → 追加形态（content 崩溃前正文原色 + error 独立 danger 行）。
   *  [M2 形态统一] 纯 error 形态已消灭——错误文本只住 error 字段，content 恒为崩溃前
   *  正文（手动追加的错误消息 content 为空），渲染只有追加形态一种。 */
  status?: MessageStatus
  /** 错误文本（assistant Message.error 字段，status==='error' 时有值——收口兜底保证非空）。 */
  error?: string
  /** 所属 assistant message 时刻（epoch ms，行尾时刻显示） */
  messageTimestamp?: number
  /** 所属 session（透传给 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
  /** 壳层是否收到 #turn-actions 插槽（Block 壳 $slots 判空传入；真值时锚行恒渲染，
   *  可见度由 opacity 门控） */
  hasTurnActions?: boolean
}>()

/** error 终态：msg.error 有值（收口侧兜底保证非空；!! 防御漏网产出点）→ 独立 danger 行。 */
const isAppendError = computed(() => props.status === 'error' && !!props.error)

/** text 分支颜色：正常正文 文本活跃（streaming 且未定稿）→neutral-mid、定稿/终态→neutral-fg（正文永不因 error 整条染红） */
const textColorClass = computed(() => {
  return props.streaming ? 'text-neutral-mid' : 'text-neutral-fg'
})
</script>
