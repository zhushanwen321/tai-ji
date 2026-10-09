<!--
  Settings · 更新设置页。
  自动更新开关 + 更新来源三选（自动/GitHub/GitCode）+ 当前版本 + 检查更新状态机
  + 预下载开关 + 代理模式选择 + 手动模式下 HTTP/HTTPS 代理输入 + 测试代理连接。
  更新设置三字段（autoUpdate/preDownload/updateSource）走 setting-field module 编排；
  代理表单为显式保存形态（createExplicitSave）；onTestProxy 为查询型动作留组件。

  [w3] demo 对照（UpdateSection.vue）：三卡 = GroupCard（gcard-head gc-title+gc-sub /
  tight 卡体 4-10-8）；行 = SettingRow（.srow 范式）；版本行 = demo srow（tag.ok pill +
  srow-desc 渠道注记）；测试/保存行收进代理卡体尾（demo srow border-top:0）。
-->
<template>
  <div class="flex flex-col">
    <!-- page-head（对齐 settings 页共享范式；demo 页头 = 标题 + desc） -->
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.update') }}</h1>
        <p class="desc">{{ t('settings.menu.updateDesc') }}</p>
      </div>
    </header>

    <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；可落盘控件禁用直到重拉成功 -->
    <div
      v-if="loadError"
      data-testid="update-page-load-error"
      class="flex items-center gap-2 px-1 pb-[8px] text-[length:var(--text-2xs)] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span>{{ t('settings.update.loadErrorHint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[length:var(--text-2xs)] text-accent"
        data-testid="update-page-load-retry"
        @click="loadConfig"
      >{{ t('settings.update.loadErrorRetry') }}</Button>
    </div>

    <!-- 卡 1：自动更新（开关 + 更新来源 + 版本行 + 检查更新状态机 + 手动升级通道） -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.update.autoUpdateTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.update.autoUpdateDesc') }}</p>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <SettingRow :label="t('settings.update.autoUpdateLabel')">
          <Switch
            data-testid="switch-auto-update"
            :model-value="autoUpdate"
            :disabled="autoUpdateBusy || loadError"
            @update:model-value="onToggleAutoUpdate"
          />
        </SettingRow>
        <!-- 更新来源行（三选：自动（推荐）/GitHub/GitCode；选择即优先级，切换即持久化） -->
        <SettingRow :label="t('settings.update.updateSourceLabel')">
          <Select
            :model-value="updateSource"
            :disabled="updateSourceBusy || loadError"
            @update:model-value="(v) => onSourceChange(String(v))"
          >
            <SelectTrigger class="w-[200px]" data-testid="select-update-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{{ t('settings.update.updateSourceAuto') }}</SelectItem>
              <SelectItem value="github">{{ t('settings.update.updateSourceGithub') }}</SelectItem>
              <SelectItem value="gitcode">{{ t('settings.update.updateSourceGitcode') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <!-- 版本行 = demo srow：tag.ok pill（版本号）+ srow-desc 渠道/重启弱注记（R2-13 拆分同款） -->
        <div class="flex min-h-[44px] items-center gap-4 border-t border-hairline px-[6px] py-[10px]">
          <span
            class="inline-flex h-[18px] shrink-0 items-center rounded-full bg-accent-soft px-[7px] font-mono text-[length:var(--text-2xs)] font-semibold text-accent"
            data-testid="current-version-pill"
          >v{{ appVersion }}</span>
          <span class="min-w-0 text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.update.channelHint') }}</span>
        </div>
        <!-- 检查更新状态机（UpdateCheckCard 内嵌为卡内区块） -->
        <UpdateCheckCard />
      </div>
    </GroupCard>

    <!-- 卡 2：预下载设置 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.update.preDownloadTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.update.preDownloadDesc') }}</p>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <SettingRow :label="t('settings.update.preDownloadLabel')">
          <Switch
            data-testid="switch-pre-download"
            :model-value="preDownload"
            :disabled="preDownloadBusy || loadError"
            @update:model-value="onTogglePreDownload"
          />
        </SettingRow>
      </div>
    </GroupCard>

    <!-- 卡 3：代理配置 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.update.sectionTitle') }}</h3>
          <p class="gc-sub">{{ t('settings.update.sectionDesc') }}</p>
        </div>
      </template>
      <div class="px-[10px] pb-[8px] pt-[4px]">
        <!-- 代理模式 -->
        <SettingRow :label="t('settings.update.proxyMode')">
          <Select
            :model-value="localConfig.mode"
            @update:model-value="(v) => onModeChange(String(v))"
          >
            <SelectTrigger class="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{{ t('settings.update.proxyModeSystem') }}</SelectItem>
              <SelectItem value="manual">{{ t('settings.update.proxyModeManual') }}</SelectItem>
              <SelectItem value="disabled">{{ t('settings.update.proxyModeDisabled') }}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>

        <!-- HTTP 代理（手动模式；demo UiRow 右置 280px mono 输入） -->
        <SettingRow v-if="localConfig.mode === 'manual'" :label="t('settings.update.httpProxy')">
          <Input
            v-model="localConfig.httpProxy"
            :placeholder="t('settings.update.httpProxyPlaceholder')"
            class="w-[280px] font-mono"
            data-testid="input-http-proxy"
          />
        </SettingRow>

        <!-- HTTPS 代理（手动模式） -->
        <SettingRow v-if="localConfig.mode === 'manual'" :label="t('settings.update.httpsProxy')">
          <Input
            v-model="localConfig.httpsProxy"
            :placeholder="t('settings.update.httpsProxyPlaceholder')"
            class="w-[280px] font-mono"
            data-testid="input-https-proxy"
          />
        </SettingRow>

        <!-- 测试/保存行（demo srow border-top:0：测试钮左 · 结果中 · solid 保存右） -->
        <div class="flex min-h-[44px] items-center gap-4 px-[6px] py-[10px]">
          <Button
            variant="ghost"
            :disabled="testing || localConfig.mode === 'disabled'"
            :title="localConfig.mode === 'disabled' ? t('settings.update.testProxyTooltipDisabled') : undefined"
            class="h-[32px] gap-[6px] px-[12px] text-[length:var(--text-sm)]"
            data-testid="btn-test-proxy"
            @click="onTestProxy"
          >
            <Zap v-if="!testing" class="size-3.5" />
            <Loader2 v-else class="size-3.5 animate-spin" />
            <span>{{ testing ? t('settings.update.testing') : t('settings.update.testProxy') }}</span>
          </Button>

          <span class="flex-1" />

          <!-- 测试结果 -->
          <div
            v-if="testResult !== null"
            class="min-w-0 text-[length:var(--text-xs)]"
            data-testid="test-proxy-result"
          >
            <span
              :class="{
                'text-success': testResult.status === 'success',
                'text-danger': testResult.status === 'failed',
                'text-neutral-mid': testResult.status === 'skipped',
              }"
            >
              {{ testResult.status === 'success'
                ? t('settings.update.testSuccess')
                : testResult.status === 'skipped'
                  ? (testResult.message ?? '')
                  : t('settings.update.testFailed', { msg: testResult.message ?? '' })
              }}
            </span>
            <!-- 恢复指引（suggestion 存在时显示） -->
            <div v-if="testResult.status === 'failed' && testResult.suggestion" class="mt-0.5 text-[length:var(--text-2xs)] text-neutral-mid">
              {{ testResult.suggestion }}
            </div>
          </div>

          <!-- 保存按钮（demo btn solid） -->
          <Button
            :disabled="saveProxySaving || loadError"
            class="h-[32px] gap-[6px] px-[12px] text-[length:var(--text-sm)]"
            data-testid="btn-save-proxy"
            @click="onSave"
          >
            <Save v-if="!saveProxySaving" class="size-3.5" />
            <Loader2 v-else class="size-3.5 animate-spin" />
            <span>{{ saveProxySaving ? t('settings.update.saving') : t('settings.update.save') }}</span>
          </Button>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { Zap, Save, Loader2, AlertTriangle } from '@lucide/vue'
import type { IProxyConfig, UpdateSourcePref } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { GroupCard } from '@taiji/ui/features/settings'
import { getProxyConfig, setProxyConfig, testProxy, getUpdateSettings, setUpdateSettings } from '@/api/domains/settings'
import { createExplicitSave, createSettingFieldGroup } from '@/composables/features/settings/setting-field'
import { useToast } from '@/composables/useToast'
import SettingRow from '../SettingRow.vue'
import UpdateCheckCard from '../UpdateCheckCard.vue'

const { t } = useI18n()
const { error: toastError } = useToast()

// ── State ──

/** 本地代理配置（表单草稿双向绑定；显式保存形态，保存动作见 createExplicitSave） */
const localConfig = reactive<IProxyConfig>({
  mode: 'system',
  httpProxy: '',
  httpsProxy: '',
})

/** 测试中 */
const testing = ref(false)
/** 测试结果（null=未测试） */
type TestResult = { status: 'success' } | { status: 'failed'; message?: string; suggestion?: string } | { status: 'skipped'; message?: string }
const testResult = ref<TestResult | null>(null)

// ── 更新设置三字段（autoUpdate/preDownload/updateSource）走 setting-field module：
//    load 失败归并 loadError（RD-4#8 默认值不冒充已存值）+ 乐观写/失败回滚/toast 编排 ──

/** 更新设置字段组成功/失败 toast key（proxy 表单的 settings.update.saved 语义专属，不混用） */
const UPDATE_SAVED_TOAST_KEY = 'settings.update.updateSettingsSaved'
const UPDATE_SAVE_FAILED_TOAST_KEY = 'settings.update.updateSettingsSaveFailed'

const group = createSettingFieldGroup()
const loadError = group.loadError

const autoUpdateField = group.field<boolean>(false, {
  save: (next) => setUpdateSettings({ autoUpdate: next }),
  savedToastKey: UPDATE_SAVED_TOAST_KEY,
  saveFailedToastKey: UPDATE_SAVE_FAILED_TOAST_KEY,
})
const autoUpdate = autoUpdateField.value
const autoUpdateBusy = autoUpdateField.busy

const preDownloadField = group.field<boolean>(false, {
  save: (next) => setUpdateSettings({ preDownload: next }),
  savedToastKey: UPDATE_SAVED_TOAST_KEY,
  saveFailedToastKey: UPDATE_SAVE_FAILED_TOAST_KEY,
})
const preDownload = preDownloadField.value
const preDownloadBusy = preDownloadField.busy

/** 更新来源偏好枚举（与 SelectItem value 一一对应）。 */
const UPDATE_SOURCE_PREFS = ['auto', 'github', 'gitcode'] as const

/** 运行时守卫：把 Select 的字符串 value 收敛为 UpdateSourcePref 字面量联合（无需 as 断言）。 */
function isUpdateSourcePref(value: string): value is UpdateSourcePref {
  return (UPDATE_SOURCE_PREFS as readonly string[]).includes(value)
}

/** 更新来源偏好（选择即优先级非独占：任一源失败仍自动降级另一源；切换即持久化） */
const updateSourceField = group.field<UpdateSourcePref>('auto', {
  save: (next) => setUpdateSettings({ updateSource: next }),
  savedToastKey: UPDATE_SAVED_TOAST_KEY,
  saveFailedToastKey: UPDATE_SAVE_FAILED_TOAST_KEY,
})
const updateSource = updateSourceField.value
const updateSourceBusy = updateSourceField.busy

// 共享 loader：一次 getUpdateSettings 回填三字段 + proxy 配置独立 loader（loadAll 并行，任一失败归并 loadError）
group.registerLoader(async () => {
  const settings = await getUpdateSettings()
  preDownloadField.reset(settings.preDownload)
  // 旧 settings 文件无 autoUpdate/updateSource 字段 → 缺省回退（D3 向后兼容）
  autoUpdateField.reset(settings.autoUpdate ?? false)
  updateSourceField.reset(settings.updateSource ?? 'auto')
})
group.registerLoader(async () => {
  const config = await getProxyConfig()
  localConfig.mode = config.mode
  localConfig.httpProxy = config.httpProxy ?? ''
  localConfig.httpsProxy = config.httpsProxy ?? ''
})

/** 当前应用版本（vite define 注入，全局声明见 env.d.ts） */
const appVersion = __APP_VERSION__

// ── Lifecycle ──

/** 加载/重试：全部 loader 并行执行，任一失败归并置 loadError（控件禁用直到重拉成功）。 */
async function loadConfig(): Promise<void> {
  await group.loadAll()
}

onMounted(() => {
  void loadConfig()
})

/** 切换自动更新开关（立即持久化；编排全在 setting-field module）。 */
function onToggleAutoUpdate(value: boolean | string): void {
  void autoUpdateField.persist(value === true)
}

/** 切换预下载开关（立即持久化；编排全在 setting-field module）。 */
function onTogglePreDownload(value: boolean | string): void {
  void preDownloadField.persist(value === true)
}

/**
 * 切换更新来源（立即持久化）。
 * 仅写偏好，不触发 force 检查——偏好实际生效以检查缓存 TTL 为界
 * （update-multi-source D3：手动「检查更新」才是 force 语义）。
 */
function onSourceChange(value: string): void {
  // 守卫落 persist 前：清单外值禁止进入乐观写/落盘路径
  if (!isUpdateSourcePref(value)) return
  void updateSourceField.persist(value)
}

// ── Actions ──

/** 代理模式枚举（与 SelectItem value 一一对应）。 */
const PROXY_MODES = ['system', 'manual', 'disabled'] as const
type ProxyMode = (typeof PROXY_MODES)[number]

/** 运行时守卫：把 Select 的字符串 value 收敛为 ProxyMode 字面量联合（无需 as 断言）。 */
function isProxyMode(value: string): value is ProxyMode {
  return (PROXY_MODES as readonly string[]).includes(value)
}

/**
 * 模式切换。
 * Select 的 SelectItem value 恒为字符串，但 reka-ui 事件载荷是 AcceptableValue，
 * 故在绑定处 String() 收敛为 string；这里再用 isProxyMode 守卫收敛为字面量联合。
 */
function onModeChange(value: string) {
  if (!isProxyMode(value)) return
  localConfig.mode = value
  // 切换到非手动模式时清空手动配置
  if (value !== 'manual') {
    localConfig.httpProxy = ''
    localConfig.httpsProxy = ''
  }
  // 清空测试结果
  testResult.value = null
}

/** 测试代理（查询型动作，不落盘，留在组件） */
async function onTestProxy() {
  // disabled 模式不发起测试：代理未启用，测试无意义，直接给出提示而非误导性的成功
  if (localConfig.mode === 'disabled') {
    testResult.value = { status: 'skipped', message: t('settings.update.testDisabled') }
    return
  }

  testing.value = true
  testResult.value = null

  try {
    const config: IProxyConfig = {
      mode: localConfig.mode,
      httpProxy: localConfig.httpProxy || undefined,
      httpsProxy: localConfig.httpsProxy || undefined,
    }
    const res = await testProxy(config)
    testResult.value = res.success
      ? { status: 'success' }
      : { status: 'failed', message: res.message, suggestion: res.suggestion }
  } catch (err) {
    testResult.value = {
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    }
  } finally {
    testing.value = false
  }
}

// 显式保存动作（setting-field module · createExplicitSave）：saving 防重入 + 成功/失败 toast；
// 组装收进动作本体，域校验留调用方（onSave）
const saveProxy = createExplicitSave({
  run: async () => {
    await setProxyConfig({
      mode: localConfig.mode,
      httpProxy: localConfig.httpProxy || undefined,
      httpsProxy: localConfig.httpsProxy || undefined,
    })
  },
  savedToastKey: 'settings.update.saved',
  onError: (e) => t('settings.update.saveFailed', { msg: e instanceof Error ? e.message : String(e) }),
})
const saveProxySaving = saveProxy.saving

/** 保存配置：manual 非空 + URL 校验留调用方（校验拒绝不进入保存动作、无成功 toast）。 */
function onSave() {
  if (localConfig.mode === 'manual') {
    if (!localConfig.httpProxy) {
      toastError(t('settings.update.httpProxyRequired'))
      return
    }
    // 验证 URL 格式
    try {
      new URL(localConfig.httpProxy)
      if (localConfig.httpsProxy) new URL(localConfig.httpsProxy)
    } catch {
      toastError(t('settings.update.invalidUrl'))
      return
    }
  }
  void saveProxy.run()
}
</script>
