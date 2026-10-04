/**
 * PiMcpStore — mcp.json 的唯一读写层（pi-mcp-management 设计 D2 存储层范式 /
 * D4 校验边界 / D7 编辑写回契约）。
 *
 * mcp.json 是 pi 1.0 内置 MCP 扩展的配置文件（路径 <agentDir>/mcp.json，经
 * getMcpConfigPath() 动态推导）：会话启动时由 `--extension builtin:mcp` 装载的
 * 扩展读取并后台连接全部启用的服务器（spawn 白名单配套见 pi-rpc spawn-args）。
 *
 * 与 pi-settings-store 的关键差异（D2 并发契约，必须照此理解）：
 *   pi 自身的 mcp.json 写路径（dist/extensions/mcp/config.js editMcpServers）是
 *   裸「读文件 → 改 → 写文件」，无锁、无原子写（与 settings.json 的 proper-lockfile
 *   可互操作协议不同）。因此本模块的跨进程磁盘锁（withFileLockSync，锁文件
 *   <mcp.json>.lock）互斥的是 taiji 自身的多窗口/并发保存；挡不住外部写方
 *   （终端 `pi mcp add/remove/login`、外部手编——它们不认任何锁）。taiji 侧承诺
 *   收缩为：锁内重读磁盘最新内容再做合并写入（D2），使 taiji 发起的丢失更新窗口
 *   收窄到「taiji 持锁期间外部恰好完成一整轮读改写」。已接受代价的四要素登记见
 *   设计文档 D2「已接受代价（外部并发窗口）」。
 *
 * 校验边界（D4，写死）：
 *   - 保存校验面 = §2.4 三不变量（名称字符集与全局唯一 / command、url 至少其一 /
 *     文件整体 JSON 合法）+ 两条有意收紧：command 与 url 同填拦截（pi 实装是 url
 *     优先静默忽略，taiji 拦截报互斥错）、重名添加拦截不替换（pi CLI add 是静默
 *     替换，表单语境下误覆盖不可接受）+ type 例外条款（三值闭集 "stdio"/"http"/
 *     "streamable-http"，"sse" 拒绝、未知值报错、type 与传输形态不符报错——该形态
 *     pi 加载期整条拒载且报错文案与病因错位，实装探针已核实：type:"http"+command
 *     报的是 needs either "command" (stdio) or "url" (streamable HTTP)）。
 *   - 表单外键（timeout/toolExposure/auth/oauth）与 exposure 的**值域**不进保存
 *     校验范围——pi 加载期 validateMcpServerConfig 是最终权威，坏值经保存落盘、
 *     到 pi 加载期报错并经新会话 toast 反馈（已知回流窗口，D4 登记接受）。
 *   - 读侧标注范围 = 三不变量 + -/_ 归并同名（先入者胜，复刻 pi loadMcpConfig 的
 *     clash 检测），**不含** type 校验与互斥收紧——读侧标注作用于打开清单时的全部
 *     条目，误标会引导用户误删 pi 实际接受的合法条目（混填与显式 type 坏值在 pi
 *     侧各有明确行为：混填按 http 处理、坏 type 走新会话 toast，D8③ 取舍）。
 *   - 管线顺序（D4 写死）：type 剥离与键级清理先于保存校验——校验输入恒为写回
 *     产物；表单路径产物无 type 键，type 校验在该路径空转。
 *
 * 编辑写回契约（D7，写死）：
 *   - 表单模式 = 表单字段**合并**进既有条目对象（锁内最新读为底），表单外键与
 *     其他未知键原样保留，禁按表单字段集全量替换（替换会静默丢 oauth/timeout 等
 *     外键，用户不自知）。
 *   - `type` 键无条件剥离（表单模式保存一律剥）：type 是可由 command/url 有无推导
 *     的冗余键（pi 校验器两分支对无 type 条目按传输字段归类，实装探针核实），
 *     条件式保留需引入一致性判断分支且判错时落回同一坏形态，无条件剥离结构性封死。
 *   - 切换传输类型 / 既有混填条目的表单编辑 = 删除条目对象中两类型的全部表单映射键
 *     （command/args/env/cwd ↔ url/headers）后按当前类型回填——只清表单字段不清
 *     条目键会留下混填滞留条目，pi 静默按 http 处理（F2 经编辑通道复发）。
 *   - 清空可选字段 = 删键（不浅合并）：「合并」的保留通道只留给表单外键，清空不
 *     生效、残留配置改不掉与表单所见即所得的编辑预期相悖。
 *   - 代码模式 = 解析结果整体作为条目值（外键在 textarea 可见可改，无静默丢失
 *     通道），不做表单合并、不剥 type；添加流要求 { "名称": {...} } 单键包装形态
 *     （裸条目值对象无键名可取，名称是聚合唯一键）；编辑流包装键名必须与被编辑
 *     条目名一致（名称锁定，改名 = 删除后重建）。
 *
 * 写回保留文件结构（D4）：`mcpServers` 之外的顶层键（如 autoEnableCodemode）原样
 * 保留不动——对齐 pi editMcpServers「Other content is kept」，丢顶层键会静默改变
 * codemode 激活行为；缩进按文件既有缩进保持（同 pi 写路径），写盘走 atomicWrite。
 *
 * 🔒 三层架构：本模块属 infra（直接碰文件系统），services 经 port 访问，不直接
 * import 本模块（同 pi-settings-store）。
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { withFileLockSync } from '../../utils/file-lock.js'
import { atomicWrite } from '../../utils/fs-utils.js'
import { isEnoent } from '../../utils/errors.js'
import { getMcpConfigPath } from './pi-paths.js'

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/** 清单单条目：文件原样值 + 读侧标注。坏条目照原样保留（config 可能是任意 JSON 值）。 */
export interface McpServerEntryView { // oe-exempt:20261004:framework:store 读侧跨层投影形状（infra→transport→renderer，坏条目原样投影契约）
  name: string
  /** 文件中的原样条目值（D4：坏条目照原样保留，不阻塞其余条目管理）。 */
  config: unknown
  /** 读侧复刻校验标注（三不变量 + 归并同名）；合法条目为 null。 */
  error: string | null
}

