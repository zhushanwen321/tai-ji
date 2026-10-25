/**
 * provider headers 出线脱敏（ISSUES-2 ⑨ 修复）：headers 键名命中凭据词根的条目
 * 不随 config.providers / model.list 协议帧出线。
 *
 * 定位：只作用于「runtime → UI 协议面」的读侧出口（listProviders 聚合输出，broadcast
 * reply / sendInitialState 同源），**不触碰 models.json 落盘形态**——pi 扩展对话链读
 * models.json 条目 headers 取 refreshToken 刷新令牌（插件设计的进程内/同机文件通道，
 * 非广播），落盘键被剔除会直接打断该链。
 *
 * 为什么「键剔除」而不是值替换占位（如 '[redacted]'）：插件来源条目（ProviderRowCard
 * 展开体恒渲染 ProviderEditBody）的 headers 行从 p.headers 初始化草稿，占位值会随用户
 * 保存整体覆盖写回 models.json（resolveHeadersForSave 草稿非空回传草稿）——真实凭据被
 * 占位串静默覆盖，比键缺失更难排查。键剔除在「用户不碰 headers 行」时零副作用
 * （resolveHeadersForSave 基线空 + 草稿空 → undefined = 不变），与 apiKey 出线形态
 * （apiKeySet 布尔，本体不出 WS 帧）同一哲学。
 *
 * 为什么窄词根模式而不是全量剥离：headers 是用户可编辑配置（自定义 UA、网关调试头等
 * 非凭据键需要随帧下发供编辑回显），全量剥离破坏既有透传行为；凭据材料词根（token /
 * secret / password / api-key / authorization / credential / cookie）出现在 header 键名
 * 里几乎必然承载凭据。不含裸 `auth` / `key`（`x-authenticated-at` / `x-key-id` 类误伤）。
 */

/** 凭据材料词根（大小写不敏感；命中即不随协议帧出线，覆盖 provider 级与模型级 headers）。 */
const SENSITIVE_HEADER_KEY_PATTERN = /token|secret|passw(?:or)?d|api[-_]?key|authorization|credential|cookie/i

/** header 键名是否命中凭据词根（导出供测试与未来写侧防线复用同一判定）。 */
export function isSensitiveHeaderKey(key: string): boolean {
  return SENSITIVE_HEADER_KEY_PATTERN.test(key)
}

/**
 * 出线脱敏：剔除键名命中凭据词根的条目；剔除后为空返回 undefined（帧内不落 headers
 * 字段，消费方按缺省处理——provider-edit 表单 `p.headers ? {...} : {}` 两态等价）。
 * 输入对象不被修改（返回新对象）。
 */
export function redactSensitiveHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!isSensitiveHeaderKey(key)) kept[key] = value
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}
