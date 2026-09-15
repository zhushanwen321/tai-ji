<!--
  UpdateCheckCard · 版本检查区块（挂载于 UpdatePage 自动更新卡内）。

  自包含组件：内部调 useAppUpdate（单例 state），与侧边栏 UpdateButton 共享同一份 state，
  天然联动（任一入口检测/下载/安装，另一处实时反映）。

  v6 demo 回填：原为独立卡片（含「版本更新」标题），现去卡片壳内嵌为
  UpdatePage「自动更新」卡的卡内区块（版本行 + 检查按钮 + 状态机 + 确认 Dialog）。

  状态机分支（state.state）：
  - idle         检查按钮
  - checking     loading + disabled
  - available    新版本号 + 下载并安装
  - downloading  进度百分比
  - downloaded   重启安装（弹确认 Dialog）
  - replacing    替换中
  - restarting   即将重启
  - error        错误信息 + 重试
  - unsupported  前往下载（备用页）
-->
<template>
  <div class="flex items-center justify-between border-t border-border px-4 py-3">
      <!-- 状态文案（左） -->
      <div class="flex min-w-0 items-center gap-1.5">
        <!-- idle / checking：无左侧状态文案（当前版本已由自动更新卡内版本行展示），仅保留右侧按钮 -->
        <!-- available：发现新版本 -->
        <span
          v-if="state.state === 'available'"
          class="text-[12px] text-accent"
          data-testid="settings-update-new-version"
        >{{ t('settings.system.newVersionAvailable', { version: state.latestRelease?.version }) }}</span>
        <!-- downloading：进度 -->
        <span
          v-if="state.state === 'downloading'"
          class="inline-flex items-center gap-1 text-[12px] text-neutral-mid"
        >
          <Loader2 class="size-4 animate-spin" />
          {{ t('settings.system.downloading', { percent: state.percent }) }}
        </span>
        <!-- downloaded：已下载 -->
        <span
          v-else-if="state.state === 'downloaded'"
          class="inline-flex items-center gap-1 text-[12px] text-success"
        >
          <CheckCircle2 class="size-4" />
          {{ t('settings.system.downloaded') }}
        </span>
        <!-- replacing -->
        <span
          v-else-if="state.state === 'replacing'"
          class="inline-flex items-center gap-1 text-[12px] text-neutral-mid"
        >
          <Loader2 class="size-4 animate-spin" />
          {{ t('settings.system.replacing') }}
        </span>
        <!-- restarting -->
        <span
          v-else-if="state.state === 'restarting'"
          class="inline-flex items-center gap-1 text-[12px] text-success"
        >
          <CheckCircle2 class="size-4" />
          {{ t('settings.system.restarting') }}
        </span>
        <!-- error：错误信息 -->
        <span
          v-else-if="state.state === 'error'"
          class="inline-flex items-center gap-1 text-[12px] text-danger"
          data-testid="settings-update-error"
        >
          <AlertCircle class="size-4 shrink-0" />
          <span class="truncate">{{ state.errorMessage }}</span>
        </span>
        <!-- unsupported -->
        <span
          v-else-if="state.state === 'unsupported'"
          class="text-[12px] text-neutral-mid"
        >{{ t('settings.system.unsupported') }}</span>
      </div>

      <!-- 操作按钮（右） -->
      <div class="flex shrink-0 items-center gap-2">
        <!-- idle：检查更新 -->
        <Button
          v-if="state.state === 'idle'"
          variant="default"
          size="sm"
          data-testid="settings-update-check"
          @click="onCheck"
        >
          <RefreshCw class="size-4" />
          {{ t('settings.system.checkUpdate') }}
        </Button>
        <!-- checking：loading disabled -->
        <Button
          v-else-if="state.state === 'checking'"
          variant="default"
          size="sm"
          disabled
          data-testid="settings-update-check"
        >
          <Loader2 class="size-4 animate-spin" />
          {{ t('settings.system.checking') }}
        </Button>
        <!-- available：下载并安装 -->
        <Button
          v-else-if="state.state === 'available'"
          variant="default"
          size="sm"
          data-testid="settings-update-download"
          @click="onDownload"
        >
          <Download class="size-4" />
          {{ t('settings.system.downloadAndInstall') }}
        </Button>
        <!-- downloaded：重启安装（弹确认 Dialog） -->
        <Button
          v-else-if="state.state === 'downloaded'"
          variant="default"
          size="sm"
          data-testid="settings-update-install"
          @click="onInstallClick"
        >{{ t('settings.system.restartInstall') }}</Button>
        <!-- error：重试 -->
        <Button
          v-else-if="state.state === 'error'"
          variant="secondary"
          size="sm"
          data-testid="settings-update-retry"
          @click="onRetry"
        >
          <RefreshCw class="size-4" />
          {{ t('settings.system.retry') }}
        </Button>
        <!-- unsupported：前往下载 -->
        <Button
          v-else-if="state.state === 'unsupported'"
          variant="default"
          size="sm"
          data-testid="settings-update-unsupported"
          @click="onOpenFallbackUrl"
        >{{ t('settings.system.goToDownload') }}</Button>
      </div>
    </div>

    <!-- 手动升级通道（update-network-resilience D9）：断网/代理故障时的人工逃生通道。
         默认展开（路径属常驻引导），可折叠。目录路径与 main 侧 MANUAL_ASSET_DIR 同源
         （<dataDir>/update/manual），「打开目录」经 main 侧 update:openManualDir
         （幂等建目录 + shell.openPath，见 impl-plan u7b）。 -->
    <Collapsible
      v-model:open="manualChannelOpen"
      class="border-t border-border"
      data-testid="settings-update-manual-channel"
    >
      <div class="flex items-center px-4 py-2">
        <CollapsibleTrigger as-child>
          <Button
            variant="ghost"
            size="sm"
            class="h-auto gap-1.5 px-2 text-[12px] text-muted hover:text-fg"
            data-testid="settings-update-manual-toggle"
          >
            <ChevronDown
              class="size-3.5 shrink-0 transition-transform duration-150"
              :class="manualChannelOpen ? 'rotate-180' : ''"
            />
            {{ t('settings.system.manualChannelTitle') }}
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent class="px-4 pb-3">
        <p class="text-[11px] leading-relaxed text-neutral-mid" data-testid="settings-update-manual-hint">
          {{ t('settings.system.manualChannelHint') }}
        </p>
        <!-- D3 已知边界：sha256 基准只认 app 已知 release，必须向用户言明限定 -->
        <p class="mt-1 text-[11px] text-muted" data-testid="settings-update-manual-restriction">
          {{ t('settings.system.manualChannelRestriction') }}
        </p>
        <div class="mt-2 flex min-w-0 items-center gap-2">
          <span class="shrink-0 text-[11px] text-fg">{{ t('settings.system.manualChannelDirLabel') }}</span>
          <code
            class="min-w-0 truncate rounded-sm border border-border-strong bg-bg-input px-2 py-0.5 font-mono text-[11px] text-fg"
            data-testid="settings-update-manual-dir"
          >{{ manualDir ?? t('settings.system.manualChannelDirUnavailable') }}</code>
          <!-- D9 u7b：main 侧幂等建目录后打开，路径不可用时按钮仍可用（目录由 main 创建） -->
          <Button
            variant="secondary"
            size="sm"
            class="h-6 shrink-0 gap-1 px-2 text-[11px]"
            data-testid="settings-update-manual-open-dir"
            @click="onOpenManualDir"
          >
            <FolderOpen class="size-3.5" />
            {{ t('settings.system.manualChannelOpenDir') }}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>

    <!-- 确认重启安装 Dialog -->
    <Dialog :open="showConfirmDialog" @update:open="showConfirmDialog = $event">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ t('settings.system.restartInstall') }}</DialogTitle>
          <DialogDescription>
            {{ t('settings.system.confirmInstall', { version: state.latestRelease?.version }) }}
          </DialogDescription>
        </DialogHeader>
        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" @click="onLater">{{ t('settings.system.installLater') }}</Button>
          <Button
            variant="default"
            size="sm"
            data-testid="settings-update-confirm-install"
            @click="onConfirmInstall"
          >{{ t('settings.system.installNow') }}</Button>
        </div>
      </DialogContent>
    </Dialog>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, Download, CheckCircle2, AlertCircle, Loader2, ChevronDown, FolderOpen } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { useAppUpdate } from '@/composables/features/settings/useAppUpdate'