/** mcp.json 快照（拉取口径，读以文件为准）。 */
export interface McpSnapshot { // oe-exempt:20261004:framework:store 读侧跨层投影形状（mcp.json 快照拉取契约，读以文件为准）
  /** 当前生效路径（getMcpConfigPath() 或测试重定向值）。 */
  filePath: string
  /** 文件整体损坏（JSON 语法错误 / 顶层非对象 / mcpServers 非对象 / 不可读）——true 时 servers 恒空。 */
  corrupted: boolean
  corruptedReason: string | null
  servers: McpServerEntryView[]
}

/** 表单模式字段集（D7 表单字段映射表；传输类型二选一决定 stdio/http 键组）。 */
export interface McpFormFields { // oe-exempt:20261004:framework:renderer 表单→store 保存链路契约输入形状（D7 字段映射，跨层协议）
  transport: 'stdio' | 'http'
  /** stdio 必填：单个可执行文件，非 shell 语句。 */
  command?: string
  /** stdio 可选：参数数组。 */
  args?: string[]
  /** stdio 可选：环境变量键值对。 */
  env?: Record<string, string>
  /** stdio 可选：工作目录。 */
  cwd?: string
  /** http 必填：streamable HTTP 地址。 */
  url?: string
  /** http 可选：请求头键值对。 */
  headers?: Record<string, string>
  /** 两者可选：一句话描述。 */
  description?: string
  /** 两者可选：暴露档位（codemode 缺省化，见 buildFormConfig）。 */
  exposure?: string
  /** 两者可选：启停（缺省启用；false 落键，对齐 pi 写路径语义）。 */
  enabled?: boolean
}

/** 表单模式保存输入。 */
export interface McpFormSaveInput { // oe-exempt:20261004:framework:renderer 表单→store 保存链路契约输入形状（McpSaveInput 变体）
  mode: 'form'
  fields: McpFormFields
}

/** 代码模式保存输入：textarea JSON.parse 的解析产物原样传入（解析层照常接受，形态判定在保存校验层）。 */
export interface McpCodeSaveInput { // oe-exempt:20261004:framework:renderer 代码→store 保存链路契约输入形状（McpSaveInput 变体）
  mode: 'code'
  parsed: unknown
}

export type McpSaveInput = McpFormSaveInput | McpCodeSaveInput

