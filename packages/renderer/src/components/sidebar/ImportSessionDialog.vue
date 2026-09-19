<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-[620px]" data-testid="import-session-dialog">
      <DialogHeader>
        <DialogTitle>
          {{ phase === 'source' ? t('importSession.pickSourceTitle') : t(activeTitleKey) }}
        </DialogTitle>
        <DialogDescription>
          {{ phase === 'source' ? t('importSession.pickSourceDescription') : t(activeDescriptionKey) }}
        </DialogDescription>
      </DialogHeader>

      <!-- 阶段一：来源选择视图（ImportSourcePicker，设计 §3.1 两选项 + 来源说明；
           选定即进入阶段二拉取该源候选） -->
      <ImportSourcePicker v-if="phase === 'source'" @pick="chooseSource" />

      <template v-else>
      <!-- 返回重选来源（设计 §3.1「左上角可返回重选」；视图切回阶段一，候选数据保留） -->
      <div class="flex items-center">
        <Button
          variant="ghost"
          size="sm"
          data-testid="import-back-btn"
          class="h-7 shrink-0 gap-1 rounded-md px-2 text-xs text-neutral-mid hover:text-neutral-fg"
          @click="backToSource"
        >
          <ArrowLeft class="size-3.5" />
          {{ t('importSession.backToSource') }}
        </Button>
      </div>

      <!-- 搜索：名称 / Session ID / 短 ID / 绝对路径。'/' 或 '~' 开头切路径模式（D5 S7：
           renderer 切形态，runtime 无分支——sourcePath includes 匹配天然覆盖）。
           左 search icon + 右 Esc kbd（demo searchbox 形态；Esc 关闭由 Dialog 原语提供） -->
      <div class="relative">
        <Search
          class="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-neutral-dim"
        />
        <Input
          v-model="query"
          :placeholder="t('importSession.searchPlaceholder')"
          data-testid="import-search-input"
          class="pl-9 pr-11"
          autocomplete="off"
        />
        <kbd
          class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-sm border border-border-strong px-1.5 py-0.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
        >Esc</kbd>
      </div>

      <!-- 目录筛选：「全部目录 ▾」单 chip + 弹出菜单（demo dir-menu：全部 + 各一层子目录
           每项带计数；tooltip 声明扫描深度假设 D3/S8）；「选择其他目录」（V8）同行 + 右侧可见计数 -->
      <div class="flex items-center gap-2">
        <Popover v-model:open="dirMenuOpen">
          <PopoverTrigger as-child>
            <Button
              variant="ghost"
              size="sm"
              data-testid="import-dir-chip"
              class="h-7 shrink-0 gap-1.5 rounded-md border px-2.5 text-xs"
              :class="idleChipClass"
              :title="t('importSession.dirScanHint')"
            >
              <Folder class="size-3 text-neutral-dim" />
              <span class="max-w-[200px] truncate">{{ selectedDirLabel }}</span>
              <ChevronDown class="size-3 text-neutral-dim" />
            </Button>
          </PopoverTrigger>
          <!-- PopoverContent z-[1100] 高于 Dialog(1000)，嵌套弹层不被遮罩压住 -->
          <PopoverContent align="start" class="w-80 p-1" data-testid="import-dir-menu">
            <div class="flex max-h-60 flex-col gap-px overflow-y-auto">
              <Button
                v-for="opt in dirOptions"
                :key="opt.value"
                variant="ghost"
                data-testid="import-dir-option"
                class="h-auto w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-xs"
                :class="selectedDir === opt.value ? 'text-accent' : 'text-neutral-mid'"
                @click="selectDir(opt.value)"
              >
                <Folder
                  class="size-3.5 shrink-0"
                  :class="selectedDir === opt.value ? 'text-accent' : 'text-neutral-dim'"
                />
                <span class="min-w-0 flex-1 truncate" :class="opt.value === '' ? '' : 'font-mono'">
                  {{ opt.label }}
                </span>
                <span class="shrink-0 text-[length:var(--text-3xs)] text-neutral-dim">
                  {{ opt.count }}
                </span>
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <!-- 「选择其他目录」（V8）：切扫描根重拉；虚线边框区分于筛选态 chip。
             自定义根时 title 展示根路径（观察者可见当前扫描位置）。
             仅 pi 源显示——rootDir 是 pi 目录扫描概念，zcode 源换根 out-of-scope -->
        <Button
          v-if="source === 'pi'"
          variant="ghost"
          size="sm"
          data-testid="import-choose-dir-btn"
          class="h-7 shrink-0 rounded-full border border-dashed px-3 py-1 text-xs text-neutral-mid hover:text-neutral-fg"
          :title="rootDir ?? t('importSession.dirScanHint')"
          @click="chooseRootDir()"
        >
          {{ t('importSession.chooseDirBtn') }}
        </Button>
        <span
          v-if="rootDir"
          data-testid="import-root-dir"
          class="max-w-[140px] shrink-0 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim"
          :title="rootDir"
        >{{ rootDir }}</span>
        <span data-testid="import-count" class="ml-auto shrink-0 text-xs text-neutral-dim">
          {{ t('importSession.sessionCount', { visible: filteredItems.length, total }) }}
        </span>
      </div>

      <!-- 路径模式（query 以 '/' 或 '~' 开头）：列表隐藏，路径行展示命中元信息 + 直达导入
           （demo 方案 A path-bar：左 file icon info 色） -->
      <div
        v-if="isPathMode"
        data-testid="import-path-bar"
        class="flex items-center gap-2 rounded-md border border-border px-3 py-2"
      >
        <FileText class="size-3.5 shrink-0 text-info" />
        <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-3xs)] text-neutral-fg">
          {{ query.trim() }}
        </span>
        <span
          data-testid="import-path-meta"
          class="shrink-0 text-[length:var(--text-3xs)] text-neutral-dim"
        >
          {{ pathHit ? `${formatSize(pathHit.size)} · ${formatRelativeTime(pathHit.lastModified)}` : t('importSession.pathNoMatch') }}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="import-path-import-btn"
          class="h-6 shrink-0 rounded-sm px-2 text-xs"
          :disabled="!pathHit || pathHit.alreadyImported || importing"
          @click="pathHit && importSession(pathHit)"
        >
          {{ t('importSession.pathImportBtn') }}
        </Button>
      </div>

      <!-- 候选列表：按 今天/昨天/本周/更早 分组（分组头 + 条目行） -->
      <ScrollArea v-else class="h-[320px]">
        <div class="pr-2">
          <!-- 加载骨架（demo §4「骨架屏不用转圈」）：三段占位块对齐条目行形态
               （icon 块 + 标题行 + 尾部元信息块），shimmer 阶梯延迟复刻 demo 时序 -->
          <div
            v-if="loading"
            data-testid="import-loading"
            aria-busy="true"
            class="flex flex-col gap-1 py-2"
          >
            <div v-for="row in SKELETON_ROWS" :key="row" class="flex items-center gap-2.5 px-3 py-2">
              <span class="size-3.5 shrink-0 animate-pulse rounded-sm bg-surface-2" />
              <span class="h-2.5 min-w-0 flex-1 animate-pulse rounded-sm bg-surface-2 [animation-delay:100ms]" />
              <span class="h-2.5 w-11 shrink-0 animate-pulse rounded-sm bg-surface-2 [animation-delay:200ms]" />
            </div>
          </div>
          <div v-else-if="loadFailed" class="flex flex-col items-center gap-2 px-2 py-8">
            <!-- 识别码按码展示恢复指引（V6 dir_unreadable 可达）；表外/未识别码走通用失败 + 重试 -->
            <p data-testid="import-load-error" class="px-4 text-center text-sm text-neutral-mid">
              {{ loadErrorCode ? errorText(loadErrorCode) : t('importSession.loadFailed') }}
            </p>
            <Button variant="ghost" size="sm" data-testid="import-retry-btn" @click="fetchCandidates">
              {{ t('importSession.retry') }}
            </Button>
          </div>
          <!-- 空结果（demo empty 形态）：给两条出路——换关键词 / 粘贴绝对路径 -->
          <div
            v-else-if="groups.length === 0"
            data-testid="import-empty"
            class="flex flex-col items-center gap-1.5 px-2 py-10 text-center"
          >
            <Search class="size-[22px] text-neutral-faint" />
            <p class="text-[length:var(--text-xs)] text-neutral-mid">
              {{ t('importSession.emptyTitle') }}
            </p>
            <p class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid">
              {{ t('importSession.emptyHint') }}
            </p>
          </div>
          <template v-else v-for="group in groups" :key="group.key">
            <div data-testid="import-group" class="px-1 pb-1 pt-3 text-xs font-medium text-neutral-dim">
              {{ group.label }}
            </div>
            <div
              v-for="item in group.items"
              :key="item.sessionId"
              data-testid="import-item"
              :title="item.sourcePath"
              class="mb-1 cursor-pointer rounded-md border px-3 py-2 transition-colors"
              :class="[
                selectedId === item.sessionId
                  ? 'border-accent-ring bg-surface'
                  : 'border-transparent hover:bg-surface-hover',
                item.alreadyImported ? 'opacity-50' : '',
              ]"
              @click="select(item.sessionId)"
            >
              <div class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                  {{ shortId(item) }}
                </span>
                <span class="min-w-0 flex-1 truncate text-sm text-neutral-fg">
                  {{ item.name || item.dirLabel }}
                </span>
                <!-- 降维徽标（demo badge-dim：surface-2/neutral-mid）区分于 fresh「导入」accent 形态 -->
                <span
                  v-if="item.alreadyImported"
                  data-testid="import-item-imported"
                  class="shrink-0 rounded-sm bg-surface-2 px-1 py-0.5 text-[length:var(--text-3xs)] leading-none text-neutral-mid"
                >{{ t('importSession.importedBadge') }}</span>
                <span class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                  {{ formatSize(item.size) }} · {{ formatRelativeTime(item.lastModified) }}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="import-item-import-btn"
                  class="h-6 shrink-0 rounded-sm px-2 text-xs"
                  :disabled="item.alreadyImported || importing"
                  @click.stop="importSession(item)"
                >
                  {{ t('importSession.importBtn') }}
                </Button>
              </div>
              <div class="mt-1 flex min-w-0 items-center gap-2">
                <!-- 行2 = 原工作目录（设计 §3.1）；全路径 sourcePath 降级为行 title tooltip -->
                <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                  {{ item.cwd }}
                </span>
                <span
                  v-if="!item.cwdExists"
                  data-testid="import-item-cwd-missing"
                  class="shrink-0 text-[length:var(--text-3xs)] text-warn"
                >{{ t('importSession.cwdMissing') }}</span>
              </div>
            </div>
          </template>
        </div>
      </ScrollArea>

      <!-- 导入失败：内联恢复指引（error envelope code → 文案映射，不弹系统对话框；
           zcode 源对部分码走特化文案，见 errorText） -->
      <p v-if="importErrorCode" data-testid="import-error" class="text-xs text-danger">
        {{ errorText(importErrorCode) }}
      </p>
      </template>

      <!-- 底部：阶段二 = 导入目标 project（默认当前活跃）+ 取消 / 导入；阶段一 = 仅取消
           （导入动作在选定来源前无意义；关闭另有右上 X / Esc / 遮罩三通道） -->
      <div class="flex items-center gap-2">
        <template v-if="phase === 'list'">
          <span class="shrink-0 text-sm text-neutral-mid">{{ t('importSession.importTo') }}</span>
          <Select v-model="selectedProjectId">
            <SelectTrigger class="h-8 w-[180px] px-2 text-xs" data-testid="import-project-select">
              <!-- SelectValue 自动 label 依赖 optionsSet（SelectItem 渲染时注册），初始未打开
                   下拉时为空——slot 覆盖为自算名，保证「默认当前激活 project」打开即可见 -->
              <SelectValue>{{ selectedProjectName }}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="p in projectStore.recentProjects"
                :key="p.id"
                :value="p.id"
              >
                {{ p.name || t('importSession.defaultProjectName') }}
              </SelectItem>
            </SelectContent>
          </Select>
        </template>
        <div class="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" data-testid="import-cancel-btn" @click="onCancel">
            {{ t('importSession.cancel') }}
          </Button>
          <Button
            v-if="phase === 'list'"
            size="sm"
            :disabled="!canConfirm"
            data-testid="import-confirm-btn"
            @click="onConfirm"
          >
            {{ importing ? t('importSession.importing') : t('importSession.importBtn') }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, ChevronDown, Search, FileText, ArrowLeft } from '@lucide/vue'
