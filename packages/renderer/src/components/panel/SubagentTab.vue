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
    <!-- 二级 tab 条（subagent-detail-tabs 2026-10-15）：多 subagent 详情并行保留——
         打开序排列，激活者高亮；× 关闭（激活者关闭时激活右邻/左邻，store 编排）。
         视觉范式 = DetailPane 实例 tab 条同款（display-containers §6.3）。
         恒渲染（2026-10-17 用户裁决）：单 tab/空态不隐藏——tab 区域位置稳定，
         开第一个 tab / 关最后一个 tab 不产生布局跳变。 -->
    <div
      class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-hairline px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="drawer-subagent-tab-strip"
      role="tablist"
    >
      <div
        v-for="tabVid in openTabs"
        :key="tabVid"
        data-testid="drawer-subagent-tab-item"
        :data-vid="tabVid"
        :data-active="tabVid === activeTab ? 'true' : 'false'"
        role="tab"
        tabindex="0"
        :aria-selected="tabVid === activeTab"
        class="flex shrink-0 cursor-pointer select-none items-center gap-0.5 rounded-sm border py-0.5 pl-1.5 pr-[3px] font-mono text-[length:var(--text-2xs)] transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]"
        :class="
          tabVid === activeTab
            ? 'border-border bg-surface-hover text-neutral-fg'
            : 'border-border bg-bg-input text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'
        "
        :title="tabLabel(tabVid)"
        @click="onTabActivate(tabVid)"
        @keydown.enter.prevent="onTabActivate(tabVid)"
        @keydown.space.prevent="onTabActivate(tabVid)"
      >
        <span class="max-w-36 truncate">{{ tabLabel(tabVid) }}</span>
        <Button
          variant="ghost"
          data-testid="drawer-subagent-tab-close"
          class="size-5 shrink-0 rounded-[var(--radius-xs)] p-0 text-neutral-dim hover:bg-danger-soft hover:text-danger"
          :title="t('panel.sideDrawer.close')"
          @click.stop="onTabClose(tabVid)"
        >
          <X class="size-[11px]" stroke-width="1.8" />
        </Button>
      </div>
    </div>

    <!-- 空态：无打开的 subagent tab（activeTab === null；demo .empty 文字形态） -->
    <div
      v-if="!activeTab"
      class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="drawer-subagent-empty"
    >
      <Bot class="size-6 text-neutral-dim opacity-40" stroke-width="1.6" />
      <p class="text-[length:var(--text-xs)] text-neutral-mid">{{ t('panel.sideDrawer.noSubagent') }}</p>
      <p class="text-[length:var(--text-2xs)] text-neutral-dim">{{ t('panel.sideDrawer.subagentHint') }}</p>
    </div>

    <template v-else>
      <!-- 标题栏：差异化层（agent·slug + model·thinking 元信息；返回按钮已随 drawer
           workflow tab 删除移除——agent call 详情现归宿 = workflow 浮层的 agent 抽屉）。
           对齐 demo .sub-head：透明底（无 surface-2 色块），左右内缩 14px、下 6px
           （demo panel 12px + sub-head 0 2px 6px 折算）。 -->
      <div class="flex shrink-0 items-center gap-2 px-3.5 pb-1.5 pt-2">
        <Bot class="size-3.5 shrink-0 text-neutral-dim" />
        <span class="min-w-0 truncate font-mono text-xs font-medium text-neutral-fg">
          {{ subagentMeta?.agent ?? 'subagent' }}
        </span>
        <span v-if="subagentMeta?.slug" class="min-w-0 shrink-0 truncate font-mono text-[length:var(--text-2xs)] text-neutral-dim">
          · {{ subagentMeta.slug }}
        </span>
        <!-- 引擎 badge（U3 D9）：常态引擎名（运行期不换引擎，无回退态） -->
        <span
          class="shrink-0 rounded-sm border border-hairline px-1 font-mono text-[length:var(--text-3xs)] leading-4 text-neutral-dim"
          :title="engineBadgeTitle"
          data-testid="subagent-engine-badge"
        >{{ engineBadgeText }}</span>
        <!-- 停因词（永久会话模型 §3.2.8 U8b）：上一轮为什么停，原文 kebab-case 对齐
             U8a TUI 决策（interrupted / interrupted-by-restart / ...）；有值即展示
            （idle 与 A-lite 轮终 running-resumable 均携带合法停因）-->
        <span
          v-if="subagentMeta?.stopReason"
          class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim opacity-70"
          :title="t('panel.sideDrawer.subagentStopReason')"
          data-testid="subagent-stop-reason"
        >{{ subagentMeta.stopReason }}</span>
        <!-- 模型标签（subagent-model-switch §7.1 入口层）：chat 域成员与 agentcall 视图的
             workflow 成员均可切换（ModelSelectPopover 复用；提交走 subagent.setModel，
             回执写状态禁乐观写）；标签读取规则四分支合成见 modelDisplay。agentcall 视图
             经 call.memberRecordId 圈定成员 record 作切换目标（switchRecord），record
             缺失（未创建 / 载荷未经详情增强通道）降级为 meta 槽纯显示。 -->
        <ModelSelectPopover
          v-if="switchRecord !== null"
          :selected="modelDisplay.label ?? ''"
          :switching="switching"
          @select="onModelSelect"
        >
          <template #trigger>
            <!-- 调用方自包 PopoverTrigger as-child（ModelSelectPopover 组件契约：#trigger slot 不自带包裹）——
                 D3-A6 缺陷修复：裸 Button 点击不弹 popover（单测 mock 组件致点击行为零覆盖）。 -->
            <PopoverTrigger as-child>
              <Button
                variant="ghost"
                class="ml-auto flex shrink-0 items-center gap-1 rounded-sm px-1 font-mono text-[length:var(--text-3xs)] text-neutral-dim transition-colors hover:text-neutral-fg"
                :title="modelTriggerTitle"
                data-testid="subagent-model-trigger"
              >
                <span v-if="modelDisplay.label" class="max-w-[160px] truncate">{{ modelDisplay.label }}</span>
                <span
                  v-if="modelDisplay.overridden"
                  class="shrink-0 rounded-sm border border-[color-mix(in_oklch,var(--accent)_40%,transparent)] px-1 text-[length:var(--text-3xs)] text-accent"
                  data-testid="subagent-override-badge"
                >{{ t('panel.sideDrawer.subagentOverrideBadge') }}</span>
                <ChevronDown class="size-3 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
          </template>
        </ModelSelectPopover>
        <!-- 派发期模型来源标注（subagent-detail-model-info 2026-10-15）：「派发时是指定还是
             缺省补缺」——与模型覆盖/热切正交（只记 spawn 时点来源）；存量 record 无字段
             不展示（title 含完整盖章 ref，悬停可见全值）。 -->
        <span
          v-if="modelSourceBadge"
          class="shrink-0 rounded-sm border border-hairline px-1 font-mono text-[length:var(--text-3xs)] leading-4 text-neutral-dim"
          :title="modelSourceTitle"
          data-testid="subagent-model-source-badge"
        >{{ modelSourceBadge }}</span>
        <span
          v-if="switchRecord === null && subagentMeta?.meta"
          class="ml-auto shrink-0 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim"
        >
          {{ subagentMeta.meta }}
        </span>
      </div>

      <!-- 只读提示（差异化层）：composer 不出时（agentcall 快照视图 / 引擎未声明续聊
           能力）保留只读说明。对齐 demo .sub-ro：头行下方的纯文字行（3xs 档 mid、
           无边框无图标），不再是底部 border-t 条。composer 出现时本行消失（文案
           「无 composer」与事实矛盾）。 -->
      <div
        v-if="!composerVisible"
        class="flex shrink-0 items-center px-3.5 pb-2 text-[length:var(--text-3xs)] text-neutral-mid"
      >
        <span>{{ t('panel.sideDrawer.subagentReadonly') }}</span>
      </div>

      <!-- 运行中 coarse 提示（U4 D7）：非 pi 引擎 running 任务不支持实时流，如实提示不伪造流。
           pi 任务恒不出现（D5：undefined 缺省映射为 pi）。 -->
      <div
        v-if="coarseHintVisible"
        class="flex shrink-0 items-center gap-1.5 border-b border-hairline bg-surface-2 px-3.5 py-1.5 text-[length:var(--text-3xs)] text-neutral-dim"
        data-testid="subagent-coarse-hint"
      >
        <Clock class="size-3 shrink-0 opacity-70" />
        <span>{{ t('panel.sideDrawer.subagentCoarseHint', { engine: coarseHintEngine }) }}</span>
      </div>

      <!-- live 流降级提示（M3 relay-spawn-transport D6）：镜像 seq 空洞 → runtime 停止
           live 发布，reply.degraded=true 经 core 流状态机透传；内容以落盘为准，
           刷新/重开拉全量历史。 -->
      <div
        v-if="streamDegraded"
        class="flex shrink-0 items-center gap-1.5 border-b border-hairline bg-warn-soft px-3.5 py-1.5 text-[length:var(--text-3xs)] text-warn"
        role="status"
        data-testid="subagent-stream-degraded"
      >
        <TriangleAlert class="size-3 shrink-0 opacity-80" aria-hidden="true" />
        <span>{{ t('panel.sideDrawer.subagentStreamDegraded') }}</span>
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
           MessageStream 按 :session-id 读 chatStore.messages 虚拟分区，对虚拟 id 完全透明。
           mainSessionId = panelStore.focusedSessionId（头部注释同源约定）——agentcall 两段式
           vid 的归属解析（file 白名单/markdown 路径 cwd 回真实 session）依赖它；subagent:
           三段式自带 mainSid 不消费。 -->
      <MessageStream
        v-else
        :key="activeTab"
        :session-id="activeTab"
        :main-session-id="panelStore.focusedSessionId ?? undefined"
      />

      <!-- composer 带（subagent-composer 2026-10-18）：与主面板同一 band 壳
           （COMPOSER_BAND_CLASS 单源，几何关系一致）+ 同一 Composer（subagent 通道形态：
           发送/中止经 session.subagentAction 通道分流，左簇/指标/模型簇裁剪——模型入口
           留在本组件头部）。回显事实源 = SubagentTee entry 帧（含 user entry），与主
           agent 定向消息（@ mention）同一链路。 -->
      <div v-if="composerVisible" :class="COMPOSER_BAND_CLASS" data-fs-scope="chat" data-testid="drawer-subagent-composer-band">
        <Composer :session-id="activeTab" :show-btw="false" subagent />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, Bot, ChevronDown, Clock, TriangleAlert, X } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { useSubagentSelection } from '@taiji/core/domain/drawer'
