<!--
  容器组件 · Settings 全屏 overlay（demo .pg-set .settings 形态 + v6 §6.4 D1）。
  数据来自 settings store（单一真相源：providers/skills/agents/extensions/system）。
  store 由 AppShell 应用级 init（常驻订阅），本组件只读 store + open 时刷新 providers。
  形态：fixed inset-0 z-modal bg-bg 全屏覆盖。左 nav 252px（bg-sunken + 右 hairline 分隔，
  三组头分组，nav 列表自身滚动）+ 右 content flex-1（内容列 max-w 720/860/1064 三态左对齐）。
  header 面包屑「设置 · <page>」+ 右侧 X 关闭。
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
      <!-- 左上 chrome 按钮组（demo .chrome：fixed top 9px / left 8px / gap 2px，钮 32x32 r-sm、icon 15px；
           顺序 = 后退（可用）· 收起侧栏 · 前进，与主应用 win-chrome 同位接管形态。
           浮在 overlay 层（非 nav 内），确保按钮组定位对齐窗口左上且不受 nav 布局影响。
           平移按平台（推导同 AppNavControls / DESIGN.md §11）：基准 left 8 + 平移 = 灯组右缘 + 6px 盒距
           （demo .lights margin-right 4 + 行 gap 2，实测 6.00）- 8；mac 灯组 OS 绘制（macOS 26 实测右缘 x≈68）
           → 66，win/linux 自绘灯组右缘 60 → 58。 -->
      <div
        class="absolute top-[9px] left-[8px] z-10 flex gap-[2px] [-webkit-app-region:no-drag]"
        :class="isMac ? 'translate-x-[66px]' : 'translate-x-[58px]'"
      >
        <Button
          variant="ghost"
          size="icon"
          class="nav-btn relative h-[32px] w-[32px] rounded-[var(--radius-sm)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg focus-visible:ring-0 focus-visible:ring-offset-0 after:absolute after:-inset-[3px] after:content-['']"
          :title="t('shell.goBack')"
          :aria-label="t('shell.goBack')"
          data-testid="settings-back-btn"
          @click="close"
        >
          <ArrowLeft class="size-[15px]" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled
          class="nav-btn h-[32px] w-[32px] rounded-[var(--radius-sm)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-mid focus-visible:ring-0 focus-visible:ring-offset-0"
          :title="t('shell.collapseSidebar')"
          :aria-label="t('shell.toggleSidebar')"
        >
          <PanelLeftClose class="size-[15px]" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled
          class="nav-btn h-[32px] w-[32px] rounded-[var(--radius-sm)] text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-mid focus-visible:ring-0 focus-visible:ring-offset-0"
          :title="t('shell.goForward')"
          :aria-label="t('shell.goForward')"
        >
          <ArrowRight class="size-[15px]" />
        </Button>
      </div>
      <!-- 左 nav（demo .s-nav：252px + 右 1px hairline 分隔；nav 列表自身滚动 flex-1 overflow-y-auto） -->
      <aside class="flex w-[252px] shrink-0 flex-col border-r border-hairline bg-[var(--bg-sunken)] p-[8px]" data-settings-nav>
        <!-- traffic light + chrome 让位（44px）：按钮组浮在 overlay 层（上方 absolute，同主应用 AppNavControls
             位置），nav 顶部留白避免遮挡 menus。红黄绿原生位置 x8~60。 -->
        <div class="h-[44px] shrink-0"></div>
        <nav ref="navRootEl" :aria-label="t('settings.title')" class="flex min-h-0 flex-1 flex-col gap-[1px] overflow-y-auto pb-[8px]">
          <template v-for="group in navGroups" :key="group.labelKey">
            <!-- demo .nv-group：text-2xs neutral-mid，padding 10/10/3，字距 0.02em；首组头顶距 2px -->
            <div class="px-[10px] pb-[3px] pt-[10px] text-[length:var(--text-2xs)] tracking-[0.02em] text-neutral-mid first:pt-[2px]">{{ t(group.labelKey) }}</div>
            <Button
              v-for="item in group.items"
              :key="item.id"
              type="button"
              variant="ghost"
              class="nav-item group h-auto w-full flex items-center gap-[8px] py-[8px] px-[10px] rounded-[var(--radius-sm)] text-[length:var(--text-base)] font-normal leading-[1.5] text-left text-neutral-mid whitespace-normal transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] focus-visible:ring-0 focus-visible:ring-offset-0 [&:hover:not(.active)]:bg-surface-hover [&:hover:not(.active)]:text-neutral-fg [&.active]:bg-surface [&.active]:text-neutral-fg"
              :class="{ active: item.id === activeMenu }"
              :data-testid="`settings-nav-${item.id}`"
              :aria-current="item.id === activeMenu ? 'page' : undefined"
              @click="select(item.id)"
            >
              <component :is="item.icon" class="w-[16px] h-[16px] shrink-0 opacity-[0.85] transition-opacity duration-[var(--duration-fast)] ease-[var(--ease)] group-hover:opacity-100 group-[.active]:opacity-100" />
              <span class="flex-1 min-w-0 truncate">{{ t(item.labelKey) }}</span>
              <span v-if="getItemCount(item.id)" class="inline-flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-surface px-[5px] font-mono text-[length:var(--text-3xs)] font-bold text-[color:var(--neutral-fg-2)] group-hover:bg-bg-card group-[.active]:text-neutral-fg shrink-0">{{ getItemCount(item.id) }}</span>
            </Button>
          </template>
        </nav>
      </aside>

      <!-- 右 content -->
      <div ref="contentEl" class="flex min-w-0 flex-1 flex-col bg-bg overflow-auto">
        <div class="flex h-[44px] shrink-0 items-center justify-between px-[14px] border-b border-border">
          <span class="text-[length:var(--text-sm)] font-semibold text-neutral-fg">{{ t('settings.title') }} · {{ t(currentMenu.labelKey) }}</span>
          <Button
            ref="closeBtnEl"
            type="button"
            variant="ghost"
            class="xbtn relative flex h-[28px] w-[28px] p-0 items-center justify-center rounded-[var(--radius-sm)] text-[length:var(--text-base)] font-normal leading-[1.5] text-neutral-mid whitespace-normal transition-colors duration-[var(--duration-fast)] ease-[var(--ease)] hover:bg-surface-hover hover:text-neutral-fg focus-visible:ring-0 focus-visible:ring-offset-0 after:absolute after:-inset-[3px] after:content-['']"
            :title="t('settings.closeEsc')"
            :aria-label="t('settings.close')"
            data-testid="settings-close-btn"
            @click="close"
          >
            <X class="w-[16px] h-[16px]" />
          </Button>
        </div>
        <div class="content-col-inner w-full m-0 pt-[var(--space-6)] px-[24px] pb-[var(--space-8)]"
             :style="{ maxWidth: contentMaxWidth }">
          <!-- 分区切换（demo settings spec §2/§3.3 裁决 6A）：已访问分区 v-show 常挂载 +
               sec-fade 类随激活位移动。不用 <Transition>（Vue 3.5.39 out-in leave 后 enter
               不触发、concurrent 两页堆叠），不用 KeepAlive（只缓存组件 vnode，分支里的
               普通 element 包装层不进缓存、实例不保留）——demo 同款机制兼容性最稳：
               v-show 保留组件实例（表单态跨分区不丢），display:none ↔ 可见切换 + 类重挂
               重触发 300ms 淡入。分区首访才挂载（visitedViews），避免开弹层即触发全部
               15 分区的加载副作用。extension 域子视图（contributions）是独立访问键，
               切回扩展管理页表单态同样保留。 -->
          <template v-for="view in visitedViews" :key="view">
            <div v-show="activeView === view" class="sec-fade" :class="{ on: activeView === view }">
              <ProviderPage v-if="view === 'provider'" :providers="providers" :is-active="activeView === 'provider'" />
              <SettingsResourcePage
                v-else-if="view === 'skill'"
                kind="skill"
                :items="skills"
                :dirs="skillDirs"
                :save-error="saveSkillDirs.saveError.value"
                @update-dirs="saveSkillDirs.run"
              />
              <div v-else-if="view === 'agent'" class="flex flex-col gap-4">
                <!-- [U7] 子代理引擎选择（engines.json 动态清单；置顶为该页第一配置） -->
                <SubagentEngineSection />
                <SettingsResourcePage
                  kind="agent"
                  :items="agents"
                  :dirs="agentDirs"
                  :save-error="saveAgentDirs.saveError.value"
                  @update-dirs="saveAgentDirs.run"
                />
              </div>
              <ExtensionPage v-else-if="view === 'extension'" :extensions="extensions" @open-contributions="extensionView = 'contributions'" />
              <PluginContributionsPage v-else-if="view === 'extension-contributions'" @back="extensionView = 'main'" />
              <SystemPage v-else-if="view === 'system'" :system="system" @update="onSystemUpdate" />
              <NetworkPage v-else-if="view === 'network-proxy'" />
              <SystemPromptPage v-else-if="view === 'system-prompt'" />
              <RenameSessionPage v-else-if="view === 'rename-session'" />
              <TerminalPage v-else-if="view === 'terminal'" :is-active="activeView === 'terminal'" />
              <McpSection v-else-if="view === 'mcp'" />
              <PiPresetsPage v-else-if="view === 'preset'" />
              <TtsPage v-else-if="view === 'tts'" />
              <WorktreePage v-else-if="view === 'worktree'" />
              <UpdatePage v-else-if="view === 'update'" />
              <RemoteAccessPage v-else-if="view === 'remote-access'" />
              <AppearancePage v-else-if="view === 'appearance'" :system="system" :is-active="activeView === 'appearance'" @update="onSystemUpdate" />
              <UsagePage v-else-if="view === 'usage'" />
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { Settings, Sparkles, Bot, Blocks, SlidersHorizontal, ScrollText, Tag, TerminalSquare, GitBranch, ClipboardList, Server, Volume2, X, Download, Palette, ChartColumn, ArrowLeft, ArrowRight, PanelLeftClose, Wifi, Waypoints, type LucideIcon } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { registerModalSurface, otherSurfaceYieldsEsc } from '@/composables/features/app/modal-surface-registry'
import { detectPlatform } from '@/composables/effects/usePlatformChrome'
import { cycleTabFocus, getFocusableElements } from '@/composables/logic/focus-trap'
import { getSettingsStore, useSettings, type SystemSettings } from '@taiji/core'
import { useToast } from '@/composables/useToast'
import { createMirrorSave } from '@/composables/features/settings/setting-field'
import type { SkillDirConfig } from '@taiji/shared'
import ProviderPage from './provider/ProviderPage.vue'
import SettingsResourcePage from './resource/SettingsResourcePage.vue'
import SubagentEngineSection from './agent/SubagentEngineSection.vue'
import ExtensionPage from './extension/ExtensionPage.vue'
import PluginContributionsPage from './extension/PluginContributionsPage.vue'
import SystemPage from './system/SystemPage.vue'
import SystemPromptPage from './system/SystemPromptPage.vue'
import RenameSessionPage from './rename-session/RenameSessionPage.vue'
import TerminalPage from './terminal/TerminalPage.vue'
import McpSection from './mcp/McpSection.vue'
import WorktreePage from './worktree/WorktreePage.vue'
import PiPresetsPage from './preset/PiPresetsPage.vue'
import TtsPage from './tts/TtsPage.vue'
import UpdatePage from './update/UpdatePage.vue'
import RemoteAccessPage from './remote-access/RemoteAccessPage.vue'
import UsagePage from './usage/UsagePage.vue'
import AppearancePage from './appearance/AppearancePage.vue'
import NetworkPage from './network/NetworkPage.vue'