import { useToast } from '@/composables/useToast'
import { getDataDir, openUpdateManualDir } from '@/api/domains/settings'

const { t } = useI18n()
const { state, checkForUpdate, performDownload, performInstall, openFallbackUrl } = useAppUpdate()
const { error: toastError } = useToast()

/** 确认重启安装 Dialog 开关 */
const showConfirmDialog = ref(false)

/** 手动通道折叠区开关（D9：默认展开——路径属常驻引导，用户可收起） */
const manualChannelOpen = ref(true)

/** 手动升级目录（~ 缩写展示形态；getDataDir 返回失败/无 IPC 环境为 null → 显示占位） */
const manualDir = ref<string | null>(null)

onMounted(async () => {
  try {
    const dir = await getDataDir()
    // 与 main 侧 MANUAL_ASSET_DIR = path.join(getDataDir(), 'update', 'manual') 同源
    // （update/constants.ts + update/manual-claim.ts）。getDataDir 为 ~ 缩写展示形态
    // （bridge-handlers get-data-dir），仅作展示用，不做文件系统操作。
    if (dir) {
      const sep = dir.includes('\\') ? '\\' : '/'
      manualDir.value = `${dir}${sep}update${sep}manual`
    }
  } catch (e) {
    // 展示态降级：IPC reject 时 manualDir 保持 null 走占位态（打开目录不依赖路径展示，
    // main 侧幂等建目录），onMounted async 不被 await，不 catch 会产生 unhandledRejection
    console.warn('[UpdateCheckCard] getDataDir failed:', e)
  }
})

/** idle：强制检测新版 */
function onCheck(): void {
  void checkForUpdate(true)
}

/** available：触发下载阶段 */
function onDownload(): void {
  void performDownload()
}

/** downloaded：打开确认 Dialog（不直接执行 install，避免误点中断会话） */
function onInstallClick(): void {
  showConfirmDialog.value = true
}

/** 确认安装：关闭 Dialog 后执行 install（替换 + 重启） */
async function onConfirmInstall(): Promise<void> {
  showConfirmDialog.value = false
  await performInstall()
}

/** 稍后：仅关闭 Dialog */
function onLater(): void {
  showConfirmDialog.value = false
}

/** error 态重试：强制重新检测 */
function onRetry(): void {
  void checkForUpdate(true)
}

/** unsupported：打开备用下载页 */
function onOpenFallbackUrl(): void {
  void openFallbackUrl()
}

/** D9 u7b：打开手动产物目录（main 幂等建目录 + shell.openPath）。
 *  打开失败 toast 提示（错误信息含 main 侧 openPath 返回的具体原因），不打断页面。 */
function onOpenManualDir(): void {
  openUpdateManualDir().catch((err: unknown) => {
    toastError(err instanceof Error ? err.message : String(err))
  })
}
</script>