import { usePanelStore } from '@/stores/panel'
import { useChatStore } from '@/stores/chat'
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
import type { ProviderId, SubagentRecord, WorkflowAgentCall } from '@taiji/shared'
import MessageStream from './MessageStream.vue'
import Composer from './Composer.vue'
import { COMPOSER_BAND_CLASS } from './composer-band'
import { isSubagentComposerEligible } from '@/composables/panel/subagent-composer-lane'
import ModelSelectPopover from './ModelSelectPopover.vue'
import { PopoverTrigger } from '@/components/ui/popover'
import { DEFAULT_ENGINE_ID } from '@/constants/engine-icons'
// u6.1 chat facet 收尾：对话流数据编排（chat store ops 范围消费）下沉 composable，
// 组件只保留 readers 范围消费
import { useSubagentTabData } from '@/composables/panel/useSubagentTabData'
import { useSubagentDrawerTabs } from '@/composables/panel/useSubagentDrawerTabs'
// subagent-model-switch §7.1（U1）：执行模型切换（回执写状态禁乐观写）+ 标签读取规则
// （thinking 槽取值同源 composable 纯函数——热切回执档位优先，回退启动盖章值）
import {
  resolveSubagentThinkingLevel,
  useSubagentModel,
  useSubagentModelSourceBadge,
} from '@/composables/features/subagent/useSubagentModel'

