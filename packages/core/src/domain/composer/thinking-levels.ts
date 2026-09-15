/**
 * 思考等级（前端固定枚举，非后端推送数据）。
 *
 * 后端 session.setThinkingLevel 只接收一个 level 字符串，不推送等级列表——
 * 故用常量而非订阅。组件从本文件取，不再直接 import api/mock/composer-data。
 *
 * 前端有自己的 UI 档位名（含 max），通过 thinkingLevelMap 的 key→value 映射
 * 把 UI 档位名转换成 pi 认识的值，发给 runtime 的是 value。
 * 展示是展示，传递 value 是 value——两回事。
 *
 * [W3 迁移] 本文件是 core 纯逻辑部分（迁自 renderer components/panel/thinking-levels.ts）。
 * getDisplayLabel 留 renderer，因依赖 i18n（@/i18n）；isOnOffMap 作为纯逻辑函数随迁，
 * 当前无 core 内消费者，留作 getDisplayLabel 后续以注入 t 方式迁入时复用 + T14 shim
 * 后 renderer 可从 core re-import。
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ThinkingLevelOption {
  level: ThinkingLevel
  /** 中文 label（向后兼容 + fallback；新代码优先用 labelKey + t()） */
  label: string
  /** i18n key（指向 composable.thinkingLevel.*） */
  labelKey: string
  en: string
  available: boolean
}

export const THINKING_LEVELS: ThinkingLevelOption[] = [
  { level: 'off', label: '关', labelKey: 'composable.thinkingLevel.off', en: 'off', available: true },
  { level: 'minimal', label: '极简', labelKey: 'composable.thinkingLevel.minimal', en: 'minimal', available: true },
  { level: 'low', label: '低', labelKey: 'composable.thinkingLevel.low', en: 'low', available: true },
  { level: 'medium', label: '中', labelKey: 'composable.thinkingLevel.medium', en: 'medium', available: true },
  { level: 'high', label: '高', labelKey: 'composable.thinkingLevel.high', en: 'high', available: true },
  { level: 'xhigh', label: '极高', labelKey: 'composable.thinkingLevel.xhigh', en: 'xhigh', available: true },
  { level: 'max', label: '最高', labelKey: 'composable.thinkingLevel.max', en: 'max', available: true },
]

/** ThinkingLevel 全枚举表（isThinkingLevel 的判定依据，对齐 pi EXTENDED_THINKING_LEVELS 序；
 *  数值强度排序职责已由 PI_LEVEL_ORDER 的数组顺序承担，本表不再用于排序） */
const LEVEL_STRENGTH: Record<ThinkingLevel, number> = {
  off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6,
}

/** 判断字符串是否为合法 ThinkingLevel 枚举值 */
export function isThinkingLevel(v: string): v is ThinkingLevel {
  return v in LEVEL_STRENGTH
}

/**
 * pi EXTENDED_THINKING_LEVELS 全序（pi-ai 0.84.1 dist/models.js 实装值，勿改顺序）。
 */
const PI_LEVEL_ORDER: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 下发档位集缺失/空时的归一结果（off..high 五档，对齐 pi 无 map 模型的默认档）。 */
const DEFAULT_SUPPORTED_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high']

/**
 * 归一 runtime 下发的档位可用集（ProviderInfo.models[].supportedLevels，U5 注册表同源计算）。
 *
 * [HISTORICAL] 本函数的前身（从 thinkingLevelMap+reasoning 本地推算可用档，U6 已删）
 * 已随 U6 删除——它是 pi getSupportedThinkingLevels 的影子实现（对 reasoning 缺失的语义
 * 解释与 pi 相反，事故 B 根因 ②），档位可用集唯一权威 = runtime 侧 pi 同源计算下发的
 * supportedLevels（pi-boundary-reliability D3③）。本函数只做归一（非法值过滤 + 全序排列），
 * 零 pi 语义推断。
 *
 * 归一规则：
 * - undefined / 空数组 → 默认五档（supportedLevels 下发链路未接通时的过渡态，对齐旧实现「map 缺失 → 五档」）
 * - 非法值过滤；合法档位按 pi 全序排列；'off' 恒在（防御归一）
 *
 * @param levels runtime 下发的支持档位集（string[]，pi 同源计算产物）
 * @returns 按 pi 全序升序的可用 ThinkingLevel 列表，至少含 off
 */