import ImportSourcePicker from '@/components/sidebar/ImportSourcePicker.vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import {
  useImportSession,
  IMPORT_SHORT_ID_LENGTH,
  type ImportSessionImportedPayload,
} from '@/composables/features/sidebar/useImportSession'
import { useProjectStore } from '@/stores/project'
import type { ImportCandidate, ImportSourceKind } from '@taiji/shared'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  imported: [payload: ImportSessionImportedPayload]
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

const {
  open: dialogOpen,
  query,
  source,
  selectSource,
  dirs,
  total,
  loading,
  loadFailed,
  loadErrorCode,
  selectedDir,
  rootDir,
  chooseRootDir,
  selectedProjectId,
  selectedProjectName,
  selectedId,
  importing,
  importErrorCode,
  filteredItems,
  isPathMode,
  pathHit,
  selectedItem,
  canConfirm,
  close,
  resetForOpen,
  select,
  importSession,
  fetchCandidates,
} = useImportSession({ onImported: (payload) => emit('imported', payload) })

const idleChipClass = 'border-border text-neutral-mid hover:text-neutral-fg'

/**
 * 两阶段视图态（设计 §3.7 GUI：同一对话框内切换视图态，不叠弹框）：
 * 'source' = 阶段一来源选择；'list' = 阶段二当前源候选列表（结构两源同构）。
 */
