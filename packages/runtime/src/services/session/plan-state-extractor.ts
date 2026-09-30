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
 * schema 靠**字段级 optional 判存在**消解——skills/docs 逐字段守卫透传，不做
 * v 守卫（与 subagent/workflow extractor 的 v !== 1 早退是刻意差异，依据 D4「版本号字段被否」）。
 *
 * 派生归一（plan 状态机显式化 D2 读方②）：产出 View **恒携带 `state`**（新 entry 直读 /
 * 旧 entry 经 reviewState 映射（awaiting→reviewing、revising→revising、无→planning|idle
 * 按 isActive）），resumeHint 直读或由 reviewStateSource:'resubmit' 同义映射；**旧字段
 * （reviewState/reviewStateSource）只作映射输入、永不透出进 View**（取代式演进；
 * selfReview 不投影，D9③：消费面止于审批请求帧 + entry 比较基线）。映射实现单源 =
 * extension-protocol legacy-entries（plan-mode-audit-remediation D-B4-1 下沉——原内联
 * 拷贝删除，扩展读方①同引一份；契约断言面 = protocol 包内 legacy-entries.test.ts）。
 *
 * runtime 不 import extensions/ 源码（依赖方向不允许，同 subagent-extractor:194 先例），
 * entry data 按防御式逐字段守卫消费；extension-protocol 是包依赖（tsup noExternal 已打包，
 * 与 event-adapter 的 marker 常量同引法）。
 */
import { readFileSync, statSync } from 'node:fs'
import type { PlanDocMeta, PlanStateView } from '@taiji/shared'
import { READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
// 生命周期值域与 legacy entry 映射 canonical = extension-protocol（包依赖，非 extensions/
// 源码——tsup noExternal 已打包该包，与 event-adapter 的 marker 常量同引法）
import {
  PLAN_STATE_CUSTOM_TYPE,
  readLifecycleState,
  readResumeHint,
} from '@zhushanwen/extension-protocol'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'

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
 * requirement 读侧封顶上限（64KB = 64 * 1024 字节）：与 extension 写侧
 * MAX_PLAN_REQUIREMENT_LENGTH（extensions/universal/plan/src/state.ts）刻意同值——
 * runtime 不 import extensions/ 源码（依赖方向不允许，同 subagent-extractor:194 先例），
 * 跨包对齐靠注释互指。数值用单字面量而非 64 * 1024 乘法形态：乘法操作数仍会被
 * no-magic-numbers 逐个告警，本处以命名 + 注释承载换算语义，不加静默规则豁免
 * （BYTES_PER_MB 的既有豁免注释不在此修复范围）。
 */
const MAX_PLAN_REQUIREMENT_LENGTH_BYTES = 65_536

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
 * - optional 字段区（D4 + D2 归一）：skills/docs 字段存在且形状合法才透传（不存在 → View
 *   上不设键，而非显式 undefined——「旧 entry 派生出无新字段区」的字面语义）；state 恒携带
 *   （派生归一）、resumeHint 条件落键，全部下沉到 applyOptionalPlanFields。
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
    requirement: normalizeNonEmptyString(d.requirement, MAX_PLAN_REQUIREMENT_LENGTH_BYTES),
    templateName: normalizeNonEmptyString(d.templateName),
  }
  applyOptionalPlanFields(view, d)
  return view
}

/**
 * string 字段读取 + 空串归一 null（parsePlanStateEntry 三个必填 string 字段共用）：
 * entry 域「无文件/无需求」的历史形态是空串，View 域归一为 null 单一表达
 * （shared PlanStateView 的 `string | null` 值域），消费方判式单一（`=== null` 即「无」）。
 * capTo 参数：requirement 传封顶上限（P3-8 读侧对齐——封顶机制上线前写入的超长 entry
 * 在派生处同样截断，保证 plan 帧恒有界；新写入恒已在 extension 写侧封顶，本防御只服务
 * 存量旧 entry）。
 */
function normalizeNonEmptyString(v: unknown, capTo?: number): string | null {
  if (typeof v !== 'string' || v === '') return null
  if (capTo !== undefined && v.length > capTo) {
    const omitted = v.length - capTo
    console.warn(
      `[plan-state-extractor] requirement entry over cap (${v.length} > ${capTo} chars), ` +
      `truncating in derived view (${omitted} characters omitted)`,
    )
    return v.slice(0, capTo)
  }
  return v
}

/**
 * optional 字段派生（D4 + D2 读方② 归一）：skills 要求 string[]、docs 逐元素守卫（坏元素
 * 过滤）；state 恒携带（readLifecycleState 归一）、resumeHint 条件落键（readResumeHint）；
 * 旧字段 reviewState/reviewStateSource **只作映射输入、不透出进 View**（D2 取代式演进）；
 * selfReview 不投影（D9③——投影面止于审批请求帧，planState 帧有界前提不扩展）。
 */
function applyOptionalPlanFields(view: PlanStateView, d: Record<string, unknown>): void {
  if (isStringArray(d.skills)) {
    view.skills = d.skills
  }
  if (Array.isArray(d.docs)) {
    view.docs = d.docs.map(parsePlanDocMeta).filter((doc): doc is PlanDocMeta => doc !== null)
  }
  // View 恒携带 state（D2 读方②）：新 entry 直读、旧 entry 经 reviewState 映射——映射
  // 实现单源直引 extension-protocol legacy-entries（D-B4-1 下沉，扩展读方①同引一份）
  view.state = readLifecycleState(d, view.isActive)
  // resumeHint 只认 'resubmit' 一字面量：新 entry 直读，旧 entry 由 reviewStateSource
  // 同义映射（'explain' 等存量值归无值——explain 交互已删，renderer 缺省分支渲染通用文案）
  const resumeHint = readResumeHint(d)
  if (resumeHint !== undefined) view.resumeHint = resumeHint
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
 * 读失败分级（照 subagent-extractor extractSubagentsFromSessionFile 契约）：
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
