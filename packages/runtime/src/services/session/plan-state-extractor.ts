/**
 * plan-state-extractor — plan 模式状态投影域（plan 模式重设计 D1④，照 subagent-extractor /
 * workflow-extractor 同族形态）。
 *
 * `scanPlanStateEntries(entries)` 是 plan 状态唯一派生函数：实时（SessionRecords 增量拉取）
 * 与冷启动（getPlanState 磁盘全量，D1⑥ 冷路径）共用同一份代码——live ≡ reload 由「派生代码
 * 唯一」构造性保证（session-records.ts:64-79 同款「数据写路径唯一 = entry 扫描」不变量）。
 *
 * 派生语义 = 读 session 内**最后一条**合法 plan-state entry（extension 侧 reconstructPlanState
 * 的逆序取首同构——entry 顺序即时间顺序，每次状态迁移整体重写快照，无 per-key merge）。
 *
 * schema 兼容（D4）：entry data 无版本字段（版本号字段 + 迁移逻辑已被 D1 明文否决），新旧
 * schema 靠**字段级 optional 判存在**消解——旧 entry（仅四必填字段）派生出无新字段区的
 * PlanStateView，新字段（skills/docs/reviewState）逐字段守卫透传，不做 v 守卫（与
 * subagent/workflow extractor 的 v !== 1 早退是刻意差异，依据 D4「版本号字段被否」）。
 *
 * runtime 不 import extensions/ 源码（依赖方向不允许，同 subagent-extractor:194 先例），
 * entry data 按防御式逐字段守卫消费。
 */
import { readFileSync, statSync } from 'node:fs'
import type { PlanDocMeta, PlanStateView } from '@taiji/shared'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'

/**
 * plan-state entry 的 customType 字面量（D1①，event-adapter 白名单 + 第二道门共用）。
 *
 * 定义在 runtime 侧而非 @taiji/shared：subagent/workflow 两常量在 shared 是因为 extension
 * 侧同用（跨包共享）；plan-state 字面量只有 runtime 侧消费（extension 侧自带字面量），且
 * shared 不在本单元领地——常量与派生扫描器同文件是 runtime 内单数据源的正确形态
 * （本文件 = plan 域唯一 runtime 模块，两道门的共同 import 源）。
 */
export const PLAN_STATE_CUSTOM_TYPE = 'plan-state'

/** JSONL 中的 custom entry 结构（照 subagent-extractor JsonlCustomEntry 简化形态）。 */
interface JsonlCustomEntry {
  type: string
  customType?: string
  data?: unknown
}

/** MB 换算常数（oversize 降级 warn 文案的体积展示，对齐 workflow-extractor BYTES_PER_MB）。 */
// eslint-disable-next-line no-magic-numbers -- 1MB = 1024 * 1024 bytes
const BYTES_PER_MB = 1024 * 1024

/**
 * 「未激活」缺省 View（无 entry / ENOENT / oversize 降级共用，对齐 extension
 * DEFAULT_PLAN_STATE 的 View 域投影）。导出给 SessionRecords 的 publish 归一
 * （全量重建发现 entry 被外部清空 → 缺省 View 发布帧，见 mergePlanState）。
 */
export const INACTIVE_PLAN_STATE_VIEW: PlanStateView = {
  isActive: false,
  planFilePath: null,
  requirement: null,
  templateName: null,
}

/**
 * entry 扫描器：从 entry 列表派生 plan 状态视图（D1④）。
 *
 * 逆序取**最后一条**合法 plan-state entry（坏 entry 跳过继续向前——extension 侧
 * state.ts reconstructPlanState 的 continue 语义同构）；无任何合法命中返回 null
 * （= session 从未进过 plan 模式，publish 侧跳过；冷路径调用方归一为「未激活」缺省 View）。
 *
 * entries 来源两种形态同构（pi SessionEntry 内存对象与 JSONL 行反序列化，type 判定
 * 'custom'，对齐 subagent-extractor:181-182 注释）。
 */
export function scanPlanStateEntries(entries: unknown[]): PlanStateView | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const view = parsePlanStateEntry(entries[i])
    if (view) return view
  }
  return null
}

/**
 * 单条 entry → PlanStateView（type/customType/data 逐层守卫，非 plan-state entry 或坏
 * data 返回 null）。字段映射规则：
 * - 四必填字段：isActive 严格 `=== true`（其他形态归 false——View 契约是 boolean，防御
 *   extension 侧异常写入）；三个 string 字段空串归一 null（normalizeNonEmptyString）。
 * - 三 optional 新字段（D4）：字段存在且形状合法才透传（不存在 → View 上不设键，而非
 *   显式 undefined——「旧 entry 派生出无新字段区」的字面语义），下沉到
 *   applyOptionalPlanFields（守卫判定顺序与拆分前逐一等价）。
 */