const { t } = useI18n()
const panelStore = usePanelStore()
const chatStore = useChatStore()
const subagentStore = useSubagentStore()
const workflowStore = useWorkflowStore()

const { selectedSubagentId } = useSubagentSelection()

/** tab 条文案（agent · slug；record 缺失降级 'subagent'）。 */
function tabLabel(vid: string): string {
  const meta = isSubagentVirtualId(vid) ? subagentRecordMeta(vid) : agentCallHeaderMeta(vid)
  const base = meta?.agent ?? 'subagent'
  return meta?.slug ? `${base} · ${meta.slug}` : base
}

// 切换编排（回执写状态在 composable；displayOf 供 thinking 槽与 modelDisplay 消费）
const { setSubagentModel, displayOf } = useSubagentModel()

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

/** 标题栏元信息形状（chat record 与 agentcall 快照两视图共用的派生视图）。 */
type SubagentHeaderMeta = { agent: string; slug?: string; meta?: string; engine?: string; stopReason?: string }

/** 三段式虚拟 id（chat 域 record）的标题栏元信息。 */
function subagentRecordMeta(vid: string): SubagentHeaderMeta | null {
  const mainSessionId = extractMainSessionId(vid)
  const subId = extractSubagentId(vid)
  const record = subagentStore.getRecordsBySession(mainSessionId).find((r) => r.subagentId === subId)
  if (!record) return null
  // 模型槽位移交 modelDisplay（标签读取规则四分支），meta 只余 thinking 档位：
  // §6.4 展示口径——热切回执生效档位（展示态）优先，回退启动盖章值（record.thinkingLevel）。
  const thinkingLevel = resolveSubagentThinkingLevel(displayOf(record.subagentId), record.thinkingLevel)
  return {
    agent: record.agent,
    slug: record.slug || undefined,
    meta: thinkingLevel ? `thinking ${thinkingLevel}` : undefined,
    engine: record.engine || undefined,
    // 停因词（U8b §3.2.8）：有值即派生——idle 与 A-lite 轮终 running-resumable 均携带
    // 合法停因；「为什么停」一句话解释，不参与资格判定
    stopReason: record.stopReason,
  }
}

