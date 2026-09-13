<!--
  SubagentTab —— drawer subagent tab：只读嵌套 subagent 对话流。

  D3 完整复用原则（硬约束）：直接挂主对话流同一个 MessageStream（:session-id=虚拟 id），
  连同其内部 Turn/Block/thinking/tool/markdown 整套渲染树完整复用，不重写任何对话流渲染。
  差异化层仅：标题栏（元信息 + 返回按钮）+ 底部只读提示条（无 composer）+ 空态/错误态。

  两类虚拟 id（D4）：
  - subagent:<mainSid>:<subId> 三段式（chat 块 / sidebar 入口）：
    fetchAndInject 拉历史注入虚拟分区（空历史不写分区，drawer-blank u1）+ 恒订阅 stream_delta 实时增量（E-4：entry 帧走
    routeInbound 兜底链消费，不依赖 drawer 打开；此处只管打字机 delta）
  - agentcall:<acsId> 两段式（workflow tab 点 agent call 入口）：
    快照只读，仅拉历史不接实时流式（D4 裁决：agent call 实时性由 workflow tab 列表 status 体现）

  mainSid 来源：panelStore.focusedSessionId（主 session）。
  MessageStream 对虚拟 id 透明（chatStore.messages Map 按虚拟 id 分区），forceWorking
  内部已按 isSubagentVirtualId 判定（agentcall 不生效，快照视图）。
-->
<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="drawer-subagent-tab">
    <!-- 空态：未选中 subagent（selectedSubagentId === null） -->
    <div
      v-if="!selectedSubagentId"
      class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="drawer-subagent-empty"
    >
      <Bot class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-70">{{ t('panel.sideDrawer.noSubagent') }}</p>
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-50">{{ t('panel.sideDrawer.subagentHint') }}</p>
    </div>

    <template v-else>
      <!-- 标题栏：差异化层（enteredFrom==='workflow' 显返回按钮；agent·slug + model·thinking 元信息） -->
      <div class="flex shrink-0 items-center gap-2 bg-surface-2 px-2.5 py-1.5">
        <Button
          v-if="enteredFrom === 'workflow'"
          variant="ghost"
          size="icon"
          class="size-6 shrink-0 text-neutral-dim hover:text-neutral-fg"
          :title="t('panel.sideDrawer.backToWorkflow')"
          data-testid="drawer-subagent-back"
          @click="onBack"
        >
          <ChevronLeft class="size-3.5" />
        </Button>
        <Bot class="size-3.5 shrink-0 text-neutral-dim" />
        <span class="min-w-0 truncate font-mono text-xs font-medium text-neutral-fg">
          {{ subagentMeta?.agent ?? 'subagent' }}
        </span>
        <span v-if="subagentMeta?.slug" class="min-w-0 shrink-0 truncate font-mono text-xs text-neutral-dim">
          · {{ subagentMeta.slug }}
        </span>
        <!-- 引擎 badge（U3 D9）：常态引擎名；engineFallback 存在 → 警告态 + 回退文案 -->
        <span
          class="shrink-0 rounded-sm px-1 font-mono text-[length:var(--text-3xs)] leading-4"
          :class="subagentMeta?.engineFallback ? 'bg-warn-soft text-warn' : 'border border-hairline text-neutral-dim'"
          :title="engineBadgeTitle"
          data-testid="subagent-engine-badge"
        >{{ engineBadgeText }}</span>
        <!-- 停因词（永久会话模型 §3.2.8 U8b）：上一轮为什么停，原文 kebab-case 对齐
             U8a TUI 决策（interrupted / interrupted-by-restart / ...）；仅 idle 有值时展示 -->
        <span
          v-if="subagentMeta?.stopReason"
          class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim opacity-70"
          :title="t('panel.sideDrawer.subagentStopReason')"
          data-testid="subagent-stop-reason"
        >{{ subagentMeta.stopReason }}</span>
        <span v-if="subagentMeta?.meta" class="ml-auto shrink-0 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim">
          {{ subagentMeta.meta }}
        </span>
      </div>

      <!-- 运行中 coarse 提示（U4 D7）：非 pi 引擎 running 任务不支持实时流，如实提示不伪造流。
           pi 任务恒不出现（D5：undefined 缺省映射为 pi）。 -->
      <div
        v-if="coarseHintVisible"
        class="flex shrink-0 items-center gap-1.5 border-b border-hairline bg-surface-2 px-3 py-1.5 text-[10px] text-neutral-dim"
        data-testid="subagent-coarse-hint"
      >
        <Clock class="size-3 shrink-0 opacity-70" />
        <span>{{ t('panel.sideDrawer.subagentCoarseHint', { engine: coarseHintEngine }) }}</span>
      </div>

      <!-- 错误态：历史加载失败（fail-fast，提供重试入口，不阻塞主对话流） -->
      <div
        v-if="loadError"
        class="flex flex-col items-center justify-center gap-2 p-6 text-center"
        data-testid="drawer-subagent-error"
      >
        <AlertCircle class="size-5 text-danger opacity-60" />
        <p class="text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.sideDrawer.subagentLoadFailed') }}</p>
        <p class="max-w-full break-all text-[length:var(--text-3xs)] text-neutral-dim opacity-60">{{ loadError }}</p>
        <!-- 非 pi record 加载失败时的 outcome 摘要兜底（A8：详情页永不白屏） -->
        <p
          v-if="outcomeSummaryText"
          class="max-w-full break-words text-[length:var(--text-2xs)] text-neutral-mid"
          data-testid="subagent-outcome-summary"
        >{{ outcomeSummaryText }}</p>
        <Button variant="ghost" class="h-6 text-[length:var(--text-2xs)] text-accent" data-testid="drawer-subagent-retry" @click="reload">
          {{ t('panel.sideDrawer.subagentRetry') }}
        </Button>
      </div>

      <!-- 对话流：复用 MessageStream（D3 硬约束，禁止重建任何 turn/block/thinking/markdown 渲染）。
           MessageStream 按 :session-id 读 chatStore.messages 虚拟分区，对虚拟 id 完全透明。 -->
      <MessageStream v-else :session-id="selectedSubagentId" />

      <!-- 底部只读提示条（差异化层：subagent 为 background 任务，无 composer） -->
      <div class="flex shrink-0 items-center gap-1.5 border-t border-hairline px-3 py-1.5 text-[length:var(--text-3xs)] text-neutral-dim">
        <Lock class="size-3 shrink-0 opacity-70" />
        <span>{{ t('panel.sideDrawer.subagentReadonly') }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Bot, ChevronLeft, Clock, Lock } from '@lucide/vue'
