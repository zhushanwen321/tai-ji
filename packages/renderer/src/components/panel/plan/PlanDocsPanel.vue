<template>
  <!--
    计划产物文档面板（plan 模式重设计 u1-docs-panel，设计 §3.1 步骤 3-5 / G2 后半 + G3；
    态矩阵 plan-mode-ux-refactor §3.2）。渲染决策链（D10/D4/D5 三裁决合流 + §3.2 态矩阵）：
    docs 非空即渲染 L2 tab + 正文——isActive 不参与产物渲染门（D5 终态矩阵：产物 tab 由
    docs.length 驱动、与 isActive 解耦，退出/执行后仍可回看）；docs 空时按 isActive 与
    agent 活跃信号分态：isActive && agent 活跃 → pending 进行时 #1；isActive && agent
    空闲 → pending 等待态 #2（恢复出口，防 pending 自身成死胡同）；!isActive && 有
    planFilePath → D4 降级单文件 #3（legacy 回看）；其余 → 空态 #4。
    正文 = file.read RPC（带 sessionId 走 cwd 守门，复用 CommandDocPanel 先例形态）+
    markdown 渲染；失败 → E2 占位错误态（条目不清，agent 可重新产出提示）。
    划选评论 = PlanCommentPopover（浮条/编辑器）→ 本组件写 planStore 草稿（D6）。
  -->
  <!-- §3.2 矩阵 #1：isActive && docs 空 && agent 活跃（isGenerating）→ pending 进行时 -->
  <div
    v-if="pendingGenerating"
    data-testid="plan-docs-pending-active"
    class="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center"
  >
    <Loader2 class="size-3.5 animate-spin text-neutral-dim" aria-hidden="true" />
    <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('plan.drawer.pendingActive') }}</p>
  </div>
  <!-- §3.2 矩阵 #2：isActive && docs 空 && agent 空闲 → pending 等待态 + 恢复入口提示
       （交互语义 = 指引用户发消息，无独立按钮；恢复入口 = 文案指引，已随 u-drawer-gate 落地，无程序动作） -->
  <div
    v-else-if="pendingIdle"
    data-testid="plan-docs-pending-idle"
    class="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center"
  >
    <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('plan.drawer.pendingIdle') }}</p>
    <p class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-dim opacity-50">
      {{ t('plan.drawer.pendingIdleHint') }}
    </p>
  </div>
  <!-- §3.2 矩阵 #4：无 plan 状态 / !isActive 且无产物 → 空态（正常退出落此态） -->
  <div
    v-else-if="docItems.length === 0"
    data-testid="plan-docs-empty"
    class="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center"
  >
    <p class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('plan.drawer.noPlan') }}</p>
    <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-50">{{ t('plan.drawer.planHint') }}</p>
    <!-- 首拉失败（分区 loadError，u1-store 错误通路）：view 为空时状态带不渲染（isActive 门），
         错误若只落状态带呈全面即静默降级（C-U1）——本面板空态就近呈现「错误 + 恢复指引」，
         与 PlanModeBar 状态带错误行同款形态 -->
    <p
      v-if="loadError"
      data-testid="plan-docs-load-error"
      role="alert"
      class="text-[length:var(--text-2xs)] leading-relaxed text-danger"
    >
      {{ loadError }}
      <span class="text-neutral-dim">{{ t('plan.docs.loadErrorHint') }}</span>
    </p>
  </div>
  <div v-else data-testid="plan-docs-panel" class="flex h-full min-h-0 flex-col overflow-hidden">
    <!-- L2 横排文档 tab（demo doc-tabs 形态）：fileName ellipsis 截断（title 全名）+
         来源技能 chip + version meta + 修订中圆点；降级单文件条目无 chip/version（D4） -->
    <div
      role="tablist"
      data-testid="plan-docs-tabs"
      class="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-2.5"
    >
      <Button
        v-for="doc in docItems"
        :key="doc.absPath"
        variant="ghost"
        role="tab"
        data-testid="plan-docs-tab"
        class="h-auto max-w-[200px] shrink-0 justify-start gap-1.5 rounded-t-[var(--radius-sm)] rounded-b-none px-3 py-2 font-normal text-[length:var(--text-xs)]"
        :class="
          doc.absPath === selectedDoc?.absPath
            ? 'bg-surface-hover text-neutral-fg'
            : 'text-neutral-dim hover:text-neutral-mid'
        "
        :aria-selected="doc.absPath === selectedDoc?.absPath"
        :title="doc.fileName"
        @click="selectedAbsPath = doc.absPath"
      >
        <span class="truncate">{{ doc.fileName }}</span>
        <span
          v-if="doc.sourceSkill"
          data-testid="plan-docs-tab-skill"
          class="shrink-0 rounded-full bg-surface-hover px-1.5 py-px font-mono text-[length:var(--text-3xs)] text-neutral-mid"
        >{{ doc.sourceSkill }}</span>
        <span
          v-if="!doc.degraded"
          data-testid="plan-docs-tab-version"
          class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
        >v{{ doc.version }}</span>
        <i
          v-if="revising"
          data-testid="plan-docs-tab-revising"
          class="size-[5px] shrink-0 rounded-full bg-warn"
          aria-hidden="true"
        />
      </Button>
    </div>
    <!-- meta 行（demo doc-meta 形态）：来源技能 / 版本 / 路径；修订中提示 -->
    <div
      v-if="selectedDoc"
      data-testid="plan-docs-meta"
      class="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-2.5"
    >
      <span
        v-if="!selectedDoc.degraded && selectedDoc.sourceSkill"
        data-testid="plan-docs-meta-skill"
        class="rounded-full bg-info-soft px-2 py-0.5 font-mono text-[length:var(--text-3xs)] text-info"
      >{{ t('plan.docs.sourceLabel') }} · {{ selectedDoc.sourceSkill }}</span>
      <span
        v-if="!selectedDoc.degraded"
        data-testid="plan-docs-meta-version"
        class="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-[length:var(--text-3xs)] text-neutral-mid"
      >v{{ selectedDoc.version }}</span>
      <span
        class="min-w-0 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim"
        :title="selectedDoc.absPath"
      >{{ selectedDoc.absPath }}</span>
      <span
        v-if="revising"
        data-testid="plan-docs-meta-revising"
        class="rounded-full bg-warn-soft px-2 py-0.5 text-[length:var(--text-3xs)] text-warn"
      >{{ t('plan.docs.revisingBadge') }}</span>
    </div>
    <!-- 正文滚动区 + 划选评论目标容器 -->
    <div ref="bodyEl" data-testid="plan-docs-body" class="min-h-0 flex-1 overflow-auto px-4 py-3">
      <template v-if="selectedDoc">
        <!-- E2：file.read 失败 → 占位错误态（条目不清，恢复 = agent 重新产出或用户忽略） -->
        <div
          v-if="loadFailed"
          data-testid="plan-docs-error"
          role="alert"
          class="flex flex-col items-start gap-1.5 rounded-[var(--radius)] border border-border bg-surface p-4"
        >
          <p class="text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ t('plan.docs.notFound') }}</p>
          <p class="text-[length:var(--text-xs)] leading-relaxed text-neutral-dim">{{ t('plan.docs.notFoundHint') }}</p>
        </div>
        <!-- [RD-2#4] 请求在途：加载行（切换即清正文，旧文档内容不残留） -->
        <div
          v-else-if="isLoading"
          data-testid="plan-docs-loading"
          class="flex items-center justify-center gap-1.5 py-6 text-[length:var(--text-xs)] text-neutral-dim"
        >
          <Loader2 class="size-3 animate-spin" aria-hidden="true" />
          {{ t('plan.docs.loading') }}
        </div>
        <MarkdownRenderer
          v-else-if="content !== null"
          data-testid="plan-docs-content"
          :content="content"
          :session-id="sessionId ?? undefined"
        />
      </template>
      <!-- 评论草稿列表（D6：提交前 GUI 草稿，可多条可删除；提交打包由 PlanReviewBar 负责。
           §3.5 草稿回看锚点：审批条评论计数点击 → 本面板消费 plan-store 回看请求滚动至此） -->
      <div
        v-if="drafts.length > 0"
        ref="draftsEl"
        data-testid="plan-comment-drafts"
        class="mt-6 border-t border-border pt-3"
      >
        <p class="mb-2 text-[length:var(--text-2xs)] font-medium uppercase tracking-wider text-neutral-dim">
          {{ t('plan.comment.draftsTitle', { count: drafts.length }) }}
        </p>
        <div
          v-for="(draft, i) in drafts"
          :key="i"
          data-testid="plan-comment-draft-item"
          class="flex flex-col gap-1 border-b border-border py-2 last:border-b-0"
        >
          <p
            class="truncate rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
            :title="draft.quote"
          >“{{ draft.quote }}”</p>
          <div class="flex items-start gap-2">
            <p class="min-w-0 flex-1 break-words text-[length:var(--text-xs)] leading-relaxed text-neutral-mid">
              {{ draft.comment }}
            </p>
            <Button
              variant="ghost"
              size="sm"
              class="h-6 shrink-0 gap-1 px-1.5 text-[length:var(--text-2xs)] text-neutral-dim hover:text-danger"
              data-testid="plan-comment-draft-delete"
              @click="removeDraft(i)"
            >
              <X class="size-3" aria-hidden="true" />
              {{ t('plan.comment.delete') }}
            </Button>
          </div>
        </div>
      </div>
    </div>
    <!-- 划选评论浮条（revising 态评论按钮禁用——设计 §3.1 失败路径） -->
    <PlanCommentPopover :target="bodyEl" :disabled="revising" @submit="addDraft" />
  </div>
</template>

<script setup lang="ts">
/**
 * PlanDocsPanel —— drawer「计划产物」tab 的文档面板（L2 文档 tab + 正文 + 划选评论）。
 *
 * 状态源：usePlanState（u1-store 组件消费接口——view/docs/评论草稿），本组件只做呈现与
 * file.read 拉取编排，不持 plan 状态。正文加载复用 CommandDocPanel 先例形态：file.read
 * 带 sessionId 走 cwd 守门（plan 产物在 session cwd 的 .tmp/plans/ 下），失败按 E2
 * 落占位错误态——不做无 sessionId 白名单降级（.tmp 不在白名单内，二次必失败）。
 *
 * 修订刷新（G3）：刷新键 = 选中文档 absPath + version + reviewState 组合——agent 修订重
 * 登记（version bump）或 reviewState 离开 revising 时键变化 → 重新 file.read；tab 切换
 * （absPath 变化）同键承载，单一 watch 收口三种触发。loadingPath 标记防并发竞态
 * （CommandDocPanel 同款：异步期间切走丢弃旧结果）。
 *
 * D4 降级（§3.2 矩阵 #3）：旧 entry 无 docs 字段（或模板流程 docs 空）且 **!isActive** →
 * planFilePath 单文件条目（fileName 取路径末段，无 chip/version）。isActive 期间不渲染
 * 降级条目——enter 恒设 planFilePath，「上轮残留」与「本轮未创建」不可区分，条目可点即
 * E2 假错误（已接受代价：isActive && docs=0 期间 legacy 条目暂不可回看，设计 §3.2 登记）。
 */
import { computed, nextTick, onMounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, X } from '@lucide/vue'
import { Button, MarkdownRenderer, ChatViewDepsKey } from '@taiji/ui'
import type { PlanDocMeta } from '@taiji/shared'
import { useChatViewDeps } from '@/composables/panel/useChatViewDeps'
import * as fileApi from '@taiji/core/transport/api/domains/file'
import { useChatStore } from '@/stores/chat'
import { usePlanStore } from '@/stores/plan-store'
import { usePlanState } from '@/composables/use-plan-sync'
import PlanCommentPopover from './PlanCommentPopover.vue'

const props = defineProps<{
  /** drawer 所属 panel 的 session（file.read cwd 守门 + planStore 分区键） */
  sessionId: string | null
}>()

const { t } = useI18n()

// MarkdownRenderer 经 ChatViewDepsKey inject 壳层依赖；面板在 DrawerPanel 作用域内
// （MessageStream provide 之外），须自行 provide——CommandDocPanel:143 同范式
const { view, loadError, drafts, addDraft, removeDraft } = usePlanState(computed(() => props.sessionId))
provide(ChatViewDepsKey, useChatViewDeps(computed(() => props.sessionId ?? '')))

/** tab 条目（docItems 归一后的渲染模型；degraded = D4 降级条目） */
interface DocTabItem {
  fileName: string
  absPath: string
  sourceSkill: string
  version: number
  degraded: boolean
}

/** 路径末段（降级条目 fileName；兼容 / 与 \ 分隔） */
function basename(p: string): string {
  const last = p.split(/[\\/]/).pop()
  return last !== undefined && last.length > 0 ? last : p
}

/**
 * 渲染决策链（D4 + §3.2 态矩阵）：docs 非空 → 正常条目；docs 空且 !isActive 且有
 * planFilePath → D4 降级单文件（legacy 回看，isActive 门见头注释）；其余 → 空数组
 * （pending #1/#2 或空态 #4，由 pending 计算属性分流）。
 */
const docItems = computed<DocTabItem[]>(() => {
  const v = view.value
  if (!v) return []
  const docs = v.docs
  if (docs && docs.length > 0) {
    return docs.map((d: PlanDocMeta) => ({
      fileName: d.fileName,
      absPath: d.absPath,
      sourceSkill: d.sourceSkill,
      version: d.version,
      degraded: false,
    }))
  }
  if (!v.isActive && v.planFilePath) {
    return [
      { fileName: basename(v.planFilePath), absPath: v.planFilePath, sourceSkill: '', version: 0, degraded: true },
    ]
  }
  return []
})

// agent 活跃信号（§3.2 矩阵 #1/#2 判据）：chat store 的 isGenerating（per-session 惰性
// 派生，仅反映 assistant streaming 实体）。computed 体内调用建立响应式依赖，翻转驱动
// pending 两态切换
const chatStore = useChatStore()
const agentActive = computed(() => (props.sessionId !== null && chatStore.isGenerating(props.sessionId)))

/**
 * pending 态（§3.2 矩阵）：isActive && docs 空。判据不含 planFilePath 维度——
 * activatePlanMode 每次进入恒设该字段，pending 期间该字段非空不代表产物已创建。
 * docs 空时 reviewState 必无值（submit-review 前置 ≥1 doc，结构性成立），不引入第四维度。
 */
const pendingGenerating = computed(
  () => view.value?.isActive === true && docItems.value.length === 0 && agentActive.value,
)
const pendingIdle = computed(
  () => view.value?.isActive === true && docItems.value.length === 0 && !agentActive.value,
)

/** 修订中（reviewState=revising：tab 圆点 / meta 提示 / 评论按钮禁用） */
const revising = computed(() => view.value?.reviewState === 'revising')

/** 选中 tab（absPath 定位；未选/失效回落第一个——docs 渐进增长与重置的自然兜底） */
const selectedAbsPath = ref<string | null>(null)
const selectedDoc = computed<DocTabItem | null>(
  () => docItems.value.find((d) => d.absPath === selectedAbsPath.value) ?? docItems.value[0] ?? null,
)

// ── 正文加载（file.read + E2 占位）──
const bodyEl = ref<HTMLElement | null>(null)
const content = ref<string | null>(null)
const loadFailed = ref(false)
/** [RD-2#4] 请求在途标记：切换/修订刷新即清正文进 loading 态（正文区渲染加载行，不残留旧文档） */
const isLoading = ref(false)
/** 防竞态标记：异步期间选中项已切走则丢弃本次结果（CommandDocPanel 同款） */
let loadingPath: string | null = null

async function loadSelected(): Promise<void> {
  const doc = selectedDoc.value
  if (!doc) {
    content.value = null
    loadFailed.value = false
    isLoading.value = false
    return
  }
  const path = doc.absPath
  if (loadingPath === path) return
  loadingPath = path
  // [RD-2#4] 切换即同步清正文：请求期间头部/meta 已是新条目，残留上一文档内容 = 串内容误读
  content.value = null
  loadFailed.value = false
  isLoading.value = true
  try {
    const result = await fileApi.read(path, props.sessionId ?? undefined)
    if (loadingPath !== path) return
    content.value = result.content
    loadFailed.value = false
    isLoading.value = false
  } catch {
    // E2：文件不存在 / cwd 守门拒绝 → 占位错误态（条目不清，docs 保留）
    if (loadingPath !== path) return
    content.value = null
    loadFailed.value = true
    isLoading.value = false
  } finally {
    if (loadingPath === path) loadingPath = null
  }
}

/**
 * 刷新键单 watch 收口三种触发：tab 切换（absPath）/ 修订重登记（version bump）/ 修订
 * 收尾（reviewState 变化含离开 revising）。immediate 承担挂载首拉；null 键 = 无选中，
 * 清空正文。
 */
watch(
  () => {
    const doc = selectedDoc.value
    if (!doc) return null
    return `${doc.absPath}\u0000${doc.degraded ? 'd' : doc.version}\u0000${view.value?.reviewState ?? ''}`
  },
  () => void loadSelected(),
  { immediate: true },
)

// ── 草稿回看消费（§3.5）：审批条评论计数点击 → 打开/聚焦 drawer 计划产物 tab 后滚动
// 到草稿列表。openDrawerTab 由 PlanReviewBar 调用，本面板只消费 plan-store 的回看请求：
// ① 已挂载时 watch seq 递增即时消费；② drawer 关闭时点击（本面板未挂载）由挂载钩子
// 补消费——consumed 标记保证请求只消费一次，drawer 重开/重挂载不重复滚动。
const planStore = usePlanStore()
const draftsEl = ref<HTMLElement | null>(null)

function consumeDraftsReveal(): void {
  if (!planStore.draftsRevealPending) return
  planStore.markDraftsRevealConsumed()
  if (drafts.value.length === 0) return
  // nextTick：请求同帧触发的 DOM 更新（tab 渲染/草稿列表）先落位再滚
  void nextTick(() => {
    draftsEl.value?.scrollIntoView({ block: 'start' })
  })
}

watch(
  () => planStore.draftsRevealSeq,
  () => consumeDraftsReveal(),
)
onMounted(consumeDraftsReveal)
</script>
