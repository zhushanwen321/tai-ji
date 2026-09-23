<!--
  容器组件 · Settings 全屏 overlay（v6 §6.4 D1 + §5.8 GroupCard）。
  数据来自 settings store（单一真相源：providers/skills/agents/extensions/system）。
  store 由 AppShell 应用级 init（常驻订阅），本组件只读 store + open 时刷新 providers。
  形态：fixed inset-0 z-modal bg-bg 全屏覆盖。左 nav 220px（bg-sunken）+ 右 content flex-1（内容列 max-w-720 左对齐）。
  nav 11 项（含 appearance 外观）。header 面包屑「设置 · <page>」+ 右侧 X 关闭。
-->
<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fso fixed inset-0 z-[var(--z-modal)] flex bg-bg"
      role="dialog"
      aria-modal="true"
      :aria-label="t('settings.title')"
      @keydown="onKeydown"
    >
      <!-- 左上 chrome 按钮组（与主应用 AppNavControls 同位 top-5/left-8/translate-x-64 + 同样式 nav-btn）：
           ← 后退退出 settings（回到非 settings 页面）；收起侧栏/前进在 settings 全屏内无可见导航语义，禁用。
           浮在 overlay 层（非 nav 内），确保按钮组定位对齐窗口左上（与主应用一致）且不受 nav 布局影响。 -->
      <div class="absolute top-[5px] left-[8px] z-10 flex gap-0.5 translate-x-[64px] [-webkit-app-region:no-drag]">
        <Button
          variant="ghost"
          size="icon"
          disabled
          class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim disabled:opacity-40"
          :title="t('shell.collapseSidebar')"
          :aria-label="t('shell.toggleSidebar')"
        >
          <PanelLeftClose class="size-[14px]" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
          :title="t('shell.goBack')"
          :aria-label="t('shell.goBack')"
          data-testid="settings-back-btn"
          @click="close"
        >
          <ArrowLeft class="size-[14px]" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled
          class="nav-btn h-[22px] w-[26px] rounded-md text-neutral-dim disabled:opacity-40"
          :title="t('shell.goForward')"
          :aria-label="t('shell.goForward')"
        >
          <ArrowRight class="size-[14px]" />
        </Button>
      </div>
      <!-- 左 nav -->
      <nav ref="navRootEl" class="flex w-[220px] shrink-0 flex-col bg-[var(--bg-sunken)] p-[8px] gap-[1px]" data-settings-nav>
        <!-- traffic light + chrome 让位（44px）：按钮组浮在 overlay 层（上方 absolute，同主应用 AppNavControls
             位置），nav 顶部留白避免遮挡 menus。红黄绿原生位置 x8~60。 -->
        <div class="h-[44px] shrink-0"></div>
        <div class="flex flex-col gap-[1px]">
          <Button
            v-for="item in menus"
            :key="item.id"
            type="button"
            variant="ghost"
            class="nav-item group h-auto w-full flex items-center gap-[8px] py-[8px] px-[10px] rounded-[var(--radius-sm)] text-[length:var(--text-base)] font-normal leading-[1.5] text-left text-neutral-mid whitespace-normal transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] [&:hover:not(.active)]:bg-surface-hover [&:hover:not(.active)]:text-neutral-fg [&.active]:!bg-surface [&.active]:text-accent"
            :class="{ active: item.id === activeMenu }"
            :data-testid="`settings-nav-${item.id}`"
            :aria-current="item.id === activeMenu ? 'page' : undefined"
            @click="select(item.id)"
          >
            <component :is="item.icon" class="!w-[16px] !h-[16px] shrink-0 opacity-[0.85] transition-opacity duration-[var(--duration-fast)] ease-[var(--ease)] group-hover:opacity-100 group-[.active]:opacity-100" />
            <span class="flex-1 min-w-0 truncate">{{ t(item.labelKey) }}</span>
            <span v-if="getItemCount(item.id)" class="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-surface px-[5px] font-mono text-[10px] font-semibold text-neutral-dim shrink-0">{{ getItemCount(item.id) }}</span>
          </Button>
        </div>
      </nav>

      <!-- 右 content -->
      <div ref="contentEl" class="flex min-w-0 flex-1 flex-col bg-bg overflow-auto">
        <div class="flex h-[44px] shrink-0 items-center justify-between px-[14px] border-b border-border">
          <span class="text-[14px] font-semibold text-neutral-fg">{{ t('settings.title') }} · {{ t(currentMenu.labelKey) }}</span>
          <Button
            type="button"
            variant="ghost"
            class="xbtn flex h-[28px] w-[28px] p-0 items-center justify-center rounded-[var(--radius-sm)] text-[length:var(--text-base)] font-normal leading-[1.5] text-neutral-mid whitespace-normal transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:bg-surface-hover hover:text-neutral-fg"
            :title="t('settings.closeEsc')"
            :aria-label="t('settings.close')"
            data-testid="settings-close-btn"
            @click="close"
          >
            <X class="!w-[16px] !h-[16px]" />
          </Button>
        </div>
        <div class="content-col-inner w-full m-0 pt-[var(--space-6)] px-[24px] pb-[var(--space-8)]"
             :style="{ maxWidth: activeMenu === 'usage' ? '1064px' : 'var(--content-max-w)' }">
          <!-- 设置页切换保持瞬时（不加过渡动画）：
               Vue <Transition mode="out-in"> + v-if/else-if 链在 Vue 3.5.39 下 leave
               完成后 enter 不触发（调度 bug，内容区永久空白）；concurrent 模式（无 mode）
               两个 block 页面同时 in-flow 会垂直堆叠、容器高度翻倍。设置页是低频操作，
               瞬时切换是 Linear/Raycast 的标准行为，符合太极克制风格。 -->
          <ProviderPage v-if="activeMenu === 'provider'" :key="activeMenu" :providers="providers" />
          <SettingsResourcePage
            v-else-if="activeMenu === 'skill'"
            :key="activeMenu"
            kind="skill"
            :items="skills"
            :dirs="skillDirs"
            :save-error="skillDirsSaveError"
            @update-dirs="onUpdateSkillDirs"
          />
          <div v-else-if="activeMenu === 'agent'" :key="activeMenu" class="flex flex-col gap-4">
            <!-- [U7] 子代理引擎选择（engines.json 动态清单；置顶为该页第一配置） -->
            <SubagentEngineSection />
            <SettingsResourcePage
              kind="agent"
              :items="agents"
              :dirs="agentDirs"
              :save-error="agentDirsSaveError"
              @update-dirs="onUpdateAgentDirs"
            />
          </div>
          <ExtensionPage v-else-if="activeMenu === 'extension' && extensionView === 'main'" :key="activeMenu" :extensions="extensions" @open-contributions="extensionView = 'contributions'" />
          <PluginContributionsPage v-else-if="activeMenu === 'extension' && extensionView === 'contributions'" :key="'plugin-contributions'" @back="extensionView = 'main'" />
          <SystemPage v-else-if="activeMenu === 'system'" :key="activeMenu" :system="system" @update="onSystemUpdate" />
          <SystemPromptPage v-else-if="activeMenu === 'system-prompt'" :key="activeMenu" />
          <TerminalPage v-else-if="activeMenu === 'terminal'" :key="activeMenu" />
          <PiPresetsPage v-else-if="activeMenu === 'preset'" :key="activeMenu" />
          <WorktreePage v-else-if="activeMenu === 'worktree'" :key="activeMenu" />
          <UpdatePage v-else-if="activeMenu === 'update'" :key="activeMenu" />
          <AppearancePage v-else-if="activeMenu === 'appearance'" :key="activeMenu" :system="system" @update="onSystemUpdate" />
          <UsagePage v-else-if="activeMenu === 'usage'" :key="activeMenu" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { Settings, Sparkles, Bot, Blocks, SlidersHorizontal, ScrollText, TerminalSquare, GitBranch, ClipboardList, X, Download, Palette, BarChart3, ArrowLeft, ArrowRight, PanelLeftClose } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { getSettingsStore, useSettings, type SystemSettings } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import type { SkillDirConfig } from '@taiji/shared'