// mac 灯组为 OS 绘制，几何随系统版本 → 左上 chrome 组平移按平台分叉（推导见 template 内注释）
const isMac = detectPlatform() === 'mac'

// 左 nav 分组（demo NAV_GROUPS 形态：三组头 + 组内项；渲染与键盘 ↑↓/Home/End 顺序均按此结构）。
// 仅展示层分组，不改分区注册/store 契约（menus 各项的 id/labelKey/icon 原样保留）。
const navGroups = [
  {
    labelKey: 'settings.menu.groupResources',
    items: [
      { id: 'provider', labelKey: 'settings.menu.provider', icon: Settings },
      { id: 'skill', labelKey: 'settings.menu.skill', icon: Sparkles },
      { id: 'agent', labelKey: 'settings.menu.agent', icon: Bot },
      { id: 'extension', labelKey: 'settings.menu.extension', icon: Blocks },
      { id: 'mcp', labelKey: 'settings.menu.mcp', icon: Server },
      { id: 'preset', labelKey: 'settings.menu.preset', icon: ClipboardList },
    ],
  },
  {
    labelKey: 'settings.menu.groupInputAppearance',
    items: [
      { id: 'appearance', labelKey: 'settings.menu.appearance', icon: Palette },
      { id: 'system-prompt', labelKey: 'settings.menu.systemPrompt', icon: ScrollText },
      { id: 'rename-session', labelKey: 'settings.menu.sessionRename', icon: Tag },
      { id: 'tts', labelKey: 'settings.menu.tts', icon: Volume2 },
      { id: 'terminal', labelKey: 'settings.menu.terminal', icon: TerminalSquare },
    ],
  },
  {
    labelKey: 'settings.menu.groupEnvSystem',
    items: [
      { id: 'worktree', labelKey: 'settings.menu.worktree', icon: GitBranch },
      { id: 'update', labelKey: 'settings.menu.update', icon: Download },
      { id: 'remote-access', labelKey: 'settings.menu.remoteAccess', icon: Wifi },
      { id: 'network-proxy', labelKey: 'settings.menu.networkProxy', icon: Waypoints },
      { id: 'system', labelKey: 'settings.menu.system', icon: SlidersHorizontal },
      { id: 'usage', labelKey: 'settings.menu.usage', icon: ChartColumn },
    ],
  },
] as const