/** 两段式虚拟 id（agentcall 快照）的标题栏元信息。 */
function agentCallHeaderMeta(vid: string): SubagentHeaderMeta | null {
  const call = findAgentCall(extractAgentCallSessionId(vid))
  if (!call) return null
  return {
    agent: call.agent,
    // model 'default' 不显示（占位值不展示，语义沿用退役的侧栏工作流详情视图）；
    // 成员 record 在场时模型标签由 ModelSelectPopover 承载（switchRecord 非空），
    // 本 meta 槽仅在 record 缺失降级态显示 call.model
    meta: call.model && call.model !== 'default' ? call.model : undefined,
  }
}

/** 标题栏元信息（响应式：records 变化时重算）。chatMeta = 三段式虚拟 id 的 record；agentcall 两段式 = null。 */
const subagentMeta = computed<SubagentHeaderMeta | null>(() => {
  const vid = activeTab.value
  if (!vid) return null
  if (isSubagentVirtualId(vid)) return subagentRecordMeta(vid)
  if (isAgentCallVirtualId(vid)) return agentCallHeaderMeta(vid)
  return null
})

/** 当前选中的 chat 域 record（对话流与头部元信息语义；agentcall 两段式 = null——
 *  模型切换/标签合成目标见 switchRecord）。 */
const chatMeta = computed<SubagentRecord | null>(() => {
  const vid = activeTab.value
  if (!vid || !isSubagentVirtualId(vid)) return null
  const record = subagentStore
    .getRecordsBySession(extractMainSessionId(vid))
    .find((r) => r.subagentId === extractSubagentId(vid))
  return record ?? null
})

/**
 * agentcall 两段式的 workflow 成员 record（成员级模型切换目标）：经 call.memberRecordId
 * 圈定 subagentStore 成员 record——成员键单源对齐锚 = runtime 详情增强透出的
 * memberRecordId ≡ SubagentRecord.subagentId（≡ run 级聚合应答成员标识；call.sessionId
 * 是 pi session uuidv7，不在成员键域）。record 缺失（成员 record 未创建 / 载荷未经
 * 详情增强通道）= null，切换入口降级为 meta 槽纯显示。
 */
const agentcallRecord = computed<SubagentRecord | null>(() => {
  const vid = activeTab.value
  if (!vid || !isAgentCallVirtualId(vid)) return null
  const call = findAgentCall(extractAgentCallSessionId(vid))
  const recordId = call?.memberRecordId
  if (recordId === undefined) return null
  return (
    subagentStore
      .getRecordsBySession(panelStore.focusedSessionId ?? '')
      .find((r) => r.subagentId === recordId) ?? null
  )
})

/** 模型标签合成与切换目标的 record：chat 域 = 三段式 record；agentcall 域 = 成员
 *  record。两域共用同一 ModelSelectPopover 与 setModel 提交通道（recordId 键同源）。 */
const switchRecord = computed<SubagentRecord | null>(() => chatMeta.value ?? agentcallRecord.value)

// ── 执行模型切换（subagent-model-switch §7.1，U1）────────────────────

/** 切换中（ModelSelectPopover switching 门：禁重复开合与点选） */
const switching = ref(false)

// ── 模型信息展示（subagent-detail-model-info 2026-10-15）：标签四分支合成 + 来源
// 标注/title 全量下沉 useSubagentModel（模型域单源），组件只保留 readers 消费。
const { modelDisplay, modelTriggerTitle, modelSourceBadge, modelSourceTitle } =
  useSubagentModelSourceBadge(computed(() => switchRecord.value), displayOf, t)

/** 点选候选 → subagent.setModel（switchRecord 目标——chat 域 record 或 agentcall 成员
 *  record，recordId 键同源）；回执写状态在 composable（禁乐观写）。 */
