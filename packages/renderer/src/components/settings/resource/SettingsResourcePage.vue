<template>
  <!--
    Settings · 资源菜单页（合并自 SkillPage/AgentPage，两者同构 ~85%）。
    ADR-0021 §5：目录级管道模型——目录在 = 启用，无文件级开关。
    层 A 勾选/排序写 discovery.json（SSOT），层 B 只读预览扫描结果。
    通过 kind 区分 skill/agent，差异仅资源类型/标题/来源配色/扫描 API（统一内聚）。
  -->
  <div class="flex flex-col">
    <header class="page-head">
      <div class="head-text">
        <h1 class="title">{{ kind === 'skill' ? t('settings.menu.skill') : t('settings.menu.agent') }}</h1>
        <p class="desc">{{ kind === 'skill' ? t('settings.menu.skillDesc') : t('settings.menu.agentDesc') }}</p>
      </div>
    </header>

    <!-- 层 A · 加载路径（共享组件，接 store *Dirs，emit 回写 store）。
         [w3b] LoadPaths 为 ui 包组件（非 GroupCard，无相邻 margin），mb-16 兜住卡间距。 -->
    <div class="mb-[16px]">
      <LoadPaths
        :kind="kind"
        :forced-dirs="forcedDirs"
        :dirs="dirs"
        :disabled="false"
        :save-error="saveError"
        @update-dirs="onUpdateDirs"
      />
    </div>

    <!-- RD-4#11：数据目录读取失败时的显式标注（user 级强制目录不展示，不伪装真实路径） -->
    <p
      v-if="dataDirReadFailed"
      data-testid="resource-datadir-read-failed"
      class="mb-[16px] text-[length:var(--text-2xs)] text-warn"
    >{{ t('settings.resource.dataDirReadFailed') }}</p>

    <!-- 层 B · 资源只读预览。
         [w3b] demo 对照：AgentSection.vue「已发现的 Agent」卡——卡头 gc-title + .bdg 计数 +
         .btn.secondary 刷新钮（icon 14px / spin 12px）；body = .u-seg tab（mb 10px）+ .srow
         align-start 行（name 14px/600 + 来源 tag 链，首位「生效」后缀、其余 opacity .6，+
         desc max-w 200 截断）。bdg 计数 = 全量清单数（demo found.length，不随 tab 变化）。 -->
    <GroupCard>
      <template #head>
        <div class="gc-head-text">
          <h3 class="gc-title">{{ t('settings.resource.discovered', { label }) }}</h3>
        </div>
      </template>
      <template #actions>
        <span class="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-surface px-[5px] font-mono text-[length:var(--text-3xs)] font-bold text-[color:var(--neutral-fg-2)]">{{ items.length }}</span>
        <Button
          variant="secondary"
          class="h-[32px] gap-[6px] px-[12px] text-[length:var(--text-sm)] [&_svg]:size-[14px]"
          :disabled="scanning"
          @click="onScan"
        >
          <RefreshCw v-if="scanning" class="animate-spin" />
          {{ scanning ? t('settings.resource.refreshing') : t('settings.resource.refresh') }}
        </Button>
      </template>
      <div class="p-[12px_16px]">
        <!-- 来源 tab 过滤（demo .u-seg 分段，McpServerForm 同款范式）。槽底引 --bg-input（凹陷档）：
             demo --surface-2 = var(--card-inset) 凹陷档，real --surface-2 浮起档（登记见
             docs/DESIGN.md §4.1 背景层级）同名分叉，复刻消费点按 demo 方向引凹陷档 -->
        <div class="mb-[10px] inline-flex gap-[2px] rounded-md border border-hairline bg-bg-input p-[2px]" role="tablist">
          <Button
            variant="ghost"
            v-for="tab in sourceTabs"
            :key="tab.id"
            type="button"
            role="tab"
            class="h-[26px] rounded-[var(--radius-sm)] px-[10px] text-[length:var(--text-xs)] hover:bg-transparent"
            :class="activeSource === tab.id ? 'bg-bg-elevated font-semibold text-neutral-fg' : 'text-neutral-mid hover:text-neutral-fg'"
            :aria-selected="activeSource === tab.id"
            @click="activeSource = tab.id"
          >{{ t(tab.labelKey) }}</Button>
        </div>

        <p v-if="actionError" class="mb-[8px] px-[6px] text-[length:var(--text-2xs)] text-danger">{{ actionError }}</p>

        <!-- 空态（demo 卡内空态行：desc p 8px 6px） -->
        <div v-if="!filteredItems.length" class="px-[6px] py-[8px] text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t(activeSource === 'all' ? 'settings.resource.notFound' : 'settings.resource.notFoundInSource', { label }) }}</div>

        <!-- ADR §5：只读预览，无开关无 CRUD。来源 badge 链（demo .tag 形态）+ effective 标生效。 -->
        <div v-for="item in filteredItems" :key="item.id" class="flex min-h-[44px] items-start gap-[16px] border-t border-hairline px-[6px] py-[10px]">
          <span class="min-w-0 flex-1 truncate text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ item.name }}</span>
          <!-- 来源 badge 链（多来源时展开，第一个标生效；demo tag 链 opacity .6） -->
          <span class="flex shrink-0 flex-wrap items-center gap-[4px]">
            <span
              v-for="(src, i) in itemSources(item)"
              :key="src.source + src.sourcePath"
              class="inline-flex h-[18px] items-center rounded-full px-[7px] text-[length:var(--text-2xs)] font-semibold"
              :class="[sourceBadgeClass(src.source), i > 0 ? 'opacity-60' : '']"
              :title="i === 0 ? t('settings.resource.effective') : src.sourcePath"
            >{{ i === 0 ? `${src.source} · ${t('settings.resource.effective')}` : src.source }}</span>
            <!-- 单来源无 badge 链时，直接标 source + 生效 -->
            <span v-if="!itemSources(item).length" class="inline-flex h-[18px] items-center rounded-full px-[7px] text-[length:var(--text-2xs)] font-semibold" :class="sourceBadgeClass(itemSource(item))">{{ itemSource(item) }}</span>
            <span v-if="item.effective && !itemSources(item).length" class="inline-flex h-[18px] items-center rounded-full bg-accent-soft px-[7px] text-[length:var(--text-2xs)] font-semibold text-accent">{{ t('settings.resource.effective') }}</span>
          </span>
          <span class="max-w-[200px] shrink-0 truncate text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]" :title="item.description">{{ item.description }}</span>
        </div>
      </div>
    </GroupCard>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, provide, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { GroupCard, LoadPaths, SETTINGS_CHOOSE_DIRECTORY_KEY } from '@taiji/ui/features/settings'
