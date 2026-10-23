/**
 * 插件命名空间推导与绑定校验 SSOT（provider-plugin-access D4）
 *
 * namespace 是插件向 models.json 写 provider 条目（providers.write / providers.delete /
 * providers.credential 三 RPC）的边界：插件只能触达 `ns` 或 `ns-<suffix>` 前缀的
 * providerId。ns 不落盘——包名即唯一事实源，ns 由包名纯函数推导（可派生状态不落
 * 第二份，ADR-0122）：
 *
 *   去 npm scope、去 `plugin-` 前缀：
 *     '@zhushanwen/plugin-wool-workbuddy' → 'wool-workbuddy'
 *
 * 推导在安装期与 manifest 的 taijiPlugin.namespace 显式声明绑定校验，不一致拒绝安装
 * （NAMESPACE_MISMATCH）。为什么需要声明 + 校验而非纯推导：对话链硬依赖的 providerId
 * 前缀（如 wool-workbuddy）语义上不等价于包名本身，剥离规则是约定而非语义必然——由
 * 插件作者显式声明、宿主按同一规则校验，双方对「约定」的偏离都会被安装期拦截。
 *
 * 纯函数、零 IO、零依赖：消费方 = 安装期校验（runtime 安装器）与 providers.* RPC 的
 * 命名空间前缀校验（provider-write-proxy）。
 */

/** 命名空间绑定校验失败的错误码（安装拒绝 / 安装确认卡错误提示共用字面量） */
export const NAMESPACE_MISMATCH = 'NAMESPACE_MISMATCH' as const

export type NamespaceMismatchCode = typeof NAMESPACE_MISMATCH

/** manifest 未声明 namespace（非 provider 插件的常态，跳过绑定校验的判定输入） */
export type NamespaceBindingResult =
  | { ok: true; /** 校验通过的命名空间（= 推导值，调用方直接消费，不重复推导） */ namespace: string }
  | { ok: false; code: NamespaceMismatchCode; declared: string; derived: string }

/**
 * 从插件 npm 包名推导命名空间：去 npm scope、去 `plugin-` 前缀（各剥离一次）。
 *
 * - '@zhushanwen/plugin-wool-workbuddy' → 'wool-workbuddy'
 * - 'plugin-foo' → 'foo'（无 scope）
 * - '@scope/foo' → 'foo'（非 plugin- 前缀，scope 剥离后原样）
 * - 'plugin-plugin-x' → 'plugin-x'（只剥一次——重复前缀是包名的一部分，不猜测意图）
 * - 'plugins-x' → 'plugins-x'（前缀是 'plugin-' 字面，不误剥）
 *
 * 包名形态异常（空串 / 裸 scope '@scope/'）返回空串，由调用方按无效处置
 * （validateNamespaceBinding 判 NAMESPACE_MISMATCH）。
 */
export function deriveNamespace(pkgName: string): string {
  const trimmed = pkgName.trim()
  let rest = trimmed
  if (rest.startsWith('@')) {
    const slash = rest.indexOf('/')
    if (slash < 0) return ''
    rest = rest.slice(slash + 1)
  }
  const PREFIX = 'plugin-'
  if (rest.startsWith(PREFIX)) {
    rest = rest.slice(PREFIX.length)
  }
  return rest
}

/**
 * manifest 声明的 namespace 与包名推导值的绑定校验（安装期，D4）。
 *
 * 声明值 ≠ 推导值 → NAMESPACE_MISMATCH（安装拒绝，不落任何半成品）；声明值为空串
 * 视为无效声明（同一错误码——空 namespace 无法构成 providerId 前缀边界）。
 */
export function validateNamespaceBinding(pkgName: string, declared: string): NamespaceBindingResult {
  const derived = deriveNamespace(pkgName)
  if (!derived || declared.trim() !== derived) {
    return { ok: false, code: NAMESPACE_MISMATCH, declared, derived }
  }
  return { ok: true, namespace: derived }
}
