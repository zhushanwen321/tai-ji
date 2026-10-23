<template>
  <!--
    羊毛向导弹层（D6 ①：ProviderPage「添加 Provider」→「羊毛 provider」入口打开）。
    两相：family（家族选择，三卡+检测徽标+风险行）↔ flow（选定家族的步骤区——按
    credentialsSource 渲染提取族/授权族模板，D7）。编排（步骤推进/动作触发/确认框
    决策）在本组件；步骤渲染在 WoolExtractFlow / WoolOauthFlow；状态机在
    useWoolWizard（纯状态机工厂）；快照数据在 useWool。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-[440px]" @interact-outside="onInteractOutside">
      <DialogHeader>
        <DialogTitle data-testid="wool-wizard-title">
          {{ phase === 'family' || !selectedFamily ? t('wool.menuLabel') : selectedFamily.displayName }}
        </DialogTitle>
      </DialogHeader>

      <!-- 相 1：家族选择（打开时对 ide-extract 家族做一次存在性检测——D3） -->
      <WoolFamilyCards v-if="phase === 'family'" :families="families" @select="onFamilySelect" />

      <!-- 相 2：步骤区（模板族已定；detect/账号/目录数据读快照实时值） -->
      <WoolExtractFlow
        v-else-if="wizard && selectedFamily && template === 'extract'"
        :display-name="selectedFamily.displayName"
        :step-states="wizard.stepStates"
        :current-step="wizard.currentStep.value"
        :extract-confirm-pending="wizard.extractConfirmPending.value"
        :detect="selectedFamily.detect"
        :catalog-loading="catalogLoading"
        :catalog-count="catalogCount"
        @retry-install="runInstallStep"
        @retry-credentials="startCredentialsStep"
        @confirm-extract="onConfirmExtract"
        @cancel-extract="cancelExtract"
      />
      <WoolOauthFlow
        v-else-if="wizard && selectedFamily"
        :display-name="selectedFamily.displayName"
        :step-states="wizard.stepStates"
        :current-step="wizard.currentStep.value"
        :account="selectedFamily.account"
        :auto-checkin="selectedFamily.autoCheckin"
        :authorize-url-opened="authorizeUrlOpened"
        :authorize-signaling="authorizeSignaling"
        :authorize-retry-hint="authorizeRetryHint"
        :catalog-loading="catalogLoading"
        :catalog-count="catalogCount"
        @retry-install="runInstallStep"
        @retry-authorize="runAuthorizeStep"
        @retry-ready="runReadyStep"
        @authorize="runAuthorizeStep"
        @authorize-done="onAuthorizeDone"
        @authorize-cancel="onAuthorizeCancel"
        @set-auto-checkin="onSetAutoCheckin"
      />

      <div class="flex items-center justify-end gap-2">
        <Button
          v-if="phase === 'family'"
          variant="ghost"
          data-testid="wool-wizard-cancel"
          @click="emit('update:open', false)"
        >{{ t('wool.cancel') }}</Button>
        <template v-else>
          <Button variant="ghost" data-testid="wool-wizard-back" @click="backToFamily">{{ t('wool.cancel') }}</Button>
          <Button
            v-if="wizard && wizard.currentStep.value === 'done' && wizard.stepStates.done.status === 'ok'"
            variant="default"
            data-testid="wool-wizard-finish"
            @click="emit('update:open', false)"
          >{{ t('wool.finish') }}</Button>
        </template>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * 向导编排（状态机驱动；组件相 = family ↔ flow）：
 * - 打开：拉快照 + ide-extract 家族各发一次 detect（存在性检查，徽标数据源）
 * - 选家族：构造 useWoolWizard 状态机（shallowRef 持有，选家族时重建）→ install 自动执行
 * - 提取族：install ok → credentials（detect → 确认框 → extract）→ status 后台拉 → done
 * - 授权族：install ok → authorize（按钮触发；授权窗内订阅 wool.authorize_url →
 *   浮层浏览器打开授权页，done/cancel 信号驱动扩展侧回调，凭据回传即落步）→ ready（status）→ checkin → done
 * - done：catalog refresh（一次）+ 目录计数；完成钮关闭
 * 中途关闭（授权待决态）零本地持久化——恢复靠快照（wool.state）重新呈现；
 * 关闭不撤销在途 authorize（runtime 授权窗有界回收，重开可等完成或重新授权）。
 */