import ProviderPage from './provider/ProviderPage.vue'
import SettingsResourcePage from './resource/SettingsResourcePage.vue'
import SubagentEngineSection from './agent/SubagentEngineSection.vue'
import ExtensionPage from './extension/ExtensionPage.vue'
import PluginContributionsPage from './extension/PluginContributionsPage.vue'
import SystemPage from './system/SystemPage.vue'
import SystemPromptPage from './system/SystemPromptPage.vue'
import TerminalPage from './terminal/TerminalPage.vue'
import WorktreePage from './worktree/WorktreePage.vue'
import PiPresetsPage from './preset/PiPresetsPage.vue'
import UpdatePage from './update/UpdatePage.vue'
import UsagePage from './usage/UsagePage.vue'
import AppearancePage from './appearance/AppearancePage.vue'

const menus = [
  { id: 'provider', labelKey: 'settings.menu.provider', icon: Settings },
  { id: 'appearance', labelKey: 'settings.menu.appearance', icon: Palette },
  { id: 'skill', labelKey: 'settings.menu.skill', icon: Sparkles },
  { id: 'agent', labelKey: 'settings.menu.agent', icon: Bot },
  { id: 'extension', labelKey: 'settings.menu.extension', icon: Blocks },
  { id: 'system-prompt', labelKey: 'settings.menu.systemPrompt', icon: ScrollText },
  { id: 'terminal', labelKey: 'settings.menu.terminal', icon: TerminalSquare },
  { id: 'preset', labelKey: 'settings.menu.preset', icon: ClipboardList },
  { id: 'worktree', labelKey: 'settings.menu.worktree', icon: GitBranch },
  { id: 'update', labelKey: 'settings.menu.update', icon: Download },
  { id: 'system', labelKey: 'settings.menu.system', icon: SlidersHorizontal },
  { id: 'usage', labelKey: 'settings.menu.usage', icon: BarChart3 },
] as const

