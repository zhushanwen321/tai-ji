<template>
  <div class="flex flex-col gap-4">
    <!-- 推荐扩展区：快捷一键安装 builtin pi-extensions（SSOT = recommended-extensions.json）。onMounted 拉取 installed，install 后 watch(extensions) 刷新。-->
    <section v-if="recommended.length" class="rounded-card bg-card">
      <div class="border-b border-border px-3 py-2">
        <h3 class="text-[12px] font-medium text-neutral-fg">{{ t('settings.extension.recommendedTitle') }}</h3>
      </div>
      <div class="flex flex-col gap-0.5 p-2">
        <div
          v-for="r in recommended"
          :key="r.name"
          class="flex items-center gap-3 rounded-sm px-2 py-2 hover:bg-surface"
        >
          <div class="min-w-0 flex-1 flex flex-col gap-0.5">
            <span class="truncate text-[12px] font-medium text-neutral-fg">{{ r.name }}</span>
            <span class="truncate text-[11px] text-neutral-mid">{{ r.description }}</span>
          </div>
          <!-- 已安装：disabled + Check 图标；未安装：点击调 install(npm:pkgName) -->
          <Button
            variant="ghost"
            size="dense"
            class="shrink-0 rounded-sm text-[11px]"
            :disabled="r.installed || installingRecommended.has(r.name)"
            @click="onInstallRecommended(r.name)"
          >
            <Loader2 v-if="installingRecommended.has(r.name)" class="animate-spin" />
            <Check v-else-if="r.installed" />
            {{ r.installed ? t('settings.extension.installed') : t('settings.extension.install') }}
          </Button>
        </div>
      </div>
    </section>

    <!-- 安装区 -->
    <section class="rounded-card bg-card">
      <div class="flex items-center gap-1 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          v-for="tab in tabs"
          :key="tab.id"
          class="h-auto rounded-sm px-2.5 py-1 text-[12px]"
          :class="activeTab === tab.id ? 'bg-bg-elevated text-neutral-fg' : 'text-neutral-mid hover:text-neutral-fg'"
          @click="activeTab = tab.id"
        >{{ tab.label }}</Button>
      </div>
      <div class="flex items-center gap-2 p-3">
        <Input
          v-model="installInput"
          data-testid="install-input"
          class="h-8 flex-1 text-[12px]"
          :placeholder="tabPlaceholder"
          @keyup.enter="onInstall"
        />
        <Button
          class="h-8 shrink-0 rounded-sm px-3 text-[12px]"
          :disabled="!installInput.trim() || installing"
          @click="onInstall"
        >
          <Loader2 v-if="installing" class="animate-spin" />
          {{ installButtonText }}
        </Button>
      </div>
      <!-- 错误反馈（非静默吞，AGENTS.md 规则 #3） -->
      <div v-if="actionError" class="flex items-center gap-1.5 border-t border-border px-3 py-1.5 text-[11px] text-danger">
        <AlertCircle class="size-3.5 shrink-0" />
        <span class="truncate">{{ actionError }}</span>
      </div>
    </section>

    <!-- 候选内联展开（dir/git 多步第二步，§6.3 点3：安装区下方直接展开） -->
    <section v-if="discovered" data-testid="install-candidates" class="rounded-card bg-card">
      <div class="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 class="text-[12px] font-medium text-neutral-fg">{{ t('settings.extension.discoverResultTitle', discovered.candidates.length, { named: { count: discovered.candidates.length } }) }}</h3>
        <Button variant="ghost" class="h-auto px-2 py-0.5 text-[11px] text-neutral-dim" @click="onCancelInstall">{{ t('settings.extension.cancel') }}</Button>
      </div>
      <div v-if="!discovered.candidates.length" class="py-4 text-center text-[11px] text-neutral-mid">{{ t('settings.extension.noCandidates') }}</div>
      <div v-else class="flex flex-col gap-0.5 p-2">
        <Label
          v-for="c in discovered.candidates"
          :key="c.dirName"
          class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-surface"
        >
          <!--
            候选多选（W2 D3 修复）：Checkbox 受控（selected Set 管理）。去掉内层 div @click，
            仅靠 Label→Checkbox 转发 + update:model-value 单通道，避免双触发翻转抵消。
          -->
          <Checkbox
            :model-value="selected.has(c.dirName)"
            class="shrink-0"
            @update:model-value="toggleCandidate(c.dirName)"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-[12px] text-neutral-fg">{{ c.name }}</span>
              <span class="rounded-sm bg-surface px-1 py-0.5 font-mono text-[10px] text-neutral-dim">{{ c.dirName }}</span>
              <span class="font-mono text-[10px] text-neutral-dim">v{{ c.version }}</span>
            </div>
            <span class="truncate text-[11px] text-neutral-mid">{{ c.description }}</span>
          </div>
        </Label>
      </div>
      <div v-if="discovered.candidates.length" class="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-neutral-dim">{{ t('settings.extension.selectedCount', { selected: selected.size, total: discovered.candidates.length }) }}</span>
          <Button variant="ghost" size="dense" class="h-auto px-1.5 py-0.5 text-[11px] text-neutral-dim hover:text-neutral-fg" @click="toggleSelectAll">
            {{ isAllSelected ? t('settings.extension.unselectAll') : t('settings.extension.selectAll') }}
          </Button>
        </div>
        <Button size="dense" :disabled="selected.size === 0 || installing" @click="onFinishInstall">
          <Loader2 v-if="installing" class="animate-spin" />
          {{ t('settings.extension.installSelected') }}
        </Button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, AlertCircle, Check } from '@lucide/vue'
