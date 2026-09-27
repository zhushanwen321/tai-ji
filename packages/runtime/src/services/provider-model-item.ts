/**
 * 模型项 pi-schema 守卫（U6①，**写侧与启动清洗侧共享的谓词单点**）。
 *
 * 从 provider-config-helper 抽出（该文件超 max-lines 上限 → 正面提取，非 disable）：
 * 谓词的消费者有两侧——services 层写入口（`applyProviderWritePolicy` 的模型级转译）与
 * infra 层启动清洗（`sanitizeInvalidProviders` 的 id 规则）。两侧必须**同一口径**，
 * 否则「新写不再毒化」与「存量自愈」会各自漂移（U6①/U6③ 的同一问题两面）。
 *
 * 分层：放 services 层（infra 已有 value import services 的既有先例：
 * `pi-provider-store.ts` 导入 `provider-catalog.js`）；反向（services → infra 值导入）
 * 是仓内禁止的，故不能放 infra。
 */

/**
 * 模型项 id 判定：**可强转则强转、不可用才丢**。
 *
 * pi `ModelDefinitionSchema.id = Type.String({minLength:1})` 且**非 Optional**
 * （实装 `dist/core/model-config.js:137` 核实）——id 缺失（undefined/null）、空串、
 * 或不可强转成非空字符串的条目都会让 pi **拒载整个 models.json**（实测
 * `loadedProviders=0`，全部 provider 一起失效）。
 *
 * 口径（与 settings 路径 `mergeProviderModel` 的 `String(m.id)` 强转同口径，
 * `{id:123}` 两条写入口都写成 `'123'`）：
 * - 可强转（number/boolean/bigint，`String(v).trim() !== ''`）→ 就地写回字符串并保留；
 * - undefined / null / 空串 / 纯空白 / 对象等 → `ok:false`，调用方整条丢弃。
 *
 * `coerced:true` 供调用方判定「需要落盘」（启动清洗侧据此记变更，避免
 * 「强转了但不写盘 → 盘上仍是 non-string id」的静默失效）。
 */
export function normalizeModelIdOrReject(
  model: Record<string, unknown>,
): { ok: true; coerced?: true } | { ok: false; reason: string } {
  const raw = model.id
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'missing/non-string id' }
  }
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { ok: false, reason: 'empty-string id' }
    return { ok: true }
  }
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    const coerced = String(raw).trim()
    if (coerced === '') return { ok: false, reason: 'missing/non-string id' }
    model.id = coerced
    return { ok: true, coerced: true }
  }
  return { ok: false, reason: 'missing/non-string id' }
}
