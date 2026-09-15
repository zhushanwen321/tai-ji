import { createI18n } from 'vue-i18n'
import type { DefaultLocaleMessageSchema } from 'vue-i18n'
import zhCN from './locales/zh-CN'

export type Locale = 'zh-CN' | 'en-US'

/**
 * 初始 locale：统一从 system 偏好 key 读（单一真相源，与 settings store 一致）。
 * 兼容旧 key taiji-locale（历史数据），但新写入只走 system。
 * i18n 模块先于 AppShell 初始化，故此处同步读；store.init 后会再次 setLocale 对齐。
 */
const SYSTEM_KEY = 'taiji:system-settings'
const LEGACY_LOCALE_KEY = 'taiji-locale'

function readInitialLocale(): Locale {
  try {
    const raw = localStorage.getItem(SYSTEM_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { locale?: unknown }
      if (parsed.locale === 'zh-CN' || parsed.locale === 'en-US') return parsed.locale
    }
  // eslint-disable-next-line taste/no-silent-catch -- 启动期 localStorage 损坏属非致命：i18n 有 fallbackLocale，回退默认值即可
  } catch (e) {
    console.warn('[i18n] system settings 解析失败，回退默认 locale', e)
  }
  const legacy = localStorage.getItem(LEGACY_LOCALE_KEY)
  return legacy === 'en-US' ? 'en-US' : 'zh-CN'
}

const initialLocale = readInitialLocale()

/**
 * Q1-2 惰性 locale 加载：初始只静态注册 zh-CN（默认 locale，语言包不进异步 chunk），
 * en-US 按需动态 import + setLocaleMessage（不进首屏 chunk——zh-CN 用户不再为用不到的
 * en-US 全量（settings 等 13 域）付出启动编译成本；en-US 偏好用户首屏则同时含静态注册的
 * zh-CN（顶层静态 import 无条件进首屏 chunk，因其为默认 locale）与 top-level await 拉取的
 * en-US，两份均在、无对应节省）。
 *
 * 显式泛型 <[DefaultLocaleMessageSchema], string, false>：默认推断会把 composer 的 locale
 * ref 窄化为 '"zh-CN"'（messages 只含 zh-CN），setLocale('en-US') 赋值需 cast。Locales 不能
 * 填 Locale 联合——那会要求 messages 全 locale 齐备（TS2741，与 en-US 懒加载冲突）；用
 * string 后写路径 locale.value = locale 免 cast，读路径 getLocale 保持 as Locale 收窄
 * （不变式：locale 只经 createI18n 初始值 / setLocale 写入，运行时必为 Locale 联合成员）。
 */
const i18n = createI18n<[DefaultLocaleMessageSchema], string, false>({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
  },
})

/** 已注册 messages 的 locale（幂等守卫：避免重复动态 import / setLocaleMessage） */
// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，登记草稿）：已加载 locale 标记集合（i18n 基建，非 GUI 数据）——运行时经 add() 变异（i18n/index.ts:73），字面量初始化后仍运行时写的形态归 S1 语义层兜底，显式例外登记（verifier W24 minor 3）
const loadedLocales = new Set<Locale>(['zh-CN'])

/**
 * 动态加载 en-US 语言包并注册。字面量 import 路径保证 bundler 静态可分析（拆独立 chunk）。
 *
 * 不变量：zh-CN 静态注册（loadedLocales 初始含 'zh-CN'），动态加载只有 en-US 一条路径
 * ——参数收窄为字面量 'en-US'，杜绝「zh-CN 走动态 import」的死分支（loadedLocales 初始已含
 * zh-CN，该分支永不执行，产物却会留一个桩 chunk）。
 *
 * 失败处理：动态 import 失败（chunk 404 / 产物损坏）在内部 catch——warn 指向恢复动作而非
 * 变成 unhandledrejection；返回是否加载成功，调用方据决定是否仍切换 locale。
 */
async function loadEnUsMessages(): Promise<boolean> {
  if (loadedLocales.has('en-US')) return true
  try {
    const mod = await import('./locales/en-US')
    i18n.global.setLocaleMessage('en-US', mod.default)
    loadedLocales.add('en-US')
    return true
  } catch (e) {
    console.warn(
      '[i18n] en-US 语言包加载失败，UI 保持当前语言。可重试 setLocale(\'en-US\')；' +
      '若持续失败请检查构建产物完整性（renderer dist/assets 内 en-US chunk 是否存在）',
      e,
    )
    return false
  }
}

// en-US 偏好用户冷启动：top-level await 在模块解析内补齐 en-US 再放行 main.ts——
// 否则 connecting 屏第一帧（AppShell 渲染前）locale=en-US 但 messages 未注册，
// 会看到裸 key / 回退中文的闪烁。zh-CN 用户（默认）不执行此分支：模块同步解析、
// en-US 不进首屏 chunk（切换时再动态拉取）。
if (initialLocale === 'en-US') {
  await loadEnUsMessages()
}

/**
 * fallbackLocale 'en-US' 懒加载的兜底恢复：zh-CN 用户缺 key 时 vue-i18n 回退 en-US，
 * 若 en-US 未注册则显示裸 key。启动后空闲时后台预载（不阻塞首屏），loadedLocales
 * 幂等守卫使已加载场景零开销。requestIdleCallback 不可用的环境回落 setTimeout。
 */
function scheduleFallbackPreload(): void {
  const idle = typeof window !== 'undefined' ? window.requestIdleCallback : undefined
  if (typeof idle === 'function') {
    idle(() => void loadEnUsMessages())
  } else {
    setTimeout(() => void loadEnUsMessages(), 0)
  }
}
scheduleFallbackPreload()

/** setLocale 请求序号：连续快速切换时后写胜，防止先发的动态加载完成晚到后回写过期 locale */
let setLocaleSeq = 0

/**
 * 切换运行时语言。首次切换到 en-US 时先动态 import 其语言包（拆 chunk，
 * 一次网络/磁盘往返）再切换；已加载的 locale（含初始 zh-CN）同步命中缓存，仅一个 microtask。
 * en-US 加载失败时保持当前语言不切换（messages 缺失下切换只会显示裸 key）。
 * 持久化由 settings store 统一负责（system 偏好 key），此处不写 locale，避免双真相源。
 */
export async function setLocale(locale: Locale): Promise<void> {
  const seq = ++setLocaleSeq
  // zh-CN 静态注册（loadedLocales 初始含之），仅 en-US 需要动态拉取
  if (locale === 'en-US' && !(await loadEnUsMessages())) return
  if (seq !== setLocaleSeq) return // 已有更新的切换请求，本请求过期
  i18n.global.locale.value = locale
}

export function getLocale(): Locale {
  return i18n.global.locale.value as Locale
}

export default i18n