import type { SkillInfo, AgentInfo, SkillDirConfig } from '@taiji/shared'
import { getSettingsTransport } from '@taiji/core'
import { chooseDirectory, getDataDir } from '@/api/domains/settings'

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
// 动态推导数据目录，修复原硬编码 '~/.taiji/skills' 在 dev 下与实际扫描路径不一致、误导排查的问题。
// getDataDir 为 async（IPC）；返回失败/无 IPC（web/mock）时保持 null → user 级强制目录不展示——
// 数据目录缺省 dev（~/.taiji-dev）与打包 prod（~/.taiji）不同（C-proc-26），兜底断言任一具体
// 路径都会误导排查，reject 时经 dataDirReadFailed 显式标注。
const dataDirDisplay = ref<string | null>(null)
/** RD-4#11：getDataDir 读取失败标记——失败时显式标注，不伪装真实路径。 */
const dataDirReadFailed = ref(false)
onMounted(async () => {
  try {
    const dir = await getDataDir()
    if (dir) dataDirDisplay.value = dir
  } catch (e) {
    // RD-4#11：IPC reject 时不回落写死路径。置位 dataDirReadFailed → 页面显式标注
    // 「数据目录读取失败」，user 级强制目录不展示，避免误导排查。
    console.warn('[SettingsResourcePage] getDataDir failed:', e)
    dataDirReadFailed.value = true
  }
})
const forcedDirs = computed(() => {
  const sub = props.kind === 'skill' ? 'skills' : 'agents'
  return dataDirDisplay.value ? [`${dataDirDisplay.value}/${sub}`, `.taiji/${sub}`] : [`.taiji/${sub}`]
})

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
      await getSettingsTransport().scanSkills(paths)
    } else {
      await getSettingsTransport().scanAgents(paths)
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
 * 软底统一用 *-soft 令牌类（与 FileTreeRow.vue badge 的 bg-success-soft text-success 同款）。
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