import { Button } from '@xyz-agent/ui'
import { useDrawerControl, openWorkflow } from '@xyz-agent/core/domain/drawer'
import { usePanelStore } from '@/stores/panel'
import {
  useSubagentStore,
  isSubagentVirtualId,
  extractSubagentId,
  extractMainSessionId,
} from '@/stores/subagent'
import {
  useWorkflowStore,
  isAgentCallVirtualId,
  extractAgentCallSessionId,
} from '@/stores/workflow'
import type { SubagentRecord, WorkflowAgentCall } from '@xyz-agent/shared'
import MessageStream from './MessageStream.vue'
import { DEFAULT_ENGINE_ID } from '@/constants/engine-icons'
// u6.1 chat facet 收口：对话流数据编排（chat store ops 面消费）下沉 composable，
// 组件只保留 readers 面消费
import { useSubagentTabData } from '@/composables/panel/useSubagentTabData'

const { t } = useI18n()
const panelStore = usePanelStore()
const subagentStore = useSubagentStore()
const workflowStore = useWorkflowStore()

const { selectedSubagentId, enteredFrom } = useDrawerControl()

/** 从 workflowStore records 查找指定 acsId 的 agent call（agentcall 入口的元信息来源） */
function findAgentCall(acsId: string): WorkflowAgentCall | undefined {
  const mainSessionId = panelStore.focusedSessionId
  if (!mainSessionId) return undefined
  for (const wf of workflowStore.getRecordsBySession(mainSessionId)) {
    const call = wf.agentCalls.find((c) => c.sessionId === acsId)
    if (call) return call
  }
  return undefined
}

/** 标题栏元信息（响应式：records 变化时重算） */
const subagentMeta = computed<{ agent: string; slug?: string; meta?: string; engine?: string; engineFallback?: { from: string; reason: string }; stopReason?: string } | null>(() => {
  const vid = selectedSubagentId.value
  if (!vid) return null

  if (isSubagentVirtualId(vid)) {
    const mainSessionId = extractMainSessionId(vid)
    const subId = extractSubagentId(vid)
    const record = subagentStore.getRecordsBySession(mainSessionId).find((r) => r.subagentId === subId)
    if (!record) return null
    const metaParts: string[] = []
    if (record.model) metaParts.push(record.model)
    if (record.thinkingLevel) metaParts.push(`thinking ${record.thinkingLevel}`)
    return {
      agent: record.agent,
      slug: record.slug || undefined,
      meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
      engine: record.engine || undefined,
      engineFallback: record.engineFallback,
      // 停因词（U8b §3.2.8）：仅 idle 有意义——「为什么停」一句话解释，不参与资格判定
      stopReason: record.status === 'idle' ? record.stopReason : undefined,
    }
  }

  if (isAgentCallVirtualId(vid)) {
    const call = findAgentCall(extractAgentCallSessionId(vid))
    if (!call) return null
    return {
      agent: call.agent,
      // model 'default' 不显示（对齐 WorkflowDetail modelDefault 语义）
      meta: call.model && call.model !== 'default' ? call.model : undefined,
    }
  }

  return null
})

