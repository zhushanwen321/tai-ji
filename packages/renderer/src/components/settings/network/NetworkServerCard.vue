<template>
  <!-- 代理服务器卡（llm-network-proxy §3.1 卡 1）：卡头总开关 + 协议/地址/端口/认证/noProxy
       纵排 SettingRow（settings 域现行惯例，demo 单行三字段的紧凑布局让位一致性）+
       底部测试结果行（runtime 两段探测归因文案 + 耗时，三态）+ 测试连接 + 保存。
       草稿经 defineModel 双向（TtsProviderForm v-model:state 同型）；保存编排归
       NetworkPage（单页单保存语义：本卡「保存」作用于整页草稿）。 -->
  <GroupCard>
    <template #head>
      <div class="gc-head-text">
        <h3 class="gc-title">{{ t('settings.network.serverCard') }}</h3>
        <p class="gc-sub">{{ t('settings.network.serverCardDesc') }}</p>
      </div>
    </template>
    <template #actions>
      <div class="flex items-center gap-2">
        <span class="text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.network.enabled') }}</span>
        <Switch
          data-testid="network-enabled-switch"
          :model-value="draft.enabled"
          @update:model-value="draft.enabled = $event === true"
        />
      </div>
    </template>

    <div class="px-[10px] pt-[4px] pb-[8px]" data-testid="network-server-card">
      <SettingRow :label="t('settings.network.protocol')">
        <Select v-model="protocolModel" class="w-[140px]" data-testid="network-protocol-select">
          <SelectTrigger data-testid="network-protocol-trigger" class="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="p in NETWORK_PROXY_PROTOCOLS" :key="p" :value="p" :data-testid="`network-protocol-option-${p}`">
              {{ p }}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow :label="t('settings.network.host')">
        <Input
          v-model="draft.host"
          data-testid="network-host-input"
          class="max-w-[360px]"
          autocomplete="off"
        />
      </SettingRow>
      <SettingRow :label="t('settings.network.port')">
        <Input
          v-model="portDraft"
          data-testid="network-port-input"
          type="number"
          :min="1"
          :max="65535"
          :step="1"
          class="w-[120px]"
        />
      </SettingRow>
      <SettingRow :label="t('settings.network.username')" :desc="t('settings.network.authPairHint')">
        <Input
          v-model="draft.username"
          data-testid="network-username-input"
          class="max-w-[360px]"
          :placeholder="t('settings.network.usernamePlaceholder')"
          autocomplete="off"
        />
      </SettingRow>
      <SettingRow :label="t('settings.network.password')">
        <Input
          v-model="draft.password"
          data-testid="network-password-input"
          type="password"
          class="max-w-[360px]"
          autocomplete="new-password"
        />
      </SettingRow>
      <SettingRow :label="t('settings.network.noProxy')" :desc="t('settings.network.noProxyHint')">
        <Input
          v-model="draft.noProxyInput"
          data-testid="network-noproxy-input"
          class="max-w-[360px]"
          autocomplete="off"
        />
      </SettingRow>

      <!-- 测试结果行（三态：idle 不渲染 / testing / done 归因文案+耗时；ok 绿 err 红）。
           message = runtime 两段探测的归因文案（含恢复指引），本组件不自造文案。 -->
      <div class="flex min-h-[44px] items-center gap-[12px] border-t border-hairline px-[6px] py-[10px]">
        <span
          v-if="testState === 'testing'"
          class="text-[length:var(--text-sm)] text-neutral-mid"
          data-testid="network-test-testing"
          role="status"
        >{{ t('settings.network.testing') }}</span>
        <span
          v-else-if="testResult"
          class="min-w-0 flex-1 text-[length:var(--text-sm)]"
          :class="testResult.ok ? 'text-success' : 'text-danger'"
          data-testid="network-test-result"
          role="status"
        >{{ testResult.message }}（{{ t('settings.network.testElapsed', { ms: testResult.elapsedMs }) }}）</span>
        <span v-else class="min-w-0 flex-1"></span>
        <Button
          variant="secondary"
          size="sm"
          class="h-[32px] px-[12px] text-[length:var(--text-sm)]"
          data-testid="network-test-btn"
          :disabled="testState === 'testing'"
          @click="onTest"
        >
          {{ t('settings.network.testConnection') }}
        </Button>
        <Button
          size="sm"
          class="h-[32px] px-[12px] text-[length:var(--text-sm)]"
          data-testid="network-save-btn"
          :disabled="saving"
          @click="emit('save')"
        >
          {{ t('settings.network.save') }}
        </Button>
      </div>
    </div>
  </GroupCard>
</template>

<script setup lang="ts">
/**
 * 代理服务器卡：草稿字段编辑 + 测试连接（transport.testNetworkProxy，测当前草稿）。
 * 保存动作经 save 事件上抛 NetworkPage（草稿是页面级，规则卡字段一并保存——单页单保存）。
 * 测试前先走 shared 校验（fail fast：端口/凭据成对坏值不发 RPC，错误文案含修复动作）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { GroupCard } from '@taiji/ui/features/settings'
import SettingRow from '../SettingRow.vue'
import { getSettingsTransport } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import { NETWORK_PROXY_PROTOCOLS, validateNetworkProxyConfig, type NetworkProxyTestResult } from '@taiji/shared'
import { buildConfigFromDraft, type NetworkProxyDraft } from './network-page-model'

// [C3] settings 域 transport 只经 SettingsTransport seam
const transport = getSettingsTransport()

const { t } = useI18n()
const { error: toastError } = useToast()

const draft = defineModel<NetworkProxyDraft>('draft', { required: true })
defineProps<{ /** 保存中（由 page 的 createExplicitSave.saving 透传，防重入） */ saving: boolean }>()
const emit = defineEmits<{ save: [] }>()

/** 端口草稿边界（draft 契约 = port 字符串承载，network-page-model 头注）：type=number 透传到
 * 原生 input 后，Vue 内建 v-model 对 number 输入经 looseToNumber 产出数字——边界处还原
 * 字符串，保存/测试的 Number 化仍由 buildConfigFromDraft + shared 校验统一承担。 */
const portDraft = computed<string>({
  get: () => draft.value.port,
  set: (v) => {
    draft.value.port = String(v)
  },
})

/** 协议 Select 桥（reka 回填 AcceptableValue；运行时判型收窄回 NetworkProxyProtocol，TtsPage 同款）。 */
const protocolModel = computed<NetworkProxyDraft['protocol']>({
  get: () => draft.value.protocol,
  set: (v) => {
    if (typeof v === 'string' && (NETWORK_PROXY_PROTOCOLS as readonly string[]).includes(v)) {
      draft.value.protocol = v as NetworkProxyDraft['protocol']
    }
  },
})

const testState = ref<'idle' | 'testing' | 'done'>('idle')
const testResult = ref<NetworkProxyTestResult | null>(null)

/** 测试连接：草稿即被测配置（未保存的编辑也在测——所见即所测）；校验失败不发 RPC。 */
async function onTest(): Promise<void> {
  if (testState.value === 'testing') return
  const config = buildConfigFromDraft(draft.value)
  const res = validateNetworkProxyConfig(config)
  if (!res.ok) {
    toastError(res.errors[0])
    return
  }
  testState.value = 'testing'
  testResult.value = null
  try {
    testResult.value = await transport.testNetworkProxy(config)
    testState.value = 'done'
  } catch (e) {
    testState.value = 'idle'
    toastError(t('settings.network.testFailed'))
    console.warn('[NetworkServerCard] testNetworkProxy failed:', e)
  }
}
</script>
