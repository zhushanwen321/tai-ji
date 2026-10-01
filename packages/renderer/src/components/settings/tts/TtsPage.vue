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

    <!-- 选中服务商全量配置（表单投影驱动；capabilities 缺失时禁用；keyOp 供动作按钮 armed 态展示） -->
    <TtsProviderForm
      v-if="activeForm && activeState"
      v-model:state="activeState"
      v-model:key-input="activeKeyInput"
      :provider-id="activeProvider"
      :form="activeForm"
      :has-api-key="providerMeta(activeProvider).hasApiKey"
      :provider-key-available="providerMeta(activeProvider).providerKeyAvailable"
      :key-op="keyOps[activeProvider]"
      :disabled="capsFailed"
      @clear-key="markKeyOp('clear')"
      @bring-key="markKeyOp('bring')"
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
import { computed, onMounted, reactive, ref } from 'vue'
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
// Key 输入/一次性动作是临时态（不落表单值；保存时组 apiKeys）
const keyInputs = reactive<Record<TtsProviderId, string>>({ stepfun: '', minimax: '', mimo: '' })
const keyOps = reactive<Record<TtsProviderId, KeyOp>>({ stepfun: null, minimax: null, mimo: null })
const saving = ref(false)

const { enabled: ttsEnabledRef, setEnabled } = useTtsSpeechEnabled()
const speechEnabled = computed(() => ttsEnabledRef.value)

const testState = computed(() => player.speakStateOf(SETTINGS_TTS_TEST_MESSAGE_ID))

const activeForm = computed(() => forms.value?.[activeProvider.value] ?? null)
const activeState = computed(() => formStates[activeProvider.value])
const activeKeyInput = computed({
  get: () => keyInputs[activeProvider.value],
  set: (v: string) => {
    keyInputs[activeProvider.value] = v
    // 输入新值 = 更新的意图：显式解除已 armed 的清除/带入。
    // （v0.10.8 实测缺陷：残留输入串在 save() 里静默压过 armed 动作，
    //  「带入」点了却把旧粘贴串原样再存一遍——此处从源头消除双意图并存）
    if (v.trim() !== '') keyOps[activeProvider.value] = null
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
 * armed 动作标记（保存时消费）。armed 时清空残留输入：手动输入与动作互斥，
 * 杜绝「输入框残留串静默压过动作」的实测缺陷；再次点击同动作 = 取消。
 */
function markKeyOp(op: Exclude<KeyOp, null>): void {
  const pid = activeProvider.value
  const next = keyOps[pid] === op ? null : op
  keyOps[pid] = next
  if (next !== null) keyInputs[pid] = ''
}

function onToggleEnabled(v: string | number | boolean | undefined): void {
  setEnabled(v === true)
}

/** 落盘配置 → 表单编辑态（只刷指定家：其他家未保存编辑态保留，独立记忆语义）。 */
function applyProviderConfig(pid: TtsProviderId, config: SanitizedTtsConfig): void {
  const form = forms.value?.[pid]
  if (!form) return
  formStates[pid] = formStateFromConfig(pid, form, config.providers[pid].config)
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
    keyInputs[pid] = ''
    keyOps[pid] = null
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
