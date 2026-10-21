<template>
  <!--
    羊毛向导弹层（D6 ①：ProviderPage「添加 Provider」→「羊毛 provider」入口打开）。
    两相：family（家族选择，三卡+检测徽标+风险行）↔ flow（选定家族的步骤区——按
    credentialsSource 渲染提取族/授权族模板，D7）。编排（步骤推进/动作触发/确认框
    决策）在本组件；步骤渲染在 WoolExtractFlow / WoolOauthFlow；状态机在
    useWoolWizard（纯状态机工厂）；快照数据在 useWool。
  -->
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-[440px]">
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
        :catalog-loading="catalogLoading"
        :catalog-count="catalogCount"
        @retry-install="runInstallStep"
        @retry-authorize="runAuthorizeStep"
        @retry-ready="runReadyStep"
        @authorize="runAuthorizeStep"
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
 * - 提取族：install ok → credentials（detect → 确认框 → extract → status 后台拉）
 * - 授权族：install ok → authorize（按钮触发）→ ready（status）→ checkin（开关交互态）
 * - done：catalog refresh（一次）+ 目录计数；完成钮关闭
 * 中途关闭（授权待决态）零本地持久化——恢复靠快照（wool.state）重新呈现。
 */
import { computed, shallowRef, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@taiji/ui'
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

// 打开时复位相 + 检测（每次打开重新检测——凭据文件可能已变化，D3 存在性检查语义）。
watch(() => props.open, (open) => {
  if (!open) return
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
  void runInstallStep()
}

function backToFamily(): void {
  phase.value = 'family'
  selected.value = null
  wizard.value = null
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

/** 确认框「提取」→ extract 动作（成功即凭据入库 + adopted 置位）→ status 后台 → done。 */
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

/** 授权族 authorize 步（按钮/重试共用；成功 → ready）。 */
async function runAuthorizeStep(): Promise<void> {
  const w = wizard.value
  if (!w || !selected.value) return
  await w.runStepAction('authorize', 'authorize')
  if (w.stepStates.authorize.status === 'ok') void runReadyStep()
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
