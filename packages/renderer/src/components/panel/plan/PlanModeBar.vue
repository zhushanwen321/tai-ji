<template>
  <!--
    PlanModeBar —— 计划模式状态带（plan-mode-ux-refactor u-plan-bar，设计 §3.3 D1）。
    挂载位 = Panel 内 composer 下方一行（.composer-band 之后，窗口底部）；审阅动作由右区
    PlanReviewBar 承载（D1 chrome 收敛为单行）。
    组件常驻挂载（Panel 无条件挂载本组件，isActive=false 时 template 根 v-if 不渲染
    DOM）——setup 内 useExtensionUI(planReviewFilter) 订阅与 getPendingRequests 拉取
    不随显隐销毁，isActive=false 期间 planReview 请求恒入 store（挂起审批的唯一兜底
    消费面：C4 分流把 planReview 排除出 CompanionBand 原始 dialog，无二通道；订阅宿主
    若组件级 v-if，挂起请求无人枚举 → agent 永挂）。focusedSid 注入义务（原横幅/审批
    条 setup 内 usePlanState → syncFocus）随组件迁移到本组件（承接清单②）。
    视觉 = text-xs / text-neutral-dim / 无填充背景 / border-t hairline，比内容安静。
  -->
  <!-- 行级 flex-wrap 承载「一行两区」窄窗契约（F-R2-2）：右区（PlanReviewBar，basis =
       max-content）一行放不下时整体换行到第二行，左区 shrink-0 优先保全——删 wrap 会
       退回右区收缩、justify-end 内容左溢覆盖左区的事故形态（策略实装见 PlanReviewBar）-->
  <div
    v-if="isActive"
    data-testid="plan-mode-bar"
    class="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border px-5 pb-3 pt-1.5 text-xs text-neutral-dim"
  >
    <!-- 左区（常驻，isActive 即渲染）：模式名 + 三阶段点（done 对勾/同色系，去绿）+ 退出 -->
    <span
      data-testid="plan-mode-bar-title"
      class="flex shrink-0 items-center gap-1.5 font-medium text-neutral-mid"
      :title="skillsTitle"
    >
      <SquareCheckBig class="size-3.5 shrink-0 text-accent" aria-hidden="true" />
      {{ t('plan.modeBar.title') }}
    </span>
    <!-- 三步阶段指示（D1 推导不落盘，消费 usePlanState 的 stage；点带 tooltip 说明含义） -->
    <span class="flex shrink-0 items-center gap-1 whitespace-nowrap" data-testid="plan-mode-bar-stage">
      <template v-for="(step, i) in stageSteps" :key="step.stage">
        <span v-if="i > 0" class="h-px w-3.5 bg-neutral-faint opacity-40" aria-hidden="true" />
        <span
          class="flex items-center gap-1"
          :title="step.tip"
          :class="stepStage(i) === 'cur' ? 'text-accent' : stepStage(i) === 'done' ? 'text-neutral-mid' : ''"
        >
          <!-- done = 对勾（同 accent 色系，去旧绿点）；cur = accent 高亮点；todo = 灰点 -->
          <Check
            v-if="stepStage(i) === 'done'"
            aria-hidden="true"
            class="size-2.5 text-accent"
          />
          <i
            v-else
            aria-hidden="true"
            class="inline-block size-[5px] rounded-full"
            :class="stepStage(i) === 'cur' ? 'bg-accent shadow-[0_0_0_3px_var(--accent-soft)]' : 'bg-neutral-faint'"
          />
          {{ step.label }}
        </span>
      </template>
    </span>
    <!-- 退出（D5：确认后 emit session.abortPlan WS 命令，E10：
         挂起 select 期退出联动在 extension 侧）。§3.5 退出确认 Popover：确认前置 + 分情境
         警示（revising = agent 侧修订将中止 / 有评论草稿 = 将丢弃，按序取首个命中）；
         2026-09-21 精简后本按钮是退出唯一入口（degraded 态不再另设右区退出） -->
    <Popover :open="exitConfirmOpen" @update:open="exitConfirmOpen = $event">
      <PopoverTrigger as-child>
        <Button
          variant="ghost"
          size="sm"
          class="ml-auto shrink-0 gap-1 rounded-[var(--radius-sm)] px-[7px] py-[3px] text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
          data-testid="plan-mode-bar-exit"
          :disabled="exiting"
        >
          {{ t('plan.modeBar.exit') }}
          <X class="size-3" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" :collision-padding="8" class="w-64 p-3">
        <div data-testid="plan-mode-bar-exit-confirm" class="flex flex-col gap-2.5">
          <p class="text-[length:var(--text-xs)] font-medium text-neutral-fg">
            {{ t('plan.modeBar.exitConfirmTitle') }}
          </p>
          <!-- 警示行（分情境，可共存时按优先级取首个）：revising 优先（与审批条分支
               竞态安全序一致——revising 态 GUI 草稿已在 revise 提交时清空，两警示语义互斥） -->
          <p
            v-if="reviewState === 'revising'"
            data-testid="plan-mode-bar-exit-warn-revising"
            class="text-[length:var(--text-2xs)] leading-relaxed text-warn"
          >
            {{ t('plan.modeBar.exitWarnRevising') }}
          </p>
          <p
            v-else-if="drafts.length > 0"
            data-testid="plan-mode-bar-exit-warn-drafts"
            class="text-[length:var(--text-2xs)] leading-relaxed text-warn"
          >
            {{ t('plan.modeBar.exitWarnDrafts', { count: drafts.length }) }}
          </p>
          <div class="flex justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              data-testid="plan-mode-bar-exit-cancel"
              @click="exitConfirmOpen = false"
            >
              {{ t('plan.modeBar.exitCancel') }}
            </Button>
            <Button
              variant="default"
              size="sm"
              data-testid="plan-mode-bar-exit-confirm"
              :disabled="exiting"
              @click="onExitConfirmed"
            >
              {{ t('plan.modeBar.exitConfirm') }}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
    <!-- 右区（情境）：PlanReviewBar 子组件（四分支 ready/revising/degraded/隐藏逻辑原样
         复用；isActive 门由本行根 v-if 保证，mode=null 时右区仅剩左区占位）。
         2026-09-21 精简：原 degraded 右区退出按钮删除（与左区退出两键同屏，问题 5 去重），
         退出唯一入口 = 左区退出按钮（常驻），exit 事件链随之拆除 -->
    <PlanReviewBar :session-id="sessionId" />
    <!-- E9：退出命令失败（reply success=false → promise reject）——状态带保持原状，错误
         就近呈现且内嵌恢复动作（横幅错误通路同款迁移） -->
    <p
      v-if="exitError"
      data-testid="plan-mode-bar-error"
      role="alert"
      class="w-full text-[length:var(--text-2xs)] text-danger"
    >
      {{ exitError }}
    </p>
    <!-- 首拉失败（分区 loadError）：view 不被覆盖，状态带照旧值显示，错误行提示状态可能过期 -->
    <p
      v-else-if="loadError"
      data-testid="plan-mode-bar-load-error"
      role="alert"
      class="w-full text-[length:var(--text-2xs)] text-danger"
    >
      {{ loadError }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * PlanModeBar —— 计划模式状态带（左区常驻模式态 + 右区情境审批条）。
 *
 * 结构（设计 §3.3）：一行两区。左区 = 模式名 + 三阶段点 + 退出（常驻，isActive 即渲染）；
 * 右区 = PlanReviewBar（四分支情境渲染，机制知识随其文件延续）。
 *
 * 常驻挂载订阅约束（承接清单①，M1）：本组件由 Panel 无条件挂载（禁组件级 v-if），
 * isActive=false 时仅 template 根 v-if 不渲染 DOM——setup 内 useExtensionUI(
 * planReviewFilter) 实例与 usePlanState 的 WS 订阅/首拉不随显隐销毁。isActive=false
 * 期间到达的 planReview 请求仍入 extensionUIStore（PlanReviewBar 此时未创建，本实例
 * 是唯一订阅面；refCount 订阅 + store requestId dedup 使 isActive=true 后 PlanReviewBar
 * 的第二实例幂等共存，getPendingRequests 快照补拉兜住晚订阅窗口）。
 *
 * focusedSid 注入义务（承接清单②）：planStore.focusedSid 的注入方原为同宿主
 * （PanelContainer）的横幅/审批条，二者删除后由本组件 setup 内 usePlanState 的
 * watch immediate → syncFocus 承接（新宿主 Panel.vue；use-plan-drawer-sync 依赖该
 * 注入，见其头注释）。多实例同值注入无互覆（设计已核实，恒单 Panel 下安全）。
 *
 * 退出链路（§3.5）：左区退出按钮 = 确认 Popover 触发器（分情境警示：revising 中警示
 * agent 侧修订将中止 / 有评论草稿警示将丢弃，按序取首个命中），确认后清焦点分区草稿 +
 * command('session.abortPlan') → runtime ensureActive + client.prompt('/plan abort')；
 * 退出唯一入口 = 本按钮（原 degraded 右区退出按钮已删，问题 5 去重）。
 * reply 失败 = promise reject → E9 恢复指引就近呈现、状态带保持原状；成功后 isActive=false
 * 由投影链广播驱动（本组件不本地改状态）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, SquareCheckBig, X } from '@lucide/vue'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@taiji/ui'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { toErrorMessage } from '@taiji/core'