/** 引擎 badge 文案（U3 D9）：常态引擎名（缺省 pi）；fallback 警告态显示回退链 */
const engineBadgeText = computed<string>(() => {
  const meta = subagentMeta.value
  const engine = meta?.engine || DEFAULT_ENGINE_ID
  if (meta?.engineFallback) {
    return t('panel.sideDrawer.engineFallbackBadge', { from: meta.engineFallback.from, to: engine })
  }
  return engine
})

/** 引擎 badge title：常态 = 引擎名；fallback = 恢复指引 */
const engineBadgeTitle = computed<string>(() => {
  const meta = subagentMeta.value
  if (meta?.engineFallback) {
    return t('panel.sideDrawer.engineFallbackHint', { from: meta.engineFallback.from, to: meta.engine || DEFAULT_ENGINE_ID })
  }
  return t('panel.sideDrawer.engineBadgeTitle', { engine: meta?.engine || DEFAULT_ENGINE_ID })
})

/** 当前选中 subagent 的 record（三段式虚拟 id 才有；agentcall 两段式返回 null） */
const currentRecord = computed<SubagentRecord | null>(() => {
  const vid = selectedSubagentId.value
  if (!vid || !isSubagentVirtualId(vid)) return null
  const record = subagentStore
    .getRecordsBySession(extractMainSessionId(vid))
    .find((r) => r.subagentId === extractSubagentId(vid))
  return record ?? null
})

// 对话流数据编排（loadError 兜底态 + 加载/停止；recordEngine 供 coarse 提示与兜底判断复用）
const { loadError, loadSubagentData, stopSubagentStream, recordEngine } = useSubagentTabData({
  currentRecord,
  noOutcomeText: () => t('panel.sideDrawer.subagentNoOutcome'),
})

/**
 * 运行中 coarse 提示可见性（U4 D7）：非 pi 引擎 + 任务真在跑（窄口径同
 * isStreamingSubagent：running 且无轮终 result、非 resumable）。pi 恒 false（D5）。
 */
const coarseHintVisible = computed<boolean>(() => {
  const record = currentRecord.value
  if (!record || recordEngine(record) === DEFAULT_ENGINE_ID) return false
  return subagentStore.isStreamingSubagent(extractMainSessionId(selectedSubagentId.value ?? ''), record.subagentId)
})

/** coarse 提示的引擎名（可见时 record.engine 恒非空非 pi） */
const coarseHintEngine = computed<string>(() => {
  const record = currentRecord.value
  return record ? recordEngine(record) : DEFAULT_ENGINE_ID
})

/**
 * 加载失败时的 outcome 摘要文案（A8 不白屏）：非 pi record 且有 result/error 时
 * 在错误态面板中展示，详情页至少有任务结果可读。
 */
const outcomeSummaryText = computed<string | null>(() => {
  const record = currentRecord.value
  if (!record || recordEngine(record) === DEFAULT_ENGINE_ID) return null
  const outcome = record.result ?? record.error
  return outcome !== undefined ? outcome : null
})

/** selectedSubagentId 变化：停旧订阅 + 加载新数据（immediate 覆盖 onMounted 首次加载） */
watch(
  selectedSubagentId,
  (vid, oldVid) => {
    if (oldVid) stopSubagentStream()
    if (vid) void loadSubagentData(vid)
  },
  { immediate: true },
)

/**
 * 非 pi 终态回填桥（设计 D2，docs/design/subagent-nonpi-visibility-followups.md）：
 * 非 pi 引擎无实时流通道，运行中打开的 tab 内容停在打开时刻——record 跨越收口
 * （running → 非 running）时重拉一次，对话流自动收敛到完整内容。四守卫：
 * cur/prev 任一 null（agentcall / 未选中）跳过；vid 或 subId 变化 = 切换 subagent
 * 跳过（新 vid 由上方 selectedSubagentId watch 负责）；仅 running → 非 running 跨越
 * 触发（打开时已收口由首拉覆盖）；pi 引擎跳过（D5 零变化）。
 * [U8b 两态判据核对] 占用两态下 settle 写 idle——running → idle 即收口跨越，本判据
 * 无需改动即正确触发（idle → running 续轮走 pi 实时流 / 非 pi coarse 轮终再跨越，
 * 与旧 closed → running 复活行为一致）；legacy 五值同落非 running 半边，兼容不破。
 */
watch(
  () => {
    const vid = selectedSubagentId.value
    const record = currentRecord.value
    if (!vid || !record) return null
    return { vid, subId: record.subagentId, status: record.status }
  },
  (cur, prev) => {
    if (!cur || !prev) return
    if (cur.vid !== prev.vid || cur.subId !== prev.subId) return
    if (prev.status !== 'running' || cur.status === 'running') return
    const record = currentRecord.value
    if (!record || recordEngine(record) === DEFAULT_ENGINE_ID) return
    void loadSubagentData(cur.vid)
  },
)

onBeforeUnmount(() => {
  stopSubagentStream()
})

function reload(): void {
  const vid = selectedSubagentId.value
  if (vid) void loadSubagentData(vid)
}

function onBack(): void {
  openWorkflow()
}
</script>
