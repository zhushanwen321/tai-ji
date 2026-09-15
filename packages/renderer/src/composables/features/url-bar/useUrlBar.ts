/**
 * useUrlBar —— BrowserPane 地址栏编辑态管理。
 *
 * 职责：管理地址栏 Input 的编辑态值 + 导航触发 + 防钓鱼回填 + 危险协议拦截。
 * 抽出 composable 让 BrowserPane 聚焦布局，地址栏逻辑独立可测。
 *
 * 状态流：
 * - 非编辑态：urlInput 同步 displayUrl（主进程 did-navigate 回填真实 URL）
 * - 编辑态（聚焦中）：urlInput 独立持有用户输入，displayUrl 更新不覆盖（避免导航中闪烁）
 * - 回车：协议前缀补全 + 危险协议黑名单拦截 + 触发 navigate + 退出编辑态
 * - Escape：放弃编辑，回填 displayUrl（防钓鱼：不导航到未确认的输入）
 *
 * [HISTORICAL] 危险协议拦截（PR #100 B1 第一层防御）：renderer 端先用黑名单
 * 拒 javascript: / data: / file: / blob: 等，命中即 toast 提示。
 * 这是用户即时反馈的第一层；主进程 navigate handler + manager.navigate
 * 各自还有白名单 + 黑名单，三道防线独立函数 + 独立 fail point。
 *
 * [HISTORICAL] useUrlBar 直接接 useToast 是设计妥协——本 composable 专属于
 * BrowserPane（位于 features/），不是通用 composable。BrowserPane.vue 因
 * <script setup> 行数上限（vue_rules_checker 300）要求把 toast 集成内联，
 * 抽出 useUrlBarWithToast 会再引入 1 行 import，得不偿失。
 *
 * @param displayUrlRef 真实 URL 的响应式 ref（主进程回填，防钓鱼 SSOT）
 * @param navigateFn 导航回调（调用方传入 browserNavigate IPC）
 * @returns { urlInput, isEditingUrl, onUrlFocus, onUrlEnter, onUrlEscape }
 */
import { ref, watch, type Ref } from 'vue'
import { useToast } from '@/composables/useToast'

/** URL 协议前缀正则（http:// 或 https://，大小写不敏感） */
const URL_SCHEME_RE = /^https?:\/\//i

/** 危险协议黑名单（与 main/gateway/url-scheme-validators.ts DANGEROUS_SCHEMES 对齐，
 *  renderer 端独立维护一份——三道防线不互相依赖，renderer 升级/降级不影响主进程）
 *
 * - javascript: / vbscript: —— 脚本执行，XSS 钓鱼
 * - data: —— base64 payload，可绕过 https 信任指示
 * - file: / blob: —— 访问本地文件系统
 * - chrome: / devtools: / about: —— Chromium 内部页
 */
const DANGEROUS_SCHEME_PREFIXES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
  'chrome:',
  'devtools:',
  'about:',
] as const

/** 危险协议拦截 toast：URL 预览截断长度（字符数）。避免长 base64 data: URL 撑爆 toast 布局 */
const REJECT_PREVIEW_LEN = 40

/** 校验 URL 是否命中危险协议黑名单（renderer 端独立函数，三道防线解耦）。
 *
 * 大小写不敏感，前缀匹配 scheme:。命中即返回命中的 scheme（用于错误提示）。
 *
 * @param url 待校验 URL
 * @returns 命中的 dangerous scheme（含冒号），或 null（未命中）
 */
function findDangerousScheme(url: string): string | null {
  if (!url) return null
  const lower = url.trim().toLowerCase()
  for (const scheme of DANGEROUS_SCHEME_PREFIXES) {
    if (lower.startsWith(scheme)) return scheme
  }
  return null
}

export function useUrlBar(
  displayUrlRef: Ref<string>,
  navigateFn: (url: string) => void,
): {
  urlInput: Ref<string>
  isEditingUrl: Ref<boolean>
  onUrlFocus: (e: FocusEvent) => void
  onUrlEnter: () => void
  onUrlEscape: () => void
} {
  const { error: toastError } = useToast()

  /** 地址栏编辑态值（Input v-model） */
  const urlInput = ref<string>(displayUrlRef.value)
  /** 是否处于编辑态（聚焦中）。编辑态时 displayUrl 更新不覆盖用户输入 */
  const isEditingUrl = ref<boolean>(false)

  // 非编辑态时同步 displayUrl → urlInput（主进程 did-navigate 回填真实 URL）
  watch(displayUrlRef, (url) => {
    if (!isEditingUrl.value) urlInput.value = url
  })

  /** 聚焦 → 进入编辑态，全选当前 URL（方便整体替换输入新地址） */
  function onUrlFocus(e: FocusEvent): void {
    isEditingUrl.value = true
    const input = e.target as HTMLInputElement
    input.select()
  }

  /** 回车 → 危险协议拦截 → 补全协议前缀 + 导航，退出编辑态。
   * 命中黑名单时：early return + toast 提示，不补全前缀、不 navigate、不退出编辑态
   * （保持编辑态让用户修正输入，避免「拦截后输入被擦掉」的体验断裂）。
   * 裸域名（example.com）补全为 https://example.com；已有 http(s):// 不重复补全。 */
  function onUrlEnter(): void {
    const raw = urlInput.value.trim()
    if (!raw) return
    // [HISTORICAL] PR #100 B1 第一层：危险协议拦截（renderer 端黑名单）。
    // 命中即 early return + toast；不调 navigateFn、不退出编辑态（保用户输入便于修正）。
    const dangerous = findDangerousScheme(raw)
    if (dangerous) {
      // 协议名展示为大写（符合惯例：JAVASCRIPT: / FILE: 等）
      toastError(`危险协议已拦截：${dangerous.toUpperCase()}（${raw.slice(0, REJECT_PREVIEW_LEN)}）`)
      return
    }
    const url = URL_SCHEME_RE.test(raw) ? raw : `https://${raw}`
    isEditingUrl.value = false
    navigateFn(url)
    blurActive()
  }

  /** Escape → 放弃编辑，回填真实 URL（防钓鱼：不导航到未确认输入） */
  function onUrlEscape(): void {
    urlInput.value = displayUrlRef.value
    isEditingUrl.value = false
    blurActive()
  }

  return { urlInput, isEditingUrl, onUrlFocus, onUrlEnter, onUrlEscape }
}

/** 失焦当前 active element（回车/Escape 后让 Input 退出编辑态视觉） */
function blurActive(): void {
  ;(document.activeElement as HTMLElement | null)?.blur()
}