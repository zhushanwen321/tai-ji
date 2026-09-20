<template>
  <!--
    Settings · 资源菜单页（合并自 SkillPage/AgentPage，两者同构 ~85%）。
    ADR-0021 §5：目录级管道模型——目录在 = 启用，无文件级开关。
    层 A 勾选/排序写 discovery.json（SSOT），层 B 只读预览扫描结果。
    通过 kind 区分 skill/agent，差异仅资源类型/标题/来源配色/扫描 API（统一内聚）。
  -->
  <div class="flex flex-col gap-4">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ kind === 'skill' ? t('settings.menu.skill') : t('settings.menu.agent') }}</h1>
        <p class="desc">{{ kind === 'skill' ? t('settings.menu.skillDesc') : t('settings.menu.agentDesc') }}</p>
      </div>
    </header>

    <!-- 层 A · 加载路径（共享组件，接 store *Dirs，emit 回写 store） -->
    <LoadPaths
      :kind="kind"
      :forced-dirs="forcedDirs"
      :dirs="dirs"
      :disabled="false"
      :save-error="saveError"
      @update-dirs="onUpdateDirs"
    />

    <!-- 层 B · 资源只读预览 -->
    <section>
      <!-- 来源 tab 过滤 -->
      <div class="mb-2 flex items-center gap-2">
        <h3 class="text-[12px] font-medium text-neutral-fg">{{ t('settings.resource.discovered', { label }) }}</h3>
        <span class="rounded-sm bg-surface px-1.5 py-0.5 text-[10px] text-neutral-dim">{{ filteredItems.length }}</span>
        <Button
          variant="secondary"
          class="ml-1 gap-1.5 rounded-sm px-2 py-0.5 text-[11px] [&_svg]:size-3"
          :disabled="scanning"
          @click="onScan"
        >
          <RefreshCw v-if="scanning" class="animate-spin" />
          {{ scanning ? t('settings.resource.refreshing') : t('settings.resource.refresh') }}
        </Button>
        <div class="ml-auto flex gap-0.5">
          <Button
            variant="ghost"
            v-for="tab in sourceTabs"
            :key="tab.id"
            class="h-auto rounded-sm px-2 py-0.5 text-[11px]"
            :class="activeSource === tab.id ? 'bg-bg-elevated text-neutral-fg' : 'text-neutral-mid hover:text-neutral-fg'"
            @click="activeSource = tab.id"
          >{{ t(tab.labelKey) }}</Button>
        </div>
      </div>

      <p v-if="actionError" class="mb-2 text-[11px] text-danger">{{ actionError }}</p>

      <div v-if="!filteredItems.length" class="py-8 text-center text-[12px] text-neutral-mid">{{ t(activeSource === 'all' ? 'settings.resource.notFound' : 'settings.resource.notFoundInSource', { label }) }}</div>

      <!-- ADR §5：只读预览，无开关无 CRUD。来源 badge 链 + effective 标生效。 -->
      <div v-for="item in filteredItems" :key="item.id" class="flex items-center gap-2 rounded-card bg-card px-3 py-2">
        <span class="flex-1 truncate text-[12px] font-medium text-neutral-fg">{{ item.name }}</span>
        <!-- 来源 badge 链（多来源时展开，第一个标生效） -->
        <span
          v-for="(src, i) in itemSources(item)"
          :key="src.source + src.sourcePath"
          class="rounded-sm px-1.5 py-0.5 text-[10px]"
          :class="[sourceBadgeClass(src.source), i === 0 ? 'ring-1 ring-inset ring-accent/40' : 'opacity-60']"
          :title="i === 0 ? t('settings.resource.effective') : src.sourcePath"
        >{{ i === 0 ? `${t('settings.resource.effective')}·${src.source}` : src.source }}</span>
        <!-- 单来源无 badge 链时，直接标 source + 生效 -->
        <span v-if="!itemSources(item).length" class="rounded-sm px-1.5 py-0.5 text-[10px]" :class="sourceBadgeClass(itemSource(item))">{{ itemSource(item) }}</span>
        <span v-if="item.effective && !itemSources(item).length" class="rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{{ t('settings.resource.effective') }}</span>
        <span class="max-w-[200px] truncate text-[11px] text-neutral-dim" :title="item.description">{{ item.description }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, provide, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { LoadPaths, SETTINGS_CONFIG_API_KEY, SETTINGS_CHOOSE_DIRECTORY_KEY } from '@taiji/ui/features/settings'
import type { SkillInfo, AgentInfo, SkillDirConfig } from '@taiji/shared'
import { config } from '@/api'
import { chooseDirectory, getDataDir } from '@/api/domains/settings'

// W3：LoadPaths（含 SourceImportSection）迁入 ui 包，其 config(@/api) 依赖经 inject 注入。
// 此处把 renderer 的 config 作为 SettingsConfigApi provide 给 ui 组件（detectSources 等方法）。
provide(SETTINGS_CONFIG_API_KEY, config)
// v2 §3 目录选择 dialog：LoadPaths 经 inject 调 chooseDirectory（lib/ipc 封装，preload 复用 pick-directory handler）
provide(SETTINGS_CHOOSE_DIRECTORY_KEY, chooseDirectory)

/**
 * 资源类型。用 kind 单 prop 内部 switch（而非 props 爆炸）：
 * 差异全是配置（标题/来源/扫描 API/forcedDirs），领域知识内聚于此组件，
 * 调用方只需传 kind + 数据，不必关心 skill vs agent 的实现细节。
 */
const props = defineProps<{
  kind: 'skill' | 'agent'
  /** 资源列表（skills 或 agents） */
  items: SkillInfo[] | AgentInfo[]
  /** 加载路径配置（来自 settings store，ADR-0021 §1 discovery.json SSOT 视图） */
  dirs: SkillDirConfig[]
  /** 路径保存失败常驻态（RD-4#1）：由 SettingsModal 的持久化 catch 置位，透传 LoadPaths */
  saveError?: boolean
}>()

const emit = defineEmits<{
  /** 目录配置变更 → 父组件写回 store（setSkillDirs / setAgentDirs） */
  'update-dirs': [dirs: SkillDirConfig[]]
}>()

// ── kind 驱动的配置（差异内聚于此） ──
const label = computed(() => (props.kind === 'skill' ? 'Skill' : 'Agent'))

// ADR-0021 §1.1 强制目录（桥接层硬编码注入，UI 只读）
// 动态推导数据目录（dev=~/.taiji-dev，prod=~/.taiji），修复原硬编码 '~/.taiji/skills'
// 在 dev 下与实际扫描路径不一致、误导排查的问题。getDataDir 为 async（IPC），初始用默认值兜底，
// 拉取完成后更新。
const dataDirDisplay = ref('~/.taiji')
onMounted(async () => {
  const dir = await getDataDir()
  if (dir) dataDirDisplay.value = dir
})
const forcedDirs = computed(() =>
  props.kind === 'skill'
    ? [`${dataDirDisplay.value}/skills`, '.taiji/skills']
    : [`${dataDirDisplay.value}/agents`, '.taiji/agents'],
)

const { t } = useI18n()

// 来源 tab 过滤（skill/agent 共用 4 项；agent 实际无 pi-install 来源，tab 仍可点但结果为空）
const sourceTabs = [
  { id: 'all', labelKey: 'settings.resource.sourceAll' },
  { id: 'pi', labelKey: 'settings.resource.sourcePi' },
  { id: 'claude', labelKey: 'settings.resource.sourceClaude' },
  { id: 'agents', labelKey: 'settings.resource.sourceAgents' },
] as const

const activeSource = ref<string>('all')
const scanning = ref(false)
const actionError = ref('')

const filteredItems = computed(() =>
  activeSource.value === 'all'
    ? props.items
    : props.items.filter((i) => sourceOf(i) === activeSource.value),
)

/** 归一化取 source（SkillInfo 必填 / AgentInfo 可选）。
 *  'piinstall' 归一化到 'pi'（来源 tab 过滤时 pi-install 来源归入 pi tab，避免空结果）。 */
function sourceOf(item: SkillInfo | AgentInfo): string {
  const s = item.source ?? ''
  return s === 'piinstall' ? 'pi' : s
}

// 模板辅助：保持 item.source / item.sources 的可空兼容
function itemSource(item: SkillInfo | AgentInfo): string {
  return sourceOf(item)
}

/** 取多来源 badge 链（ADR §5）；单来源时返回空数组（用主 source 标识）。
 * SkillInfo/AgentInfo 均含 sources? 字段（shared 契约对称），统一复用同一链逻辑。 */
function itemSources(item: SkillInfo | AgentInfo): Array<{ source: string; sourcePath: string }> {
  return item.sources ?? []
}

/** 加载路径变更（勾选/拖排序）→ emit 给父组件，由 SettingsModal 统一写 store（避免重复请求）。
 * 拖拽的即时性已由 LoadPaths 本地状态保证，这里只负责持久化（发后即忘）。 */
function onUpdateDirs(dirs: SkillDirConfig[]): void {
  actionError.value = ''
  emit('update-dirs', dirs)
}

/** 刷新已加载列表（ADR-0021 §5 只读模型：扫描只刷新 discovery 目录扫描结果，不做文件级导入）。 */
async function onScan(): Promise<void> {
  scanning.value = true
  actionError.value = ''
  try {
    const paths = props.dirs.filter((d) => d.enabled).map((d) => d.path)
    if (props.kind === 'skill') {
      await config.scanSkills(paths)
    } else {
      await config.scanAgents(paths)
    }
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  } finally {
    scanning.value = false
  }
}

/**
 * 来源 badge 配色——token 化（ADR-0019）：全部用 design-tokens 语义色，
 * 禁止直引 Tailwind 调色板（amber/emerald/violet）。
 * skill/agent 配色统一：pi=accent(主色) · claude=warning · agents=success · pi-install=info。
 * /12 软底透明度对齐 FileTreeRow.vue 既有的 badge 模式（bg-success/12 text-success）。
 */
function sourceBadgeClass(source: string): string {
  const map: Record<string, string> = {
    pi: 'bg-accent-soft text-accent',
    claude: 'bg-warn-soft text-warn',
    agents: 'bg-success-soft text-success',
    piinstall: 'bg-info-soft text-info',
  }
  return map[source] ?? 'bg-surface text-neutral-mid'
}
</script>