type MenuId = (typeof menus)[number]['id']

const { t } = useI18n()

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const activeMenu = ref<MenuId>('provider')
/** extension 域子视图（M16）：main=扩展管理 ExtensionPage / contributions=插件贡献 PluginContributionsPage。 */
const extensionView = ref<'main' | 'contributions'>('main')
const currentMenu = computed(() => menus.find((m) => m.id === activeMenu.value) ?? menus[0])

const settingsStore = getSettingsStore()
const { providers, skills, agents, extensions, system, skillDirs, agentDirs } = settingsStore
const { refreshProviders } = useSettings()

// 打开时刷新 providers + 聚焦首个 nav 项；关闭时还原焦点给触发元素
const triggerEl = ref<HTMLElement | null>(null)
const navRootEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)

// [W31 review major-1] immediate 必须保留：AppShell 懒加载下 settingsOpen=true 与组件挂载同帧，
// props.open 初始即 true，非 immediate watch 无变化沿 → 回调不执行 → refreshProviders
// （settings-lifecycle「打开 modal 时刷新 providers」语义）、triggerEl 捕获、首 nav 项聚焦全部跳过。
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    triggerEl.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
    refreshProviders()
    nextTick(() => {
      navRootEl.value?.querySelector<HTMLElement>('.nav-item')?.focus()
    })
  } else if (triggerEl.value) {
    // 选型说明：当前唯一宿主 AppShell 是 v-if 卸载式（关闭 = settingsOpen=false = 同帧卸载，
    // 本分支不触发，焦点还原由下方 onBeforeUnmount 承接）。保留本分支是 open 契约的自洽性：
    // 组件模板仍以 v-if="open" 表达「常驻挂载 + open 切换」形态，非卸载式宿主（open 变 false
    // 而不卸载）经此分支正确还原焦点；删除会把该场景的焦点还原静默降级为只依赖卸载路径。
    triggerEl.value.focus()
    triggerEl.value = null
  }
}, { immediate: true })

function close(): void {
  emit('update:open', false)
}

/** window 级 ESC 兜底：焦点逃逸到 body（不在 .fso 内）时，.fso 的 @keydown 收不到事件，
 *  需 window 监听兜底。open=true 时注册、false 时自动卸载（reactive target）。
 *  与 .fso 的 onKeydown 并存：焦点在 .fso 内时 onKeydown 先 fire（preventDefault），
 *  本监听检查 defaultPrevented 跳过，避免重复 close。 */
useEventListener(
  () => (props.open ? window : null),
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (e.defaultPrevented) return
    e.preventDefault()
    close()
  },
)

function select(id: MenuId): void {
  activeMenu.value = id
  // 切 nav 时内容列滚动回顶部
  contentEl.value?.scrollTo({ top: 0 })
  // 离开 extension 域时还原子视图（重进默认扩展管理页）
  if (id !== 'extension') extensionView.value = 'main'
}

function getItemCount(id: string): number {
  switch (id) {
    case 'provider': return providers.value.length
    case 'skill': return skills.value.length
    case 'agent': return agents.value.length
    case 'extension': return extensions.value.length
    default: return 0
  }
}

/** 键盘：Tab 循环（焦点陷阱）+ nav 内 ↑↓/Home/End 移动切换 + Esc 关闭。
 *  三路编排（complexity-debt U02 拆分）：Escape / Tab / nav 导航各归独立 helper，落空放行。 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'Tab') {
    handleTabCycle(e)
    return
  }
  handleNavItemNavigation(e)
}

/** Tab 焦点陷阱：焦点在末个且非 shift → 回首个；在首个且 shift → 跳末个；
 *  其余 Tab（中间元素间移动）不拦截，交给浏览器原生顺序。 */
function handleTabCycle(e: KeyboardEvent): void {
  const list = getFocusables()
  if (list.length === 0) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  if (active === last && !e.shiftKey) {
    e.preventDefault()
    first.focus()
  } else if (active === first && e.shiftKey) {
    e.preventDefault()
    last.focus()
  }
}

/** nav 内 ↑↓/Home/End 移动切换：焦点须在 .nav-item 上，否则放行；
 *  越界目标（首条 ↑ / 末条 ↓）与非导航键放行。命中则 preventDefault + 聚焦并切页。 */