type MenuId = (typeof navGroups)[number]['items'][number]['id']

/** 键盘 ↑↓/Home/End 导航与页查找用的平铺顺序（= 显示顺序）；显式注解 + spread 拷贝解
 *  as const 元组 flatMap 的推断塌缩（readonly 字面量元组直接 flatMap 会推成数组联合） */
const flatMenus: readonly { id: MenuId; labelKey: string; icon: LucideIcon }[] =
  navGroups.flatMap((group) => [...group.items])

const { t } = useI18n()

const props = defineProps<{ open: boolean; /** 直达分区（AppShell openSettings(section) 传入；非法值回落 provider——侧栏远程钮等深链入口用） */ initialSection?: string }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

// 模态表面聚合注册（§6.7）：开合态绑 props.open 状态本体；旗标组由登记表按 id 读取
// （模态族双键均让位 + shieldsView unconditional）。onBeforeUnmount 卸载对称注销。
const disposeSurfaceRegistration = registerModalSurface({
  surface: 'settings-modal',
  key: 'settings-modal',
  isOpen: () => props.open,
})
onBeforeUnmount(disposeSurfaceRegistration)

const activeMenu = ref<MenuId>(
  flatMenus.some((m) => m.id === props.initialSection) ? (props.initialSection as MenuId) : 'provider',
)
/** extension 域子视图（M16）：main=扩展管理 ExtensionPage / contributions=插件贡献 PluginContributionsPage。 */
const extensionView = ref<'main' | 'contributions'>('main')
const currentMenu = computed(() => flatMenus.find((m) => m.id === activeMenu.value) ?? flatMenus[0])
/** keyed 访问键（v-show 常挂载渲染表）：nav 分区 id；extension 域子视图展开为独立键
 *  （切回扩展管理页表单态保留）。其余分区键 = 分区 id 本身。 */
