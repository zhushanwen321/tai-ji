<template>
  <!--
    BrowserPane —— 嵌入式浏览器面板（Browser Drawer Wave 2 + Wave 3）。

    挂在 SideDrawer 的 browser tab，点击 agent 输出的 http(s) 链接 → drawer.open('browser',{url})
    → SideDrawer 显本组件 → onMounted 创建 WebContentsView（主进程）+ pushRect（推 viewport 元素位置/尺寸）
    + 加载 url + show。主进程 view 经 setBounds 定位到本组件 browser-vp 元素，覆盖渲染真实页面。
    主进程 webContents 事件经 onBrowserState 推回，更新地址栏真实 URL（防钓鱼）+ loading/error 态。

    Wave 2 最小闭环：
    - 导航栏骨架（back/forward 占位 disabled，reload 可用，外链导出降级到系统浏览器）
    - 加载 / 错误 / 空态三态切换

    Wave 3 rect 同步：
    - ResizeObserver + window resize + rAF + 33ms 节流推 viewport 元素 rect 给主进程 setRect
    - show 前先 pushRect（否则 lastRect 是 HIDDEN_RECT，show 后 view 在 0,0,0,0）
    - [HISTORICAL] rect 不乘 devicePixelRatio（setBounds 用 DIP，与 CSS px 1:1）

    安全：WebContentsView 由主进程创建，零信任 webPreferences（contextIsolation + sandbox），
    本组件不接触 webContents，只经 IPC 触发 create/navigate/hide/show/setRect。
  -->
  <div class="flex h-full flex-col" data-testid="browser-pane">
    <!-- 首次使用引导（spec §4.6：首次触发时提示条，可关闭，localStorage 记录已看过） -->
    <div
      v-if="showGuide"
      class="flex flex-shrink-0 items-center gap-2 border-b border-border bg-accent-soft px-3 py-2"
      data-testid="browser-guide"
    >
      <Globe class="size-4 flex-shrink-0 text-accent" />
      <span class="flex-1 text-[length:var(--text-xs)] text-neutral-fg">{{ t('panel.browserPane.guideHint') }}</span>
      <Button variant="ghost" size="sm" class="flex-shrink-0" data-testid="browser-guide-close" @click="dismissGuide">
        <X class="size-3" />
      </Button>
    </div>
    <!-- 导航栏骨架 -->
    <div class="flex-shrink-0 border-b border-border">
      <div class="flex items-center gap-1 px-2 py-1.5">
        <Button variant="ghost" size="icon" :disabled="!canGoBack" data-testid="browser-back" class="size-7" :title="t('panel.browserPane.back')" @click="goBack">
          <ArrowLeft />
        </Button>
        <Button variant="ghost" size="icon" :disabled="!canGoForward" data-testid="browser-forward" class="size-7" :title="t('panel.browserPane.forward')" @click="goForward">
          <ArrowRight />
        </Button>
        <Button variant="ghost" size="icon" data-testid="browser-reload" class="size-7" :title="t('panel.browserPane.reload')" @click="reload">
          <RotateCw />
        </Button>
        <!-- 地址栏：可输入导航 + 显示真实 URL（主进程 did-navigate 回填，防钓鱼）。
             非编辑态显示真实 URL；点击/聚焦进入编辑态可输入新 URL，回车导航，Escape 回填放弃。-->
        <div
          class="mx-1 flex flex-1 items-center gap-1.5 rounded-full bg-bg-input px-3 py-1"
          data-testid="browser-urlbar"
        >
          <Lock v-if="isSecure" class="size-3 flex-shrink-0 text-success" />
          <Input
            v-model="urlInput"
            class="h-6 flex-1 border-transparent bg-transparent px-1 font-mono text-[length:var(--text-2xs)] text-neutral-fg focus-visible:border-transparent focus-visible:ring-0"
            data-testid="browser-urlbar-input"
            :placeholder="t('panel.browserPane.urlPlaceholder')"
            @keydown.enter="onUrlEnter"
            @keydown.escape="onUrlEscape"
            @focus="onUrlFocus"
          />
        </div>
        <!-- 复制链接 -->
        <Button
          variant="ghost"
          size="icon"
          data-testid="browser-copy-url"
          class="size-7"
          :title="t('panel.browserPane.copyUrl')"
          :disabled="!displayUrl"
          @click="copyUrl"
        >
          <component :is="copied ? Check : Copy" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          data-testid="browser-open-external"
          class="size-7"
          :title="t('panel.browserPane.openExternal')"
          :disabled="!displayUrl"
          @click="openInExternal"
        >
          <ExternalLink />
        </Button>
      </div>
    </div>

    <!-- 登录墙提示（spec §4.2：检测 401/403 → 醒目提示条 + 系统浏览器出口）-->
    <div
      v-if="loginRequired"
      class="flex flex-shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-2"
      data-testid="browser-login-wall"
    >
      <AlertCircle class="size-4 flex-shrink-0 text-warn" />
      <div class="min-w-0 flex-1">
        <p class="text-[length:var(--text-xs)] font-medium text-warn">{{ t('panel.browserPane.loginRequired') }}</p>
        <p class="truncate text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.browserPane.loginHint') }}</p>
      </div>
      <Button variant="ghost" size="sm" class="flex-shrink-0" @click="openInExternal">
        <ExternalLink class="size-3" />
      </Button>
    </div>

    <!-- viewport 区域（Wave 3：主进程 WebContentsView 经 setRect 定位到本元素的位置/尺寸，
         真实页面由主进程 view 覆盖渲染；本组件仅渲染加载 / 错误 / 空态覆盖层）。-->
    <div ref="viewportEl" class="relative min-h-0 flex-1 bg-bg" data-testid="browser-vp">
      <!-- 加载态 -->
      <div
        v-if="isLoading"
        class="absolute inset-0 flex flex-col items-center justify-center gap-3"
        data-testid="browser-loading"
      >
        <div class="size-6 animate-spin rounded-full border-2 border-border border-t-accent" />
        <span class="font-mono text-[length:var(--text-2xs)] text-neutral-mid">{{ displayUrl }}</span>
      </div>
      <!-- 错误态 -->
      <div
        v-else-if="error"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4"
        data-testid="browser-error"
      >
        <AlertCircle class="size-8 text-danger" />
        <span class="text-[length:var(--text-sm)] font-semibold text-neutral-fg">{{ t('panel.browserPane.loadFailed') }}</span>
        <span class="max-w-[240px] text-center text-[length:var(--text-2xs)] text-neutral-mid">{{ error.errorDescription }}</span>
        <div class="mt-2 flex gap-2">
          <Button variant="secondary" size="sm" @click="reload">{{ t('panel.browserPane.retry') }}</Button>
          <Button variant="ghost" size="sm" @click="openInExternal">{{ t('panel.browserPane.openExternal') }}</Button>
        </div>
      </div>
      <!-- 空态（无 url）-->
      <div
        v-else-if="!url"
        class="absolute inset-0 flex flex-col items-center justify-center gap-2"
        data-testid="browser-empty"
      >
        <Globe class="size-10 text-neutral-dim opacity-40" />
        <span class="text-[length:var(--text-xs)] text-neutral-dim">{{ t('panel.browserPane.empty') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * BrowserPane 脚本：生命周期 + rect 同步 + 状态订阅。
 * 流程：onMounted → browserCreate + ResizeObserver + window resize → nextTick：pushRect → 若 url：navigate + show → 订阅 onBrowserState
 * onBeforeUnmount → browserHide + 清理监听 + 取消订阅
 * pushRect 用 getBoundingClientRect()（CSS px，[HISTORICAL] 不乘 dpr）；onBrowserState 更新 displayUrl（防钓鱼）+ loading/error
 * windowId 从 URLSearchParams(window.location.search).get('windowId') 读（window-factory 注入）
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Lock,
  ExternalLink,
  AlertCircle,
  Globe,
  Copy,
  Check,
  X,
} from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  browserCreate,
  browserNavigate,
  browserHide,
  browserShow,
  browserBack,
  browserForward,
  onBrowserState,
  openExternal,
} from '@/lib/ipc'
import { useBrowserZoom } from '@/composables/features/browser/useBrowserZoom'
import { useBrowserRectSync } from '@/composables/features/browser/useBrowserRectSync'
import { useUrlBar } from '@/composables/features/url-bar/useUrlBar'

