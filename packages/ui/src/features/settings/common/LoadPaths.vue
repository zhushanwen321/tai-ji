<template>
  <!--
    加载路径（层 A）—— Skill/Agent 共享组件（ADR-0021 §5）。
    v6 重构（v6-spec-settings-resources §1/§2/§3）：
    - 按 scope 分两组渲染（项目目录 / 全局目录），项目优先级 > 全局
    - 排序改 ↑↓ 组内移动（组首↑ / 组末↓ disabled），取代 HTML5 拖拽
    - 每组添加区 = 目录选择 dialog（Folder）+ 手动填写（Input + 添加）
    - forcedDirs 只读置顶于项目目录组（Checkbox checked+disabled + Lock + 「系统」tag）
    - §1.1 可见性修复：Checkbox 传局部 class 覆盖未选态边框（不改全局 token）

    零回路：每次勾选/移动/添加/移除都立即改 localDirs 并 emit update-dirs 持久化（发后即忘）。
  -->
  <section data-testid="load-paths">
    <div class="mb-1.5 flex items-baseline gap-2">
      <h3 class="text-[12px] font-medium text-neutral-fg">{{ t('settings.loadPaths.title') }}</h3>
      <span class="text-[11px] text-neutral-mid">{{ t('settings.loadPaths.priorityHint') }}</span>
    </div>

    <!-- RD-4#1 保存失败常驻态：红字标注当前显示的是最近落盘值（不得只靠 toast，toast 会自动消失） -->
    <p
      v-if="saveError"
      data-testid="load-paths-save-error"
      class="mb-1.5 flex items-center gap-1 text-[11px] text-danger"
    >
      <AlertCircle class="size-3 shrink-0" />
      {{ t('settings.loadPaths.saveErrorHint') }}
    </p>

    <div class="overflow-hidden rounded-card bg-card">
      <div
        v-for="scope in SCOPES"
        :key="scope"
        data-testid="dir-group"
        :data-scope="scope"
      >
        <!-- 组头（作用域标：project=accent-soft / global=中性）-->
        <div
          class="flex items-center gap-2 bg-surface-2 px-3 py-2"
          :class="{ 'border-t border-border': scope === 'global' }"
          :data-testid="`group-head-${scope}`"
        >
          <span class="text-[12px] font-semibold text-neutral-fg">
            {{ scope === 'project' ? t('settings.loadPaths.groupProject') : t('settings.loadPaths.groupGlobal') }}
          </span>
          <span
            class="rounded-full px-1.5 py-0.5 font-mono text-[10px]"
            :class="scope === 'project' ? 'bg-accent-soft text-accent' : 'bg-surface text-neutral-mid'"
          >
            {{ scope === 'project' ? t('settings.loadPaths.scopeProject') : t('settings.loadPaths.scopeGlobal') }}
          </span>
          <span class="ml-auto font-mono text-[10px] text-neutral-dim">
            {{ scope === 'project' ? 'projectPaths' : 'globalPaths' }}
          </span>
        </div>

        <!-- 系统锁定目录（仅项目目录组顶部；不可关不可移不可排序）-->
        <template v-if="scope === 'project'">
          <div
            v-for="dir in forcedDirs"
            :key="`forced:${dir}`"
            data-testid="forced-dir-row"
            class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]"
          >
            <Checkbox
              :model-value="true"
              disabled
              class="shrink-0"
              :aria-label="t('settings.loadPaths.enableDir', { path: dir })"
            />
            <span class="flex-1 truncate font-mono text-neutral-fg opacity-60">{{ dir }}</span>
            <Lock class="size-3.5 shrink-0 text-neutral-dim" />
            <span class="rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-neutral-dim">
              {{ t('settings.loadPaths.systemTag') }}
            </span>
          </div>
        </template>

        <!-- 用户可选目录（Checkbox + ↑↓ + 移除）-->
        <div
          v-for="(dir, i) in dirsFor(scope)"
          :key="dir.path"
          data-testid="dir-row"
          :data-scope="scope"
          class="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px]"
        >
          <Checkbox
            :model-value="dir.enabled"
            class="shrink-0"
            :disabled="disabled"
            :aria-label="t('settings.loadPaths.enableDir', { path: dir.path })"
            @update:model-value="onToggle(scope, i, $event)"
          />
          <span class="flex-1 truncate font-mono text-neutral-fg">{{ dir.path }}</span>
          <div class="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              data-testid="move-up-btn"
              class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
              :disabled="disabled || i === 0"
              :aria-label="t('settings.loadPaths.moveUp')"
              @click="moveUp(scope, i)"
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              data-testid="move-down-btn"
              class="size-7 rounded-sm p-0 text-neutral-dim hover:text-neutral-fg"
              :disabled="disabled || i === dirsFor(scope).length - 1"
              :aria-label="t('settings.loadPaths.moveDown')"
              @click="moveDown(scope, i)"
            >
              <ChevronDown />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              data-testid="remove-path-btn"
              class="size-7 rounded-sm p-0 text-danger hover:bg-danger-soft"
              :disabled="disabled"
              :aria-label="t('settings.loadPaths.removeDir', { path: dir.path })"
              @click="onRemove(scope, i)"
            >
              <Trash2 />
            </Button>
          </div>
        </div>

        <!-- 添加路径区（目录选择 dialog + 手动填写校验）-->
        <div class="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <Input
            v-model="newPath[scope]"
            :data-testid="`new-path-input-${scope}`"
            :placeholder="scope === 'project' ? './relative/or/~/or/abs/path' : '/abs/or/~/path'"
            class="h-8 min-w-[180px] flex-1 font-mono text-[12px]"
            :error="!!pathError[scope]"
            :disabled="disabled"
            @keydown.enter="onAddPath(scope)"
          />
          <Button
            variant="secondary"
            size="dense"
            :data-testid="`choose-dir-btn-${scope}`"
            :disabled="disabled || !chooseDirectoryFn"
            @click="onChooseDirectory(scope)"
          >
            <Folder />
            {{ t('settings.loadPaths.chooseDirectory') }}
          </Button>
          <Button
            size="dense"
            :data-testid="`add-path-btn-${scope}`"
            :disabled="disabled"
            @click="onAddPath(scope)"
          >
            <Plus />
            {{ t('settings.loadPaths.addPath') }}
          </Button>
          <p
            v-if="pathError[scope]"
            :data-testid="`path-error-${scope}`"
            class="flex w-full items-center gap-1 text-[11px] text-danger"
          >
            <AlertCircle class="size-3 shrink-0" />
            {{ pathError[scope] }}
          </p>
        </div>
      </div>
    </div>

    <!-- 从其他 Agent 导入（独立卡片，避免嵌套；§4 确认弹窗内置于该组件）-->
    <SourceImportSection
      class="mt-2"
      :kind="kind"
      :existing-dirs="localDirs.filter((d) => d.enabled).map((d) => d.path)"
      :disabled="disabled"
      @import="onImportFromAgents"
    />

    <p v-if="kind === 'agent'" class="mt-1.5 text-[11px] text-neutral-dim">{{ t('settings.loadPaths.agentRestartHint') }}</p>
    <p v-else-if="kind === 'extension'" class="mt-1.5 text-[11px] text-neutral-dim">{{ t('settings.loadPaths.extensionLoadOrderHint') }}</p>
  </section>