type ImportPhase = 'source' | 'list'
const phase = ref<ImportPhase>('source')

/** 选定来源：进入阶段二（composable 侧按需拉取该源候选） */
function chooseSource(kind: ImportSourceKind): void {
  selectSource(kind)
  phase.value = 'list'
}

/** 返回重选来源（阶段二左上入口；候选数据保留，重进同源不重拉） */
function backToSource(): void {
  phase.value = 'source'
}

/** 阶段二标题/描述按源取（pi = 现有 dialogTitle/description，zcode 同构专属文案） */
const activeTitleKey = computed(() =>
  source.value === 'zcode' ? 'importSession.zcodeDialogTitle' : 'importSession.dialogTitle',
)
const activeDescriptionKey = computed(() =>
  source.value === 'zcode' ? 'importSession.zcodeDescription' : 'importSession.description',
)

/**
 * zcode 源特化恢复指引的错误码（设计 §3.6，与 pi 同码不同义）：未装库 / 会话不在库或
 * schema 漂移——pi 文案里的「选择其他目录」对 zcode 是死路指引；目标位置冲突——zcode 库内
 * 会话无「原始文件名」可选（罕见，换目标 project 不影响本错误），指引联系反馈。
 * 其余码（already_imported / copy_failed 等）两源恢复动作一致，共用通用文案。
 */