function parsePlanStateEntry(entry: unknown): PlanStateView | null {
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as JsonlCustomEntry
  if (e.type !== 'custom' || e.customType !== PLAN_STATE_CUSTOM_TYPE) return null
  const data = e.data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>

  const view: PlanStateView = {
    isActive: d.isActive === true,
    planFilePath: normalizeNonEmptyString(d.planFilePath),
    requirement: normalizeNonEmptyString(d.requirement),
    templateName: normalizeNonEmptyString(d.templateName),
  }
  applyOptionalPlanFields(view, d)
  return view
}

/**
 * string 字段读取 + 空串归一 null（parsePlanStateEntry 三个必填 string 字段共用）：
 * entry 域「无文件/无需求」的历史形态是空串，View 域归一为 null 单一表达
 * （shared PlanStateView 的 `string | null` 值域），消费方判式单一（`=== null` 即「无」）。
 */
function normalizeNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * D4 optional 新字段透传（守卫通过才挂键，optional 字段缺省不设、禁显式 undefined 占位）：
 * skills 要求 string[]、docs 逐元素守卫（坏元素过滤）、reviewState 限两字面量。
 */
function applyOptionalPlanFields(view: PlanStateView, d: Record<string, unknown>): void {
  if (isStringArray(d.skills)) {
    view.skills = d.skills
  }
  if (Array.isArray(d.docs)) {
    view.docs = d.docs.map(parsePlanDocMeta).filter((doc): doc is PlanDocMeta => doc !== null)
  }
  if (d.reviewState === 'awaiting' || d.reviewState === 'revising') {
    view.reviewState = d.reviewState
  }
}

/** string[] 守卫（skills 透传前置条件，空数组合法——extension 侧语义由其自行定义）。 */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string')
}

/**
 * docs 元素逐字段守卫 → PlanDocMeta（shared 契约四字段；坏元素返回 null 被过滤——
 * 单文档元数据损坏不拖垮整组产物清单，未损坏部分照常显示）。
 */
function parsePlanDocMeta(v: unknown): PlanDocMeta | null {
  if (typeof v !== 'object' || v === null) return null
  const d = v as Record<string, unknown>
  if (
    typeof d.fileName !== 'string' ||
    typeof d.absPath !== 'string' ||
    typeof d.sourceSkill !== 'string' ||
    typeof d.version !== 'number'
  ) {
    return null
  }
  return { fileName: d.fileName, absPath: d.absPath, sourceSkill: d.sourceSkill, version: d.version }
}

/**
 * 从主 session JSONL 文件提取 plan 状态视图（冷启动 / getPlanState RPC 路径，D1⑥ 冷腿）。
 *
 * 读取文件 → parseJsonl → scanPlanStateEntries（与实时增量拉取同一份派生代码）。
 *
 * 读失败分级（照 subagent-extractor extractSubagentsFromSessionFile:346-353 契约）：
 * - 文件不存在（ENOENT）→ 「未激活」缺省 View（合法边界：pi session 文件延迟写入，文件
 *   都不存在必然无 plan-state entry；缺省形态对齐 extension DEFAULT_PLAN_STATE 的 View 域
 *   投影——isActive:false + 三 string 字段 null）。
 * - 其他读错误（EACCES / EISDIR 等）→ 原样上抛（RPC 报错；降级缺省 View 会把「读失败」
 *   与「从未进过 plan」混淆）。
 * - oversize（> READ_PRECHECK_MAX_BYTES 32MB）→ warn 留痕 + 缺省 View 降级（G3 峰值治理
 *   同款裁决：全文扫描语义不做尾读部分提取；降级形态与 ENOENT 同为「未激活」——
 *   PlanStateView 无降级标记位（shared 协议已 committed），失败可观测性由 warn 承担）。
 */
export function extractPlanStateFromSessionFile(filePath: string): PlanStateView {
  let fileSize = -1
  try {
    fileSize = statSync(filePath).size
  } catch {
    // 预检失败不改变错误契约：fall through 到读路径，由 readFileSync 产生原分级错误
    fileSize = -1
  }
  if (fileSize > READ_PRECHECK_MAX_BYTES) {
    console.warn(
      `[plan-state-extractor] session file oversize ` +
      `(${(fileSize / BYTES_PER_MB).toFixed(1)} MB > ${(READ_PRECHECK_MAX_BYTES / BYTES_PER_MB).toFixed(0)} MB), ` +
      `skip plan-state extraction (degraded to inactive view): ${filePath}`,
    )
    return INACTIVE_PLAN_STATE_VIEW
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) return INACTIVE_PLAN_STATE_VIEW
    throw e
  }

  return scanPlanStateEntries(parseJsonl(content)) ?? INACTIVE_PLAN_STATE_VIEW
}
