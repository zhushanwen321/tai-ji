/**
 * parseBackgroundBashDetails 单测（对话流系统通知渲染升级 D1/D2）。
 *
 * 覆盖：合法两形态（natural / timeout-exitCode-null）全字段解析 + 防御矩阵——
 * details 非对象形态、必需字段（taskId/command/durationMs/endReason）缺失/空串/类型异常、
 * endReason 非法值（killed / process-exit 等不可达值）、exitCode 类型异常、可空字段缺失归 null。
 *
 * 消费点：ui SystemNotice.vue 的 background-bash 分支（命中 → 结构化行；null → content 原文行，
 * 旧 session 逐字节回到现状渲染）。解析口径与 parseBgNotifyDetails 同款（shared 单点收敛）。
 *
 * 另含 SSOT + 机器守卫组：BackgroundBashDetails 字段镜像（扩展侧 notify.ts ↔ 宿主侧
 * message.ts）的逐项相等断言，见文件尾 describe 注释。
 *
 * 运行：cd packages/shared && npx vitest run __tests__/background-bash-details.test.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parseBackgroundBashDetails } from '../src/message'

/** natural 成功形态（exit 0）。 */
const naturalDetails: Record<string, unknown> = {
  taskId: 'bt-3',
  command: 'pnpm test --workspace extensions',
  durationMs: 192000,
  endReason: 'natural',
  exitCode: 0,
}

describe('parseBackgroundBashDetails 合法输入', () => {
  it('natural：五字段原样解析（exit 0 成功形态）', () => {
    expect(parseBackgroundBashDetails(naturalDetails)).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'natural',
      exitCode: 0,
    })
  })

  it('timeout：exitCode null 正常解析（超时杀进程无退出码）', () => {
    expect(
      parseBackgroundBashDetails({ ...naturalDetails, endReason: 'timeout', exitCode: null }),
    ).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'timeout',
      exitCode: null,
    })
  })

  it('非 0 exitCode 原样透传（成败判色由渲染层按值决定，解析层不改写）', () => {
    const parsed = parseBackgroundBashDetails({ ...naturalDetails, exitCode: 2 })
    expect(parsed?.exitCode).toBe(2)
    expect(parsed?.endReason).toBe('natural')
  })

  it('exitCode 缺失 → 归 null（可空字段缺失非整体拒绝，降级只显命令 + 耗时）', () => {
    const { exitCode: _drop, ...withoutExitCode } = naturalDetails
    const parsed = parseBackgroundBashDetails(withoutExitCode)
    expect(parsed).toEqual({
      taskId: 'bt-3',
      command: 'pnpm test --workspace extensions',
      durationMs: 192000,
      endReason: 'natural',
      exitCode: null,
    })
  })

  it('字段集锁定：只取契约内五字段，多余字段不泄漏', () => {
    const parsed = parseBackgroundBashDetails({
      ...naturalDetails,
      content: '[background-bash] bt-3 finished (exit 0, 3m12s)',
      extra: 'noise',
    })
    expect(Object.keys(parsed as object)).toEqual(['taskId', 'command', 'durationMs', 'endReason', 'exitCode'])
  })
})

describe('parseBackgroundBashDetails 防御矩阵：details 非对象形态 → null', () => {
  it('null / undefined → null', () => {
    expect(parseBackgroundBashDetails(null)).toBeNull()
    expect(parseBackgroundBashDetails(undefined)).toBeNull()
  })

  it('原始类型（string / number / boolean）→ null', () => {
    expect(parseBackgroundBashDetails('[background-bash] bt-3 finished')).toBeNull()
    expect(parseBackgroundBashDetails(42)).toBeNull()
    expect(parseBackgroundBashDetails(true)).toBeNull()
  })

  it('数组 → null（数组是 object，须显式排除）', () => {
    expect(parseBackgroundBashDetails([naturalDetails])).toBeNull()
  })
})

describe('parseBackgroundBashDetails 防御矩阵：必需字段缺失/空串/类型异常 → null', () => {
  it('逐个缺必需字段 → null', () => {
    const { taskId: _t, ...noTaskId } = naturalDetails
    const { command: _c, ...noCommand } = naturalDetails
    const { durationMs: _d, ...noDuration } = naturalDetails
    const { endReason: _e, ...noEndReason } = naturalDetails
    expect(parseBackgroundBashDetails(noTaskId)).toBeNull()
    expect(parseBackgroundBashDetails(noCommand)).toBeNull()
    expect(parseBackgroundBashDetails(noDuration)).toBeNull()
    expect(parseBackgroundBashDetails(noEndReason)).toBeNull()
  })

  it('必需字段类型异常 → null', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, taskId: 3 })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, command: null })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, durationMs: '192000' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: true })).toBeNull()
  })

  it('taskId / command 为空串 → null（空串视为缺失，与 parseBgNotifyDetails 同款语义）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, taskId: '' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, command: '' })).toBeNull()
  })

  it('endReason 非法值 → null（killed / process-exit 不可达值不落 schema）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'killed' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'process-exit' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: 'completed' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: null })).toBeNull()
  })
})