const activeView = computed(() =>
  activeMenu.value === 'extension' && extensionView.value === 'contributions'
    ? 'extension-contributions'
    : (activeMenu.value as string),
)
/** 已访问分区清单（首访挂载，此后 v-show 常挂载——demo「15 分区组件常挂载、切分区
 *  不丢已填表单与交互态」的 real 形态；首访才挂载是 real 侧加载副作用的收敛差异）。
 *  activeView 变化即登记，覆盖 nav 点击与 extension 子视图事件两条进入路径。 */
const visitedViews = ref<string[]>([])
watch(activeView, (view) => {
  if (!visitedViews.value.includes(view)) visitedViews.value.push(view)
}, { immediate: true })

// 内容列限宽三态（demo：wide=--content-max-w-wide 1064（usage）· narrow 860（mcp/system-prompt，
// demo P2「限宽双实现」收敛值）· 其余 --content-max-w 720）
const contentMaxWidth = computed(() => {
  if (activeMenu.value === 'usage') return 'var(--content-max-w-wide)'
  if (activeMenu.value === 'mcp' || activeMenu.value === 'system-prompt' || activeMenu.value === 'rename-session') return '860px'
  return 'var(--content-max-w)'
})

const settingsStore = getSettingsStore()
const { providers, skills, agents, extensions, system, skillDirs, agentDirs } = settingsStore
const { refreshProviders } = useSettings()