</template>

<script setup lang="ts">
import { Checkbox, Input, Button } from '@taiji/ui'
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronUp, ChevronDown, Trash2, Lock, Folder, Plus, AlertCircle } from '@lucide/vue'

import SourceImportSection from './SourceImportSection.vue'
import { useChooseDirectory } from '../injection-keys'
import type { SkillDirConfig } from '@taiji/shared'

type Scope = 'project' | 'global'

const props = defineProps<{
  /** 强制目录路径（只读置顶于项目目录组，ADR-0021 §1.1 层 1-2） */
  forcedDirs: string[]
  /** 可选目录配置（来自 store，元素含 scope） */
  dirs: SkillDirConfig[]
  /** 资源类型：skill 即时生效，agent 需重开会话，extension 新会话生效 */
  kind: 'skill' | 'agent' | 'extension'
  /** 操作禁用（扫描中等场景） */
  disabled?: boolean
  /** 保存失败常驻态（RD-4#1）：置位时 localDirs 回弹至最近落盘值（props.dirs）并常驻红字标注 */
  saveError?: boolean
}>()

const emit = defineEmits<{
  /** 目录配置变更（勾选/排序/添加/移除），父组件写回 store */
  'update-dirs': [dirs: SkillDirConfig[]]
}>()

const { t } = useI18n()
const chooseDirectoryFn = useChooseDirectory()

const SCOPES: Scope[] = ['project', 'global']

// 单一数组（含 scope）—— emit 透传整个有序数组；渲染按 scope 分组
const localDirs = ref<SkillDirConfig[]>([...props.dirs])

watch(
  () => props.dirs,
  (next) => {
    localDirs.value = next.map((d) => ({ ...d }))
  },
  { deep: true },
)

// RD-4#1 失败回弹：保存失败时 runtime 不广播（仅成功落盘后广播），store 仍持最近落盘值，
// 而本组件的乐观编辑（commit）已让 localDirs 偏离。saveError 置位时强制从 props.dirs
// （store 广播镜像）重拉，界面回弹至最近落盘值——不引入第二套本地状态。
watch(
  () => props.saveError,
  (failed) => {
    if (failed) localDirs.value = props.dirs.map((d) => ({ ...d }))
  },
)