describe('parseBackgroundBashDetails 防御矩阵：exitCode 类型异常 → 整体拒绝', () => {
  it('exitCode 非 number/null → null（可空字段同样不静默吞类型异常）', () => {
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: '0' })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: false })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: { code: 0 } })).toBeNull()
    expect(parseBackgroundBashDetails({ ...naturalDetails, exitCode: [0] })).toBeNull()
  })
})

// ── SSOT + 机器守卫：BackgroundBashDetails 字段镜像（扩展侧 notify.ts ↔ 宿主侧 message.ts）──
//
// 镜像两端（注释级手工镜像，两侧注释均声明「改动须同步另一侧」，本组用例把该纪律机器化）：
// - 扩展侧权威（生产方）：extensions/universal/base-tool-enhance/src/background/notify.ts
//   · BackgroundBashDetails 接口（约 :223，endReason 内联枚举）
//   · buildNotifyDetails（约 :240，details 载荷唯一产出点）
// - 宿主侧镜像（消费方）：packages/shared/src/message.ts
//   · BackgroundBashEndReason 别名（约 :359）+ BackgroundBashDetails 接口（约 :368）
//   · parseBackgroundBashDetails（约 :391）
//
// 两包物理独立（extensions 是独立 npm 包，不依赖 @taiji/shared，反向亦不可 import），
// 守卫形态 = fs 读两侧源文件提取接口结构做逐项相等断言（对齐 .githooks
// check_env_whitelist_sync.py 的「SDK 镜像与 SSOT 逐项相等」先例语义）。行号是辅助
// 锚点（可能漂移），以导出名为准。
//
// 对齐面 = D1 注释声明的三处：「字段名、可空性、枚举值」。类型串不做全文相等比对——
// 两侧 endReason 形态刻意不同构（扩展侧内联枚举 / 宿主侧类型别名），引号分号风格亦不同。
// 契约枚举全集 BackgroundTaskEndReason 从其 SSOT（packages/extension-protocol/src/
// background-task.ts，base-tool-enhance 经 re-export 消费）提取。

// 测试文件所在目录锚定（vitest 下 __dirname 解析为进程 cwd 不可靠，用 import.meta.url）
const HERE = fileURLToPath(new URL('.', import.meta.url))
const NOTIFY_TS = resolve(
  HERE,
  '../../../extensions/universal/base-tool-enhance/src/background/notify.ts',
)
const MESSAGE_TS = resolve(HERE, '../src/message.ts')
const PROTOCOL_BG_TASK_TS = resolve(HERE, '../../../packages/extension-protocol/src/background-task.ts')

interface FieldDecl {
  name: string
  type: string
}

/** 提取 export interface NAME { ... } 的花括号内文本（花括号计数配对取块）。 */
function extractInterfaceBody(source: string, name: string): string {
  const start = source.indexOf(`export interface ${name}`)
  if (start < 0) throw new Error(`镜像守卫：源文件中找不到 export interface ${name}，接口改名/删除须同步更新本守卫`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`镜像守卫：export interface ${name} 花括号未闭合（源码结构异常？）`)
}

/** 接口体 → 字段声明序列（跳过注释行；兼容 tab/空格缩进与行尾分号有无两侧风格）。 */
function parseFields(body: string): FieldDecl[] {
  const fields: FieldDecl[] = []
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) continue
    // 先剥行尾 `//` 注释再捕获：防止注释被 `(.+?);?$` 吸进 type 串
    //（对无注释源码行为不变；本镜像面类型串不含字符串字面量 `//`，URL 形枚举不在对齐面）
    const code = t.replace(/\/\/.*$/, '').trim()
    const m = /^(\w+)(\?)?:\s*(.+?);?$/.exec(code)
    if (m) fields.push({ name: m[1], type: m[3] })
  }
  return fields
}

