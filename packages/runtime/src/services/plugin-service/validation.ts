/**
 * 插件 RPC 入口参数校验器（SEC-A5 路径注入防御 + S3-W3 窄校验层）
 *
 * 插件 Worker 经 RPC 传入的字符串标识符（sessionId / pluginId / key / scope）
 * 此前以 `params.sessionId as string` 直接下发，并 join 进持久化路径——
 * `../../` 可越出数据目录读/写/删任意 .json。本模块在 API 入口层收敛校验：
 * 凡会进入文件系统路径的标识符必须过 asSafeKey（字符集白名单），从语法上
 * 排除路径分隔符与 `..` 遍历序列。store 层另有 path.resolve 深度防御兜底
 * （session-data-store.ts / plugin-storage.ts），两层独立生效。
 *
 * S3-W3（D7 输入校验层）扩展：全部 40+ plugin.* RPC 方法入口的手写窄校验
 * 工具（不引入 ajv——runtime 无该依赖，为窄校验引入打包依赖违反最小化与
 * tsup noExternal 纪律）。工具族：asString / asBoundedString / asSafeKey /
 * asStringArray / asOptionalString / asRecord，对齐 core 侧 message-bus-bridge
 * 既有窄化模式（返回值收窄，坏值抛结构化错误）。
 *
 * 错误契约：抛 `errorWithCode(message, 'INVALID_<FIELD>')`——code 由字段名
 * 推导（sessionId → INVALID_SESSION_ID，pluginId → INVALID_PLUGIN_ID，
 * key → INVALID_KEY，scope → INVALID_SCOPE）；message 含字段名、白名单
 * regex 与实际收到的值（截断），插件作者可直接照此修正。
 */

import { errorWithCode } from '../../utils/errors.js'

/**
 * 标识符白名单：字母/数字/`.`/`_`/`-`，1-128 字符。
 * `/`、`\`、`:`、空白与 `..` 遍历序列均不在字符集内。
 * 128 与 pluginId/sessionId 的现有取值空间（npm 包名、session id）兼容。
 */
const SAFE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/** 错误 message 回显违规值的截断长度：防恶意超长输入把错误信息/日志撑爆 */
const VALUE_PREVIEW_MAX_CHARS = 64

/** camelCase 字段名 → 错误码：'sessionId' → 'INVALID_SESSION_ID' */
function fieldToErrorCode(field: string): string {
  return `INVALID_${field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`
}

/** 违规值的可读回显：string 带引号（超长截断），非 string 只报类型，避免泄露整包内容 */
function previewValue(value: unknown): string {
  if (typeof value === 'string') {
    const shown = value.length > VALUE_PREVIEW_MAX_CHARS
      ? `${value.slice(0, VALUE_PREVIEW_MAX_CHARS)}…(truncated)`
      : value
    return `"${shown}"`
  }
  return `(${typeof value})`
}

/**
 * 断言 value 是 string，否则抛 `INVALID_<FIELD>` 结构化错误。
 *
 * 不含字符集/长度约束——用于只需「确实是字符串」的场景（后续单元扩展使用）。
 */
export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw errorWithCode(
      `Invalid ${field}: expected a string but received ${previewValue(value)}. Pass the ${field} as a JSON string in the RPC params.`,
      fieldToErrorCode(field),
    )
  }
  return value
}

/**
 * 断言 value 是 string 且 UTF-8 字节数不超过 maxBytes，否则抛 `INVALID_<FIELD>`。
 *
 * 长度上限由调用方按域定值（后续单元扩展使用）。
 */
export function asBoundedString(value: unknown, field: string, maxBytes: number): string {
  const str = asString(value, field)
  const bytes = Buffer.byteLength(str, 'utf-8')
  if (bytes > maxBytes) {
    throw errorWithCode(
      `Invalid ${field}: length ${bytes} bytes exceeds the ${maxBytes}-byte limit (${previewValue(str)}). Shorten the ${field} and retry.`,
      fieldToErrorCode(field),
    )
  }
  return str
}

/**
 * 断言 value 是符合白名单的安全标识符，否则抛 `INVALID_<FIELD>` 结构化错误。
 *
 * 用于会进入文件系统路径的标识符（sessionId / pluginId / key / scope）：
 * 字符集白名单从语法上排除路径分隔符与 `..` 遍历，1-128 字符上限防止
 * 超长键名进入文件名与内存 size 跟踪。
 */
export function asSafeKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_KEY_PATTERN.test(value)) {
    throw errorWithCode(
      `Invalid ${field} ${previewValue(value)}: must match /^[A-Za-z0-9._-]{1,128}$/ `
      + `(1-128 chars of letters, digits, '.', '_', '-'; path separators and '..' are not allowed). `
      + `Pass the ${field} exactly as provided by the host API, without path segments.`,
      fieldToErrorCode(field),
    )
  }
  return value
}

/**
 * 断言 value 是 string[]，否则抛 `INVALID_<FIELD>`。
 *
 * 数组内任一元素非 string 即整体拒绝（showSelect options 等——半坏的选项列表
 * 无法安全裁剪：插件作者应修自己的数据，而不是让用户看到被静默阉割的选项）。
 */
export function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) {
    throw errorWithCode(
      `Invalid ${field}: expected an array of strings but received ${previewValue(value)}. `
      + `Pass ${field} as a JSON string array, e.g. ${field}: ["a", "b"].`,
      fieldToErrorCode(field),
    )
  }
  return value
}

/**
 * 断言 value 缺省（undefined）或是 string，否则抛 `INVALID_<FIELD>`。
 *
 * 可选字段的类型守卫：缺省合法放行（undefined），present 但类型错即拒绝——
 * 与 asString 的区别仅在不把「缺省」当错误。
 */
export function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw errorWithCode(
      `Invalid ${field}: expected a string (or omit the field) but received ${previewValue(value)}.`,
      fieldToErrorCode(field),
    )
  }
  return value
}

/**
 * 断言 value 是普通对象（非 null/数组），否则抛 `INVALID_<FIELD>`。
 *
 * 嵌套结构（command / options / guiTree 条目）的第一层形状守卫；字段级校验
 * 由调用方在解构后用本模块其它工具继续做。
 */
export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw errorWithCode(
      `Invalid ${field}: expected an object but received ${previewValue(value)}.`,
      fieldToErrorCode(field),
    )
  }
  return value as Record<string, unknown>
}

/**
 * 断言 value 缺省（undefined）或符合安全标识符白名单，否则抛 `INVALID_<FIELD>`。
 *
 * 可选的路径敏感标识符（如 sendMessage 的 sessionId——缺省表示发给活跃
 * session）：缺省放行，present 即必须过白名单。
 */
export function asOptionalSafeKey(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return asSafeKey(value, field)
}
