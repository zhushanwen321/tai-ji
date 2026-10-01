<!--
  Settings · 语音菜单页（ai-voice-tts 设计 §5.2；M0）。

  自上而下：通用配置（启用总开关）→ 服务商卡片单选（三家独立记忆）→ 选中服务商全量
  配置（TtsProviderForm，表单投影 TtsFormModel 驱动）→ 操作行（保存 / 保存并测试 /
  额度说明）。数据源：打开时并行拉 tts.getConfig + tts.getCapabilities（§7.5）；capabilities
  首载失败时表单区整体不渲染（投影枚举缺失无从渲染半态）+ 重试入口；已成功加载过投影
  后的重试失败保留禁用表单（已保存配置的 Key 状态点经 getConfig 始终可见）。
  「保存并测试」合成固定样句走 useTtsPlayer 的 settings-tts-test 通道（全局互斥，§7.5 要点 4）。
-->
<template>
  <div data-testid="tts-page" class="flex max-w-[860px] flex-col gap-3">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.tts') }}</h1>
        <p class="desc">{{ t('settings.menu.ttsDesc') }}</p>
      </div>
    </header>

    <!-- capabilities 拉取失败：表单禁用 + 重试（不渲染半态枚举，§7.5 TtsPage） -->
    <div
      v-if="capsFailed"
      data-testid="tts-caps-failed"
      class="flex items-center gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-neutral-fg"
    >
      <AlertTriangle class="size-4 shrink-0 text-warn" aria-hidden="true" />
      <span class="flex-1">{{ t('settings.tts.capsFailedHint') }}</span>
      <Button variant="secondary" size="dense" data-testid="tts-caps-retry" :disabled="loading" @click="reload">
        {{ t('settings.tts.retry') }}
      </Button>
    </div>

    <!-- 通用配置：启用语音朗读总开关 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.tts.enabledLabel') }}</h3>
          <p class="gc-sub">{{ t('settings.tts.enabledDesc') }}</p>
        </div>
      </template>
      <div class="flex items-center justify-between px-4 py-3">
        <Label class="text-[11px] text-neutral-dim" for="tts-enabled-switch">{{ t('settings.tts.enabledLabel') }}</Label>
        <Switch
          id="tts-enabled-switch"
          data-testid="tts-enabled-switch"
          :model-value="speechEnabled"
          @update:model-value="onToggleEnabled"
        />
      </div>
    </GroupCard>

    <!-- 服务商下拉单选（单选选中态由 Select 触发器直接可见；Key 状态点与协议形态标签随选中家展示） -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.tts.providerSection') }}</h3>
        </div>
      </template>
      <div class="flex flex-wrap items-center gap-3 px-4 py-3">
        <Select v-model="providerModel" :disabled="capsFailed">
          <SelectTrigger
            id="tts-provider-select"
            data-testid="tts-provider-select"
            class="h-8 w-[220px] text-[13px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="pid in PROVIDER_IDS"
              :key="pid"
              :value="pid"
              :data-testid="`tts-provider-option-${pid}`"
            >
              {{ t(`settings.tts.providerName.${pid}`) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <span
          data-testid="tts-provider-key-status"
          class="flex items-center gap-1.5 text-[12px]"
          :class="providerMeta(activeProvider).hasApiKey ? 'text-success' : 'text-neutral-dim'"
        >
          <span
            class="size-[7px] shrink-0 rounded-full"
            :class="providerMeta(activeProvider).hasApiKey ? 'bg-success' : 'bg-neutral-dim opacity-40'"
            aria-hidden="true"
          />
          {{ providerMeta(activeProvider).hasApiKey ? t('settings.tts.keyConfigured') : t('settings.tts.keyNotConfigured') }}
        </span>
        <span class="font-mono text-[10px] text-neutral-dim">{{ protocolLabel(activeProvider) }}</span>
      </div>
    </GroupCard>

    <!-- 选中服务商全量配置（表单投影驱动；capabilities 缺失时禁用；Key 展示态由页面状态机驱动） -->
    <TtsProviderForm
      v-if="activeForm && activeState"
      v-model:state="activeState"
      v-model:key-display="activeKeyDisplay"
      :provider-id="activeProvider"
      :form="activeForm"
      :has-api-key="providerMeta(activeProvider).hasApiKey"
      :provider-key-available="providerMeta(activeProvider).providerKeyAvailable"
      :key-op="keyOps[activeProvider]"
      :key-masked="keyMaskedOf(activeProvider)"
      :disabled="capsFailed"
      @clear-key="markKeyOp('clear')"
      @bring-key="markKeyOp('bring')"
      @key-blur="onKeyBlur(activeProvider)"
    />

    <!-- 操作行：额度说明（§5.2 第 5 点原文）+ 保存 / 保存并测试 -->
    <div class="flex items-end gap-2">
      <p class="flex-1 text-[11px] leading-relaxed text-neutral-dim">{{ t('settings.tts.quotaNote') }}</p>
      <Button variant="secondary" size="dense" data-testid="tts-save" :disabled="saving || capsFailed || !activeForm" @click="save">
        {{ t('settings.tts.save') }}
      </Button>
      <Button
        v-if="testState === 'idle'"
        size="dense"
        data-testid="tts-save-and-test"
        :disabled="saving || capsFailed || !activeForm"
        @click="saveAndTest"
      >
        {{ t('settings.tts.saveAndTest') }}
      </Button>
      <Button
        v-else-if="testState === 'loading'"
        variant="secondary"
        size="dense"
        data-testid="tts-test-loading"
        @click="player.stop()"
      >
        {{ t('settings.tts.testing') }}
      </Button>
      <Button v-else variant="secondary" size="dense" data-testid="tts-test-stop" @click="player.stop()">
        {{ t('settings.tts.stopTest') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { GroupCard } from '@taiji/ui/features/settings'
import { tts } from '@/api'
import { useToast } from '@/composables/useToast'
import { SETTINGS_TTS_TEST_MESSAGE_ID, useTtsPlayer } from '@/composables/features/chat/useTtsPlayer'
import TtsProviderForm from './TtsProviderForm.vue'
import { buildConfig, emptyFormState, formStateFromConfig, type TtsProviderFormState } from './tts-form-model'
import { useTtsSpeechEnabled } from './use-tts-enabled'
import type {
  SanitizedTtsConfig,
  TtsApiKeyInput,
  TtsFormModel,
  TtsProviderId,
} from '@taiji/shared'

const { t } = useI18n()
const { info: toastInfo, error: toastError } = useToast()
const player = useTtsPlayer()

/** 「保存并测试」固定样句（设计 §5.2 第 5 点）。 */
const TEST_SENTENCE = '你好，我是太极语音助手。'

/** 投影/配置的遍历序（卡片展示顺序；M0 三家固定）。 */
const PROVIDER_IDS: readonly TtsProviderId[] = ['stepfun', 'minimax', 'mimo']

type KeyOp = 'clear' | 'bring' | null

/** 已存 Key 的脱敏展示串（输入框值，非真实 Key——真实 Key 明文永不下发 renderer）。 */
const SAVED_KEY_MASK = '***'
/** 「带入」填充展示串长度（纯视觉占位宽度，不携带真实 Key 长度语义）。 */
const BRING_FILL_MASK_LENGTH = 12
/** 「带入」填充展示串（同样非真实 Key；保存时提交 'from-provider' 由 runtime 解析）。 */
const BRING_FILL_MASK = '*'.repeat(BRING_FILL_MASK_LENGTH)
/** 逐字动画步进间隔（清除 + 填充两相共用；总时长 ≈ (3+12)×18ms ≈ 270ms）。 */
const KEY_ANIM_STEP_MS = 18

const loading = ref(false)
const capsFailed = ref(false)
const configs = ref<SanitizedTtsConfig | null>(null)
const forms = ref<Record<TtsProviderId, TtsFormModel> | null>(null)
const activeProvider = ref<TtsProviderId>('minimax')
// 三家表单编辑态独立记忆（切服务商互不影响，§5.2 第 4 点）
const formStates = reactive<Record<TtsProviderId, TtsProviderFormState | null>>({
  stepfun: null,
  minimax: null,
  mimo: null,
})
// Key 展示态/输入/一次性动作是临时态（不落表单值；保存时组 apiKeys）：
// - keyDisplay：输入框展示值（明文新输入 / '***' 脱敏 / 带入填充串 / 清空）
// - keyInputs：用户真实键入串（'' = 未输入；仅 @input 写入，掩码剥离后）
// - keyOps：armed 动作（保存时消费；清除/带入是纯页面填充，落盘都走保存）
const keyInputs = reactive<Record<TtsProviderId, string>>({ stepfun: '', minimax: '', mimo: '' })
const keyOps = reactive<Record<TtsProviderId, KeyOp>>({ stepfun: null, minimax: null, mimo: null })
const keyDisplay = reactive<Record<TtsProviderId, string>>({ stepfun: '', minimax: '', mimo: '' })
const keyAnimToken = reactive<Record<TtsProviderId, number>>({ stepfun: 0, minimax: 0, mimo: 0 })
const saving = ref(false)

const { enabled: ttsEnabledRef, setEnabled } = useTtsSpeechEnabled()
const speechEnabled = computed(() => ttsEnabledRef.value)

const testState = computed(() => player.speakStateOf(SETTINGS_TTS_TEST_MESSAGE_ID))

const activeForm = computed(() => forms.value?.[activeProvider.value] ?? null)
const activeState = computed(() => formStates[activeProvider.value])
const activeKeyDisplay = computed({
  get: () => keyDisplay[activeProvider.value],
  set: (v: string) => {
    onKeyTyped(activeProvider.value, v)
  },
})

/** Select 桥（reka 回填 AcceptableValue；运行时判型收窄回 TtsProviderId）。 */
const providerModel = computed<TtsProviderId>({
  get: () => activeProvider.value,
  set: (v) => {
    if (typeof v === 'string' && (PROVIDER_IDS as readonly string[]).includes(v)) {
      activeProvider.value = v as TtsProviderId
    }
  },
})

function providerMeta(pid: TtsProviderId): { hasApiKey: boolean; providerKeyAvailable: boolean } {
  const p = configs.value?.providers[pid]
  return { hasApiKey: p?.hasApiKey === true, providerKeyAvailable: p?.providerKeyAvailable === true }
}

/** 协议形态标签（卡片第二行；投影 endpointPath + authHeader 组装，非硬编码文案）。 */
function protocolLabel(pid: TtsProviderId): string {
  const form = forms.value?.[pid]
  if (!form) return ''
  return `POST ${form.capabilities.endpointPath} · ${form.capabilities.authHeader}`
}

/**
 * 带入填充动画：逐字清空当前展示 → 逐字填满填充串（仅已存 Key 时有清空相）。
 * token 失配即中止（再次点击/键入/清除/保存/卸载都会使旧动画失效）。
 */
function animateBringFill(pid: TtsProviderId): void {
  const token = ++keyAnimToken[pid]
  void (async () => {
    const current = keyDisplay[pid]
    for (let i = current.length; i > 0; i--) {
      if (keyAnimToken[pid] !== token) return
      keyDisplay[pid] = current.slice(0, i - 1)
      await new Promise((r) => setTimeout(r, KEY_ANIM_STEP_MS))
    }
    for (let i = 1; i <= BRING_FILL_MASK.length; i++) {
      if (keyAnimToken[pid] !== token) return
      keyDisplay[pid] = BRING_FILL_MASK.slice(0, i)
      await new Promise((r) => setTimeout(r, KEY_ANIM_STEP_MS))
    }
  })()
}

function cancelBringAnim(pid: TtsProviderId): void {
  keyAnimToken[pid]++
}

onUnmounted(() => {
  for (const pid of PROVIDER_IDS) cancelBringAnim(pid)
})

/** 展示值是否为掩码态（非用户键入内容；聚焦时全选便于整体替换）。 */
function keyMaskedOf(pid: TtsProviderId): boolean {
  if (keyInputs[pid] !== '') return false
  const op = keyOps[pid]
  if (op === 'bring') return true
  if (op === 'clear') return false
  return providerMeta(pid).hasApiKey
}

/**
 * 用户键入（@input 唯一写入口）：展示态为掩码时剥离掩码残留只留新输入；
 * 键入 = 更新的意图，显式解除已 armed 的清除/带入并中止动画。
 * （v0.10.8 实测缺陷：残留输入串在 save() 里静默压过 armed 动作——从源头消除双意图并存）
 */
function onKeyTyped(pid: TtsProviderId, raw: string): void {
  cancelBringAnim(pid)
  let value = raw
  if (keyInputs[pid] === '') {
    const mask = keyOps[pid] === 'bring' ? BRING_FILL_MASK : SAVED_KEY_MASK
    value = value.split(mask).join('')
  }
  keyInputs[pid] = value
  keyOps[pid] = null
  keyDisplay[pid] = value
}

/** 失焦回填：键入被手工清空且无 armed 动作时，恢复已存 Key 脱敏展示。 */
function onKeyBlur(pid: TtsProviderId): void {
  if (keyInputs[pid] === '' && keyOps[pid] === null && providerMeta(pid).hasApiKey) {
    keyDisplay[pid] = SAVED_KEY_MASK
  }
}

/**
 * armed 动作标记（保存时消费；清除/带入只是页面填充，落盘统一走保存）：
 - 清除：展示清空（已存 Key 时 *** 消失；无 Key 本就不渲染按钮）；
 - 带入：已存 Key → 逐字清空+填满动画；无 Key → 直接填满；
 - 再次点击同动作 = 取消，恢复脱敏展示。
 */
function markKeyOp(op: Exclude<KeyOp, null>): void {
  const pid = activeProvider.value
  const next = keyOps[pid] === op ? null : op
  keyOps[pid] = next
  keyInputs[pid] = ''
  cancelBringAnim(pid)
  if (next === 'clear') {
    keyDisplay[pid] = ''
  } else if (next === 'bring') {
    if (providerMeta(pid).hasApiKey) animateBringFill(pid)
    else keyDisplay[pid] = BRING_FILL_MASK
  } else {
    keyDisplay[pid] = providerMeta(pid).hasApiKey ? SAVED_KEY_MASK : ''
  }
}

function onToggleEnabled(v: string | number | boolean | undefined): void {
  setEnabled(v === true)
}

/** 落盘配置 → 表单编辑态 + Key 展示态（只刷指定家：其他家未保存编辑态保留，独立记忆语义）。 */
function applyProviderConfig(pid: TtsProviderId, config: SanitizedTtsConfig): void {
  const form = forms.value?.[pid]
  if (!form) return
  formStates[pid] = formStateFromConfig(pid, form, config.providers[pid].config)
  // Key 展示态以保存结果为准（保存成功/首载回读统一走此入口）
  cancelBringAnim(pid)
  keyInputs[pid] = ''
  keyOps[pid] = null
  keyDisplay[pid] = config.providers[pid].hasApiKey === true ? SAVED_KEY_MASK : ''
}

/** 并行拉取配置投影与表单投影（独立数据源 allSettled，互不阻塞）。 */
async function reload(): Promise<void> {
  loading.value = true
  capsFailed.value = false
  const [configRes, capsRes] = await Promise.allSettled([tts.getConfig(), tts.getCapabilities()])
  if (capsRes.status === 'fulfilled') {
    forms.value = capsRes.value.forms
    if (!formStates[activeProvider.value]) {
      for (const pid of PROVIDER_IDS) formStates[pid] = emptyFormState(capsRes.value.forms[pid])
    }
  } else {
    capsFailed.value = true
  }
  if (configRes.status === 'fulfilled') {
    configs.value = configRes.value.config
    activeProvider.value = configRes.value.config.activeProvider
    if (forms.value) {
      for (const pid of PROVIDER_IDS) applyProviderConfig(pid, configRes.value.config)
    }
  } else {
    // 配置读取失败回默认骨架（可重新保存，§5.4 末行）；表单投影正常时静默骨架 + toast
    toastError(t('settings.tts.loadFailed'))
  }
  loading.value = false
}

/** 保存当前家：configure 整对象 + apiKeys（有输入才带；'from-provider' 仅在用户点了带入时）。
 *  返回回读配置（失败返回 null——调用方据此决定是否继续测试播放）。 */
async function save(): Promise<SanitizedTtsConfig | null> {
  const form = activeForm.value
  const state = activeState.value
  if (!form || !state || saving.value) return null
  saving.value = true
  try {
    const pid = activeProvider.value
    const apiKeys: Partial<Record<TtsProviderId, TtsApiKeyInput>> = {}
    const typed = keyInputs[pid].trim()
    const op = keyOps[pid]
    if (typed !== '') apiKeys[pid] = typed
    else if (op === 'clear') apiKeys[pid] = null
    else if (op === 'bring') apiKeys[pid] = 'from-provider'
    const res = await tts.configure({ providerId: pid, config: buildConfig(pid, form, state), apiKeys })
    if (!res.ok || !res.config) {
      toastError(res.error ?? t('settings.tts.saveFailed'))
      return null
    }
    configs.value = res.config
    applyProviderConfig(pid, res.config)
    toastInfo(t('settings.tts.savedToast'))
    return res.config
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
    return null
  } finally {
    saving.value = false
  }
}

/** 保存并测试：保存成功后合成固定样句（settings-tts-test 伪 id 参与全局互斥，§7.5 要点 4）。 */
async function saveAndTest(): Promise<void> {
  const saved = await save()
  if (saved === null) return
  player.speak(undefined, SETTINGS_TTS_TEST_MESSAGE_ID, TEST_SENTENCE)
}

onMounted(() => {
  void reload()
})
</script>
