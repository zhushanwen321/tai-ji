/**
 * pi-mcp-store 表驱动单测（pi-mcp-management U1 验收条款①）。
 *
 * 覆盖：三条不变量 / 名称字符集 / -/_ 归并同名 / command+url 互斥拦截（D4 有意收紧）/
 * 重名拦截（精确同名 + 归并同名 + 编辑流改键角 D7）/ 既有坏条目保留与合并 /
 * RMW 合并不丢外部条目 / §4 断言①-⑤（type 剥离、streamable-http 旧称放行、
 * 编辑流改名拦截、清空即删键、添加流裸形态拦截）/ 顶层键保留与缩进保持 /
 * 损坏拒入（S6）/ 外键原样保留（D7 禁全量替换）/ pi 实装等价性。
 *
 * pi 实装等价性断言直接调用实装版 validateMcpServerConfig（node_modules
 * @earendil-works/pi-coding-agent@1.0.0 dist，项目约定权威源）——写回产物喂给
 * pi 校验器断言可被接受，锁「taiji 复刻规则与 pi 实装不漂移」。定位与装载形态对齐
 * pi-paths-config-dir-contract.test.ts 先例（cwd 上溯定位 dist；pi exports 不开放
 * dist 子路径，file:// URL 动态 import 绕过 bare specifier 约束；包不可达环境 skip
 * 而非 fail）。
 *
 * 实施期 node 探针结论（已核实，探针用完即删）：
 *   - 名称正则 /^[A-Za-z0-9_-]+$/，报错 invalid server name ... (use letters,
 *     digits, "_" and "-")；
 *   - type 分支条件：url 分支 = undefined|"http"|"streamable-http"，command 分支 =
 *     undefined|"stdio"；"sse" 显式拒绝；type 与传输字段错配（http+command /
 *     stdio+url）落到 needs either "command" (stdio) or "url" (streamable HTTP)
 *     ——文案与真实病因错位，是 D4 例外条款（保存当场拦 type 错配）的实证；
 *   - 无 type 条目两分支均放行（按传输字段归类）——D7 type 无条件剥离的行为等价性
 *     依据；混填不报错、url 分支胜出且 config 原样含 command（taiji 有意收紧的实装
 *     证据）；command 非 string 视同缺失；-/_ 归并先入者胜（a-b 保留、a_b 报
 *     conflicts）；addMcpServerConfig 同名静默替换、顶层键保留、缩进保持。
 *
 * 写删目标全部 mkdtemp 自建自删（fs-guard 白名单），禁触碰真实数据目录。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  McpStoreError,
  addMcpServer,
  mcpServerNamespace,
  readMcpServers,
  removeMcpServer,
  setMcpStorePathForTest,
  updateMcpServer,
  validateMcpEntryForRead,
  validateMcpEntryForSave,
  type McpFormFields,
} from '../pi-mcp-store.js'

/**
 * 定位实装 pi 包 dist（先例：pi-paths-config-dir-contract.test.ts——cwd 上溯找
 * node_modules 实体；runtime 直接依赖 pi 包，vitest 从 packages/runtime 运行时
 * 上溯 1 级命中）。
 */
function locatePiDist(): string | null {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist')
    if (existsSync(join(candidate, 'core', 'mcp-servers.js'))) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}

const PI_DIST = locatePiDist()
const SKIP_REASON = PI_DIST
  ? ''
  : 'node_modules/@earendil-works/pi-coding-agent/dist 不可达（cwd 上溯 6 级未命中）'
if (!PI_DIST) {
  console.warn(`[pi-mcp-store] pi 等价性断言 skip：${SKIP_REASON}`)
}

/** 实装版 validateMcpServerConfig（pi exports 不开放 dist 子路径，file:// 绕行）。 */
const piValidate = PI_DIST
  ? ((await import(pathToFileURL(join(PI_DIST!, 'core', 'mcp-servers.js')).href)) as {
      validateMcpServerConfig: (name: string, raw: unknown) => unknown
    }).validateMcpServerConfig
  : null

let tmpDir: string
let mcpPath: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pi-mcp-store-'))
  mcpPath = join(tmpDir, 'mcp.json')
})