/** 类型串中的字符串字面量枚举成员（'natural' | "timeout" 形态 → [natural, timeout]）。 */
function enumLiterals(type: string): string[] {
  return [...type.matchAll(/['"]([\w-]+)['"]/g)].map((m) => m[1])
}

/** 提取 export type NAME = <右侧>（单行别名；多行化会在此报错提示同步本守卫）。 */
function extractTypeAlias(source: string, name: string): string {
  const m = new RegExp(`export type ${name}\\s*=\\s*(.+)$`, 'm').exec(source)
  if (!m) throw new Error(`镜像守卫：源文件中找不到 export type ${name}（多行化/改名须同步更新本守卫）`)
  return m[1]
}

/** 提取 export function NAME 函数体内 return { ... } 对象字面量的键序列（产出完整性探针）。 */
function extractReturnObjectKeys(source: string, fnName: string): string[] {
  const fnStart = source.indexOf(`export function ${fnName}`)
  if (fnStart < 0) throw new Error(`镜像守卫：源文件中找不到 export function ${fnName}，函数改名/删除须同步更新本守卫`)
  const retStart = source.indexOf('return {', fnStart)
  if (retStart < 0) throw new Error(`镜像守卫：${fnName} 函数体中找不到 return { 对象字面量（产出形态变化须同步更新本守卫）`)
  const open = source.indexOf('{', retStart)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        const keys: string[] = []
        for (const line of source.slice(open + 1, i).split('\n')) {
          const t = line.trim()
          if (!t || t.startsWith('*') || t.startsWith('//')) continue
          const m = /^(\w+):/.exec(t)
          if (m) keys.push(m[1])
        }
        return keys
      }
    }
  }
  throw new Error(`镜像守卫：${fnName} 的 return 对象未闭合`)
}

describe('BackgroundBashDetails 字段镜像守卫（notify.ts ↔ message.ts，SSOT + 机器守卫）', () => {
  const notifySource = readFileSync(NOTIFY_TS, 'utf-8')
  const messageSource = readFileSync(MESSAGE_TS, 'utf-8')
  const contractSource = readFileSync(PROTOCOL_BG_TASK_TS, 'utf-8')

  const extFields = parseFields(extractInterfaceBody(notifySource, 'BackgroundBashDetails'))
  const hostFields = parseFields(extractInterfaceBody(messageSource, 'BackgroundBashDetails'))
  const extEndReason = enumLiterals(extFields.find((f) => f.name === 'endReason')?.type ?? '')
  const hostEndReason = enumLiterals(extractTypeAlias(messageSource, 'BackgroundBashEndReason'))
  const contractEndReason = enumLiterals(extractTypeAlias(contractSource, 'BackgroundTaskEndReason'))

  it('字段名序列逐项相等（含顺序）：扩展侧接口 ↔ 宿主侧接口', () => {
    expect(extFields.map((f) => f.name)).toEqual(hostFields.map((f) => f.name))
    // 与既有「字段集锁定」用例锁定的 parse 产出序一致 → 扩展侧接口 ↔ parse 全链钉住
    expect(hostFields.map((f) => f.name)).toEqual(['taskId', 'command', 'durationMs', 'endReason', 'exitCode'])
  })

  it('endReason 枚举值集逐项相等：扩展侧内联枚举 ↔ 宿主侧 BackgroundBashEndReason', () => {
    expect(extEndReason).toEqual(['natural', 'timeout'])
    expect(hostEndReason).toEqual(extEndReason)
  })

  it('枚举收敛锁定：契约 4 值全集 − 镜像集 = 不可达值 { killed, process-exit }（双端注释声明一致）', () => {
    expect(contractEndReason).toEqual(['natural', 'timeout', 'killed', 'process-exit'])
    const unreachable = contractEndReason.filter((v) => !hostEndReason.includes(v))
    expect(unreachable).toEqual(['killed', 'process-exit'])
  })

  it('exitCode 可空性两侧对齐：类型均含 number 与 null（D1 可空字段）', () => {
    const extExit = extFields.find((f) => f.name === 'exitCode')?.type ?? ''
    const hostExit = hostFields.find((f) => f.name === 'exitCode')?.type ?? ''
    expect(extExit).toMatch(/number/)
    expect(extExit).toMatch(/null/)
    expect(hostExit).toMatch(/number/)
    expect(hostExit).toMatch(/null/)
  })

  it('buildNotifyDetails 产出键序列 = 扩展侧接口字段序列（产出完整性，漏字段即红）', () => {
    expect(extractReturnObjectKeys(notifySource, 'buildNotifyDetails')).toEqual(extFields.map((f) => f.name))
  })

  it('parse 接受集 = 扩展侧枚举集（逐值解析成功）；不可达值逐值拒绝（集合机器对机器，非字面量）', () => {
    for (const reason of extEndReason) {
      const exitCode = reason === 'timeout' ? null : 0
      expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: reason, exitCode })?.endReason).toBe(reason)
    }
    for (const reason of contractEndReason.filter((v) => !extEndReason.includes(v))) {
      expect(parseBackgroundBashDetails({ ...naturalDetails, endReason: reason })).toBeNull()
    }
  })
})