import { usePlanState } from '@/composables/use-plan-sync'
import { useExtensionUI, planReviewFilter } from '@/composables/useExtensionUI'
import PlanReviewBar from '@/components/panel/plan/PlanReviewBar.vue'

const props = defineProps<{
  /** 焦点 session（panel store 的 focusedSessionId；状态带只服务焦点 session，D1） */
  sessionId: string | null
}>()

const { t } = useI18n()

const sessionIdRef = computed(() => props.sessionId)

// focusedSid 注入 + WS 订阅 + 首拉（承接清单②；视图透出 view/stage/loadError）
// drafts = 焦点分区评论草稿（§3.5 退出确认草稿警示 + 确认退出即清的读取面）
const { view, stage, loadError, drafts, clearDrafts } = usePlanState(sessionIdRef)

// 常驻订阅（承接清单①）：isActive=false 期间 planReview 请求仍入 store 的兜底实例。
// currentPlanReviewRequests/respond 由右区 PlanReviewBar 自持实例消费，本实例只承担
// 「订阅存活」义务（filter 放行 planReview 请求入 store）。
useExtensionUI(sessionIdRef, planReviewFilter)

/** 显示驱动（D5，承横幅）：isActive 严格判定——无 view / isActive=false 都不渲染整行 */
const isActive = computed(() => view.value?.isActive === true)

