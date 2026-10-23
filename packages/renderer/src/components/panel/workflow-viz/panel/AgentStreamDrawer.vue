<!--
  AgentStreamDrawer —— workflow overlay 右侧 agent 抽屉（[2026-10-19 用户裁决] demo
  形态确认实施）：浮层内点击实例 trace 行（RunTraceTable）滑出，多 tab 并行保留，
  每 tab = 一个 agent call 实例（tab 标题 = call.agent），激活 tab 展示完整纵向
  对话流。替代原「dock 内 agent 一级 tab」形态（WorkflowLivePanel 的 agent 动态
  tab 已删——dock 纵向空间放不下完整对话流，demo 裁决收归全高右侧抽屉）。

  复用边界（D3 同款硬约束）：tab 内容直接复用 AgentTabContent（meta 快照条 +
  MessageStream `agentcall:` 虚拟 id 快照语义 + 错误态/重试 + workflowUpdate 信号
  重拉），本组件零对话流渲染、零拉取编排，只承担 tab 集与激活裁决 + 抽屉壳。

  状态生命周期：openTabs/activeCallId 是组件内本地 state——抽屉挂载由宿主
  v-if="isWorkflowOpen" 门控（overlay 关闭/切内容 = 抽屉随挂载态消亡，tab 全关，
  D11③「切 run = 关全部 run 级 tab」同款构造性）；抽屉关闭钮只收起不清 tab
  （重开恢复，SubagentTab 二级 tab 同语义）。

  宿主接线：宿主（WorkflowVizOverlayHost）经 ref 调 openAgent(call) 驱动（面板
  panelRef.openPhaseTab 同款 expose 模式）。
-->
<template>
  <aside
    v-if="run !== null"
    ref="drawerEl"
    class="fixed bottom-0 right-0 top-0 z-[calc(var(--z-dialog)+1)] flex w-[452px] max-w-[92vw] flex-col border-l border-hairline bg-surface shadow-[-24px_0_48px_rgba(0,0,0,0.4)] transition-transform duration-[250ms] ease-[var(--ease-out)]"
    :class="open ? 'translate-x-0' : 'translate-x-full'"
    :inert="!open"
    :aria-hidden="!open"
    data-testid="wf-viz-agent-drawer"
  >
    <!-- header：workflow 名 + slug + 收起钮（demo 确认形态：单行头，run 状态/时长归壳 header） -->
    <div class="flex shrink-0 items-center gap-2 px-3.5 pb-1.5 pt-3" data-testid="wf-viz-agent-drawer-head">
      <Workflow class="size-[15px] shrink-0 text-neutral-dim" aria-hidden="true" />
      <span class="min-w-0 truncate font-mono text-xs font-medium text-neutral-fg">{{ run.scriptName }}</span>
      <span v-if="run.slug" class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">{{ run.slug }}</span>
      <Button
        variant="ghost"
        size="icon"
        class="ml-auto size-6 shrink-0 text-neutral-dim hover:text-neutral-fg"
        :title="t('panel.workflowViz.agentDrawerCollapse')"
        data-testid="wf-viz-agent-drawer-collapse"
        @click="open = false"
      >
        <X class="size-3.5" />
      </Button>
    </div>

    <!-- 二级 tab 条（有 tab 即渲染——单 tab 保留关闭钮，「全关 = 收起抽屉」语义可达，
         demo 确认形态；× 关闭激活左邻，无剩余收起抽屉） -->
    <div
      v-if="openTabs.length > 0"
      class="flex shrink-0 items-center gap-0.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="wf-viz-agent-drawer-tab-strip"
      role="tablist"
    >
      <div
        v-for="callId in openTabs"
        :key="callId"
        data-testid="wf-viz-agent-drawer-tab-item"
        :data-call-id="callId"
        :data-active="callId === activeCallId ? 'true' : 'false'"
        role="tab"
        tabindex="0"
        :aria-selected="callId === activeCallId"
        class="flex shrink-0 cursor-pointer select-none items-center gap-0.5 rounded-sm border py-0.5 pl-1.5 pr-[3px] font-mono text-[length:var(--text-2xs)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]"
        :class="
          callId === activeCallId
            ? 'border-border bg-surface-hover text-neutral-fg'
            : 'border-border bg-bg-input text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'
        "
        :title="callOf(callId)?.agent ?? ''"
        @click="activate(callId)"
        @keydown.enter.prevent="activate(callId)"
        @keydown.space.prevent="activate(callId)"
      >
        <span class="size-1.5 shrink-0 rounded-full" :class="tabDotClass(callOf(callId)?.status)" />
        <span class="max-w-36 truncate">{{ callOf(callId)?.agent ?? `#${callId}` }}</span>
        <Button
          variant="ghost"
          data-testid="wf-viz-agent-drawer-tab-close"
          class="size-5 shrink-0 rounded-[var(--radius-xs)] p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger"
          :title="t('panel.sideDrawer.close')"
          @click.stop="closeTab(callId)"
        >
          <X class="size-[11px]" stroke-width="1.8" />
        </Button>
      </div>
    </div>

    <!-- 激活 tab 内容：AgentTabContent 复用（:key 切 tab 重挂——SubagentTab 同款，
         对话流数据在 chatStore 虚拟分区，重挂不丢） -->
    <AgentTabContent
      v-if="activeCall !== undefined"
      :key="activeCall.id"
      :session-id="sessionId"
      :call="activeCall"
      :run-status="run.status"
      class="min-h-0"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Workflow, X } from '@lucide/vue'
