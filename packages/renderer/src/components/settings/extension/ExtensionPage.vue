<template>
  <!--
    Settings · Extension 菜单页（方案 A · 安装多步流 + 内联候选展开 + 卸载确认）。
    刷新机制：finishInstall/uninstall 后 runtime 推 config.extensions → onExtensions 订阅（SettingsModal 持有）
    → extensions prop 流入本页，无需本页自建订阅。
    容器职责：header + 加载路径配置 + 装配子组件（安装流 ExtensionInstallFlow / 列表 ExtensionList）。
  -->
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.extension') }}</h1>
        <p class="desc">{{ t('settings.menu.extensionDesc') }}</p>
      </div>
      <!-- 插件贡献子页入口（M16）：SettingsModal 按 extensionView 切换子页，本页 emit 通知切换。 -->
      <div class="head-actions">
        <Button
          size="dense"
          class="rounded-sm text-[12px]"
          data-testid="extension-contributions-entry"
          @click="emit('open-contributions')"
        >
          {{ t('settings.extension.contributionsEntry') }}
        </Button>
      </div>
    </header>

    <!-- 加载路径（Phase 4）：共享 LoadPaths 组件，kind=extension。
         extension 的「优先级」语义因资源类型而异（tool 靠前生效、hook 全部执行），
         故措辞用「加载顺序」而非优先级；新会话生效，无需重启提示。
         不复用 SettingsResourcePage：extension 的实体列表模型与 skill/agent 不同（安装多步流、来源标签）。 -->
    <LoadPaths
      kind="extension"
      :forced-dirs="forcedExtDirs"
      :dirs="extensionDirs"
      :save-error="dirsSaveError"
      @update-dirs="onUpdateExtensionDirs"
    />

    <!-- RD-4#11：数据目录读取失败时的显式标注（user 级强制目录不展示，不伪装真实路径） -->
    <p
      v-if="dataDirReadFailed"
      data-testid="extension-datadir-read-failed"
      class="text-[11px] text-warn"
    >{{ t('settings.extension.dataDirReadFailed') }}</p>

    <!-- 安装流（推荐扩展 + npm/dir/git 安装 + 候选内联展开） -->
    <ExtensionInstallFlow :extensions="extensions" />

    <!-- 已安装列表（行 = ExtensionDetail 信息区 + ExtensionActions 操作区） -->
    <ExtensionList :extensions="extensions" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SkillDirConfig } from '@taiji/shared'
import { LoadPaths, SETTINGS_CONFIG_API_KEY, SETTINGS_CHOOSE_DIRECTORY_KEY } from '@taiji/ui/features/settings'
import { Button } from '@/components/ui/button'
import { config } from '@/api'
import { chooseDirectory, getDataDir } from '@/api/domains/settings'

provide(SETTINGS_CONFIG_API_KEY, config) // LoadPaths(SourceImportSection) 迁 ui，config 经 inject
// v2 §3 目录选择 dialog：LoadPaths 经 inject 调 chooseDirectory（lib/ipc 封装，preload 复用 pick-directory handler）
provide(SETTINGS_CHOOSE_DIRECTORY_KEY, chooseDirectory)
import { getSettingsStore } from '@taiji/core'
import type { ExtensionItem } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import ExtensionInstallFlow from './ExtensionInstallFlow.vue'
import ExtensionList from './ExtensionList.vue'

defineProps<{ extensions: ExtensionItem[] }>()
const emit = defineEmits<{ 'open-contributions': [] }>()
const settingsStore = getSettingsStore()
const { extensionDirs } = settingsStore
const { error: toastError } = useToast()
const { t } = useI18n()

// ── 加载路径配置（Phase 4，接 store.extensionDirs，回写 store.setExtensionDirs）──
/**
 * 强制目录（ADR-0021 §1.1 桥接层硬编码注入，UI 只读展示）。
 * user 级动态推导数据目录——与 SettingsResourcePage 同款：写死 '~/.taiji/extensions' 在
 * dev 下与实际扫描路径不一致、误导排查（resource 页已修过同款问题）。
 * getDataDir 为 async（IPC）；返回失败/无 IPC（web/mock）时保持 null → user 级强制目录
 * 不展示——数据目录缺省 dev（~/.taiji-dev）与打包 prod（~/.taiji）不同（C-proc-26），
 * 兜底断言任一具体路径都会误导排查，reject 时经 dataDirReadFailed 显式标注。
 */
const dataDirDisplay = ref<string | null>(null)
/** RD-4#11：getDataDir 读取失败标记——失败时显式标注，不伪装真实路径。 */
const dataDirReadFailed = ref(false)
onMounted(async () => {
  try {
    const dir = await getDataDir()
    if (dir) dataDirDisplay.value = dir
  } catch (e) {
    // RD-4#11：IPC reject 时不回落写死路径。置位 dataDirReadFailed → 显式标注
    // 「数据目录读取失败」，user 级强制目录不展示，避免误导排查。
    console.warn('[ExtensionPage] getDataDir failed:', e)
    dataDirReadFailed.value = true
  }
})
const forcedExtDirs = computed(() =>
  dataDirDisplay.value ? [`${dataDirDisplay.value}/extensions`, '.taiji/extensions'] : ['.taiji/extensions'],
)

/** 加载路径变更 → store 持久化（整体透传 SkillDirConfig[]，含 scope）。拖拽即时性由 LoadPaths 本地状态保证。
 *  失败常驻态（RD-4#1）：置位 dirsSaveError → LoadPaths 回弹至最近落盘值 + 常驻红字；每次尝试起点复位。 */
const dirsSaveError = ref(false)
async function onUpdateExtensionDirs(dirs: SkillDirConfig[]): Promise<void> {
  dirsSaveError.value = false
  try {
    await settingsStore.setExtensionDirs(dirs)
  } catch (e) {
    dirsSaveError.value = true
    toastError(e instanceof Error ? e.message : String(e))
  }
}
</script>