import type { ExtensionDiscoveredPayload, RecommendedExtension } from '@taiji/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { extension as extensionApi } from '@/api'
import type { ExtensionItem } from '@taiji/core'
import { useToast } from '@/composables/useToast'

const props = defineProps<{ extensions: ExtensionItem[] }>()

const { info: toastInfo } = useToast()
const { t } = useI18n()

const tabs = [{ id: 'npm', label: 'npm' }, { id: 'dir', label: 'Local Dir' }, { id: 'git', label: 'Git URL' }] as const

/** 推荐扩展列表（含已安装状态）。onMounted 拉取；extensions prop 变化时重新拉取。 */
const recommended = ref<Array<RecommendedExtension & { installed: boolean }>>([])
/** 推荐扩展安装中（按包名 key，支持并发不同包；同包重复点击 disabled 防抖） */
const installingRecommended = ref<Set<string>>(new Set())

async function refreshRecommended() {
  try {
    recommended.value = await extensionApi.fetchRecommended()
  } catch (e) {
    // 拉取失败仅记录到 actionError，不阻塞页面其余功能
    actionError.value = e instanceof Error
      ? t('settings.extension.loadRecommendedFailed', { msg: e.message })
      : t('settings.extension.loadRecommendedFailed', { msg: String(e) })
  }
}

onMounted(refreshRecommended)
// extensions prop 变化后刷新推荐列表的 installed 状态（install/uninstall/toggle 都会触发）
watch(() => props.extensions, refreshRecommended)

/** 推荐扩展一键安装：自动补 npm: 前缀 */
async function onInstallRecommended(pkgName: string) {
  if (installingRecommended.value.has(pkgName)) return
  actionError.value = ''
  const next = new Set(installingRecommended.value)
  next.add(pkgName)
  installingRecommended.value = next
  try {
    await extensionApi.install(`npm:${pkgName}`)
    toastInfo(t('settings.extension.installedToast'))
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    const after = new Set(installingRecommended.value)
    after.delete(pkgName)
    installingRecommended.value = after
  }
}

