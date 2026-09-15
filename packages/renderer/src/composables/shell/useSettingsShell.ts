/**
 * useSettingsShell —— settings 域壳接入编排（W4 · p3-strangler-domains::settings）。
 *
 * 承接架构 §9（PlatformPort）+ §11.0.3（bootstrap 时序）+ w3 交接项①②③④：
 * core settings 域（w1/w2 headless）+ ui settings 组件（w3）已就位，但 renderer 壳从未注入
 * platform/transport（core settings-lifecycle.init 内 getSystem(getPlatform().storage) 会 fail-fast），
 * matchMedia 系统色监听仍在旧 useSettings，ui ProviderEditModal 的 3 个注入 key 无 provide 点。
 *
 * 本模块导出两个函数：
 *  - bootstrapSettingsCore()：在 App.vue setup（连接前）调用——transport 注入 +
 *    core useSettings().init()（挂常驻订阅）。上提是为消除「订阅注册晚于 sendInitialState 首推」竞态
 *    （[HISTORICAL] 2026-08-05，详见该函数注释）。
 *  - useSettingsShell()：在 AppShell setup（连接后渲染）调用——provide 3 个 ui 注入 key +
 *    watch system.theme 挂/卸 matchMedia listener + 初始 applySystemToDom 兜底（需组件实例）。
 *
 * 拆分原因：init()（订阅注册）不依赖组件实例，但原与 provide 一起放在 AppShell setup → AppShell
 * 仅在 connected 后渲染 → 订阅永远晚于 WS 连接首推。把 init() 上提到 App.vue setup（连接前），
 * provide/matchMedia（依赖组件实例）留 AppShell。
 *
 * [HISTORICAL] 2026-08-04：providePlatform 原只在此调用，但 AppShell 仅在连接成功后渲染
 * （App.vue v-if connectionState==='connected'）→ core ws-client.connect 的 getPlatform()
 * fail-fast 死锁（永远「连接中」）。注入已上提至 main.ts；platform 装配分叉已收敛为
 * main.ts 的 resolvePlatform() 唯一一处（本函数原有的兜底注入段已删——D2 R2 收敛）。
 *
 * core 零 DOM（架构 §11.0.1 DOM 审计）：applySystemToDom + matchMedia 是浏览器 API，下沉壳。
 * 完整 bootstrap.ts 合并（跨域 transport/session/extension-host 统一编排）留给后续壳整合 wave，
 * 本 wave 仅满足 settings 域 platform/transport 注入（strangler 逐域收编，架构 §9）。
 */
import { provide, watch } from 'vue'
import {
  getSettingsStore,
  useSettings,
} from '@taiji/core'
import { provideSettingsTransport } from '@taiji/core/domain/settings'
import {
  SETTINGS_TOAST_KEY,
  USE_QUOTA_CONFIGURE_KEY,
  SETTINGS_CONFIG_API_KEY,
  applySystemToDom,
} from '@taiji/ui/features/settings'
import { createSettingsTransport } from './settings-transport-adapter'
import { useToast } from '@/composables/useToast'
import { useQuotaConfigure } from '@/composables/features/model/useQuotaConfigure'
import { config } from '@/api'
import { setLocale } from '@/i18n'
import type { Locale } from '@/i18n'

/**
 * settings 域核心初始化（transport 注入 + 订阅注册）。
 *
 * [HISTORICAL] 2026-08-05 模型选择器数据丢失修复：原订阅注册（useSettings().init）在 AppShell setup
 * 调用，但 AppShell 仅在 connectionState==='connected' 时渲染（App.vue v-if）→ 订阅注册永远晚于
 * WS 连接 sendInitialState 首推 → 首条 model.list / config.defaults 投递到空 handler Set → 丢失 →
 * settingsStore.models / defaultModel 永空 → 模型选择器下拉空 + landing 按钮文案空。
 *
 * 本函数上提到 App.vue setup（在 onMounted bootstrap 提交连接编排前）调用，确保订阅在
 * 首推前注册，从根因消除竞态。dispose 不在此触发（留 App.vue onBeforeUnmount），订阅跨断重连常驻
 * （global handler 存于模块级 Map，dispatcher 重连后复用同一 handler，无需重注册）。
 *
 * platform 注入不在本函数职责内（原兜底注入段已删）：分叉唯一装配点 = main.ts resolvePlatform()。
 */