/** 结构化错误码（u2a 按 code 映射 WS 语义；message 为可直接展示的中文可操作文案）。 */
export type McpStoreErrorCode =
  | 'name_invalid'
  | 'entry_not_object'
  | 'transport_missing'
  | 'transport_conflict'
  | 'type_sse'
  | 'type_unknown'
  | 'type_transport_mismatch'
  | 'name_conflict'
  | 'namespace_conflict'
  | 'rename_not_allowed'
  | 'code_entry_form_invalid'
  | 'code_single_entry'
  | 'store_corrupted'
  | 'not_found'

export class McpStoreError extends Error {
  constructor(
    readonly code: McpStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'McpStoreError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 校验复刻（D4；实装锚点 = pi 1.0.0 dist/core/mcp-servers.js validateMcpServerConfig，
// 实施期 node 探针逐分支核对通过——结论：名称正则 /^[A-Za-z0-9_-]+$/；type 三分支
// 条件为 undefined | "http" | "streamable-http"（url）/ undefined | "stdio"（command），
// "sse" 显式拒绝，错配落到 needs either 文案；混填不报错、url 分支胜出且 config
// 原样含 command）
// ─────────────────────────────────────────────────────────────────────────────

/** 复刻 pi SERVER_NAME（dist/core/mcp-servers.js:18 `/^[A-Za-z0-9_-]+$/`）。 */
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/** type 合法值闭集（D4 例外条款；"streamable-http" 是 streamable HTTP 旧称，其他客户端迁移片段可遇，不得误拦）。 */
const MCP_TYPE_VALUES = new Set(['stdio', 'http', 'streamable-http'])

/**
 * 复刻 pi mcpNamespace（dist/core/mcp-servers.js:20-22）：名称中连字符替换为下划线
 * 后同命名空间——两种字符不同的两个名字视为同名（不变量 1 的归并条款）。
 */
export function mcpServerNamespace(name: string): string {
  return `mcp__${name.replace(/-/g, '_')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读侧单条目标注（三不变量，不含 type 校验与互斥收紧——取舍见模块头「校验边界」）。
 * 返回 null = 合法；返回字符串 = 面向清单「配置有误」标注的中文错误摘要。
 */
export function validateMcpEntryForRead(name: string, config: unknown): string | null {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return `服务器名 "${name}" 含非法字符：只能包含字母、数字、下划线、连字符`
  }
  if (!isRecord(config)) {
    return `服务器 "${name}" 的配置必须是对象`
  }
  // 不变量 2：command（stdio）或 url（http）至少其一（pi 报错跳过的同款条件：
  // 两者皆为字符串才算存在——pi 实装 command 非 string 落 needs either 报错）
  if (typeof config.command !== 'string' && typeof config.url !== 'string') {
    return `服务器 "${name}" 缺少传输参数：需要 command（本地命令）或 url（远程地址）`
  }
  return null
}

/**
 * 保存校验面（写前，D4）：三不变量 + 互斥有意收紧 + type 例外条款。
 * 校验输入恒为写回产物（剥离/清理之后，D4 管线顺序）——表单路径产物无 type 键，
 * type 三项校验在该路径空转。校验不过抛 McpStoreError，不落盘（fail-fast）。
 */
export function validateMcpEntryForSave(name: string, config: unknown): void {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw new McpStoreError(
      'name_invalid',
      `服务器名 "${name}" 含非法字符：只能包含字母、数字、下划线、连字符，请修正名称`,
    )
  }
  if (!isRecord(config)) {
    throw new McpStoreError('entry_not_object', `服务器 "${name}" 的配置必须是 JSON 对象`)
  }
  const type = config.type
  // type 例外条款（D4）：表单产物无 type 键时本节空转
  if (type !== undefined) {
    if (type === 'sse') {
      throw new McpStoreError(
        'type_sse',
        '不支持旧版 SSE 传输（type: "sse"）：请改用 streamable HTTP 地址（填 url 字段，删除 type 键）',
      )
    }
    if (typeof type !== 'string' || !MCP_TYPE_VALUES.has(type)) {
      throw new McpStoreError(
        'type_unknown',
        `未知的 type 值 "${String(type)}"：合法值为 "stdio"、"http"、"streamable-http"，请修正或删除 type 键`,
      )
    }
  }
  const hasCommand = typeof config.command === 'string'
  const hasUrl = typeof config.url === 'string'
  if (hasCommand && hasUrl) {
    // taiji 有意收紧（D4）：pi 实装对混填是 url 优先静默忽略 command，不报错
    throw new McpStoreError(
      'transport_conflict',
      'command 与 url 不能同时填写：本地命令型只填 command，远程地址型只填 url，请删除其中一个',
    )
  }
  if (!hasCommand && !hasUrl) {
    throw new McpStoreError(
      'transport_missing',
      '缺少传输参数：本地命令型需要 command，远程地址型需要 url，请补填必填字段',
    )
  }
  if (hasUrl && type === 'stdio') {
    throw new McpStoreError(
      'type_transport_mismatch',
      'type: "stdio" 与 url 字段不符：url 是远程地址型传输，请删除 type 键或改用 command',
    )
  }
  if (hasCommand && (type === 'http' || type === 'streamable-http')) {
    throw new McpStoreError(
      'type_transport_mismatch',
      `type: "${String(type)}" 与 command 字段不符：command 是本地命令型传输，请删除 type 键或改用 url（该形态 pi 加载期整条拒载，报错文案与真实病因错位，故保存当场拦截）`,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 读取（拉取口径：读以文件为准，无缓存）
// ─────────────────────────────────────────────────────────────────────────────

/** 文件原始状态（写路径与读路径共用；仅本文件内部的解析中间态，无跨层消费——type alias 形态）。 */
type McpRawState = {
  corrupted: boolean
  corruptedReason: string | null
  /** 顶层 JSON 对象（文件不存在时 = {}；损坏时 = null）。 */
  topLevel: Record<string, unknown> | null
  /** mcpServers 对象（缺失时 = {}；损坏时 = {}）。 */
  servers: Record<string, unknown>
  /** 原始文本（不存在 = undefined）——写回时用于缩进探测与顶层重建。 */
  text: string | undefined
}

function readRawState(filePath: string): McpRawState {
  let text: string
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) {
      // 文件不存在 = 全新安装正常态，按空清单呈现（非损坏）
      return { corrupted: false, corruptedReason: null, topLevel: {}, servers: {}, text: undefined }
    }
    // 存在但不可读（EACCES 等）：无法证明 JSON 合法，按损坏处理（fail-safe 对齐
    // pi-settings-store getSettingsCorruption 形态①——放行写点会覆盖外部内容）
    return { corrupted: true, corruptedReason: `文件不可读：${String(e)}`, topLevel: null, servers: {}, text: undefined }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return { corrupted: true, corruptedReason: `JSON 语法错误：${reason}`, topLevel: null, servers: {}, text }
  }
  // 对齐 pi readConfigFile/editMcpServers 的顶层判定（顶层须为对象；mcpServers 缺失合法、存在则须为对象）
  if (!isRecord(parsed)) {
    return { corrupted: true, corruptedReason: '顶层必须是 JSON 对象', topLevel: null, servers: {}, text }
  }
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    return { corrupted: true, corruptedReason: '"mcpServers" 必须是对象', topLevel: null, servers: {}, text }
  }
  return {
    corrupted: false,
    corruptedReason: null,
    topLevel: parsed,
    servers: isRecord(parsed.mcpServers) ? parsed.mcpServers : {},
    text,
  }
}

/**
 * 读取 mcp.json 快照：解析 + 逐条目跑读侧复刻校验（坏条目照原样保留 + 错误标注，
 * 不阻塞其余条目）。文件不存在按空清单呈现；文件整体损坏时 corrupted = true
 * （servers 恒空，S6 fail-fast 契约的读侧呈现）。
 */
export function readMcpServers(): McpSnapshot {
  const filePath = getActiveMcpPath()
  const state = readRawState(filePath)
  if (state.corrupted) {
    return { filePath, corrupted: true, corruptedReason: state.corruptedReason, servers: [] }
  }
  const servers: McpServerEntryView[] = []
  // 归并同名检测的比对集：先入者胜（对齐 pi readConfigFile——仅收录校验通过且无冲突的
  // 条目，后出现的归并同名条目标注冲突；JSON 对象键唯一，同名键不会重复出现）
  const acceptedNames: string[] = []
  for (const [name, config] of Object.entries(state.servers)) {
    let error = validateMcpEntryForRead(name, config)
    if (error === null) {
      const clash = acceptedNames.find((other) => mcpServerNamespace(other) === mcpServerNamespace(name))
      if (clash !== undefined) {
        error = `服务器 "${name}" 与 "${clash}" 仅连字符/下划线不同（pi 视为同名命名空间），后者在本文件中先生效`
      } else {
        acceptedNames.push(name)
      }
    }
    servers.push({ name, config, error })
  }
  return { filePath, corrupted: false, corruptedReason: null, servers }
}

// ─────────────────────────────────────────────────────────────────────────────
// 编辑写回契约（D7）：写回产物构造（先于保存校验执行——D4 管线顺序）
// ─────────────────────────────────────────────────────────────────────────────

/** 两类型的全部表单映射键（键级清理对象；D7：command/args/env/cwd ↔ url/headers）。 */
const FORM_TRANSPORT_KEYS = ['command', 'args', 'env', 'cwd', 'url', 'headers'] as const

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim()
  return t ? t : undefined
}

function nonEmptyRecord(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined
  const entries = Object.entries(value).filter(([, v]) => typeof v === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

/** 空值删键：值为 undefined 时不写（清空 = 删键，D7 合并空值语义）。 */
function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key]
  else target[key] = value
}

/**
 * 表单模式写回产物（D7 编辑写回契约）：以既有条目对象为底（表单外键与其他未知键
 * 原样保留）→ 两类型表单映射键全删（键级清理，覆盖「切换传输类型」与「既有混填
 * 条目编辑」两角）→ type 无条件剥离 → 按当前类型与公共字段回填（清空/未提供 = 删键）。
 *
 * exposure 为 "codemode" 时缺省化（delete）——对齐 pi 自身写路径
 * （dist/extensions/mcp/config.js updateMcpServerConfig：codemode 删键、其余落键），
 * 使表单保存的文件形态与 pi CLI 写出形态一致。enabled 仅 false 落键（缺省启用）。
 */
function buildFormConfig(existing: unknown, fields: McpFormFields): Record<string, unknown> {
  // 底：既有条目对象（非 record 坏条目编辑 = 以空为底重建，是修复坏条目的正当通道）
  const next: Record<string, unknown> = isRecord(existing) ? { ...existing } : {}
  for (const key of FORM_TRANSPORT_KEYS) delete next[key]
  delete next.type
  if (fields.transport === 'stdio') {
    setOrDelete(next, 'command', trimmed(fields.command))
    setOrDelete(next, 'args', fields.args && fields.args.length > 0 ? fields.args : undefined)
    setOrDelete(next, 'env', nonEmptyRecord(fields.env))
    setOrDelete(next, 'cwd', trimmed(fields.cwd))
  } else {
    setOrDelete(next, 'url', trimmed(fields.url))
    setOrDelete(next, 'headers', nonEmptyRecord(fields.headers))
  }
  setOrDelete(next, 'description', trimmed(fields.description))
  const exposure = trimmed(fields.exposure)
  setOrDelete(next, 'exposure', exposure === 'codemode' ? undefined : exposure)
  if (fields.enabled === false) next.enabled = false
  else delete next.enabled
  return next
}

/** 单键包装形态判定：{ [key]: record } 且恰一个键。 */
function unwrapSingleEntry(parsed: unknown): { name: string; config: unknown } | null {
  if (!isRecord(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 1) return null
  const value = parsed[keys[0]!]
  return isRecord(value) ? { name: keys[0]!, config: value } : null
}

/**
 * 代码模式添加（D7 添加态名称来源，写死）：必须是单键包装 { "名称": {...} }。
 * 裸/包装形态的区分特征 = 顶层值是否为 record（裸条目值对象的值是字段值——字符串/
 * 数组/标量；包装形态的值是服务器名到配置对象的映射）：全 record 值的多键对象 =
 * 多条目粘贴（单条目形态拦截）；含非 record 值（含 0 键空对象）= 裸条目值对象
 * 拦截（名称是聚合唯一键，裸形态无键名可取——解析层照常接受输入，拒绝发生在
 * 保存校验层）。非 record 顶层（数组/标量）同按裸形态拦截。
 */
function addEntryFromCode(parsed: unknown): { name: string; config: unknown } {
  const unwrapped = unwrapSingleEntry(parsed)
  if (unwrapped !== null) return unwrapped
  if (isRecord(parsed) && Object.keys(parsed).length > 1
    && Object.values(parsed).every((value) => isRecord(value))) {
    throw new McpStoreError(
      'code_single_entry',
      '代码模式一次只能保存一个服务器：请只保留一个条目（单条目形态）',
    )
  }
  throw new McpStoreError(
    'code_entry_form_invalid',
    '添加服务器需要包装形态提供名称：请使用 { "服务器名": { ...配置 } }（裸条目值对象没有名称可取）',
  )
}

/**
 * 代码模式编辑（D7 编辑态名称键语义，写死）：单键包装且键名 === 被编辑条目名 →
 * 取内层值（表单 → 代码自动序列化的往返形态）；单键包装但键名 !== 被编辑条目名 →
 * 拦截「改名 = 删除后重建」（与表单模式名称锁定同语义，D4 重名拦截管添加流撞名、
 * 本条款管编辑流改键角，两角合起来名称唯一键无旁路）；其余（多键对象 / 0 键）=
 * 裸条目值对象，解析结果整体作为条目值（外键原样，不剥 type、不合并）。
 * 消解规则：单键且键名恰等于条目名时优先按包装解读（往返一致优先于病态重合——
 * 条目 config 恰为 { [自身名]: {...} } 的形态在此不可裸编辑，登记接受）。
 */
function updateEntryFromCode(name: string, parsed: unknown): unknown {
  const unwrapped = unwrapSingleEntry(parsed)
  if (unwrapped === null) return parsed
  if (unwrapped.name !== name) {
    throw new McpStoreError(
      'rename_not_allowed',
      `编辑态名称锁定（"${name}"），改名 = 删除后重建：请删除该条目后用新名称重新添加`,
    )
  }
  return unwrapped.config
}

// ─────────────────────────────────────────────────────────────────────────────
// 写路径（锁内 RMW + 顶层键保留 + 保存校验）
// ─────────────────────────────────────────────────────────────────────────────

let activePathOverride: string | null = null

function getActiveMcpPath(): string {
  return activePathOverride ?? getMcpConfigPath()
}

/**
 * 覆盖 mcp.json 路径（仅测试用）。传 null 恢复生产路径（getMcpConfigPath()）。
 * 生产代码禁止调用。
 */
export function setMcpStorePathForTest(path: string | null): void {
  activePathOverride = path
}

/** 锁内把写回产物落盘：mcpServers 替换、其余顶层键原样保留、缩进保持、原子写。 */
function writeRawState(state: McpRawState, nextServers: Record<string, unknown>): void {
  const filePath = getActiveMcpPath()
  const topLevel: Record<string, unknown> = { ...state.topLevel, mcpServers: nextServers }
  // 缩进探测复刻 pi editMcpServers（文件首个缩进行；无缩进或新文件 = 2 空格）
  const indent = (state.text && /^([ \t]+)\S/m.exec(state.text)?.[1]) || '  '
  mkdirSync(dirname(filePath), { recursive: true })
  atomicWrite(filePath, `${JSON.stringify(topLevel, null, indent)}\n`)
}

/** 锁内执行一次变更；入口先做损坏拒入（S6：损坏期间保存被拒，不覆盖外部手编内容）。 */
function withMcpLock<T>(fn: (state: McpRawState) => T): T {
  return withFileLockSync(getActiveMcpPath(), () => {
    // 锁内强制重读磁盘最新内容（D2 并发契约：吃进外部写方，合并底恒为锁内最新读）
    const state = readRawState(getActiveMcpPath())
    if (state.corrupted) {
      throw new McpStoreError(
        'store_corrupted',
        `mcp.json 无法解析（${state.corruptedReason}）：请先修复文件后再保存，以免覆盖手工修改的内容（文件路径：${getActiveMcpPath()}）`,
      )
    }
    return fn(state)
  })
}

/** 注册表重名/归并核对（add 流）：与锁内最新注册表比对，含 -/_ 归并同名。 */
function checkNameAvailable(servers: Record<string, unknown>, name: string): void {
  if (name in servers) {
    throw new McpStoreError('name_conflict', `已存在同名服务器 "${name}"，请编辑该条目`)
  }
  const clash = Object.keys(servers).find((other) => mcpServerNamespace(other) === mcpServerNamespace(name))
  if (clash !== undefined) {
    throw new McpStoreError(
      'namespace_conflict',
      `已存在仅连字符/下划线不同的服务器 "${clash}"（pi 视为同名）：请换一个名称，或直接编辑该条目`,
    )
  }
}

/**
 * 添加服务器（D4 重名拦截：不替换——pi CLI add 是静默替换语义，表单语境下误覆盖
 * 不可接受）。form 模式名称由调用方显式给；code 模式名称取包装键名（裸形态拦截）。
 */
export function addMcpServer(input: ({ mode: 'form'; name: string } & McpFormSaveInput) | McpCodeSaveInput): void {
  withMcpLock((state) => {
    let name: string
    let config: unknown
    if (input.mode === 'form') {
      name = input.name
      config = buildFormConfig(undefined, input.fields)
    } else {
      const built = addEntryFromCode(input.parsed)
      name = built.name
      config = built.config
    }
    // 写回产物先于保存校验（D4 管线顺序）；重名/归并核对对锁内最新注册表
    validateMcpEntryForSave(name, config)
    checkNameAvailable(state.servers, name)
    writeRawState(state, { ...state.servers, [name]: config })
  })
}

/**
 * 编辑服务器（名称锁定——名称是聚合唯一键，§3.1 编辑态锁定条款）。form 模式 =
 * 表单字段合并进锁内最新读的既有条目（外键原样、type 剥离、键级清理、清空删键）；
 * code 模式 = 解析结果整体作为条目值（包装键名必须与被编辑条目名一致）。
 * update 不产生新的名称冲突（名称不变 → 命名空间不变），无需注册表核对。
 */
export function updateMcpServer(name: string, input: McpSaveInput): void {
  withMcpLock((state) => {
    if (!(name in state.servers)) {
      throw new McpStoreError('not_found', `服务器 "${name}" 不存在：可能已被删除，请刷新清单后重试`)
    }
    const existing = state.servers[name]
    let config: unknown
    if (input.mode === 'form') {
      config = buildFormConfig(existing, input.fields)
    } else {
      config = updateEntryFromCode(name, input.parsed)
    }
    validateMcpEntryForSave(name, config)
    writeRawState(state, { ...state.servers, [name]: config })
  })
}

/**
 * 删除服务器。条目不存在返回 false（对齐 pi removeMcpServerConfig 的返回语义），
 * 不抛错——删除是幂等意图，调用方按返回值决定提示。
 */
export function removeMcpServer(name: string): boolean {
  return withMcpLock((state) => {
    if (!(name in state.servers)) return false
    const nextServers = { ...state.servers }
    delete nextServers[name]
    writeRawState(state, nextServers)
    return true
  })
}

/**
 * 启停切换专用操作（§3.1「可启停（写入 enabled 字段）」最小语义，写死）：锁内重读磁盘
 * 最新内容后仅翻转该条目的 enabled 键，其余键一律不触——不走 update 的条目值回写路径
 *（清单投影为底的全量替换会把「清单打开至切换之间」的外部并发改动（终端 pi mcp 命令 /
 * 手编）静默覆盖，丢失窗口从 D2 声明的锁内亚秒级放大到 UI 会话级；混填条目亦不会被
 * form 路径规范化改写）。false 落 enabled:false 键，true 删键（缺省启用，对齐 pi 自身
 * 写路径与 buildFormConfig 语义）。不跑保存校验：本操作不改传输字段，条目合法性与
 * 切换前一致（坏条目的启停同样只有 enabled 键语义，清单标注不阻塞管理，D4）。
 * 条目不存在抛 not_found（清单可见性窗口内被外部删除）；条目非对象（坏条目）抛
 * entry_not_object——enabled 键无处落。
 */
export function setMcpServerEnabled(name: string, enabled: boolean): void {
  withMcpLock((state) => {
    if (!(name in state.servers)) {
      throw new McpStoreError('not_found', `服务器 "${name}" 不存在：可能已被删除，请刷新清单后重试`)
    }
    const current = state.servers[name]
    if (!isRecord(current)) {
      throw new McpStoreError(
        'entry_not_object',
        `服务器 "${name}" 的配置必须是对象，无法切换启停：请先在编辑弹层或文件中修复该条目`,
      )
    }
    const next: Record<string, unknown> = { ...current }
    if (enabled === false) next.enabled = false
    else delete next.enabled
    writeRawState(state, { ...state.servers, [name]: next })
  })
}