export function normalizeSupportedLevels(levels?: string[] | null): ThinkingLevel[] {
  if (!levels || levels.length === 0) return [...DEFAULT_SUPPORTED_LEVELS]
  const valid = new Set(levels.filter(isThinkingLevel))
  valid.add('off')
  return PI_LEVEL_ORDER.filter((l) => valid.has(l))
}

/**
 * on/off 模式判定：map 只有 off + high 两个可用档位。
 * 该模式下 high 档 UI 显示「开」（而非通用 label「高」），语义为开/关二选一。
 *
 * [W3] export 给 renderer thinking-levels shim 的 getDisplayLabel 用（getDisplayLabel 留 renderer
 * 因依赖 i18n；此处 export 使 renderer 无需复制本函数）。
 */
export function isOnOffMap(map?: Record<string, string | null>): boolean {
  if (!map) return false
  const keys = Object.keys(map).filter((k) => map[k] !== null)
  const ON_OFF_AVAILABLE_COUNT = 2
  return keys.length === ON_OFF_AVAILABLE_COUNT && keys.includes('off') && keys.includes('high')
}

/**
 * 将 UI 档位（key）解析为发给 runtime 的实际 level（value）。
 *
 * thinkingLevelMap 的 value 是发给 runtime/pi 的字符串。选中某档位时：
 * - key 存在且 value 非 null → 发 value（如 max 档发 xhigh）
 * - map 为 undefined/空（all-levels）→ 发 key 自身（档位名 = 发送值）
 *
 * 展示是展示（key），传递 value 是 value——这是两回事。
 *
 * @returns 发给 runtime 的 level 字符串；key 无映射时回退 key 自身
 */
export function resolveThinkingValue(
  key: ThinkingLevel,
  map?: Record<string, string | null>,
): string {
  if (!map || Object.keys(map).length === 0) return key
  const v = map[key]
  return v ?? key
}

/**
 * 将 runtime 返回的 level（value）反向解析为 UI 档位（key）。
 *
 * pi/session.thinkingLevel 存的是发给 pi 的 value（如 'xhigh'），需反查 map
 * 找到对应的 UI 档位 key（如 'max'）才能正确高亮 popover。
 * - value 能反查到 key → 返回该 key
 * - value 等于某个 ThinkingLevel 枚举值且不在 map 的 value 里 → value 本身就是 key（all-levels 或 value=key）
 * - 都不匹配 → 返回 fallback
 *
 * @returns UI 档位 ThinkingLevel；无法映射时回退 fallback
 */
export function resolveThinkingKey(
  value: string,
  map?: Record<string, string | null>,
  fallback?: ThinkingLevel,
): ThinkingLevel {
  // 反查 map：value → key
  if (map && Object.keys(map).length > 0) {
    for (const [key, val] of Object.entries(map)) {
      if (val === value && isThinkingLevel(key)) return key
    }
  }
  // value 直接是档位名
  if (isThinkingLevel(value)) return value
  // fallback 缺省取默认五档最高档 'high'（U6：动态最高档推导已随本地档位推算函数删除，
  // 需要精确最高档的调用方显式传 fallback——如 Popover/sync 传
  // highestAvailableLevel(supportedLevels)）
  return fallback ?? 'high'
}

/**
 * 取档位可用集的最高可用档。
 *
 * 用于切换模型后当前选中档位不可用时，自动重置到最高可用档。
 * 入参是 runtime 下发的 supportedLevels（string[]，U6 切源）——归一后取末尾；
 * 缺失/空归一为默认五档，最高 high。
 */
export function highestAvailableLevel(supportedLevels?: string[] | null): ThinkingLevel {
  const levels = normalizeSupportedLevels(supportedLevels)
  return levels[levels.length - 1] ?? 'off'
}

/**
 * 判断两个模型的档位可用集（supportedLevels）是否属同一思考体系。
 *
 * 用于模型切换时判定思考等级是否可直接映射：同体系直接映射当前档位，
 * 跨体系重置到目标模型最高档。
 *
 * 入参是各自模型的 supportedLevels（U6 切源）；缺失/空归一为默认五档，
 * 两个默认五档视为同体系（与旧实现对 map 缺失的判定对齐）。
 */
export function isSameThinkingScheme(
  a?: string[] | null,
  b?: string[] | null,
): boolean {
  const keysA = normalizeSupportedLevels(a)
  const keysB = normalizeSupportedLevels(b)
  return keysA.length === keysB.length && keysA.every((k) => keysB.includes(k))
}