function handleNavItemNavigation(e: KeyboardEvent): void {
  const target = e.target
  if (!(target instanceof HTMLElement) || !target.classList.contains('nav-item')) return
  const items = Array.from(navRootEl.value?.querySelectorAll<HTMLElement>('.nav-item') ?? [])
  const i = items.indexOf(target)
  if (i === -1) return
  let next = -1
  if (e.key === 'ArrowDown') next = i + 1
  else if (e.key === 'ArrowUp') next = i - 1
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = items.length - 1
  if (next < 0 || next >= items.length) return
  e.preventDefault()
  items[next].focus()
  select(menus[next].id)
}

function getFocusables(): HTMLElement[] {
  // 整个 overlay（navRoot 的最近 dialog 容器）作为焦点陷阱范围
  const root = navRootEl.value?.closest('.fso') as HTMLElement | null
  if (!root) return []
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

/** SystemPage 偏好更新 → 走 store（写 localStorage + 同步 DOM + i18n）+ toast 反馈。 */
const { info: toastInfo, error: toastError } = useToast()
async function onSystemUpdate(patch: Partial<SystemSettings>): Promise<void> {
  try {
    await settingsStore.setSystem(patch)
    toastInfo(t('settings.applied'))
  } catch (e) {
    toastError(e instanceof Error ? e.message : String(e))
  }
}

// RD-4#1 路径保存失败常驻态（per-kind 各一份）：失败置位 → LoadPaths 回弹至最近落盘值 +
// 常驻红字；每次保存尝试起点复位（成功即消、再失败再亮）。store 不做乐观更新（靠广播推回），
// 失败时无广播，故由该标志驱动 LoadPaths 从 store 镜像（最近落盘值）强制重拉回弹。
const skillDirsSaveError = ref(false)
const agentDirsSaveError = ref(false)

async function onUpdateSkillDirs(dirs: SkillDirConfig[]): Promise<void> {
  skillDirsSaveError.value = false
  try {
    await settingsStore.setSkillDirs(dirs)
  } catch (e) {
    skillDirsSaveError.value = true
    toastError(e instanceof Error ? e.message : String(e))
  }
}

async function onUpdateAgentDirs(dirs: SkillDirConfig[]): Promise<void> {
  agentDirsSaveError.value = false
  try {
    await settingsStore.setAgentDirs(dirs)
  } catch (e) {
    agentDirsSaveError.value = true
    toastError(e instanceof Error ? e.message : String(e))
  }
}

// 卸载路径的焦点还原（与上方 watch else 分支互补，见其选型说明）：懒加载宿主（AppShell
// v-if 门控）关闭即卸载，props.open 观察不到 false 转变，还原在此承接。卸载时 open 仍为
// true（父 v-if 与 props 更新同帧，props 不再 patch），故以 props.open 判定「因关闭而卸载」。
onBeforeUnmount(() => {
  if (props.open && triggerEl.value) triggerEl.value.focus()
})
</script>

<style>
/* ── v6 settings 页共享范式（v6 §6.4 + §5.8）──
   集中定义避免各页 scoped 重复；限定 .content-col-inner 作用域，不污染全局。
   page-head：各页顶部 H1 + 描述 block；gc-sub：GroupCard head slot 内副标题。 */
.content-col-inner .page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.content-col-inner .page-head .head-text { min-width: 0; }
.content-col-inner .page-head .title {
  font-size: 20px;
  font-weight: 600;
  color: var(--neutral-fg);
  letter-spacing: -0.01em;
}
.content-col-inner .page-head .desc {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--neutral-mid);
}
.content-col-inner .page-head .head-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}
.content-col-inner .page-head .head-badge {
  height: 20px;
  padding: 0 var(--space-2);
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--text-2xs);
  font-weight: 600;
}
.content-col-inner .gc-head-text { min-width: 0; }
.content-col-inner .gc-title {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--neutral-fg);
}
.content-col-inner .gc-sub {
  margin-top: 2px;
  font-size: var(--text-2xs);
  color: var(--neutral-mid);
  line-height: 1.4;
}
</style>

<style scoped>
/* [HISTORICAL] 本文件保留 <style scoped> 的原因：.nav-item:focus-visible / .xbtn:focus-visible
   的双环 box-shadow `0 0 0 2px var(--accent), 0 0 0 4px rgba(0,0,0,0.4)` 是多值叠加（内环
   accent + 外环半透明黑），Tailwind 单个 box-shadow 工具类无法表达多值叠加，属 AGENTS.md §3
   明确允许的 escape hatch（与 MainPanel.vue 多值 shadow 同类）。其余几何/颜色/布局/过渡均已
   迁移至 Tailwind 工具类（见 template 各元素 class）。 */
.nav-item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
.xbtn:focus-visible,
.nav-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 4px rgba(0, 0, 0, 0.4);
}
</style>