/** 主进程推送的 browser 加载错误结构（与 BrowserViewState.error 对齐） */
interface BrowserLoadError {
  errorCode: number
  errorDescription: string
  validatedURL: string
}

/** HTTP 401 Unauthorized（登录墙检测） */
const HTTP_UNAUTHORIZED = 401
/** HTTP 403 Forbidden（登录墙检测，权限不足也常因未登录） */
const HTTP_FORBIDDEN = 403
/** 复制成功反馈显示时长（ms） */
const COPY_FEEDBACK_MS = 2000
/** 登录墙检测（spec §4.2）：HTTP 401/403 errorCode → 显提示条。
 * did-fail-load 的 errorCode 对应 HTTP 状态码（-3=ABORTED 已在主进程过滤）。 */
const LOGIN_ERROR_CODES = new Set([HTTP_UNAUTHORIZED, HTTP_FORBIDDEN])
/** localStorage key：首次使用引导是否已关闭 */
const GUIDE_DISMISSED_KEY = 'taiji-browser-guide-dismissed'

/** 首次使用引导（spec §4.6）：未关闭过则显示。localStorage 持久化跨 session 记住。
 * [W5] initial=false，在 onMounted 中读 localStorage 同步：避开 SSR / 隐私模式 / iframe 下
 * setup() 顶层调 safeLocalStorage 抛 SecurityError 时的默认显示问题。保守默认：不确定就隐藏。 */