afterEach(() => {
  setMcpStorePathForTest(null)
  rmSync(mcpPath, { force: true })
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 每用例独立文件 + 路径重定向（fs-guard 白名单内 mkdtemp）。 */
function useFile(preset?: unknown): void {
  if (preset !== undefined) {
    writeFileSync(mcpPath, `${JSON.stringify(preset, null, 2)}\n`, 'utf-8')
  }
  setMcpStorePathForTest(mcpPath)
}

function expectStoreError(code: string, fn: () => void): McpStoreError {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(McpStoreError)
    const err = e as McpStoreError
    expect(err.code).toBe(code)
    return err
  }
  throw new Error(`期望抛出 McpStoreError(${code})，但调用成功`)
}

/** 表单模式 stdio 快捷输入（name 默认 's'，add 直用时省写）。 */
function stdio(command: string, extra: Partial<McpFormFields> = {}, name = 's'): { mode: 'form'; name: string; fields: McpFormFields } {
  return { mode: 'form', name, fields: { transport: 'stdio', command, ...extra } }
}

/** 表单模式 http 快捷输入（name 默认 's'，add 直用时省写）。 */
function http(url: string, extra: Partial<McpFormFields> = {}, name = 's'): { mode: 'form'; name: string; fields: McpFormFields } {
  return { mode: 'form', name, fields: { transport: 'http', url, ...extra } }
}

// ─────────────────────────────────────────────────────────────────────────────
// 不变量 1：名称字符集与全局唯一
// ─────────────────────────────────────────────────────────────────────────────

describe('不变量 1 · 名称字符集（复刻 pi SERVER_NAME）', () => {
  it.each([
    ['a', true],
    ['Z', true],
    ['0', true],
    ['_', true],
    ['-', true],
    ['A-z_9-0', true],
    ['my server', false], // 空格
    ['服务器', false], // 非 ASCII
    ['a.b', false], // 点
    ['a/b', false], // 斜杠（路径注入面）
    ['a:b', false], // 冒号
    ['', false], // 空串
  ])('名称 %j 合法性 = %j', (name, valid) => {
    useFile()
    const run = () => addMcpServer({ mode: 'form', name, fields: { transport: 'stdio', command: 'x' } })
    if (valid) {
      expect(() => run()).not.toThrow()
    } else {
      const err = expectStoreError('name_invalid', run)
      expect(err.message).toContain('字母、数字、下划线、连字符')
    }
  })

  it('save 校验与读侧标注对同一字符集（读侧返回错误摘要不抛错）', () => {
    expect(validateMcpEntryForRead('my server', { command: 'x' })).toContain('非法字符')
    expect(validateMcpEntryForRead('ok-name', { command: 'x' })).toBeNull()
    expect(() => validateMcpEntryForSave('my server', { command: 'x' })).toThrow(McpStoreError)
  })
})

describe('不变量 1 · 全局唯一（重名拦截，D4 不替换）', () => {
  it('添加精确同名拦截，文案指引「编辑该条目」', () => {
    useFile({ mcpServers: { existing: { command: 'x' } } })
    const err = expectStoreError('name_conflict', () =>
      addMcpServer({ mode: 'form', name: 'existing', fields: { transport: 'stdio', command: 'y' } }),
    )
    expect(err.message).toContain('已存在同名服务器')
    expect(err.message).toContain('请编辑该条目')
    // 不替换：原条目原样
    const snap = readMcpServers()
    expect(snap.servers).toHaveLength(1)
    expect(snap.servers[0]).toMatchObject({ name: 'existing', config: { command: 'x' }, error: null })
  })

  it('添加归并同名（-/_ 不同）拦截（命名空间冲突）', () => {
    useFile({ mcpServers: { 'a-b': { command: 'x' } } })
    const err = expectStoreError('namespace_conflict', () =>
      addMcpServer({ mode: 'form', name: 'a_b', fields: { transport: 'stdio', command: 'y' } }),
    )
    expect(err.message).toContain('a-b')
    // 反向同样拦截
    rmSync(mcpPath, { force: true })
    useFile({ mcpServers: { a_b: { command: 'x' } } })
    expectStoreError('namespace_conflict', () =>
      addMcpServer({ mode: 'form', name: 'a-b', fields: { transport: 'stdio', command: 'y' } }),
    )
  })

  it('归并对既有条目无碰撞时不误拦（外部已存在的 a-b / a_b 冲突不阻塞无关新增）', () => {
    useFile({ mcpServers: { 'a-b': { command: 'x' }, a_b: { command: 'y' } } })
    expect(() => addMcpServer({ mode: 'form', name: 'other', fields: { transport: 'stdio', command: 'z' } })).not.toThrow()
  })
})

describe('-/_ 归并同名（mcpServerNamespace 复刻）', () => {
  it('复刻 pi mcpNamespace：连字符替换为下划线', () => {
    expect(mcpServerNamespace('a-b')).toBe('mcp__a_b')
    expect(mcpServerNamespace('a_b')).toBe('mcp__a_b')
    expect(mcpServerNamespace('a')).toBe('mcp__a')
  })

  it('读侧标注：归并同名先入者胜，后入者标注冲突（对齐 pi loadMcpConfig clash 检测）', () => {
    useFile({ mcpServers: { 'a-b': { command: 'x1' }, a_b: { command: 'x2' } } })
    const snap = readMcpServers()
    expect(snap.servers[0]).toMatchObject({ name: 'a-b', error: null, config: { command: 'x1' } })
    expect(snap.servers[1]!.name).toBe('a_b')
    expect(snap.servers[1]!.error).toContain('a-b')
    // 后入者条目照原样保留（不丢、不修复）
    expect(snap.servers[1]!.config).toEqual({ command: 'x2' })

    // 键序反转：先入者变为 a_b
    rmSync(mcpPath, { force: true })
    useFile({ mcpServers: { a_b: { command: 'x2' }, 'a-b': { command: 'x1' } } })
    const snap2 = readMcpServers()
    expect(snap2.servers[0]).toMatchObject({ name: 'a_b', error: null })
    expect(snap2.servers[1]!.error).toContain('a_b')
  })

  it('读侧归并检测只对三不变量通过的条目（对齐 pi：校验失败条目不参与 clash）', () => {
    // "bad name" 名称非法，不进比对集——后续 b 合法条目不应被它影响
    useFile({ mcpServers: { 'bad name': { command: 'x' }, b: { command: 'y' } } })
    const snap = readMcpServers()
    expect(snap.servers[0]!.error).toContain('非法字符')
    expect(snap.servers[1]).toMatchObject({ name: 'b', error: null })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 不变量 2：command / url 至少其一 + 互斥收紧
// ─────────────────────────────────────────────────────────────────────────────

describe('不变量 2 · 传输字段存在性（缺两者拦截）', () => {
  it.each([
    ['form stdio 缺 command', () => {
      useFile()
      addMcpServer({ mode: 'form', name: 's', fields: { transport: 'stdio' } })
    }],
    ['form http 缺 url', () => {
      useFile()
      addMcpServer({ mode: 'form', name: 's', fields: { transport: 'http' } })
    }],
    ['code 空对象', () => {
      useFile()
      addMcpServer({ mode: 'code', parsed: { s: {} } })
    }],
    ['update 后产物缺传输（清空必填 = 拦截，不是删条目）', () => {
      useFile({ mcpServers: { s: { command: 'x' } } })
      updateMcpServer('s', { mode: 'form', fields: { transport: 'stdio' } })
    }],
  ])('%s → transport_missing', (_label: string, run: () => void) => {
    const err = expectStoreError('transport_missing', run)
    expect(err.message).toContain('command')
    expect(err.message).toContain('url')
  })

  it('command 非 string 视同缺失（对齐 pi needs either 分支条件）', () => {
    useFile()
    expectStoreError('transport_missing', () => addMcpServer({ mode: 'code', parsed: { s: { command: 123 } } }))
  })
})

describe('command+url 互斥拦截（D4 taiji 有意收紧；pi 实装 url 优先静默忽略）', () => {
  it('save 档：混填拦截', () => {
    const err = expectStoreError('transport_conflict', () =>
      validateMcpEntryForSave('s', { command: 'x', url: 'https://y' }),
    )
    expect(err.message).toContain('不能同时填写')
  })

  it('读侧档：混填不标注（pi 静默按 http 处理，误标会引导误删合法条目）', () => {
    expect(validateMcpEntryForRead('s', { command: 'x', url: 'https://y' })).toBeNull()
  })

  it('端到端：form 编辑混填既有条目 → 键级清理后产物单类型、保存成功', () => {
    useFile({ mcpServers: { s: { command: 'x', url: 'https://y' } } })
    expect(() => updateMcpServer('s', http('https://z'))).not.toThrow()
    const snap = readMcpServers()
    expect(snap.servers[0]!.config).toEqual({ url: 'https://z' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 不变量 3：文件整体 JSON 合法 + 坏条目不阻塞（S6 fail-fast 契约）
// ─────────────────────────────────────────────────────────────────────────────

describe('不变量 3 · 文件损坏 fail-fast（S6）', () => {
  it('JSON 语法错误：读侧 corrupted + 损坏提示；三个写操作全部拒入且不落盘', () => {
    writeFileSync(mcpPath, '{ not valid json', 'utf-8')
    setMcpStorePathForTest(mcpPath)
    const snap = readMcpServers()
    expect(snap.corrupted).toBe(true)
    expect(snap.corruptedReason).toContain('JSON 语法错误')
    expect(snap.servers).toEqual([])

    expectStoreError('store_corrupted', () => addMcpServer(stdio('x')))
    expectStoreError('store_corrupted', () => updateMcpServer('a', stdio('x')))
    expectStoreError('store_corrupted', () => removeMcpServer('a'))
    // 拒入不改文件（不覆盖外部手编内容）
    expect(readFileSync(mcpPath, 'utf-8')).toBe('{ not valid json')
  })

  it('mcpServers 非对象按损坏处理；mcpServers 缺失按空清单', () => {
    useFile({ mcpServers: [] })
    expect(readMcpServers().corrupted).toBe(true)

    rmSync(mcpPath, { force: true })
    useFile({ otherKey: 1 })
    const snap = readMcpServers()
    expect(snap.corrupted).toBe(false)
    expect(snap.servers).toEqual([])
  })

  it('顶层非对象按损坏处理', () => {
    writeFileSync(mcpPath, '[1,2]', 'utf-8')
    setMcpStorePathForTest(mcpPath)
    expect(readMcpServers().corrupted).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 既有坏条目保留与合并（D4：文件中已存在非法条目照原样保留，不阻塞保存）
// ─────────────────────────────────────────────────────────────────────────────

describe('既有坏条目保留与合并', () => {
  it('坏条目读侧标注 + 原样保留；保存其他条目后坏条目仍在（不清理不修复）', () => {
    useFile({
      mcpServers: {
        good: { command: 'g' },
        'bad name': { command: 'x' }, // 名称非法
        noop: {}, // 缺传输
        scalar: 'oops', // 非对象
      },
    })
    const snap = readMcpServers()
    expect(snap.corrupted).toBe(false)
    const byName = Object.fromEntries(snap.servers.map((s) => [s.name, s]))
    expect(byName['good']).toMatchObject({ error: null })
    expect(byName['bad name']!.error).toContain('非法字符')
    expect(byName['bad name']!.config).toEqual({ command: 'x' })
    expect(byName['noop']!.error).toContain('缺少传输参数')
    expect(byName['scalar']!.error).toContain('必须是对象')
    expect(byName['scalar']!.config).toBe('oops')

    // 保存：坏条目不阻塞，且保存后原样保留
    expect(() => addMcpServer({ mode: 'form', name: 'newer', fields: { transport: 'stdio', command: 'n' } })).not.toThrow()
    const after = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(after.mcpServers['bad name']).toEqual({ command: 'x' })
    expect(after.mcpServers['noop']).toEqual({})
    expect(after.mcpServers['scalar']).toBe('oops')
    expect(after.mcpServers['newer']).toEqual({ command: 'n' })
  })

  it('record 形坏条目（缺传输但有外键）经表单编辑补全后外键保留（合并底生效）', () => {
    useFile({ mcpServers: { broken: { timeout: 5 } } })
    expect(() => updateMcpServer('broken', stdio('fixed', { description: 'repaired' }))).not.toThrow()
    const snap = readMcpServers()
    expect(snap.servers[0]!.config).toEqual({ timeout: 5, command: 'fixed', description: 'repaired' })
  })

  it('非 record 坏条目经表单编辑 = 以空为底重建（修复坏条目的正当通道）', () => {
    useFile({ mcpServers: { weird: 'oops' } })
    expect(() => updateMcpServer('weird', stdio('fixed'))).not.toThrow()
    const snap = readMcpServers()
    expect(snap.servers[0]!.config).toEqual({ command: 'fixed' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// RMW 合并不丢外部条目（D2：锁内重读磁盘最新内容再合并写入）
// ─────────────────────────────────────────────────────────────────────────────

describe('RMW 合并不丢外部条目', () => {
  it('外部手编追加的条目在 taiji 后续保存后仍在', () => {
    useFile({ mcpServers: { mine: { command: 'm' } } })
    // 外部写方不认锁：直接改文件（模拟终端 pi mcp add / 手编）
    const external = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    external.mcpServers['external-cli'] = { url: 'https://ext.example/mcp' }
    writeFileSync(mcpPath, `${JSON.stringify(external, null, 2)}\n`, 'utf-8')

    // taiji 保存（锁内重读 → 合并 → 写）
    expect(() => addMcpServer({ mode: 'form', name: 'added-later', fields: { transport: 'stdio', command: 'a' } })).not.toThrow()

    const after = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(Object.keys(after.mcpServers).sort()).toEqual(['added-later', 'external-cli', 'mine'])
  })

  it('合并底 = 锁内最新读：外部刚加的外键在 taiji 表单保存后保留（窗口收窄语义）', () => {
    useFile({ mcpServers: { s: { command: 'x' } } })
    // 外部给该条目追加 oauth（taiji 启动后的快照里没有）
    const external = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    external.mcpServers.s.oauth = { clientId: 'later-added' }
    writeFileSync(mcpPath, `${JSON.stringify(external, null, 2)}\n`, 'utf-8')

    updateMcpServer('s', { mode: 'form', fields: { transport: 'stdio', command: 'x', description: 'd' } })
    const snap = readMcpServers()
    expect(snap.servers[0]!.config).toEqual({ command: 'x', description: 'd', oauth: { clientId: 'later-added' } })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 顶层键保留与缩进保持（D4：对齐 pi editMcpServers「Other content is kept」）
// ─────────────────────────────────────────────────────────────────────────────

describe('写回保留文件结构', () => {
  it('mcpServers 之外顶层键在 add/update/remove 后原样保留', () => {
    useFile({
      mcpServers: { s: { command: 'x' } },
      autoEnableCodemode: false,
      customTopKey: { keep: [1, 2] },
    })
    updateMcpServer('s', stdio('y'))
    addMcpServer({ mode: 'form', name: 't', fields: { transport: 'stdio', command: 't' } })
    removeMcpServer('t')
    const after = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(after.autoEnableCodemode).toBe(false)
    expect(after.customTopKey).toEqual({ keep: [1, 2] })
    expect(after.mcpServers).toEqual({ s: { command: 'y' } })
  })

  it('缩进保持（对齐 pi：rewritten with its indentation）', () => {
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { s: { command: 'x' } } }, null, 4) + '\n', 'utf-8')
    setMcpStorePathForTest(mcpPath)
    updateMcpServer('s', stdio('y'))
    const raw = readFileSync(mcpPath, 'utf-8')
    expect(raw).toContain('    "mcpServers"')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('文件不存在：读 = 空清单；add 创建文件', () => {
    useFile()
    const snap = readMcpServers()
    expect(snap).toMatchObject({ corrupted: false, corruptedReason: null, servers: [] })
    expect(snap.filePath).toBe(mcpPath)

    addMcpServer({ mode: 'form', name: 'first', fields: { transport: 'stdio', command: 'x' } })
    const created = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(created.mcpServers).toEqual({ first: { command: 'x' } })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// type 三值闭集与形态一致性（D4 例外条款；表单产物无 type → 空转）
// ─────────────────────────────────────────────────────────────────────────────

describe('type 校验（D4 例外条款）', () => {
  it('"sse" 显式拒绝并指引改用 streamable HTTP 地址', () => {
    const err = expectStoreError('type_sse', () => validateMcpEntryForSave('s', { type: 'sse', url: 'https://x' }))
    expect(err.message).toContain('SSE')
    expect(err.message).toContain('url')
  })

  it.each(['websocket', 'SSE', 'stdio2', 42, null])('未知 type 值 %j 报错（闭集 = stdio/http/streamable-http）', (type) => {
    expectStoreError('type_unknown', () => validateMcpEntryForSave('s', { type, url: 'https://x' }))
  })

  it('streamable-http 旧称放行（其他客户端迁移片段可遇，不得误拦）', () => {
    expect(() => validateMcpEntryForSave('s', { type: 'streamable-http', url: 'https://x' })).not.toThrow()
    expect(() => validateMcpEntryForSave('s', { type: 'http', url: 'https://x' })).not.toThrow()
    expect(() => validateMcpEntryForSave('s', { type: 'stdio', command: 'x' })).not.toThrow()
  })

  it.each([
    ['type stdio + url', { type: 'stdio', url: 'https://x' }],
    ['type http + command', { type: 'http', command: 'x' }],
    ['type streamable-http + command', { type: 'streamable-http', command: 'x' }],
  ])('形态不符拦截：%s（pi 加载期整条拒载且文案与病因错位，保存当场拦）', (_label: string, config: unknown) => {
    expectStoreError('type_transport_mismatch', () => validateMcpEntryForSave('s', config))
  })

  it('表单路径产物无 type 键，type 校验空转（D4 管线顺序）', () => {
    useFile({ mcpServers: { s: { type: 'http', url: 'https://old' } } })
    // 携带显式 type 的既有条目经表单切换为 stdio：剥离先于校验，不因中间态误拦
    expect(() => updateMcpServer('s', stdio('npx'))).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 补充断言 ①-⑤（设计文档验收条款，逐条落测）
// ─────────────────────────────────────────────────────────────────────────────

describe('§4 断言① · type 剥离 + 切换键级清理 + 产物可被 pi 校验接受', () => {
  it('携带 type:"http" 的条目经表单切换为 stdio 后保存：产物无 type、url/headers 已删、pi 校验通过', () => {
    useFile({
      mcpServers: {
        s: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer t' }, timeout: 30 },
      },
    })
    updateMcpServer('s', stdio('npx', { args: ['-y', 'pkg'] }))

    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect('type' in produced).toBe(false)
    expect('url' in produced).toBe(false)
    expect('headers' in produced).toBe(false)
    expect(produced).toEqual({ timeout: 30, command: 'npx', args: ['-y', 'pkg'] })

    // 条目可被 pi 校验接受（实装版直接断言，锁 taiji 复刻与 pi 实装不漂移；包不可达时跳过）
    if (piValidate) expect(piValidate('s', produced)).toEqual(produced)
  })

  it('反向切换（stdio 既有条目切 http）：command/args/env/cwd 已删', () => {
    useFile({ mcpServers: { s: { command: 'x', args: ['a'], env: { K: 'v' }, cwd: '/w' } } })
    updateMcpServer('s', http('https://y', { headers: { 'X-A': 'b' } }))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced).toEqual({ url: 'https://y', headers: { 'X-A': 'b' } })
  })
})

describe('§4 断言② · 代码模式添加 streamable-http 旧称条目成功', () => {
  it('包装形态粘贴 type:"streamable-http" + url → 保存成功且原样落盘', () => {
    useFile()
    addMcpServer({ mode: 'code', parsed: { legacy: { type: 'streamable-http', url: 'https://old-name.example/mcp' } } })
    const snap = readMcpServers()
    expect(snap.servers[0]).toMatchObject({
      name: 'legacy',
      error: null,
      config: { type: 'streamable-http', url: 'https://old-name.example/mcp' },
    })
  })
})

describe('§4 断言③ · 编辑流代码模式改名拦截', () => {
  it('包装键名与被编辑条目名不一致 → 拦截，文案含「改名 = 删除后重建」指引', () => {
    useFile({ mcpServers: { original: { command: 'x' } } })
    const err = expectStoreError('rename_not_allowed', () =>
      updateMcpServer('original', { mode: 'code', parsed: { renamed: { command: 'y' } } }),
    )
    expect(err.message).toContain('original')
    expect(err.message).toContain('删除后重建')
    // 未落盘
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers).toEqual({ original: { command: 'x' } })
  })

  it('包装键名与被编辑条目名一致 → 按包装形态取内层值', () => {
    useFile({ mcpServers: { s: { command: 'old' } } })
    updateMcpServer('s', { mode: 'code', parsed: { s: { command: 'new' } } })
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s).toEqual({ command: 'new' })
  })

  it('裸条目值对象形态（编辑流）→ 整体作为条目值（外键随 textarea 内容替换，无静默丢失通道）', () => {
    useFile({ mcpServers: { s: { command: 'x', timeout: 5 } } })
    updateMcpServer('s', { mode: 'code', parsed: { command: 'y', timeout: 99 } })
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s).toEqual({ command: 'y', timeout: 99 })
  })
})

describe('§4 断言④ · 表单清空可选字段 = 删键（封死浅合并）', () => {
  it('既有带 args/env/cwd/description 的条目，表单只填 command 保存 → 产物不含这些键', () => {
    useFile({ mcpServers: { s: { command: 'x', args: ['a'], env: { K: 'v' }, cwd: '/w', description: 'd' } } })
    updateMcpServer('s', stdio('y'))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced).toEqual({ command: 'y' })
  })

  it('清空 description / env 空对象 / args 空数组同理删键', () => {
    useFile({ mcpServers: { s: { command: 'x', description: 'old', env: { K: 'v' } } } })
    updateMcpServer('s', stdio('y', { description: '  ', args: [], env: {} }))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect('description' in produced).toBe(false)
    expect('env' in produced).toBe(false)
    expect('args' in produced).toBe(false)
  })
})

describe('§4 断言⑤ · 添加流代码模式裸形态拦截', () => {
  it('裸条目值对象（无包装键名）→ 拦截，文案含包装形态指引', () => {
    useFile()
    const err = expectStoreError('code_entry_form_invalid', () =>
      addMcpServer({ mode: 'code', parsed: { command: 'x', args: ['a'] } }),
    )
    expect(err.message).toContain('包装形态')
    // 不落盘
    expect(readMcpServers().servers).toEqual([])
  })

  it('多键包装 → 单条目形态拦截', () => {
    useFile()
    const err = expectStoreError('code_single_entry', () =>
      addMcpServer({ mode: 'code', parsed: { a: { command: 'x' }, b: { command: 'y' } } }),
    )
    expect(err.message).toContain('一个服务器')
  })

  it('包装形态（添加流）名称自动取键名', () => {
    useFile()
    addMcpServer({ mode: 'code', parsed: { wrapped: { command: 'x' } } })
    expect(readMcpServers().servers[0]).toMatchObject({ name: 'wrapped', error: null })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 编辑写回契约 · 表单外键原样保留（D7 禁按表单字段集全量替换）
// ─────────────────────────────────────────────────────────────────────────────

describe('表单外键原样保留（D7 核心承诺）', () => {
  it('携带 oauth/timeout/toolExposure/auth 的条目经表单编辑描述与 URL 后全部保留', () => {
    useFile({
      mcpServers: {
        s: {
          url: 'https://old',
          oauth: { clientId: 'cid', callbackPort: 8899 },
          timeout: 30,
          toolExposure: { secret_tool: 'hidden' },
          auth: { provider: 'zai' },
        },
      },
    })
    updateMcpServer('s', http('https://new', { description: 'edited' }))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced.oauth).toEqual({ clientId: 'cid', callbackPort: 8899 })
    expect(produced.timeout).toBe(30)
    expect(produced.toolExposure).toEqual({ secret_tool: 'hidden' })
    expect(produced.auth).toEqual({ provider: 'zai' })
    expect(produced.url).toBe('https://new')
    expect(produced.description).toBe('edited')
  })

  it('type 是外键原样保留的唯一例外：表单模式保存一律剥离（无论是否切换过传输类型）', () => {
    useFile({ mcpServers: { s: { type: 'http', url: 'https://x', timeout: 9 } } })
    // 未切换传输类型（仍 http），仅改描述——type 同样剥离
    updateMcpServer('s', http('https://x', { description: 'same-transport-edit' }))
    const produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect('type' in produced).toBe(false)
    expect(produced.timeout).toBe(9)
  })

  it('exposure = codemode 缺省化（对齐 pi 写路径语义）；其他档位落键；enabled 仅 false 落键', () => {
    useFile({ mcpServers: { s: { command: 'x', exposure: 'direct', enabled: false } } })
    updateMcpServer('s', stdio('y', { exposure: 'codemode', enabled: true }))
    let produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect('exposure' in produced).toBe(false)
    expect('enabled' in produced).toBe(false)

    updateMcpServer('s', stdio('y', { exposure: 'direct', enabled: false }))
    produced = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers.s
    expect(produced.exposure).toBe('direct')
    expect(produced.enabled).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// remove / not_found / pi 实装等价性
// ─────────────────────────────────────────────────────────────────────────────

describe('removeMcpServer', () => {
  it('删除存在的条目：true + 条目消失 + 顶层键保留', () => {
    useFile({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } }, autoEnableCodemode: true })
    expect(removeMcpServer('a')).toBe(true)
    const after = JSON.parse(readFileSync(mcpPath, 'utf-8'))
    expect(after.mcpServers).toEqual({ b: { command: 'y' } })
    expect(after.autoEnableCodemode).toBe(true)
  })

  it('删除不存在的条目：false（幂等意图，对齐 pi removeMcpServerConfig 返回语义）', () => {
    useFile({ mcpServers: { a: { command: 'x' } } })
    expect(removeMcpServer('nope')).toBe(false)
  })
})

describe('updateMcpServer / addMcpServer 边界', () => {
  it('update 不存在的条目 → not_found', () => {
    useFile()
    const err = expectStoreError('not_found', () => updateMcpServer('ghost', stdio('x')))
    expect(err.message).toContain('不存在')
  })

  it('add code 模式顶层非对象（数组/标量）→ 形态拦截', () => {
    useFile()
    expectStoreError('code_entry_form_invalid', () => addMcpServer({ mode: 'code', parsed: [1, 2] }))
    expectStoreError('code_entry_form_invalid', () => addMcpServer({ mode: 'code', parsed: 'oops' }))
  })
})

describe.skipIf(!piValidate)(
  `pi 实装等价性（产物喂实装 validateMcpServerConfig${SKIP_REASON ? `｜skip：${SKIP_REASON}` : ''}）`,
  () => {
    it('表单产物（stdio/http）与代码模式合法粘贴均被 pi 校验器接受', () => {
      useFile()
      addMcpServer({ mode: 'form', name: 'f_stdio', fields: { transport: 'stdio', command: 'npx', args: ['-y', 'p'] } })
      addMcpServer({ mode: 'form', name: 'f_http', fields: { transport: 'http', url: 'https://x/mcp' } })
      addMcpServer({ mode: 'code', parsed: { c_code: { type: 'streamable-http', url: 'https://y' } } })

      const servers = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers
      for (const [name, config] of Object.entries(servers)) {
        const validated = piValidate!(name, config)
        expect(typeof validated).not.toBe('string')
        expect(validated).toEqual(config)
      }
    })

    it('taiji 拦截形态与 pi 实装报错对齐（混填 pi 放行 url 分支、type 错配 pi 报 needs either）', () => {
      // pi 对混填放行（taiji 有意收紧的实装证据）
      expect(piValidate!('s', { command: 'x', url: 'https://y' })).toEqual({ command: 'x', url: 'https://y' })
      // pi 对 type 错配的报错文案与病因错位（D4 例外条款实证）
      expect(piValidate!('s', { type: 'http', command: 'x' })).toBe(
        'server "s" needs either "command" (stdio) or "url" (streamable HTTP)',
      )
    })

    it('§4 断言①产物（type 剥离后）被 pi 校验器接受（无 type 条目按传输字段归类）', () => {
      expect(piValidate!('s', { command: 'npx', args: ['-y', 'pkg'], timeout: 30 })).toEqual({
        command: 'npx',
        args: ['-y', 'pkg'],
        timeout: 30,
      })
    })
  },
)