const ZCODE_ERROR_KEYS: ReadonlySet<string> = new Set([
  'import_source_missing',
  'import_invalid_session',
  'import_target_conflict',
])

/** 错误码 → 恢复指引起文案（zcode 源对特化码走 errorsZcode，其余回落通用清单） */
function errorText(code: string): string {
  if (source.value === 'zcode' && ZCODE_ERROR_KEYS.has(code)) {
    return t(`importSession.errorsZcode.${code}`)
  }
  return t(`importSession.errors.${code}`)
}

/** 骨架屏占位行数（demo §4 加载骨架 3 行） */
const SKELETON_ROWS = 3

/** 目录下拉菜单开合（demo dir-menu 弹出层） */
const dirMenuOpen = ref(false)

/**
 * 目录菜单项（demo DIRS 形态）：全部目录（计数 = 过滤前总数）+ 各一层子目录
 * （count 来自 reply.dirs）。value '' = 全部（selectedDir 既有语义不变）。
 */
const dirOptions = computed(() => [
  { value: '', label: t('importSession.allDirs'), count: total.value },
  ...dirs.value.map((d) => ({ value: d.label, label: d.label, count: d.count })),
])

/** chip 常显文案 = 当前筛选目录名（未筛 = 全部目录，demo data-dir-label） */
const selectedDirLabel = computed(
  () => dirOptions.value.find((opt) => opt.value === selectedDir.value)?.label ?? t('importSession.allDirs'),
)