const showGuide = ref<boolean>(false)

/** 关闭首次引导，持久化到 localStorage */
function dismissGuide(): void {
  showGuide.value = false
  safeLocalStorage()?.setItem(GUIDE_DISMISSED_KEY, '1')
}

/** 安全访问 localStorage（隐私模式/iframe 抛 SecurityError 时返回 null） */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const props = defineProps<{
  /** widget 订阅的 session 标识（与 SideDrawer sessionId 一致，作 WebContentsView key） */
  sessionId: string
  /** 打开时立即加载的 URL（点击 agent 输出的链接传入）；为空显空态 */
  url: string
}>()

const { t } = useI18n()

/** viewport 容器 ref（Wave 3：主进程 WebContentsView 经 setRect 定位到该元素的位置/尺寸） */
const viewportEl = ref<HTMLElement | null>(null)

/** 地址栏显示 URL：初始 = props.url，由 onBrowserState 更新为真实 URL（防钓鱼） */
const displayUrl = ref<string>(props.url)
/** 加载态（初始有 url 时 true，等主进程 did-stop-loading 推 false） */
const isLoading = ref<boolean>(Boolean(props.url))
/** 最近一次加载错误（成功导航后清空） */
const error = ref<BrowserLoadError | null>(null)
/** 是否可后退（主进程 navigationHistory.canGoBack 回传，控制 back 按钮 disabled） */
const canGoBack = ref<boolean>(false)
/** 是否可前进 */
const canGoForward = ref<boolean>(false)
/** 复制成功反馈（点复制后 2s 内显 Check icon） */
const copied = ref<boolean>(false)
/** copyUrl 的 setTimeout ID（onBeforeUnmount 清理） */
const copyTimerId = ref<number | null>(null)

/** 缩放管理（Wave 5）：zoomFactor 状态 + Cmd+/-/0 快捷键 + 主进程 IPC 同步 */
const { onZoomKeydown, setZoomFromRemote } = useBrowserZoom(toRef(props, 'sessionId'))

const loginRequired = computed<boolean>(() =>
  error.value !== null && LOGIN_ERROR_CODES.has(error.value.errorCode),
)

/** 是否 https（地址栏锁标） */
const isSecure = computed(() => displayUrl.value.startsWith('https://'))

// 地址栏编辑态管理（composable）：urlInput v-model + 聚焦/回车/Escape 处理。
// 回车时补全协议前缀 + 触发 navigate + 设置 loading 态（导航反馈）。
// [HISTORICAL] PR #100 B1 第一层防御：useUrlBar 内部已集成危险协议拦截 + toast，
// 命中黑名单时不 navigate、不退出编辑态（保用户输入便于修正）。
// 主进程 handler + manager 还有第二/三层白名单 + 黑名单，三道防线独立函数。
const { urlInput, onUrlFocus, onUrlEnter, onUrlEscape } = useUrlBar(displayUrl, (url) => {
  isLoading.value = true
  error.value = null
  void browserNavigate(props.sessionId, url).catch(() => {
    // 保底重置 loading：主进程 onBrowserState 也会推送 did-fail-load 错误态
    isLoading.value = false
  })
})

/**
 * 读取当前窗口的 windowId。
 * window-factory 创建窗口时把 windowId 注入 URL query（dev: ?windowId=win-1；prod: loadFile query）。
 * 项目无现成 getCurrentWindowId 工具，从 window.location.search 读最简。
 */
function getCurrentWindowId(): string {
  try {
    return new URLSearchParams(window.location.search).get('windowId') ?? ''
  } catch {
    return ''
  }
}

