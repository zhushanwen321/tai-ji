/**
 * URL scheme 校验（纯函数）。
 *
 * 对应 Browser Drawer 安全加固：地址栏回车可能包含 javascript: / data: / file: 等
 * 危险协议（renderer 端 UI 校验是第一层防御，主进程端必须有第二层——renderer 可被
 * XSS/console 注入绕过）。本文件抽成纯函数，navigate handler + manager.navigate
 * 双层调用，单测覆盖。
 *
 * [HISTORICAL] 不变量：
 * - 危险协议黑名单与 openExternal 的允许白名单（http/https）是两套独立防线：
 *   本文件用黑名单定位"明确危险"，handler 用白名单定位"明确允许"。
 *   双层防御都存在——renderer 端先用黑名单拒，主进程端再用白名单拒。
 * - 大小写不敏感（Chromium URL 协议大小写不敏感，Javascript: 与 javascript: 等价）。
 * - 不引入 node:url 依赖（new URL() 对 'javascript:' / 'data:' 在某些 Node 版本会抛
 *   InvalidURL，但协议字符串前置子串匹配足够稳健且零依赖）。
 *
 * 依赖方向：无下游（纯函数）
 */

/** 错误日志中 URL 的最大显示长度（防止超长 URL 刷屏，保留足够前缀便于定位） */
export const URL_PREVIEW_MAX_LENGTH = 64

/** 危险协议黑名单（命中即拒）。
 *  - javascript: / vbscript: —— 脚本执行，XSS 钓鱼
 *  - data: —— base64 payload，可绕过 https 信任指示
 *  - file: / blob: —— 访问本地文件系统（嵌入页不应读宿主文件）
 *  - chrome: / devtools: / about: —— 嵌入 Chromium 内部页，可能绕过零信任 webPreferences
 */
const DANGEROUS_SCHEMES = [
  'javascript:',
  'vbscript:',
  'data:',
  'file:',
  'blob:',
  'chrome:',
  'devtools:',
  'about:',
] as const

/**
 * 校验 URL 是否命中危险协议黑名单。
 *
 * 大小写不敏感，前缀匹配 `scheme:`（含冒号）。
 * 命中任意一个 dangerous scheme 即返回 true。
 *
 * @param url 待校验 URL
 * @returns true=危险协议应拒 / false=未命中黑名单
 */
export function isDangerousScheme(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  const lower = url.trim().toLowerCase()
  return DANGEROUS_SCHEMES.some((scheme) => lower.startsWith(scheme))
}

/**
 * 校验 URL 是否允许作为嵌入式导航目标。
 *
 * 白名单策略：只允许 http(s):// 开头。
 * 与 isValidExternalUrl 语义一致（Browser Drawer 嵌入与 openExternal 都是
 * 「第三方网页」语义，共享 http/https 白名单），但独立函数保留扩展空间（如未来
 * 允许 chrome-extension:// 等）。
 *
 * @param url 待校验 URL
 * @returns true=允许导航 / false=拒
 */
export function isAllowedNavigateUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  return /^https?:\/\//i.test(url.trim())
}