/** 菜单项选择：切筛选（客户端过滤）+ 收起菜单 */
function selectDir(value: string): void {
  selectedDir.value = value
  dirMenuOpen.value = false
}

// prop → composable：父层打开时重置状态（含回缺省 pi 源 + 视图回到阶段一来源选择）；
// 关闭时同步收起 + 取消 pending debounce
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetForOpen()
      phase.value = 'source'
    } else {
      close()
    }
  },
  { immediate: true },
)

// composable → prop：导入成功后的 close() 需传导回父层（v-model:open 收口）
watch(dialogOpen, (isOpen) => {
  if (!isOpen && props.open) emit('update:open', false)
})

function onOpenChange(value: boolean): void {
  emit('update:open', value)
}

function onCancel(): void {
  emit('update:open', false)
  close()
}

/** 底部确认导入：作用于当前点选条目（按钮可用性由 canConfirm 保证） */
function onConfirm(): void {
  const item = selectedItem.value
  if (item) void importSession(item)
}

interface ImportGroup {
  key: 'today' | 'yesterday' | 'thisWeek' | 'earlier'
  label: string
  items: ImportCandidate[]
}

const GROUP_KEYS = ['today', 'yesterday', 'thisWeek', 'earlier'] as const

/**
 * 目录过滤后的可见候选按 lastModified 归入 今天/昨天/本周/更早 四组（空组不渲染）。
 * 判定顺序即优先级：昨天先于本周——当昨天落在日历周内（如周三视角的周二）仍归昨天。
 */
const groups = computed<ImportGroup[]>(() => {
  const now = new Date()
  const today = now.toDateString()
  const yesterdayDate = new Date(now)
  yesterdayDate.setDate(now.getDate() - 1)
  const yesterday = yesterdayDate.toDateString()
  const weekStart = startOfWeekMillis(now)
  const buckets: Record<(typeof GROUP_KEYS)[number], ImportCandidate[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  }
  for (const item of filteredItems.value) {
    const dateKey = new Date(item.lastModified).toDateString()
    if (dateKey === today) buckets.today.push(item)
    else if (dateKey === yesterday) buckets.yesterday.push(item)
    else if (item.lastModified >= weekStart) buckets.thisWeek.push(item)
    else buckets.earlier.push(item)
  }
  return GROUP_KEYS.map((key) => ({
    key,
    label: t(`importSession.group.${key}`),
    items: buckets[key],
  })).filter((group) => group.items.length > 0)
})

/** 周日（getDay()=0）回退到本周周一所需的天数 */
const SUNDAY_BACK_TO_MONDAY_DAYS = 6

/** 本周 = 含 now 的日历周（周一起始），返回周一 00:00（本地时区）的时间戳 */
function startOfWeekMillis(now: Date): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = d.getDay() // 0 = 周日
  d.setDate(d.getDate() - (dow === 0 ? SUNDAY_BACK_TO_MONDAY_DAYS : dow - 1))
  return d.getTime()
}

/** 短 ID = uuid 前 6 位（等宽展示，D5 匹配语义同款截断；toast 回退同源常量） */
function shortId(item: ImportCandidate): string {
  return item.sessionId.slice(0, IMPORT_SHORT_ID_LENGTH)
}

/** 文件大小人类可读（B/KB/MB，一位小数） */
const BYTES_PER_KB = 1024
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB

function formatSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${bytes} B`
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`
}
</script>