// rect 同步（Wave 3）：ResizeObserver + window resize + Splitter CustomEvent → 节流推主进程
const { pushRect, dispose: disposeRectSync } = useBrowserRectSync(viewportEl, () => props.sessionId)

/** onBrowserState 取消订阅函数（onBeforeUnmount 调） */
let unsubscribe: (() => void) | null = null

onMounted(() => {
  // [W5] 同步引导状态（避开 SSR / 隐私模式 / iframe 场景 setup() 顶层调 localStorage 报 SecurityError）
  showGuide.value = safeLocalStorage()?.getItem(GUIDE_DISMISSED_KEY) === null

  const windowId = getCurrentWindowId()
  // [W4] windowId 缺失 fail-fast：避免推 windowId='' 到主进程主则 windows.get('') 失败
  // （PR #100 W1 静默吞错误）。运行时缺失说明调用路径异常。
  if (!windowId) {
    console.warn('[browser-pane] windowId missing from URL query, skip browserCreate')
    return
  }
  // 创建 WebContentsView（attach 到主窗口，初始隐藏）。幂等：已存在则主进程复用。
  void browserCreate(props.sessionId, windowId)

  // 缩放快捷键（Cmd/Ctrl +/-/0）
  window.addEventListener('keydown', onZoomKeydown)

  // 有 url：先 pushRect（更新 lastRect）再 navigate + show（show 时 setBounds(lastRect) 定位到正确位置）。
  // nextTick 确保 DOM 布局完成（getBoundingClientRect 才有真实值）。
  nextTick(() => {
    pushRect()
    if (props.url) {
      void browserNavigate(props.sessionId, props.url)
      void browserShow(props.sessionId)
    }
  })

  // 订阅状态推送（地址栏真实 URL 回填 + loading/error/canGoBack/canGoForward/zoomFactor 态）。仅处理本 sessionId。
  unsubscribe = onBrowserState((state) => {
    if (state.sessionId !== props.sessionId) return
    if (state.currentUrl) displayUrl.value = state.currentUrl
    isLoading.value = state.isLoading
    error.value = state.error
    canGoBack.value = state.canGoBack
    canGoForward.value = state.canGoForward
    // 主进程 autoFit 后回推 zoomFactor，同步本地基准（用户 Cmd+/- 在此基准上微调）
    if (typeof state.zoomFactor === 'number') setZoomFromRemote(state.zoomFactor)
  })
})

onBeforeUnmount(() => {
  // hide（keep-alive，不 destroy）：切 tab/关 drawer 时隐藏 WebContentsView，下次打开复用。
  // fire-and-forget：Vue 3 生命周期钩子不支持 async/await，主进程 hide 是幂等的，
  // 卸载完成后 IPC 消息仍会正常送达主进程执行隐藏。
  void browserHide(props.sessionId)
  // 清理定时器
  if (copyTimerId.value) {
    clearTimeout(copyTimerId.value)
    copyTimerId.value = null
  }
  // 清理 rect 同步 + 缩放快捷键
  disposeRectSync()
  window.removeEventListener('keydown', onZoomKeydown)
  unsubscribe?.()
  unsubscribe = null
})

/** 后退（主进程 navigationHistory.goBack） */
function goBack(): void {
  void browserBack(props.sessionId)
}

/** 前进（主进程 navigationHistory.goForward） */
function goForward(): void {
  void browserForward(props.sessionId)
}

/** 复制当前 URL 到剪贴板（spec §4.2 复制链接）。2s 内显 Check 反馈。
 * 失败静默（clipboard API 可能被权限策略拦截，非关键路径不阻塞 UI）。 */
function copyUrl(): void {
  const target = displayUrl.value || props.url
  if (!target) return
  navigator.clipboard.writeText(target).then(() => {
    copied.value = true
    copyTimerId.value = window.setTimeout(() => {
      copied.value = false
      copyTimerId.value = null
    }, COPY_FEEDBACK_MS)
  }).catch(() => {
    /* 剪贴板失败静默：非关键路径，不阻塞 UI */
  })
}

/** 重载当前 URL */
function reload(): void {
  const target = displayUrl.value || props.url
  if (!target) return
  isLoading.value = true
  error.value = null
  void browserNavigate(props.sessionId, target)
}

/** 在系统浏览器打开当前 URL（降级出口） */
function openInExternal(): void {
  const target = displayUrl.value || props.url
  if (!target) return
  void openExternal(target)
}
</script>