async function onModelSelect(payload: { modelId: string; provider: ProviderId }): Promise<void> {
  const record = switchRecord.value
  if (record === null || switching.value) return
  switching.value = true
  try {
    await setSubagentModel({
      recordId: record.subagentId,
      provider: payload.provider,
      modelId: payload.modelId,
    })
  } finally {
    switching.value = false
  }
}

/** 引擎 badge 文案（U3 D9）：常态引擎名（缺省 pi；运行期不会换引擎，无回退态） */
const engineBadgeText = computed<string>(() => {
  const meta = subagentMeta.value
  return meta?.engine || DEFAULT_ENGINE_ID
})

/** 引擎 badge title：常态 = 引擎名 */
const engineBadgeTitle = computed<string>(() => {
  const meta = subagentMeta.value
  return t('panel.sideDrawer.engineBadgeTitle', { engine: meta?.engine || DEFAULT_ENGINE_ID })
})

/** 当前选中 subagent 的 record（三段式虚拟 id 才有；agentcall 两段式返回 null）＝ chatMeta——
 *  对话流加载 / coarse 提示 / 回填桥的 chat 域消费键（模型切换消费 switchRecord，范围更宽）。 */
const currentRecord = chatMeta

// 对话流数据编排（loadError 兜底态 + 加载/停止；recordEngine 供 coarse 提示与兜底判断复用）
const { loadError, loadSubagentData, stopSubagentStream, recordEngine } = useSubagentTabData({
  currentRecord,
  noOutcomeText: () => t('panel.sideDrawer.subagentNoOutcome'),
})

// ── drawer 二级 tab 编排（subagent-detail-tabs 2026-10-15）：状态在 store per-session
// 分区（组件随 drawer 类型 tab 切换卸载），编排下沉 composable（行数上限合规 + 可测）；
// 内容数据在 chatStore 按虚拟 id 分区——切 tab 不丢详情。
const { openTabs, activeTab, activate: onTabActivate, close: onTabClose } = useSubagentDrawerTabs({
  selectedSubagentId,
  labelOf: tabLabel,
  stopStream: () => stopSubagentStream(),
})

/**
 * 运行中 coarse 提示可见性（U4 D7）：非 pi 引擎 + 任务真在跑（窄口径同
 * isStreamingSubagent：running 且无轮终 result、非 resumable）。pi 恒 false（D5）。
 */
const coarseHintVisible = computed<boolean>(() => {
  const record = currentRecord.value
  if (!record || recordEngine(record) === DEFAULT_ENGINE_ID) return false
  return subagentStore.isStreamingSubagent(extractMainSessionId(activeTab.value ?? ''), record.subagentId)
})

/** live 流降级可见性（M3 D6）：core 流状态机透传 degraded=true（镜像 seq 空洞 → runtime
 * 停止发布）。恢复 = 刷新/重开拉全量历史（内容以落盘为准）；agentcall 快照无 live 流 → false。 */
const streamDegraded = computed<boolean>(() => {
  const vid = activeTab.value
  const record = currentRecord.value
  if (!vid || !record) return false
  return chatStore.isSubagentStreamDegraded(vid, record.subagentId)
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

/** composer 可见性（判据单点在 subagent-composer-lane.isSubagentComposerEligible） */
const composerVisible = computed(() => isSubagentComposerEligible(activeTab.value, currentRecord.value))

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
 * 非 pi 终态回填桥（D2）：
 * 非 pi 引擎无实时流通道，运行中打开的 tab 内容停在打开时刻——record 跨越收尾
 * （running → 非 running）时重新拉取一次，对话流自动收敛到完整内容。四检查：
 * cur/prev 任一 null（agentcall / 未选中）跳过；vid 或 subId 变化 = 切换 subagent
 * 跳过（新 vid 由上方 activeTab watch 负责）；仅 running → 非 running 跨越
 * 触发（打开时已收尾由首次拉取覆盖）；pi 引擎跳过（D5 零变化）。
 * [U8b 两态判据核对] 占用两态下 settle 写 idle——running → idle 即收尾跨越，本判据
 * 无需改动即正确触发（idle → running 续轮走 pi 实时流 / 非 pi coarse 轮终再跨越，
 * 与旧 closed → running 复活行为一致）；legacy 五值同落非 running 半边，兼容不破。
 */
watch(
  () => {
    const vid = activeTab.value
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
  const vid = activeTab.value
  if (vid) void loadSubagentData(vid)
}
</script>