// 打开时刷新 providers + 焦点落点 = 顶栏关闭钮（demo settings spec §2/§3.1 锚定行为）；
// 关闭时还原焦点给触发元素
const triggerEl = ref<HTMLElement | null>(null)
const navRootEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)
/** 关闭钮（Button 封装单根 native button，模板 ref 拿组件实例——$el 即按钮元素） */
const closeBtnEl = ref<{ $el?: HTMLElement } | null>(null)

// [W31 review major-1] immediate 必须保留：AppShell 懒加载下 settingsOpen=true 与组件挂载同帧，
// props.open 初始即 true，非 immediate watch 无变化沿 → 回调不执行 → refreshProviders
// （settings-lifecycle「打开 modal 时刷新 providers」语义）、triggerEl 捕获、焦点落点（关闭钮）
// 全部跳过。
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    triggerEl.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
    refreshProviders()
    nextTick(() => {
      // 焦点落点 = 顶栏关闭钮（demo settings spec §3.1「打开时焦点移入顶栏关闭钮」）
      closeBtnEl.value?.$el?.focus()
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
 *  本监听检查 defaultPrevented 跳过，避免重复 close。
 *  内层弹层让位（demo settings spec §3.2 Esc 三段分流前两段）：壳内确认弹层 / 下拉 / popover
 *  开着时 Esc 归该内层（reka DismissableLayer 自行 dismiss 且不 preventDefault，事件必然
 *  冒泡到本监听）——查聚合登记表跳过自关，「Esc 只关内层、已填表单不丢」。 */
useEventListener(
  () => (props.open ? window : null),
  'keydown',
  (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (e.defaultPrevented) return
    if (otherSurfaceYieldsEsc('settings-modal')) return
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
 *  三路编排（complexity-debt U02 拆分）：Escape / Tab / nav 导航各归独立 helper，落空放行。
 *  Esc 内层让位与 window 兜底同口径（见其注释）——焦点在下拉触发钮上时事件先经本 handler
 *  再冒泡到 window，两路都须查内层，否则下拉开着按 Esc 整壳被关（Esc 死区的反面）。 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (otherSurfaceYieldsEsc('settings-modal')) return
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'Tab') {
    cycleTabFocus(e, getFocusables)
    return
  }
  handleNavItemNavigation(e)
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
  select(flatMenus[next].id)
}

/** overlay 内可聚焦元素（Tab 循环三路语义见共享单元 focus-trap）。
 *  整个 overlay（navRoot 的最近 dialog 容器）作为焦点陷阱范围 */
function getFocusables(): HTMLElement[] {
  const root = navRootEl.value?.closest('.fso')
  return root ? getFocusableElements(root) : []
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

// RD-4#1 路径保存（per-kind 各一份，setting-field module · createMirrorSave）：失败置位 →
// LoadPaths 回弹至最近落盘值 + 常驻红字；每次保存尝试起点复位（成功即消、再失败再亮）。
// store 不做乐观更新（靠广播推回），失败时无广播，标志是唯一回弹信号（契约见 module 实现注释）。
const saveSkillDirs = createMirrorSave((dirs: SkillDirConfig[]) => settingsStore.setSkillDirs(dirs))
const saveAgentDirs = createMirrorSave((dirs: SkillDirConfig[]) => settingsStore.setAgentDirs(dirs))

// 卸载路径的焦点还原（与上方 watch else 分支互补，见其选型说明）：懒加载宿主（AppShell
// v-if 门控）关闭即卸载，props.open 观察不到 false 转变，还原在此承接。卸载时 open 仍为
// true（父 v-if 与 props 更新同帧，props 不再 patch），故以 props.open 判定「因关闭而卸载」。
onBeforeUnmount(() => {
  if (props.open && triggerEl.value) triggerEl.value.focus()
})
</script>

<style>
/* ── v6 settings 页共享范式（demo .pg-set 段对齐）──
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
  color: var(--neutral-fg-2);
  line-height: 1.4;
}
/* 卡内设置行描述弱化档（demo `.pg-set .gcard .srow-desc` → neutral-fg-2）：
   SettingRow desc 默认 neutral-mid，进 GroupCard（.group-card）后切次级正文档。 */
.content-col-inner .group-card .setting-row-desc {
  color: var(--neutral-fg-2);
}

/* 内容区按钮焦点环（demo pages.css `.pg-set button:focus-visible` → outline 2px
   var(--focus-ring)（焦点指示唯一令牌，style.css 定义 = accent 别名）、offset -1px 内缩，
   作用于设置弹层全部按钮）：容器作用域一次收敛全部页面层按钮，不逐钮覆写。
   box-shadow: none 关闭 Button cva 基类 focus-visible ring 通道（Tailwind ring 编译为
   box-shadow，外扩 ring+offset 双层），焦点指示统一收归本 outline 内缩通道。 */
.content-col-inner button:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -1px;
  box-shadow: none;
}
/* 选中主题行的静态 inset 描边在键盘焦点态恢复：上方容器规则的 box-shadow:none 收敛
   Button cva 外扩环通道时，会连带抹掉主题行（@layer utilities 静态类）的选中 inset
   描边——demo 同场景 outline 与 inline inset 环同时呈现（AppearanceSection 主题行
   inline boxShadow 恒挂，类规则压不掉）。本规则同处 unlayered 且特异性 (0,4,0) 压过
   容器规则 (0,2,1)，仅按静态值恢复选中行的 inset 描边；cva 外扩环继续被容器压制。 */
.content-col-inner .theme-row[aria-pressed="true"]:focus-visible {
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

/* 弹层域级滚动条（demo pages.css `.pg-set ::-webkit-scrollbar`：10px 宽 + thumb
   border-strong / r-xs 圆角 / 2px 透明边 background-clip:content-box 收窄出悬浮感；
   覆盖全局 4px faint 隐蔽条，与 MessageStream 域级覆盖同模式，不动全局） */
.fso ::-webkit-scrollbar { width: 10px; height: 10px; }
.fso ::-webkit-scrollbar-thumb {
  background: var(--border-strong);
  border-radius: var(--radius-xs);
  border: 2px solid transparent;
  background-clip: content-box;
}

/* 首卡去线（demo pages.css `.pg-set .page > .gcard:first-of-type .gcard-head`）：仅页面
   首张卡的卡头去顶部高光线；GroupCard 内置的恒命中 first-child 去线已删，此处域级承接 */
.content-col-inner .group-card:first-of-type .group-head { border-top: 0; }

/* 弹层开合过渡（demo `.pg-set .settings` fade-in 0.16s ease，reduced-motion 门控）+
   分区切换淡入（demo settings spec §3.3 裁决 6A：激活分区 300ms 纯淡入 --ease-out；
   sec-fade 类随激活位移动——demo 同款：类重挂即重触发，v-show 显示切换不重建组件）。
   keyframes 局部命名不进全局 SSOT：仅本弹层消费、无其他挂点（非共享动画原语）。 */
@media (prefers-reduced-motion: no-preference) {
  .fso { animation: settings-fade-in 0.16s ease; }
  .content-col-inner .sec-fade.on { animation: settings-sec-fade-in 300ms var(--ease-out); }
}
@keyframes settings-fade-in { from { opacity: 0; } }
@keyframes settings-sec-fade-in { from { opacity: 0; } }
</style>

<style scoped>
/* 焦点环（demo .pg-set 焦点语言：outline 2px solid var(--focus-ring)，--focus-ring = accent 别名）
   offset -1px 内缩贴合圆角。Button cva 自带 focus-visible ring 通道：nav/chrome 各按钮
   class 上 ring-0 关闭、收归本 outline 通道；内容区页面层按钮由上方共享范式段的
   .content-col-inner button:focus-visible 容器规则统一收敛，不逐钮覆写。 */
.nav-item:focus-visible,
.xbtn:focus-visible,
.nav-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -1px;
}
</style>