import { Button } from '@taiji/ui'
import AgentTabContent from './AgentTabContent.vue'
import type { WorkflowAgentCall, WorkflowRunRecord } from '@taiji/shared'
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'

const props = defineProps<{
  /** 发起 session（AgentTabContent 的 agentcall 快照归属，D11⑤ 透传）。 */
  sessionId: string
  /** 当前 run 投影（tab 反查 call 数据源；run 更新后 call 对象换引用，按 id 重查保持最新投影）。 */
  run: WorkflowRunRecord
}>()

const { t } = useI18n()

/** 抽屉开合（收起 ≠ 卸载：tab 集保留，重开恢复；卸载归宿主 v-if）。 */
const open = ref(false)

/** 打开的 call tab（callId = WorkflowAgentCall.id，trace step 序号；打开序排列）。 */
const openTabs = ref<number[]>([])
const activeCallId = ref<number | null>(null)

// 模态表面聚合注册（§6.7 agent-stream-drawer 族）：非阻塞子交互层——不入让位族（Esc 归
// 编排器关浮层整体），只入 view 遮蔽族（shieldsView intersecting）。开合态绑抽屉 open 本体
// （收起 = 表面关）；rect 读抽屉根元素实测。旗标组由登记表按 id 读取。
const drawerEl = ref<HTMLElement | null>(null)
const drawerRect = () => {
  const el = drawerEl.value
  if (el === null) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
const disposeSurfaceRegistration = registerModalSurface({
  surface: 'agent-stream-drawer',
  key: 'agent-stream-drawer',
  isOpen: () => open.value,
  rect: drawerRect,
})
onBeforeUnmount(disposeSurfaceRegistration)

const activeCall = computed<WorkflowAgentCall | undefined>(() => {
  if (activeCallId.value === null) return undefined
  return props.run.agentCalls.find((c) => c.id === activeCallId.value)
})

function callOf(callId: number): WorkflowAgentCall | undefined {
  return props.run.agentCalls.find((c) => c.id === callId)
}

function tabDotClass(status: WorkflowAgentCall['status'] | undefined): string {
  switch (status) {
    case 'done': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'running': return 'bg-accent'
    default: return 'bg-neutral-dim opacity-40'
  }
}

/**
 * 打开 agent tab（宿主经 expose 驱动；已存在仅激活不重复追加）。pending / 无 sessionId
 * call no-op——pending 零对话可看，sessionId 缺失（60s 节流合并窗口）对齐原 openAgentTab
 * 与 RunTraceTable 行点击守卫现状。
 */
function openAgent(call: WorkflowAgentCall): void {
  if (call.status === 'pending' || !call.sessionId) return
  if (!openTabs.value.includes(call.id)) openTabs.value = [...openTabs.value, call.id]
  activeCallId.value = call.id
  open.value = true
}

/** tab 点击 = 切激活。 */
function activate(callId: number): void {
  if (openTabs.value.includes(callId)) activeCallId.value = callId
}

/**
 * tab 关闭：激活者关闭时激活左邻、无左邻取右邻（首个），无剩余收起抽屉（tab 集清空
 * ——与 SubagentTab「激活右邻/左邻」的差异：本条带无固定 tab 兜底，空即收起）。
 */
function closeTab(callId: number): void {
  const idx = openTabs.value.indexOf(callId)
  if (idx < 0) return
  const next = openTabs.value.filter((id) => id !== callId)
  openTabs.value = next
  if (next.length === 0) {
    activeCallId.value = null
    open.value = false
    return
  }
  if (activeCallId.value === callId) {
    activeCallId.value = next[Math.max(0, idx - 1)] ?? next[0]
  }
}

defineExpose({ openAgent })
</script>
