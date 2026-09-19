<template>
  <!--
    M1 计划模式横幅（plan 模式重设计 u1-banner，设计 §3.1 / D5 / G1）。
    显示驱动 = view.isActive（D5：横幅由 isActive 驱动消失——approve/abort 后 resetPlanState
    落 isActive=false，经投影链 session.planState 广播到达，横幅随之消失）。
    视觉基线 = 用户验收 demo 的 M1 顶部横幅（太极纯灰 token，禁 emoji / 原生表单）。
    挂载位 = main-panel header 下、对话流之上（PanelContainer 层独立 flex 行，与 Panel 内的
    表单 overlay/Composer 覆盖位天然不重叠）。
  -->
  <div
    v-if="isActive"
    data-testid="plan-banner"
    role="status"
    class="mx-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[var(--radius)] bg-accent-soft py-2 px-3 text-[length:var(--text-xs)] text-neutral-mid"
  >
    <SquareCheckBig class="size-3.5 shrink-0 text-accent" aria-hidden="true" />
    <span class="min-w-0 flex-[1_1_260px]">
      <b class="font-semibold text-accent">{{ t('plan.banner.title') }}</b>{{ t('plan.banner.hint') }}
    </span>
    <!-- 技能名只读显示（D2：GUI 无增删入口；D4：旧 entry 无 skills 字段降级「（未指定）」） -->
    <span
      data-testid="plan-banner-skills"
      class="flex shrink-0 items-center gap-1 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
    >
      {{ t('plan.banner.skillsLabel') }}
      <b class="font-medium text-neutral-mid">{{ skillsText }}</b>
    </span>
    <!-- 三步阶段指示（D1 推导不落盘：消费 planStore.derivePlanStage 三元组） -->
    <span class="ml-1 flex shrink-0 items-center gap-1 whitespace-nowrap" data-testid="plan-banner-stage">
      <template v-for="(step, i) in stageSteps" :key="step.stage">
        <span v-if="i > 0" class="h-px w-3.5 bg-neutral-faint opacity-40" aria-hidden="true" />
        <span
          class="flex items-center gap-1"
          :class="stepStage(i) === 'cur' ? 'text-accent' : stepStage(i) === 'done' ? 'text-neutral-mid' : ''"
        >
          <i
            aria-hidden="true"
            class="inline-block size-[5px] rounded-full"
            :class="stepStage(i) === 'cur'
              ? 'bg-accent shadow-[0_0_0_3px_var(--accent-soft)]'
              : stepStage(i) === 'done' ? 'bg-success' : 'bg-neutral-faint'"
          />
          {{ step.label }}
        </span>
      </template>
    </span>
    <!-- 退出（D5：emit session.abortPlan WS 命令；E10：挂起 select 期退出联动在 extension 侧） -->
    <Button
      variant="ghost"
      size="sm"
      class="ml-auto gap-1 rounded-[var(--radius-sm)] px-[7px] py-[3px] text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
      data-testid="plan-banner-exit"
      :disabled="exiting"
      @click="onExit"
    >
      {{ t('plan.banner.exit') }}
      <X class="size-3" aria-hidden="true" />
    </Button>
    <!-- E9：退出命令失败（reply success=false → promise reject）——横幅保持原状，错误就近呈现
         且内嵌恢复动作；与分区 loadError 同款「错误 + 恢复指引」呈现通路 -->
    <p
      v-if="exitError"
      data-testid="plan-banner-error"
      role="alert"
      class="w-full text-[length:var(--text-2xs)] text-danger"
    >
      {{ exitError }}
    </p>
    <!-- 首拉失败（分区 loadError，u1-store 错误通路）：view 不被覆盖，横幅照旧值显示，
         错误行提示状态可能过期 -->
    <p
      v-else-if="loadError"
      data-testid="plan-banner-load-error"
      role="alert"
      class="w-full text-[length:var(--text-2xs)] text-danger"
    >
      {{ loadError }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * PlanModeBanner —— 计划模式常驻横幅（G1：模式状态 GUI 可见）。
 *
 * 状态源：usePlanState（u1-store 交付的组件消费接口——view/阶段推导/分区 loadError），
 * 本组件只做呈现与退出命令，不持 plan 状态（单一状态源在 plan-store）。
 * 退出链路：command('session.abortPlan') → runtime ensureActive + client.prompt('/plan
 * abort') 直发（u1-rpc 侧）；reply success 检查 = promise reject 即失败（AGENTS.md 规则 5
 * 的 renderer 实态），失败呈现 E9 恢复指引、横幅保持原状；成功后 isActive=false 由投影
 * 链广播驱动（本组件不本地改状态）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SquareCheckBig, X } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { command, RPC_BACKSTOP_TIMEOUT_MS } from '@taiji/core/transport/api'
import { toErrorMessage } from '@taiji/core'
import { usePlanState } from '@/composables/use-plan-sync'

const props = defineProps<{
  /** 焦点 session（panel store 的 focusedSessionId；横幅只服务焦点 session，D1） */
  sessionId: string | null
}>()

const { t } = useI18n()

const sessionIdRef = computed(() => props.sessionId)
const { view, stage, loadError } = usePlanState(sessionIdRef)

/** 显示驱动（D5）：isActive 严格判定——无 view / isActive=false 都不渲染横幅 */
const isActive = computed(() => view.value?.isActive === true)

/**
 * 技能名只读文本（D4 降级契约）：有 skills 显示「a · b」，旧 entry 无字段 / 空数组
 * 显示「（未指定）」。
 */
const skillsText = computed(() => {
  const skills = view.value?.skills
  return skills && skills.length > 0 ? skills.join(' · ') : t('plan.banner.skillsUnspecified')
})

/** 三步阶段（顺序即推导序号；label 响应 i18n） */
const stageSteps = computed(() => [
  { stage: 'exploring' as const, label: t('plan.banner.stageExploring') },
  { stage: 'writing' as const, label: t('plan.banner.stageWriting') },
  { stage: 'reviewing' as const, label: t('plan.banner.stageReviewing') },
])

/** 步骤视觉态：当前（accent 高亮）/ 已完成（success 点）/ 未到（默认灰点） */
function stepStage(index: number): 'cur' | 'done' | 'todo' {
  const current = stageSteps.value.findIndex((s) => s.stage === stage.value)
  if (index === current) return 'cur'
  return index < current ? 'done' : 'todo'
}

// ── 退出（E9 错误通路）──
const exiting = ref(false)
const exitError = ref<string | null>(null)

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
    exitError.value = t('plan.banner.exitError', { message: toErrorMessage(e) })
  } finally {
    exiting.value = false
  }
}
</script>
