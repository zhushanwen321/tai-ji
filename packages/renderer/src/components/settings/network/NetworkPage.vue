<template>
  <!-- Settings · 网络代理菜单页（llm-network-proxy U4）：单页纵排三卡（§3.3 决策 6 变体一）。
       保存语义 = 单页单保存（§3.1）：三卡编辑进页面级内存草稿，代理服务器卡「保存」一次
       全量 setNetworkProxyConfig 整页草稿；开关关闭时规则卡降灰禁交互（统计卡观测与开关正交）。 -->
  <div data-testid="network-page" class="flex flex-col">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.networkProxy') }}</h1>
        <p class="desc">{{ t('settings.menu.networkProxyDesc') }}</p>
      </div>
    </header>

    <!-- 单向传引用：子卡只 mutate 草稿内容（字段赋值/数组增删），从不整体替换——
         不用 v-model:draft（reactive 对象整体重赋值无生产路径，仅余编译器 let 降级警告） -->
    <NetworkServerCard :draft="draft" :saving="saving" @save="onSave" />

    <!-- 开关关闭仅降灰规则卡（demo data-disabled 形态：opacity + pointer-events 收敛，
         关键控件再绑 disabled 键盘路径同闭——禁用态编辑规则无意义）；统计卡读侧观测与
         enabled 正交（§3.1 卡 3 / 设计目标 3），不随开关降灰。间距 16px 与 GroupCard 兄弟规则等值 -->
    <div class="mt-[var(--space-4)] flex flex-col gap-[var(--space-4)]" data-testid="network-lower-cards">
      <div :class="{ 'pointer-events-none opacity-50': !draft.enabled }" data-testid="network-rules-dim">
        <NetworkRulesCard :rules="draft.rules" :enabled="draft.enabled" :providers="providers" />
      </div>
      <NetworkStatsCard :providers="providers" />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 网络代理页编排（数据层 = SettingsTransport seam，[C3]）：
 * - 加载：onMounted 拉 getNetworkProxyConfig 回填草稿 + listProviders 取 chips/反查数据源
 *   （SystemLlmRetrySection best-effort 先例：加载失败保默认值，console.warn 不打扰）。
 * - 订阅：onNetworkProxyConfig 广播多窗口同步；草稿脏（与最近加载基准不等）时跳过覆盖
 *   ——单页草稿下不丢用户输入；自保存回声与基准同值，幂等。
 * - 保存：shared validateNetworkProxyConfig 前置校验（fail fast 不发 RPC）→
 *   createExplicitSave（saving 防重入 + 成功/失败 toast）；失败回滚草稿到最近加载基准
 *   （回滚锚点 = loadedConfig，同 setting-field createSettingFieldGroup 的基准语义）。
 */
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import NetworkServerCard from './NetworkServerCard.vue'
import NetworkRulesCard from './NetworkRulesCard.vue'
import NetworkStatsCard from './NetworkStatsCard.vue'
import { getSettingsTransport } from '@taiji/core'
import { createExplicitSave } from '@/composables/features/settings/setting-field'
import { useToast } from '@/composables/useToast'
import {
  DEFAULT_NETWORK_PROXY_CONFIG,
  validateNetworkProxyConfig,
  type NetworkProxyConfig,
  type ProviderInfo,
} from '@taiji/shared'
import { buildConfigFromDraft, draftFromConfig, type NetworkProxyDraft } from './network-page-model'

// [C3] settings 域 transport 只经 SettingsTransport seam（禁直连门面 / 禁深 import transport 域）
const transport = getSettingsTransport()

const { t } = useI18n()
const { error: toastError } = useToast()

const draft = reactive<NetworkProxyDraft>(draftFromConfig(DEFAULT_NETWORK_PROXY_CONFIG))
const providers = ref<ProviderInfo[]>([])
/** 最近加载基准（回滚锚点 + 广播脏判别基准；null = 尚未成功加载）。 */
let loadedConfig: NetworkProxyConfig | null = null

function applyLoaded(config: NetworkProxyConfig): void {
  loadedConfig = config
  Object.assign(draft, draftFromConfig(config))
}

/** 草稿是否脏（组装归一后与基准比较——输入形态差异已被 buildConfigFromDraft 消除）。 */
function isDirty(): boolean {
  if (loadedConfig === null) return false
  return JSON.stringify(buildConfigFromDraft(draft)) !== JSON.stringify(loadedConfig)
}

let unsubscribe: (() => void) | null = null

onMounted(async () => {
  unsubscribe = transport.onNetworkProxyConfig((config) => {
    // 草稿脏时广播不覆盖（另一窗口保存不冲掉本窗口未保存编辑）；干净时 apply 幂等刷新
    if (isDirty()) return
    applyLoaded(config)
  })
  try {
    const reply = await transport.getNetworkProxyConfig()
    applyLoaded(reply.config)
  } catch (e) {
    // best-effort：加载失败保持默认值（保存时以输入为准），不打扰用户
    console.warn('[NetworkPage] failed to load network proxy config:', e)
  }
  try {
    const res = await transport.listProviders()
    providers.value = res.providers
  } catch (e) {
    // chips 与统计反查降级：无 provider 数据 = chip 组无项、统计行显裸主机名，页面仍可用
    console.warn('[NetworkPage] failed to load providers:', e)
  }
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})

// 保存尾段（setting-field module）：saving 防重入 + setNetworkProxyConfig + toast；
// 失败在 run 内回滚草稿后再上抛（createExplicitSave 捕获 toast，不上抛组件）
const saveAction = createExplicitSave<NetworkProxyConfig>({
  run: async (config) => {
    try {
      await transport.setNetworkProxyConfig(config)
    } catch (e) {
      if (loadedConfig !== null) applyLoaded(loadedConfig)
      throw e
    }
    applyLoaded(config)
  },
  savedToastKey: 'settings.network.savedToast',
  onError: () => t('settings.network.saveFailed'),
})
const saving = saveAction.saving

/** 保存：前端同规则校验（shared validateNetworkProxyConfig，逐项收集不短路），失败 toast 首条不发 RPC。 */
async function onSave(): Promise<void> {
  if (saving.value) return
  const config = buildConfigFromDraft(draft)
  const res = validateNetworkProxyConfig(config)
  if (!res.ok) {
    // errors 逐项含修复动作；首条经 toast 呈现（文案已可操作，不做字段名反推标红映射）
    toastError(res.errors[0])
    return
  }
  await saveAction.run(config)
}
</script>