/**
 * 技能名收进模式名 tooltip（设计砍噪音条款）：默认不渲染技能文本，有 skills 时
 * title = 「技能：a · b」；旧 entry 无字段 / 空数组 → undefined（无 title 属性）。
 */
const skillsTitle = computed(() => {
  const skills = view.value?.skills
  return skills && skills.length > 0
    ? `${t('plan.modeBar.skillsLabel')}: ${skills.join(' · ')}`
    : undefined
})

/** 三步阶段（顺序即推导序号；label 与 tooltip 均响应 i18n） */
const stageSteps = computed(() => [
  { stage: 'exploring' as const, label: t('plan.modeBar.stageExploring'), tip: t('plan.modeBar.stageExploringTip') },
  { stage: 'writing' as const, label: t('plan.modeBar.stageWriting'), tip: t('plan.modeBar.stageWritingTip') },
  { stage: 'reviewing' as const, label: t('plan.modeBar.stageReviewing'), tip: t('plan.modeBar.stageReviewingTip') },
])

/** 步骤视觉态：当前（accent 高亮）/ 已完成（对勾）/ 未到（默认灰点） */
function stepStage(index: number): 'cur' | 'done' | 'todo' {
  const current = stageSteps.value.findIndex((s) => s.stage === stage.value)
  if (index === current) return 'cur'
  return index < current ? 'done' : 'todo'
}

// ── 退出（§3.5 确认 Popover + E9 错误通路）──
const exiting = ref(false)
const exitError = ref<string | null>(null)
/** 退出确认 Popover 开合（受控） */
const exitConfirmOpen = ref(false)

const reviewState = computed(() => view.value?.reviewState)

/**
 * 确认退出（§3.5）：关确认层 → 发 abortPlan → 命令成功后才清焦点分区评论草稿
 * （P2-4 顺序修复：原实现先清草稿后发命令，命令失败时草稿已不可恢复；现失败保留
 * 草稿供重试。agent 自退等绕过路径由 plan-store 分区写入层的翻转清兜底）。
 */
async function onExitConfirmed(): Promise<void> {
  exitConfirmOpen.value = false
  await onExit()
  if (!exitError.value) clearDrafts()
}

async function onExit(): Promise<void> {
  const sid = props.sessionId
  if (!sid || exiting.value) return
  exiting.value = true
  exitError.value = null
  try {
    // reply 契约（protocol.ts session.abortPlan）：ack void，退出结果经投影链广播推回；
    // 失败 = error envelope → promise reject（AGENTS.md 规则 5 的 renderer 实态）
    await command('session.abortPlan', { sessionId: sid }, RPC_BACKSTOP_TIMEOUT_MS)
  } catch (e) {
    exitError.value = t('plan.modeBar.exitError', { message: toErrorMessage(e) })
  } finally {
    exiting.value = false
  }
}
</script>