const activeTab = ref<'npm' | 'dir' | 'git'>('npm')
const installInput = ref('')
/** 动作错误 / 安装中 / 卸载中 / 升级中集合 */
const actionError = ref('')
const installing = ref(false)
/** dir/git 候选（多步第一步产物）；null 表示未进入候选选择。selected = finishInstall 的选中集 */
const discovered = ref<ExtensionDiscoveredPayload | null>(null)
const selected = ref<Set<string>>(new Set())

const tabPlaceholder = computed(() => {
  const map: Record<string, string> = {
    npm: 'npm:package-name',
    dir: '/path/to/extension',
    git: 'https://github.com/...',
  }
  return map[activeTab.value] ?? ''
})

/** 第一层按钮文案：npm 单步直装→"安装"；dir/git 多步流先发现候选→"发现" */
const installButtonText = computed(() => activeTab.value === 'npm' ? t('settings.extension.install') : t('settings.extension.discoverBtn'))

// 切换 tab 清空已发现候选（不同来源的候选不再适用）
watch(activeTab, () => {
  discovered.value = null
  selected.value = new Set()
})

/** 安装入口：npm 单步直装；dir/git 多步（先发现候选，内联展开） */
async function onInstall() {
  const input = installInput.value.trim()
  if (!input || installing.value) return
  actionError.value = ''
  installing.value = true
  try {
    if (activeTab.value === 'npm') {
      // 自动补 npm: 前缀（runtime installExtension 强制要求，placeholder 仅提示不强制）
      const source = input.startsWith('npm:') ? input : `npm:${input}`
      await extensionApi.install(source)
      installInput.value = ''
      toastInfo(t('settings.extension.installedToast'))
    } else if (activeTab.value === 'dir') {
      const result = await extensionApi.installDir(input)
      setDiscovered(result)
    } else {
      const result = await extensionApi.installGitRepository(input)
      setDiscovered(result)
    }
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
    discovered.value = null
  } finally {
    installing.value = false
  }
}

/** 记录发现结果，默认全选（常见 UX：一次性装全部候选，用户可逐项取消） */
function setDiscovered(result: ExtensionDiscoveredPayload) {
  discovered.value = result
  // 默认不勾选——用户手动选择要安装的 extension，避免误装
  selected.value = new Set()
}

/** 切换候选选中态（dirName 为 key） */
function toggleCandidate(dirName: string) {
  const next = new Set(selected.value)
  if (next.has(dirName)) next.delete(dirName)
  else next.add(dirName)
  selected.value = next
}

/** 是否全选（用于全选/取消全选按钮文案切换） */
const isAllSelected = computed(() =>
  !!discovered.value
  && discovered.value.candidates.length > 0
  && selected.value.size === discovered.value.candidates.length,
)

/** 全选/取消全选候选 */
function toggleSelectAll() {
  if (!discovered.value) return
  selected.value = isAllSelected.value
    ? new Set()
    : new Set(discovered.value.candidates.map((c) => c.dirName))
}

/** 完成安装：把选中候选从 tempDir 装入 extensions/，runtime 推 config.extensions 刷新列表 */
async function onFinishInstall() {
  if (!discovered.value || selected.value.size === 0 || installing.value) return
  actionError.value = ''
  installing.value = true
  const { tempDir } = discovered.value
  const selectedNames = [...selected.value]
  try {
    await extensionApi.finishInstall(tempDir, selectedNames)
    discovered.value = null
    selected.value = new Set()
    installInput.value = ''
    toastInfo(t('settings.extension.installedToast'))
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    installing.value = false
  }
}

/** 放弃安装：清理 tempDir，退出候选选择 */
async function onCancelInstall() {
  if (!discovered.value) return
  const { tempDir } = discovered.value
  discovered.value = null
  selected.value = new Set()
  try {
    await extensionApi.cancelInstall(tempDir)
  } catch (e) {
    // tempDir 清理失败仅记录，不阻塞 UI（候选区已关闭）。临时文件可能未清理，需手动检查。
    const baseMsg = e instanceof Error ? e.message : String(e)
    actionError.value = `${baseMsg}${t('settings.extension.cancelInstallTempHint')}`
  }
}
</script>