export function bootstrapSettingsCore(): void {
  provideSettingsTransport(createSettingsTransport())
  void useSettings().init()
}

/**
 * settings 域壳接入（AppShell setup 调用一次）。
 *
 * 仅承接需组件实例的副作用：provide 3 个 ui 注入 key + watch system.theme 挂/卸 matchMedia listener +
 * 初始 applySystemToDom 兜底。核心订阅注册已上提至 bootstrapSettingsCore（App.vue setup，连接前），
 * 此处不再调 init/dispose（dispose 留 App.vue onBeforeUnmount，订阅跨断重连常驻）。
 */
export function useSettingsShell(): void {
  // provide 3 个 ui 注入 key（向 SettingsModal 子树注入；ui 零 renderer import 铁律的依赖注入侧）
  const toast = useToast()
  provide(SETTINGS_TOAST_KEY, {
    error: (m: string) => toast.error(m),
    info: (m: string) => toast.info(m),
    warning: (m: string) => toast.warning(m),
  })
  provide(USE_QUOTA_CONFIGURE_KEY, useQuotaConfigure)
  provide(SETTINGS_CONFIG_API_KEY, { detectSources: () => config.detectSources() })

  // matchMedia 系统色监听 + applySystemToDom 兜底
  const store = getSettingsStore()

  /** apply 当前 system 偏好到 DOM（theme/themePreset/fontSize + locale） */
  const applyCurrent = (): void => {
    // ui deps.setLocale 签名为 string；@/i18n setLocale 窄化为 Locale（locale 来自 SystemSettings.locale，运行时必合法）。
    applySystemToDom(store.system.value, { setLocale: (l) => setLocale(l as Locale) })
  }

  // 初始 apply：init() 内 setSystem 已把 storage 值同步到 store（async），但 watch 默认 lazy 不触发初始；
  // 此处兜底首次 apply（init 的 setSystem 与本调用竞态时，watch 会再纠正）。
  applyCurrent()

  // watch system 外观字段（theme/themePreset/fontSize/locale）→ applyCurrent 同步 <html data-*> 属性。
  // 修复：原仅 watch theme=system 的 matchMedia，light↔dark 切换、太极主题（themePreset）切换、
  // 字号切换都不触发 applySystemToDom，导致系统页选主题后 data-theme/data-theme-preset 不更新，整页主题不变。
  // locale 必须在 watch 源内：setSystem({locale}) 是用户切语言的唯一真实路径（SettingsModal
  // 语言选择 → store.setSystem），漏看会导致切语言后 UI 不变，直到改主题/字号或重启。
  // setLocale 自身幂等且失败内部处理（不抛），applyCurrent fire-and-forget 安全。
  watch(
    () => [
      store.system.value.theme,
      store.system.value.themePreset,
      store.system.value.fontSize,
      // fontScales 是对象引用：setSystem 每次 spread 出新对象，引用变化即触发
      store.system.value.fontScales,
      store.system.value.locale,
    ] as const,
    () => applyCurrent(),
    { flush: 'pre' },
  )

  // watch system.theme：theme=system 时挂 matchMedia listener（OS 深浅色实时切换），非 system 时卸载。
  // watch 的 onCleanup 自动在 theme 变化/组件卸载时卸载旧 listener，避免泄漏。
  watch(
    () => store.system.value.theme,
    (theme, _old, onCleanup) => {
      if (theme !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return
      }
      const mql = window.matchMedia('(prefers-color-scheme: light)')
      const handler = (): void => applyCurrent()
      mql.addEventListener('change', handler)
      onCleanup(() => mql.removeEventListener('change', handler))
    },
    { flush: 'pre' },
  )
}

