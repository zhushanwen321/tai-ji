<!--
  Settings · 更新设置页。
  自动更新开关 + 更新来源三选（自动/GitHub/GitCode）+ 当前版本 + 检查更新状态机
  + 预下载开关 + 代理模式选择 + 手动模式下 HTTP/HTTPS 代理输入 + 测试代理连接。
  更新设置三字段（autoUpdate/preDownload/updateSource）走 setting-field module 编排；
  代理表单为显式保存形态（createExplicitSave）；onTestProxy 为查询型动作留组件。
-->
<template>
  <div class="flex max-w-[860px] flex-col gap-3">
    <!-- RD-4#8：读配置失败常驻提示（默认值非已存值）+ 重试；可落盘控件禁用直到重拉成功 -->
    <div
      v-if="loadError"
      data-testid="update-page-load-error"
      class="flex items-center gap-2 px-1 text-[11px] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span>{{ t('settings.update.loadErrorHint') }}</span>
      <Button
        variant="ghost"
        size="sm"
        class="h-5 px-1.5 text-[11px] text-accent"
        data-testid="update-page-load-retry"
        @click="loadConfig"
      >{{ t('settings.update.loadErrorRetry') }}</Button>
    </div>

    <!-- 卡 1：自动更新（v6 demo 回填：开关 + 当前版本 + 检查更新状态机） -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.update.autoUpdateTitle') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.update.autoUpdateDesc') }}</p>
      </div>
      <div class="border-t border-border">
        <!-- 自动更新开关行 -->
        <div class="flex items-center justify-between px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.update.autoUpdateLabel') }}</Label>
          <Switch
            data-testid="switch-auto-update"
            :model-value="autoUpdate"
            :disabled="autoUpdateBusy || loadError"
            @update:model-value="onToggleAutoUpdate"
          />
        </div>
        <!-- 更新来源行（三选：自动（推荐）/GitHub/GitCode；选择即优先级，切换即持久化） -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.update.updateSourceLabel') }}</Label>
          <Select
            :model-value="updateSource"
            :disabled="updateSourceBusy || loadError"
            @update:model-value="(v) => onSourceChange(String(v))"
          >
            <SelectTrigger
              class="h-8 w-[200px] px-2 text-[12px]"
              data-testid="select-update-source"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{{ t('settings.update.updateSourceAuto') }}</SelectItem>
              <SelectItem value="github">{{ t('settings.update.updateSourceGithub') }}</SelectItem>
              <SelectItem value="gitcode">{{ t('settings.update.updateSourceGitcode') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <!-- 当前版本行 -->
        <div class="flex items-center justify-between border-t border-border px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.update.currentVersionLabel') }}</Label>
          <span
            class="rounded-sm border border-border-strong bg-bg-input px-2 py-0.5 font-mono text-[11px] text-fg"
            data-testid="current-version-pill"
          >v{{ appVersion }} · {{ t('settings.update.channelHint') }}</span>
        </div>
        <!-- 检查更新状态机（UpdateCheckCard 内嵌为卡内区块） -->
        <UpdateCheckCard />
      </div>
    </div>

    <!-- 卡 2：预下载设置 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.update.preDownloadTitle') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.update.preDownloadDesc') }}</p>
      </div>
      <div class="border-t border-border">
        <div class="flex items-center justify-between px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.update.preDownloadLabel') }}</Label>
          <Switch
            data-testid="switch-pre-download"
            :model-value="preDownload"
            :disabled="preDownloadBusy || loadError"
            @update:model-value="onTogglePreDownload"
          />
        </div>
      </div>
    </div>

    <!-- 卡 3：代理配置 -->
    <div class="rounded-md border border-border bg-bg">
      <div class="px-4 pb-3 pt-3">
        <h3 class="text-[13px] font-medium text-fg">{{ t('settings.update.sectionTitle') }}</h3>
        <p class="mt-0.5 text-[11px] text-muted">{{ t('settings.update.sectionDesc') }}</p>
      </div>
      <div class="border-t border-border">
        <!-- 代理模式 -->
        <div class="flex items-center justify-between px-4 py-3">
          <Label class="text-[12px] text-fg">{{ t('settings.update.proxyMode') }}</Label>
          <Select
            :model-value="localConfig.mode"
            @update:model-value="(v) => onModeChange(String(v))"
          >
            <SelectTrigger class="h-8 w-[200px] px-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{{ t('settings.update.proxyModeSystem') }}</SelectItem>
              <SelectItem value="manual">{{ t('settings.update.proxyModeManual') }}</SelectItem>
              <SelectItem value="disabled">{{ t('settings.update.proxyModeDisabled') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- HTTP 代理（手动模式） -->
        <div v-if="localConfig.mode === 'manual'" class="border-t border-border px-4 py-3">
          <Label class="mb-2 block text-[12px] text-fg">{{ t('settings.update.httpProxy') }}</Label>
          <Input
            v-model="localConfig.httpProxy"
            :placeholder="t('settings.update.httpProxyPlaceholder')"
            class="h-8 text-[12px]"
            data-testid="input-http-proxy"
          />
        </div>

        <!-- HTTPS 代理（手动模式） -->
        <div v-if="localConfig.mode === 'manual'" class="border-t border-border px-4 py-3">
          <Label class="mb-2 block text-[12px] text-fg">{{ t('settings.update.httpsProxy') }}</Label>
          <Input
            v-model="localConfig.httpsProxy"
            :placeholder="t('settings.update.httpsProxyPlaceholder')"
            class="h-8 text-[12px]"
            data-testid="input-https-proxy"
          />
        </div>
      </div>
    </div>

    <!-- 操作栏 -->
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <!-- 测试代理按钮 -->
        <Button
          variant="ghost"
          size="sm"
          :disabled="testing || localConfig.mode === 'disabled'"
          :title="localConfig.mode === 'disabled' ? t('settings.update.testProxyTooltipDisabled') : undefined"
          class="gap-1.5 text-[12px]"
          data-testid="btn-test-proxy"
          @click="onTestProxy"
        >
          <Zap v-if="!testing" class="size-3.5" />
          <Loader2 v-else class="size-3.5 animate-spin" />
          <span>{{ testing ? t('settings.update.testing') : t('settings.update.testProxy') }}</span>
        </Button>
      </div>

      <div class="flex items-center gap-2">
        <!-- 测试结果 -->
        <div
          v-if="testResult !== null"
          class="text-[11px]"
          data-testid="test-proxy-result"
        >
          <span
            :class="{
              'text-success': testResult.status === 'success',
              'text-danger': testResult.status === 'failed',
              'text-muted': testResult.status === 'skipped',
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
          <div v-if="testResult.status === 'failed' && testResult.suggestion" class="mt-0.5 text-muted">
            {{ testResult.suggestion }}
          </div>
        </div>

        <!-- 保存按钮 -->
        <Button
          size="sm"
          :disabled="saveProxySaving || loadError"
          class="gap-1.5 text-[12px]"
          data-testid="btn-save-proxy"
          @click="onSave"
        >
          <Save v-if="!saveProxySaving" class="size-3.5" />
          <Loader2 v-else class="size-3.5 animate-spin" />
          <span>{{ saveProxySaving ? t('settings.update.saving') : t('settings.update.save') }}</span>
        </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { Zap, Save, Loader2, AlertTriangle } from '@lucide/vue'
import type { IProxyConfig, UpdateSourcePref } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getProxyConfig, setProxyConfig, testProxy, getUpdateSettings, setUpdateSettings } from '@/api/domains/settings'
import { createExplicitSave, createSettingFieldGroup } from '@/composables/features/settings/setting-field'
import { useToast } from '@/composables/useToast'
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