import { computed, shallowRef, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@taiji/ui'
import { openBrowser } from '@taiji/core/domain/overlay'
import { getSettingsTransport } from '@taiji/core'
import type { WoolFamilyId } from '@taiji/shared'
import { useWool } from '@/composables/features/settings/useWool'
import { useWoolWizard, woolTemplateOf } from '@/composables/features/settings/useWoolWizard'
import WoolFamilyCards from './WoolFamilyCards.vue'
import WoolExtractFlow from './WoolExtractFlow.vue'
import WoolOauthFlow from './WoolOauthFlow.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const { t } = useI18n()
const wool = useWool()

/** 当前相（family = 家族选择；flow = 步骤区）。 */
const phase = ref<'family' | 'flow'>('family')
const selected = ref<WoolFamilyId | null>(null)

const families = computed(() => wool.families.value)
const selectedFamily = computed(() => (selected.value !== null ? wool.familyOf(selected.value) : undefined))
const template = computed(() => woolTemplateOf(selectedFamily.value))

/** 向导状态机实例（shallowRef：事件处理器内构造/重建——纯状态机无 scope 依赖）。 */
const wizard = shallowRef<ReturnType<typeof useWoolWizard> | null>(null)

/** 完成步目录刷新状态（loading → count；null = 未触发）。 */
const catalogLoading = ref(false)
const catalogCount = ref<number | null>(null)

/** 授权页浮层浏览器的合成会话键（WebContentsView key；非真会话 id——授权页无会话归属）。 */
const WOOL_OAUTH_OVERLAY_SID = 'wool-oauth'
/** 授权 URL 订阅取消函数（authorize 编排期间挂载；back/close/完成时解除）。 */
let unsubscribeAuthorizeUrl: (() => void) | null = null
/** 授权页已打开标记（authorize running 态「授权页已打开」提示行数据源）。 */
const authorizeUrlOpened = ref(false)
/** 授权确认信号在途（done/cancel 按钮 disabled 判定）。 */
const authorizeSignaling = ref(false)
/** done 信号回 202（浏览器内尚未完成登录）提示行。 */
const authorizeRetryHint = ref(false)

/** 订阅授权 URL 广播（授权族进入 flow 相时挂载；URL 到达 → 浮层浏览器打开）。 */
function subscribeAuthorizeUrl(family: WoolFamilyId): void {
  teardownAuthorizeUrl()
  unsubscribeAuthorizeUrl = getSettingsTransport().onWoolAuthorizeUrl((payload) => {
    if (payload.family !== family) return
    authorizeUrlOpened.value = true
    openBrowser(payload.url, WOOL_OAUTH_OVERLAY_SID)
  })
}

function teardownAuthorizeUrl(): void {
  unsubscribeAuthorizeUrl?.()
  unsubscribeAuthorizeUrl = null
  authorizeUrlOpened.value = false
  authorizeRetryHint.value = false
  authorizeSignaling.value = false
}

// 打开时复位相 + 检测（每次打开重新检测——凭据文件可能已变化，D3 存在性检查语义）。
watch(() => props.open, (open) => {
  if (!open) {
    teardownAuthorizeUrl()
    return
  }
  phase.value = 'family'
  selected.value = null
  wizard.value = null
  catalogLoading.value = false
  catalogCount.value = null
  for (const f of wool.families.value) {
    if (f.credentialsSource === 'ide-extract') void wool.runAction({ action: 'detect', family: f.family })
  }
})

function onFamilySelect(family: WoolFamilyId): void {
  selected.value = family
  phase.value = 'flow'
  wizard.value = useWoolWizard(family, template.value, wool.runAction)
  // 授权族：authorize URL 广播在授权窗内随时到达（扩展发 URL 先于动作回执），进相即订阅。
  if (template.value === 'oauth') subscribeAuthorizeUrl(family)
  void runInstallStep()
}

/**
 * 层外交互守卫（interact-outside 同时承接 reka DismissableLayer 的两条关闭判定：
 * pointerdown 层外 + focusin 层外——按 originalEvent 类型分流）：
 * - focusin 通道一律不关：多步向导期间「真实焦点离开向导层」全是程序性/浮层联动
 *   （授权浮层开合、关闭浮层时焦点归还 composer），不构成「用户想离开」——曾致
 *   授权进行中的向导被焦点转移连带关掉（2026-10-22 排查定性）。
 * - pointerdown 通道三类例外不关：授权浮层（wfvz-overlay，z-dialog 高于本层——
 *   浮层是全局工作层，点它不是「点向导外面」）、Toast 通知（独立层，非阻塞通知
 *   点击不该中断向导）、授权等待态（authorize 步 running 或授权页已开——授权流程
 *   中向导锁定，只认取消/Esc 关闭）。其余层外点击（设置页空白处）保留标准关闭。
 */
function onInteractOutside(e: Event): void {
  const original = (e as CustomEvent<{ originalEvent?: Event }>).detail?.originalEvent
  if (original instanceof FocusEvent) {
    e.preventDefault()
    return
  }
  const target = e.target as Element | null
  if (target?.closest('[data-testid="wfvz-overlay"]') || target?.closest('[data-testid="toast-container"]')) {
    e.preventDefault()
    return
  }
  const authorizeActive = authorizeUrlOpened.value || wizard.value?.stepStates.authorize?.status === 'running'
  if (template.value === 'oauth' && authorizeActive) e.preventDefault()
}

function backToFamily(): void {
  phase.value = 'family'
  selected.value = null
  wizard.value = null
  teardownAuthorizeUrl()
}

function cancelExtract(): void {
  if (wizard.value) wizard.value.extractConfirmPending.value = false
}

/** install 步（首次与重试共用；清单失败在此步呈现阻断态）。 */
async function runInstallStep(): Promise<void> {
  const w = wizard.value
  if (!w || !selected.value) return
  await w.runStepAction('install', 'install')
  if (w.stepStates.install.status === 'ok') {
    if (template.value === 'extract') void startCredentialsStep()
    // oauth 族：authorize 步等用户点授权按钮（不自动）
  }
}

/** credentials 步：detect → 确认框待决（检测失败落 failed）。 */
async function startCredentialsStep(): Promise<void> {
  const w = wizard.value
  if (!w || !selected.value) return
  w.markStep('credentials', 'running')
  const detectReply = await wool.runAction({ action: 'detect', family: selected.value })
  if (!detectReply.ok) {
    w.failStep('credentials', detectReply.error.code, detectReply.error.message)
    return
  }
  w.extractConfirmPending.value = true
}

/** 确认框「提取」→ extract 动作（runtime 凭据回传落 models.json + adopted 置位）→ status 后台 → done。 */
async function onConfirmExtract(): Promise<void> {
  const w = wizard.value
  if (!w || !selected.value) return
  w.extractConfirmPending.value = false
  const extractReply = await w.runStepAction('credentials', 'extract')
  if (extractReply.ok) {
    // 凭据就绪拉一次账号状态（后台；失败不阻断——done 步目录加载是主链）
    void wool.runAction({ action: 'status', family: selected.value })
    void runDoneStep()
  }
}

/** 授权族 authorize 步（按钮/重试共用）：authorize 动作挂起至用户完成授权（授权窗内 URL 广播开浮层
 *  + done/cancel 信号交互）；成功 → ready；cancelled → 回待授权态（§3.1 授权取消停待授权态）。 */
async function runAuthorizeStep(): Promise<void> {
  const w = wizard.value
  if (!w || !selected.value) return
  await w.runStepAction('authorize', 'authorize')
  if (w.stepStates.authorize.status === 'ok') {
    // 授权完成（凭据已落库）——URL 订阅使命结束，解除。
    teardownAuthorizeUrl()
    void runReadyStep()
    return
  }
  if (w.stepStates.authorize.status === 'failed' && w.stepStates.authorize.failure?.code === 'cancelled') {
    // 取消终态：回待授权态（非失败呈现；用户可重新点授权按钮）。
    teardownAuthorizeUrl()
    w.markStep('authorize', 'pending')
  }
}

/** done 信号（「我已完成授权」按钮）：runtime 向扩展本机回调端点发确认——202 = 浏览器内
 * 尚未完成登录（提示行 + 可再点），200 = 交换完成（authorize 动作回执随后落步）。 */
async function onAuthorizeDone(): Promise<void> {
  if (!selected.value || authorizeSignaling.value) return
  authorizeSignaling.value = true
  try {
    const reply = await wool.runAction({ action: 'authorizeSignal', family: selected.value, params: { status: 'done' } })
    authorizeRetryHint.value = reply.ok && reply.data !== null && typeof reply.data === 'object'
      && (reply.data as { completed?: unknown }).completed === false
  } finally {
    authorizeSignaling.value = false
  }
}

/** cancel 信号（「取消授权」按钮）：扩展侧取消终态 → authorize 动作回 cancelled → 步骤回待授权态。 */
async function onAuthorizeCancel(): Promise<void> {
  if (!selected.value || authorizeSignaling.value) return
  authorizeSignaling.value = true
  try {
    await wool.runAction({ action: 'authorizeSignal', family: selected.value, params: { status: 'cancel' } })
  } finally {
    authorizeSignaling.value = false
  }
}

/** ready 步：status 动作（账号昵称/有效期就绪即过步；checkin 步为开关交互态直通）。 */
async function runReadyStep(): Promise<void> {
  const w = wizard.value
  if (!w || !selected.value) return
  await w.runStepAction('ready', 'status')
  if (w.stepStates.ready.status === 'ok') {
    w.markStep('checkin', 'ok')
    void runDoneStep()
  }
}

/** 签到开关（taiji 侧 settings 写，无编排会话；立即生效）。 */
async function onSetAutoCheckin(enabled: boolean): Promise<void> {
  if (!selected.value) return
  await wool.runAction({ action: 'setAutoCheckin', family: selected.value, params: { enabled } })
}

/** done 步：目录刷新（一次）→ 计数落位 → ok。 */
async function runDoneStep(): Promise<void> {
  const w = wizard.value
  if (!w || !selected.value) return
  if (w.catalogRefreshed.value) {
    w.markStep('done', 'ok')
    return
  }
  w.catalogRefreshed.value = true
  w.markStep('done', 'running')
  catalogLoading.value = true
  const reply = await wool.runAction({ action: 'refresh', family: selected.value })
  catalogLoading.value = false
  const count = wool.familyOf(selected.value)?.catalog?.models.length
  catalogCount.value = typeof count === 'number' ? count : null
  w.markStep('done', reply.ok ? 'ok' : 'failed')
}
</script>