const projectDirs = computed(() => localDirs.value.filter((d) => d.scope === 'project'))
const globalDirs = computed(() => localDirs.value.filter((d) => d.scope === 'global'))

function dirsFor(scope: Scope): SkillDirConfig[] {
  return scope === 'project' ? projectDirs.value : globalDirs.value
}

/** 显示索引 → localDirs 真实索引（组内过滤后定位）*/
function realIndex(scope: Scope, displayIdx: number): number {
  let count = 0
  for (let i = 0; i < localDirs.value.length; i++) {
    if (localDirs.value[i].scope === scope) {
      if (count === displayIdx) return i
      count++
    }
  }
  return -1
}

/** 写入 + emit（发后即忘，零回路）*/
function commit(next: SkillDirConfig[]): void {
  localDirs.value = next
  emit('update-dirs', next.map((d) => ({ ...d })))
}

// ── 组内 ↑↓ 移动（splice 交换相邻，组首↑/组末↓ disabled 由模板守卫）──
function moveUp(scope: Scope, displayIdx: number): void {
  if (props.disabled || displayIdx <= 0) return
  const a = realIndex(scope, displayIdx - 1)
  const b = realIndex(scope, displayIdx)
  if (a < 0 || b < 0) return
  const next = [...localDirs.value]
  ;[next[a], next[b]] = [next[b], next[a]]
  commit(next)
}

function moveDown(scope: Scope, displayIdx: number): void {
  if (props.disabled) return
  if (displayIdx >= dirsFor(scope).length - 1) return
  const a = realIndex(scope, displayIdx)
  const b = realIndex(scope, displayIdx + 1)
  if (a < 0 || b < 0) return
  const next = [...localDirs.value]
  ;[next[a], next[b]] = [next[b], next[a]]
  commit(next)
}

/** Checkbox 勾选 → 立即改 localDirs + emit 持久化 */
function onToggle(scope: Scope, displayIdx: number, value: string | boolean): void {
  const idx = realIndex(scope, displayIdx)
  if (idx < 0) return
  const enabled = value === true
  const next = localDirs.value.map((d, i) => (i === idx ? { ...d, enabled } : d))
  commit(next)
}

/** 彻底移除条目（区别于取消勾选）*/
function onRemove(scope: Scope, displayIdx: number): void {
  if (props.disabled) return
  const idx = realIndex(scope, displayIdx)
  if (idx < 0) return
  commit(localDirs.value.filter((_, i) => i !== idx))
}

// ── 添加路径（手动填写）──
const newPath = ref<Record<Scope, string>>({ project: '', global: '' })
const pathError = ref<Record<Scope, string>>({ project: '', global: '' })

/** 全局目录限绝对路径（spec §3 校验正则）；项目目录允许相对+绝对 */
const ABSOLUTE_RE = /^(\/|~\/|[A-Za-z]:\\)/

function onAddPath(scope: Scope): void {
  const path = newPath.value[scope].trim()
  if (!path) return
  if (localDirs.value.some((d) => d.path === path)) {
    pathError.value[scope] = t('settings.loadPaths.pathExists')
    return
  }
  if (scope === 'global' && !ABSOLUTE_RE.test(path)) {
    pathError.value[scope] = t('settings.loadPaths.pathFormatError')
    return
  }
  pathError.value = { ...pathError.value, [scope]: '' }
  newPath.value = { ...newPath.value, [scope]: '' }
  commit([...localDirs.value, { path, enabled: true, scope }])
}

/** 目录选择 dialog（经注入；选完直接 push 该 scope 组末尾）*/
async function onChooseDirectory(scope: Scope): Promise<void> {
  if (props.disabled || !chooseDirectoryFn) return
  let selected: string | null
  try {
    selected = await chooseDirectoryFn()
  } catch {
    return
  }
  if (!selected) return
  if (localDirs.value.some((d) => d.path === selected)) {
    pathError.value = { ...pathError.value, [scope]: t('settings.loadPaths.pathExists') }
    return
  }
  pathError.value = { ...pathError.value, [scope]: '' }
  commit([...localDirs.value, { path: selected, enabled: true, scope }])
}

/**
 * 从其他 Agent 导入（§4：SourceImportSection 确认后 emit）。
 * 按 spec §4 anno，导入默认写入 projectPaths（项目目录组）；去重按 path 字面相等。
 */
function onImportFromAgents(paths: string[]): void {
  if (props.disabled) return
  const existing = new Set(localDirs.value.map((d) => d.path))
  const additions: SkillDirConfig[] = []
  for (const path of paths) {
    if (existing.has(path)) continue
    existing.add(path)
    additions.push({ path, enabled: true, scope: 'project' })
  }
  if (additions.length === 0) return
  commit([...localDirs.value, ...additions])
}
</script>
