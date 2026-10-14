<template>
  <!--
    [w3b] demo 对照：ExtensionSection.vue 安装域三卡（.gcard 结构 + 卡头 gc-title）。
    推荐扩展卡 = .gcard-body.tight（4px 10px 8px）+ .srow 行（name 14px/600 + desc/pkg 13px fg-2，
    右侧 .btn.secondary 安装 / disabled+Check 已安装）；安装卡 = .gcard-body（12px 16px）+
    .u-seg 分段 tab（凹陷档槽底 / hairline 边 / r-md / p 2px / 钮 26px r-sm；槽底引 --bg-input，
    同名 --surface-2 分叉说明见下方分段处注释）+ .inp/.btn
    输入行 + 错误行（srow-desc danger p 6px，无图标）；候选内联展开在安装卡体内（demo 权威位），
    行 = .srow 单行内联（Checkbox + name + mono dirName + .tag.ok 版本 + desc）。
    demo 推荐行有第三行 pkg 文本——real RecommendedExtension.name 即 npm 包名（安装入参），
    重复展示无信息量，不照抄（内容跟 real）。
  -->
  <div class="flex flex-col">
    <!-- 推荐扩展区：快捷一键安装 builtin pi-extensions（SSOT = recommended-extensions.json）。onMounted 拉取 installed，install 后 watch(extensions) 刷新。-->
    <GroupCard v-if="recommended.length">
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.extension.recommendedTitle') }}</h3>
        </div>
      </template>
      <div class="px-[10px] pt-[4px] pb-[8px]">
        <div
          v-for="r in recommended"
          :key="r.name"
          class="flex min-h-[44px] items-center gap-[16px] border-t border-hairline px-[6px] py-[10px] first:border-t-0"
        >
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ r.name }}</span>
            <span class="mt-0.5 truncate text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ r.description }}</span>
          </div>
          <!-- 已安装：disabled + Check 图标；未安装：点击调 install(npm:pkgName) -->
          <Button
            variant="secondary"
            class="h-[32px] shrink-0 border-border-strong px-[12px] text-[length:var(--text-sm)] [&_svg]:size-[14px]"
            :disabled="r.installed || installingRecommended.has(r.name)"
            @click="onInstallRecommended(r.name)"
          >
            <Loader2 v-if="installingRecommended.has(r.name)" class="animate-spin" />
            <Check v-else-if="r.installed" />
            {{ r.installed ? t('settings.extension.installed') : t('settings.extension.install') }}
          </Button>
        </div>
      </div>
    </GroupCard>

    <!-- 安装区 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.extension.install') }}</h3>
        </div>
      </template>
      <div class="p-[12px_16px]">
        <!-- demo .u-seg 分段（McpServerForm 同款范式）：hairline 边 / r-md / p 2px / 钮 26px r-sm。
             槽底引 --bg-input（凹陷档）：demo --surface-2 = var(--card-inset) 凹陷档，
             real --surface-2 浮起档（登记见 docs/DESIGN.md §4.1 背景层级）同名分叉，
             复刻消费点按 demo 方向引凹陷档 -->
        <div class="mb-[10px] inline-flex gap-[2px] rounded-md border border-hairline bg-bg-input p-[2px]" role="tablist">
          <Button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            role="tab"
            variant="ghost"
            class="h-[26px] rounded-[var(--radius-sm)] px-[10px] text-[length:var(--text-xs)] hover:bg-transparent"
            :class="activeTab === tab.id ? 'bg-surface-hover font-semibold text-neutral-fg' : 'text-neutral-mid hover:text-neutral-fg'"
            :aria-selected="activeTab === tab.id"
            @click="activeTab = tab.id"
          >{{ tab.label }}</Button>
        </div>
        <div class="flex items-center gap-[8px]">
          <Input
            v-model="installInput"
            data-testid="install-input"
            class="flex-1"
            :placeholder="tabPlaceholder"
            @keyup.enter="onInstall"
          />
          <!-- npm 单步直装 = demo .btn.solid；dir/git 多步发现 = demo .btn.secondary -->
          <Button
            :variant="activeTab === 'npm' ? 'default' : 'secondary'"
            class="h-[32px] shrink-0 px-[12px] text-[length:var(--text-sm)]"
            :disabled="!installInput.trim() || installing"
            @click="onInstall"
          >
            <Loader2 v-if="installing" class="animate-spin" />
            {{ installButtonText }}
          </Button>
        </div>
        <!-- 错误反馈（demo：srow-desc danger + padding 6px，无图标；非静默吞，AGENTS.md 规则 #3） -->
        <div v-if="actionError" class="p-[6px] text-[length:var(--text-sm)] text-danger">
          <span class="truncate">{{ actionError }}</span>
        </div>

        <!-- 候选内联展开（dir/git 多步第二步，§6.3 点3：安装卡体内直接展开 = demo 权威位） -->
        <div v-if="discovered" data-testid="install-candidates" class="mt-[4px]">
          <div class="flex min-h-[44px] items-center gap-[8px] border-t border-hairline px-[6px] py-2.5">
            <span class="text-[length:var(--text-sm)] font-semibold text-neutral-fg">{{ t('settings.extension.discoverResultTitle', discovered.candidates.length, { named: { count: discovered.candidates.length } }) }}</span>
            <span class="flex-1" />
            <Button variant="ghost" class="h-[32px] px-[12px] text-[length:var(--text-sm)]" @click="onCancelInstall">{{ t('settings.extension.cancel') }}</Button>
          </div>
          <div v-if="!discovered.candidates.length" class="px-[6px] py-[8px] text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.extension.noCandidates') }}</div>
          <!-- 候选行 = demo .srow 单行内联（chk + name + mono dirName + tag 版本 + desc 同行） -->
          <Label
            v-for="c in discovered.candidates"
            :key="c.dirName"
            class="flex min-h-[44px] cursor-pointer items-center gap-[8px] border-t border-hairline px-[6px] py-2.5"
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
            <span class="min-w-0 flex-1 truncate text-[length:var(--text-sm)] text-neutral-fg">{{ c.name }}</span>
            <span class="min-w-0 truncate font-mono text-[length:var(--text-2xs)] text-[color:var(--neutral-fg-2)]">{{ c.dirName }}</span>
            <span class="inline-flex h-[18px] shrink-0 items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent">v{{ c.version }}</span>
            <span class="min-w-0 flex-[2] truncate text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ c.description }}</span>
          </Label>
          <div v-if="discovered.candidates.length" class="flex min-h-[44px] items-center gap-[8px] border-t border-hairline px-[6px] py-2.5">
            <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.extension.selectedCount', { selected: selected.size, total: discovered.candidates.length }) }}</span>
            <Button variant="ghost" size="dense" class="h-auto px-1.5 py-0.5 text-[length:var(--text-2xs)] text-neutral-mid hover:text-neutral-fg" @click="toggleSelectAll">
              {{ isAllSelected ? t('settings.extension.unselectAll') : t('settings.extension.selectAll') }}
            </Button>
            <span class="flex-1" />
            <Button variant="secondary" class="h-[32px] border-border-strong px-[12px] text-[length:var(--text-sm)]" :disabled="selected.size === 0 || installing" @click="onFinishInstall">
              <Loader2 v-if="installing" class="animate-spin" />
              {{ t('settings.extension.installSelected') }}
            </Button>
          </div>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Check } from '@lucide/vue'
import type { ExtensionDiscoveredPayload, RecommendedExtension } from '@taiji/shared'
import { GroupCard } from '@taiji/ui/features/settings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { getSettingsTransport } from '@taiji/core'
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
    recommended.value = await getSettingsTransport().fetchRecommendedExtensions()
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
    await getSettingsTransport().installExtension(`npm:${pkgName}`)
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
      await getSettingsTransport().installExtension(source)
      installInput.value = ''
      toastInfo(t('settings.extension.installedToast'))
    } else if (activeTab.value === 'dir') {
      const result = await getSettingsTransport().installExtensionDir(input)
      setDiscovered(result)
    } else {
      const result = await getSettingsTransport().installExtensionGitRepository(input)
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
    await getSettingsTransport().finishExtensionInstall(tempDir, selectedNames)
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
    await getSettingsTransport().cancelExtensionInstall(tempDir)
  } catch (e) {
    // tempDir 清理失败仅记录，不阻塞 UI（候选区已关闭）。临时文件可能未清理，需手动检查。
    const baseMsg = e instanceof Error ? e.message : String(e)
    actionError.value = `${baseMsg}${t('settings.extension.cancelInstallTempHint')}`
  }
}
</script>
