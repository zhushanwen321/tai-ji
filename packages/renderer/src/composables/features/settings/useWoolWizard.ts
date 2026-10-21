/**
 * useWoolWizard —— 羊毛接入向导状态机（wool-provider D6 ①/D7 两族模板，renderer 侧）。
 *
 * 状态形态判定：向导状态是**一次打开的局部 UI 态**（同屏至多一个向导实例，随组件生命
 * 周期生灭），非 per-session 共享态也非设置域全局态——ADR-0049 Map 分区与模块级单例
 * 均不适用。本工厂是**纯状态机**（零 composable 副作用——不订阅、不挂 scope dispose），
 * 动作执行经 runAction 参数注入（调用方传 useWool().runAction）：可在任意时机构造
 * （事件处理器内同样安全），组件卸载即整体丢弃。
 *
 * 状态机（D7 两族模板，步骤序列由家族 credentialsSource 决定）：
 * - 提取族（ide-extract）：install → credentials（detect → 确认 → extract）→ done
 * - 授权族（oauth）：install → authorize → ready → checkin → done
 * 每步四态（pending/running/ok/failed）；failed 携 WoolStepFailureCode（失败路径表 §3.1
 * 恢复指引渲染分支）。
 *
 * 错误码映射：WoolActionErrorCode → WoolStepFailureCode（词表语义一一对应，
 * invalid_request 归 internal——renderer→runtime 契约层错误非用户可恢复态）。
 */
import { computed, reactive, readonly, ref, type ComputedRef, type Ref } from 'vue'
import type {
  WoolActionErrorCode,
  WoolActionReply,
  WoolActionRequest,
  WoolActionType,
  WoolFamilyId,
  WoolFamilyState,
  WoolStepFailureCode,
  WoolStepStatus,
  WoolWizardTemplate,
} from '@taiji/shared'

/** 向导步骤 id（两族并集；序列按模板取子集）。 */
export type WoolWizardStepId = 'install' | 'credentials' | 'authorize' | 'ready' | 'checkin' | 'done'

/** 单步执行态（failed 态携带失败码与原始 message）。 */
export type WoolWizardStepState = {
  status: WoolStepStatus
  failure?: { code: WoolStepFailureCode; message: string }
}

/** 动作执行通道（useWool().runAction 注入；测试可传桩）。 */
export type WoolWizardRunAction = (req: WoolActionRequest) => Promise<WoolActionReply>

/** 动作错误码 → 步骤失败码映射（词表对应关系 SSOT；两侧词表扩展时同批维护）。 */
export function actionErrorToStepFailure(code: WoolActionErrorCode): WoolStepFailureCode {
  switch (code) {
    case 'unreachable': return 'manifest_unreachable'
    case 'bad_shape': return 'manifest_bad_shape'
    case 'family_absent': return 'family_absent'
    case 'invalid_request': return 'internal'
    default: return code
  }
}

/** 提取族步骤序列（credentials = 检测/确认/提取合一，D7 模板语义）。 */
const EXTRACT_STEPS: readonly WoolWizardStepId[] = ['install', 'credentials', 'done']
/** 授权族步骤序列（设计 §3.1 五步）。 */
const OAUTH_STEPS: readonly WoolWizardStepId[] = ['install', 'authorize', 'ready', 'checkin', 'done']

function initialStates(): Record<WoolWizardStepId, WoolWizardStepState> {
  return {
    install: { status: 'pending' },
    credentials: { status: 'pending' },
    authorize: { status: 'pending' },
    ready: { status: 'pending' },
    checkin: { status: 'pending' },
    done: { status: 'pending' },
  }
}

/**
 * 单族接入向导状态机（WoolWizard 选定家族后构造；纯状态机，见文件头）。
 * @param family 目标家族 id（固定——向导一次只处理一个家族）
 * @param template 模板族（决定步骤序列）
 * @param runAction 动作通道（useWool().runAction 注入）
 */
export function useWoolWizard(family: WoolFamilyId, template: WoolWizardTemplate, runAction: WoolWizardRunAction): {
  steps: ComputedRef<readonly WoolWizardStepId[]>
  stepStates: Readonly<Record<WoolWizardStepId, WoolWizardStepState>>
  currentStep: ComputedRef<WoolWizardStepId>
  /** credentials 步的确认框待决态（detect 成功后置 true，确认/取消后复位）。 */
  extractConfirmPending: Ref<boolean>
  /** 完成步触发过目录刷新标记（防重复触发 refresh 动作）。 */
  catalogRefreshed: Ref<boolean>
  runStepAction: (step: WoolWizardStepId, action: WoolActionType, params?: WoolActionRequest['params']) => Promise<WoolActionReply>
  /** 步内多段编排的手动落步入口（detect 后置确认框/开关步直通等非单动作形态）。 */
  markStep: (step: WoolWizardStepId, status: WoolStepStatus) => void
  /** 步外动作失败的手动落败入口（startCredentials 的 detect 段等；code 为动作错误码）。 */
  failStep: (step: WoolWizardStepId, code: WoolActionErrorCode, message: string) => void
  reset: () => void
} {
  const steps = computed(() => (template === 'extract' ? EXTRACT_STEPS : OAUTH_STEPS))
  const states = reactive(initialStates())
  const extractConfirmPending = ref(false)
  const catalogRefreshed = ref(false)

  const currentStep = computed(() => {
    for (const step of steps.value) {
      if (states[step].status !== 'ok') return step
    }
    return steps.value[steps.value.length - 1]
  })

  function markStep(step: WoolWizardStepId, status: WoolStepStatus): void {
    states[step] = { status }
  }

  function failStep(step: WoolWizardStepId, code: WoolActionErrorCode, message: string): void {
    states[step] = { status: 'failed', failure: { code: actionErrorToStepFailure(code), message } }
  }

  /**
   * 执行步骤动作：running → 动作 → ok/failed（错误码映射进步骤失败态）。
   * reply 原样返回（调用方需要 data 时自行消费）。
   */
  async function runStepAction(
    step: WoolWizardStepId,
    action: WoolActionType,
    params?: WoolActionRequest['params'],
  ): Promise<WoolActionReply> {
    states[step] = { status: 'running' }
    const reply = await runAction({ action, family, ...(params !== undefined ? { params } : {}) })
    if (reply.ok) {
      states[step] = { status: 'ok' }
    } else {
      failStep(step, reply.error.code, reply.error.message)
    }
    return reply
  }

  function reset(): void {
    Object.assign(states, initialStates())
    extractConfirmPending.value = false
    catalogRefreshed.value = false
  }

  return {
    steps,
    stepStates: readonly(states),
    currentStep,
    extractConfirmPending,
    catalogRefreshed,
    runStepAction,
    markStep,
    failStep,
    reset,
  }
}

/** 家族快照 → 向导模板族（credentialsSource 决定，D7；未拉到快照时缺省 extract）。 */
export function woolTemplateOf(state: WoolFamilyState | undefined): WoolWizardTemplate {
  return state?.credentialsSource === 'oauth' ? 'oauth' : 'extract'
}
