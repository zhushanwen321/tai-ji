/**
 * system-prompt extension 真实行为测试。
 *
 * 覆盖（替换原 expect(true) 占位，R3 extension-api SUGGESTION #1）：
 * - readJsonIfValid 解析边界：文件缺失 / 畸形 JSON / 顶层 array / 顶层原始值 → 全部收敛 defaults
 * - readSection 字段级防御：section 非对象、enabled 非 true、prompt 非字符串 / 空白 → 不注入
 * - capability 段三态锚点（设计 D6）：v1 存量 json（无字段）→ 注入；显式布尔 false → 不注入；
 *   损坏形态（"enabled": "false" 字符串 / capability 非对象）→ 注入（与 readSection 解析方向相反）
 * - before_agent_start 注入顺序：base → global instructions → capability → append（indexOf 链锁定，
 *   swap 注入顺序两行的 mutant 会被顺序用例 kill）
 * - -nc / --no-context-files 守卫：global 注入跳过、append 不受影响
 * - global 候选选择：候选序优先、空白内容跳过继续找、目录缺失降级
 * - fail-safe：handler 全程 throw → return undefined + logger.error 可观测；logger 自身抛错的
 *   终极兜底 process.stderr.write；systemPrompt 非法类型的旧 quirk 锚定
 *
 * 适配约定：capability 默认开（仅显式布尔 false 关闭）。聚焦 append/global 语义的既有用例
 * 在 config 里显式 "capability":{"enabled":false} 隔离关注点；无法塞字段的用例（畸形 JSON /
 * 文件缺失）期望值如实更新为含 capability 段。capability 自身行为由专项 describe 锚定。
 *
 * mock 策略（参照 msg-id-mapper 测试模式）：pi SDK import type 零运行时解析，
 * ExtensionAPI 用结构化桩；node:fs mock 后按路径分流（env 指向假目录，不碰真实文件系统）。
 *
 * 运行：cd extensions/taiji/system-prompt && npx vitest run
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@zhushanwen/pi-extension-logger', () => ({
  getLogger: () => loggerMock,
  createLogger: () => loggerMock,
}))

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import createExtension from '../index'
import type { ExtensionAPI, BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

const DATA_DIR = '/taiji-test/data'
const GLOBAL_DIR = '/taiji-test/global-agents'
const CONFIG_PATH = path.join(DATA_DIR, 'system-prompt.json')

/** capability 段 header 锚（文案变更须同步本锚，红 = 提醒评审段文本变化） */
const CAP_HEADER = '# TaiJi capabilities'
/** 既有用例隔离关注点用的「capability 显式关闭」config 片段 */
const CAP_OFF = '"capability": {"enabled": false}'

/** hook 注册表桩（参照 msg-id-mapper harness 模式） */
function createHarness(): { beforeAgentStart: (event: BeforeAgentStartEvent) => unknown } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler)
    },
  } as unknown as ExtensionAPI
  createExtension(pi)
  return {
    beforeAgentStart: (event) => handlers.get('before_agent_start')!(event),
  }
}

/** 触发一次 hook 的便捷封装（常规 event：systemPrompt 字符串） */
function runHook(systemPrompt: string): { systemPrompt?: string } | undefined {
  const h = createHarness()
  return h.beforeAgentStart({ type: 'before_agent_start', prompt: 'hi', systemPrompt }) as
    | { systemPrompt?: string }
    | undefined
}

/**
 * fs mock 分流配置。
 * - config：system-prompt.json 的文件内容（string）或 Error（readFileSync throw，默认 ENOENT）
 * - globalEntries：global 目录 readdirSync 返回（默认 [] = 无候选）
 * - globalFiles：候选文件名 → 内容（string）或 Error（stat/read throw）
 */
interface FsSetup {
  config?: string | Error
  globalEntries?: string[] | Error
  globalFiles?: Record<string, string | Error>
}

/** mtime 纪元：每次 setupFs 递增，模拟「文件被改写后 mtime 变化」。 */
let mtimeEpoch = 0

function setupFs(setup: FsSetup = {}): void {
  mtimeEpoch += 1
  const { config = new Error("ENOENT: no such file or directory, open '" + CONFIG_PATH + "'") } = setup
  const { globalEntries = [], globalFiles = {} } = setup
  vi.mocked(readdirSync).mockImplementation(() => {
    if (globalEntries instanceof Error) throw globalEntries
    return globalEntries as unknown as string[]
  })
  vi.mocked(statSync).mockImplementation((p: unknown) => {
    // config 文件可 stat（内容存在时）——cachedReadFileSync 先 stat 判 mtime 再读，
    // config 缺失（Error）时 stat 同步 throw（等价 ENOENT）
    if (String(p) === CONFIG_PATH) {
      if (config instanceof Error) throw config
      return { isFile: () => true, mtimeMs: mtimeEpoch } as unknown as ReturnType<typeof statSync>
    }
    const name = path.basename(String(p))
    if (!(name in globalFiles)) throw new Error('ENOENT stat ' + String(p))
    if (globalFiles[name] instanceof Error) throw globalFiles[name]
    // mtimeMs 模拟真实 mtime：每次 setupFs 递增一次纪元——同一 setup 内稳定（缓存命中），
    // 重新 setupFs（等价改文件）后变化（缓存失效重读），与 cachedReadFileSync 判变语义对齐。
    return { isFile: () => true, mtimeMs: mtimeEpoch } as unknown as ReturnType<typeof statSync>
  })
  vi.mocked(readFileSync).mockImplementation((p: unknown) => {
    const fp = String(p)
    if (fp === CONFIG_PATH) {
      if (config instanceof Error) throw config
      return config
    }
    const name = path.basename(fp)
    if (name in globalFiles) {
      if (globalFiles[name] instanceof Error) throw globalFiles[name]
      return globalFiles[name]
    }
    throw new Error('ENOENT: no such file, open ' + fp)
  })
}

const ENV_KEYS = ['TAIJI_AGENT_DATA_DIR', 'TAIJI_GLOBAL_AGENTS_DIR', 'PI_CODING_AGENT_DIR'] as const
const savedEnv: Record<string, string | undefined> = {}
const savedArgv = process.argv

beforeEach(() => {
  vi.clearAllMocks() // 清跨用例的 fs mock 调用记录（「守卫不触发」类断言依赖零计数）
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  process.env.TAIJI_AGENT_DATA_DIR = DATA_DIR
  process.env.TAIJI_GLOBAL_AGENTS_DIR = GLOBAL_DIR
  delete process.env.PI_CODING_AGENT_DIR
  setupFs()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  process.argv = savedArgv
  vi.restoreAllMocks()
})

describe('readJsonIfValid 解析边界（config 读取 → defaults 收敛，capability 默认开）', () => {
  // 本组 config 均无法塞字段（缺失/畸形/非对象），capability 走默认 true——
  // defaults 的语义自 schema v2 起含「capability 段注入」，期望如实更新。
  it('config 文件缺失（ENOENT）→ defaults → 仅注入 capability 段', () => {
    setupFs({ config: new Error("ENOENT: no such file or directory, open '" + CONFIG_PATH + "'") })
    expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })

  it('config 畸形 JSON（parse throw）→ defaults → 仅注入 capability 段', () => {
    setupFs({ config: '{broken json' })
    expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })

  it('config 顶层 array → isJsonObject 放行 quirk（数组不排除）→ 字段缺省收敛 defaults → 仅 capability 段', () => {
    // R3 复核锚定的行为等价：顶层数组两版实现同走 typeof object 放行路径，无错误数据
    setupFs({ config: '[1, 2]' })
    expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })

  it('config 顶层原始值（number / string / null 字面量）→ null → defaults → 仅 capability 段', () => {
    for (const bad of ['42', '"a string"', 'null', 'true']) {
      setupFs({ config: bad })
      expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
    }
  })
})

describe('readSection 字段级防御（append section；capability 显式关闭以隔离关注点）', () => {
  it('append section 非对象（null / 字符串）→ {enabled:false, prompt:""} → 不注入', () => {
    for (const section of ['null', '"just text"']) {
      setupFs({ config: `{"append": ${section}, ${CAP_OFF}}` })
      expect(runHook('base prompt')).toBeUndefined()
    }
  })

  it('append.enabled 非 true（字符串 "true"）→ 不视为开启 → 不注入', () => {
    setupFs({ config: `{"append": {"enabled": "true", "prompt": "extra"}, ${CAP_OFF}}` })
    expect(runHook('base prompt')).toBeUndefined()
  })

  it('append.prompt 非字符串（number）→ 缺省 "" → 不注入', () => {
    setupFs({ config: `{"append": {"enabled": true, "prompt": 123}, ${CAP_OFF}}` })
    expect(runHook('base prompt')).toBeUndefined()
  })

  it('append.enabled true 但 prompt 纯空白 → trim 后为空 → 不注入', () => {
    setupFs({ config: `{"append": {"enabled": true, "prompt": "   \\n\\t "}, ${CAP_OFF}}` })
    expect(runHook('base prompt')).toBeUndefined()
  })

  it('append 合法（enabled true + 非空 prompt）→ 注入到 base 之后（\\n\\n 分隔）', () => {
    setupFs({ config: `{"append": {"enabled": true, "prompt": "APPEND-TEXT"}, ${CAP_OFF}}` })
    expect(runHook('base prompt')).toEqual({ systemPrompt: 'base prompt\n\nAPPEND-TEXT' })
  })
})

describe('before_agent_start 注入顺序（base → global → capability → append）', () => {
  it('四段齐备 → base 最前、global 居中、capability 段次之、append 最后（indexOf 链锁定）', () => {
    setupFs({
      config: '{"append": {"enabled": true, "prompt": "APPEND-TEXT"}}',
      globalEntries: ['AGENTS.md'],
      globalFiles: { 'AGENTS.md': 'GLOBAL-CONTENT' },
    })
    const result = runHook('BASE-PROMPT')
    expect(result).toEqual({ systemPrompt: expect.stringContaining('APPEND-TEXT') })
    const prompt = result!.systemPrompt as string

    // 顺序锚点：base → global header → global 内容 → capability 段 → append 文本
    const iBase = prompt.indexOf('BASE-PROMPT')
    const iHeader = prompt.indexOf('# Global instructions')
    const iGlobal = prompt.indexOf('GLOBAL-CONTENT')
    const iCap = prompt.indexOf(CAP_HEADER)
    const iAppend = prompt.indexOf('APPEND-TEXT')
    expect(iBase).toBeGreaterThanOrEqual(0)
    expect(iHeader).toBeGreaterThan(iBase)
    expect(iGlobal).toBeGreaterThan(iHeader)
    expect(iCap).toBeGreaterThan(iGlobal)
    expect(iAppend).toBeGreaterThan(iCap)
    expect(prompt.indexOf('APPEND-TEXT', iAppend + 1)).toBe(-1) // append 恰一次
    expect(prompt.indexOf(CAP_HEADER, iCap + 1)).toBe(-1) // capability 段恰一次
    // global header 带真实注入路径（可追溯）
    expect(prompt).toContain(path.join(GLOBAL_DIR, 'AGENTS.md'))
  })

  it('capability 段文案覆盖四点能力面（HTML 白名单 / 相对图片 / 相对链接双通道 / 远程图片不渲染）', () => {
    setupFs({ config: '{"append": {"enabled": false, "prompt": ""}}' })
    const prompt = runHook('BASE-PROMPT')!.systemPrompt as string
    const capText = prompt.slice(prompt.indexOf(CAP_HEADER))
    expect(capText).toContain('Inline HTML')
    expect(capText).toContain('Relative image paths')
    expect(capText).toContain('Relative links')
    expect(capText).toContain('not rendered')
    expect(capText).toContain('backticks')
  })

  it('capability 关闭（显式布尔 false）→ 段消失，其余段顺序不变', () => {
    setupFs({
      config: `{"append": {"enabled": true, "prompt": "APPEND-TEXT"}, ${CAP_OFF}}`,
      globalEntries: ['AGENTS.md'],
      globalFiles: { 'AGENTS.md': 'GLOBAL-CONTENT' },
    })
    const prompt = runHook('BASE-PROMPT')!.systemPrompt as string
    expect(prompt).not.toContain(CAP_HEADER)
    // 三段顺序保持 base → global → append（capability 摘除不动既有链路）
    const iBase = prompt.indexOf('BASE-PROMPT')
    const iGlobal = prompt.indexOf('GLOBAL-CONTENT')
    const iAppend = prompt.indexOf('APPEND-TEXT')
    expect(iBase).toBeGreaterThanOrEqual(0)
    expect(iGlobal).toBeGreaterThan(iBase)
    expect(iAppend).toBeGreaterThan(iGlobal)
  })

  it('global 无候选文件 → 只剩 base + capability + append 三段', () => {
    setupFs({
      config: '{"append": {"enabled": true, "prompt": "APPEND-TEXT"}}',
      globalEntries: [],
    })
    const result = runHook('BASE-PROMPT')
    const prompt = result!.systemPrompt as string
    expect(prompt).not.toContain('# Global instructions')
    expect(prompt).toContain(CAP_HEADER)
    expect(prompt).toContain('APPEND-TEXT')
    expect(prompt.indexOf(CAP_HEADER)).toBeGreaterThan(prompt.indexOf('BASE-PROMPT'))
    expect(prompt.indexOf('APPEND-TEXT')).toBeGreaterThan(prompt.indexOf(CAP_HEADER))
  })
})

describe('capability 段三态锚点（设计 D6：仅显式布尔 false 关闭，与 readSection 方向相反）', () => {
  it('v1 存量 json（无 capability 字段）→ 默认开 → 注入', () => {
    setupFs({ config: '{"version": 1, "replace": {"enabled": false, "prompt": ""}, "append": {"enabled": false, "prompt": ""}}' })
    expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })

  it('config 文件不存在 → 同 v1 语义 → 注入', () => {
    setupFs()
    expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })

  it('显式 enabled: false（布尔）→ 关闭 → 不注入', () => {
    setupFs({ config: `{"append": {"enabled": false, "prompt": ""}, ${CAP_OFF}}` })
    expect(runHook('base prompt')).toBeUndefined()
  })

  it('显式 enabled: true → 注入', () => {
    setupFs({ config: '{"append": {"enabled": false, "prompt": ""}, "capability": {"enabled": true}}' })
    expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })

  it('损坏形态：enabled 为字符串 "false"（非布尔）→ 不视为关闭 → 注入', () => {
    setupFs({ config: '{"append": {"enabled": false, "prompt": ""}, "capability": {"enabled": "false"}}' })
    expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })

  it('损坏形态：capability 字段非对象（字符串 / null / 数组）→ 注入', () => {
    for (const bad of ['"off"', 'null', '[1]']) {
      setupFs({ config: `{"append": {"enabled": false, "prompt": ""}, "capability": ${bad}}` })
      expect(runHook('base prompt')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
    }
  })
})

describe('-nc / --no-context-files 守卫（contextFilesDisabled）', () => {
  // capability 与守卫正交（内置段不受 --no-context-files 影响，该旗标只管上下文文件
  // 发现），用例显式关 capability 隔离守卫语义。
  it('argv 含 --no-context-files → global 不注入，append 仍生效（用户显式退出不得溜回来）', () => {
    setupFs({
      config: `{"append": {"enabled": true, "prompt": "APPEND-TEXT"}, ${CAP_OFF}}`,
      globalEntries: ['AGENTS.md'],
      globalFiles: { 'AGENTS.md': 'GLOBAL-CONTENT' },
    })
    process.argv = ['node', 'pi', '--no-context-files']
    expect(runHook('BASE-PROMPT')).toEqual({ systemPrompt: 'BASE-PROMPT\n\nAPPEND-TEXT' })
    // 守卫在读 global 文件之前：readdirSync 不应被调用（global 目录完全不被触碰）
    expect(readdirSync).not.toHaveBeenCalled()
  })

  it('argv 含 -nc 短形式 → 同样跳过 global 注入（与 argv-mirror 两种形式一致）', () => {
    setupFs({
      config: `{"append": {"enabled": true, "prompt": "APPEND-TEXT"}, ${CAP_OFF}}`,
      globalEntries: ['AGENTS.md'],
      globalFiles: { 'AGENTS.md': 'GLOBAL-CONTENT' },
    })
    process.argv = ['node', 'pi', '-nc']
    expect(runHook('BASE-PROMPT')).toEqual({ systemPrompt: 'BASE-PROMPT\n\nAPPEND-TEXT' })
  })
})

describe('global 候选文件选择（readGlobalAgentsFile）', () => {
  it('候选序优先：AGENTS.MD 与 CLAUDE.md 并存 → AGENTS.MD 胜（候选列表顺序的第一个存在者）', () => {
    setupFs({
      globalEntries: ['AGENTS.MD', 'CLAUDE.md'],
      globalFiles: { 'AGENTS.MD': 'FROM-AGENTS-UPPER', 'CLAUDE.md': 'FROM-CLAUDE' },
    })
    const result = runHook('BASE-PROMPT')
    expect(result!.systemPrompt).toContain('FROM-AGENTS-UPPER')
    expect(result!.systemPrompt).not.toContain('FROM-CLAUDE')
    expect(result!.systemPrompt).toContain(path.join(GLOBAL_DIR, 'AGENTS.MD'))
  })

  it('首候选内容空白 → 跳过继续找下一候选（AGENTS.md 空白 + CLAUDE.md 有内容 → 注入 CLAUDE.md）', () => {
    setupFs({
      globalEntries: ['AGENTS.md', 'CLAUDE.md'],
      globalFiles: { 'AGENTS.md': '   \n\t', 'CLAUDE.md': 'FROM-CLAUDE' },
    })
    const result = runHook('BASE-PROMPT')
    expect(result!.systemPrompt).toContain('FROM-CLAUDE')
    expect(result!.systemPrompt).toContain(path.join(GLOBAL_DIR, 'CLAUDE.md'))
  })

  it('global 目录不存在（readdirSync throw）→ 降级 null：global 不注入、不抛错（capability 默认段仍在）', () => {
    setupFs({ globalEntries: new Error('ENOENT: no such directory') })
    const result = runHook('BASE-PROMPT')
    expect(result).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
    expect(result!.systemPrompt).not.toContain('# Global instructions')
  })
})

describe('fail-safe（外层 catch return undefined，永不阻断 agent loop）', () => {
  it('handler 全程 throw（systemPrompt getter 抛错）→ return undefined + logger.error 落盘可观测', () => {
    const h = createHarness()
    const event = { type: 'before_agent_start', prompt: 'hi' } as unknown as BeforeAgentStartEvent
    Object.defineProperty(event, 'systemPrompt', {
      get() {
        throw new Error('getter boom')
      },
    })
    expect(h.beforeAgentStart(event)).toBeUndefined()
    expect(loggerMock.error).toHaveBeenCalledWith(
      'before_agent_start hook failed: Error: getter boom',
    )
  })

  it('logger 自身抛错的终极兜底 → stderr 兜底，仍 return undefined', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    loggerMock.error.mockImplementation(() => {
      throw new Error('logger gone')
    })
    const h = createHarness()
    const event = { type: 'before_agent_start', prompt: 'hi' } as unknown as BeforeAgentStartEvent
    Object.defineProperty(event, 'systemPrompt', {
      get() {
        throw new Error('getter boom')
      },
    })
    expect(h.beforeAgentStart(event)).toBeUndefined()
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('logHookFailure also failed'),
    )
  })

  it('systemPrompt 非法类型（undefined）且无 append → 旧 quirk 锚定：返回仅含 capability 段的结果而非 undefined', () => {
    // R3 复核锚定的返回值守卫 quirk（index.ts newPrompt === event.systemPrompt 比较）：
    // base 收敛 ''，capability 默认开 → newPrompt 非空且 !== undefined → 必然返回对象。
    // 与重构前行为一致（非回归）：quirk 在「有注入时必然返回对象」，schema v2 后 capability
    // 默认开使该形态成为常态。
    const h = createHarness()
    const event = { type: 'before_agent_start', prompt: 'hi' } as unknown as BeforeAgentStartEvent
    expect(h.beforeAgentStart(event)).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })

  it('systemPrompt 非法类型（undefined）但有 append 注入 → 空串 base + capability 段 + append 依序拼接', () => {
    setupFs({ config: '{"append": {"enabled": true, "prompt": "APPEND-TEXT"}}' })
    const h = createHarness()
    const event = { type: 'before_agent_start', prompt: 'hi' } as unknown as BeforeAgentStartEvent
    // base 收敛 ''，拼接形态固定为 '' + '\n\n' + capability + '\n\n' + append（分隔符保留，与合法 base 一致）
    const result = h.beforeAgentStart(event) as { systemPrompt: string }
    expect(result.systemPrompt).toContain(CAP_HEADER)
    expect(result.systemPrompt).toContain('APPEND-TEXT')
    expect(result.systemPrompt.indexOf('APPEND-TEXT')).toBeGreaterThan(result.systemPrompt.indexOf(CAP_HEADER))
    expect(result.systemPrompt.startsWith('\n\n')).toBe(true)
  })
})

describe('cachedReadFileSync（mtime 级内容缓存，KV-cache 稳定性改造）', () => {
  it('文件未变时二次 hook 不再重复 readFileSync（缓存命中）', () => {
    setupFs({
      config: '{"append": {"enabled": true, "prompt": "P1"}}',
      globalEntries: ['AGENTS.md'],
      globalFiles: { 'AGENTS.md': '# GLOBAL' },
    })
    const r1 = runHook('base')
    const reads1 = vi.mocked(readFileSync).mock.calls.length
    const r2 = runHook('base')
    expect(r2).toEqual(r1) // 两次注入结果逐字节一致
    expect(vi.mocked(readFileSync).mock.calls.length).toBe(reads1) // 第二次全命中缓存，零重读
  })

  it('文件改写（mtime 变）后下一轮 hook 读到新内容（变更即生效语义保留）', () => {
    // CAP_OFF：本条锚精确串「base + P1」，capability 开启会让期望值带上整段常量文案，
    // 显式关闭以保持断言可读；capability 的变更即生效由 readConfig 共用路径保证。
    setupFs({ config: `{"append": {"enabled": true, "prompt": "P1"}, ${CAP_OFF}}` })
    expect(runHook('base')).toEqual({ systemPrompt: 'base\n\nP1' })
    // 模拟用户改写 append.prompt（setupFs 递增 mtime 纪元）
    setupFs({ config: `{"append": {"enabled": true, "prompt": "P2"}, ${CAP_OFF}}` })
    expect(runHook('base')).toEqual({ systemPrompt: 'base\n\nP2' })
  })

  it('文件删除（stat throw）后缓存驱逐，append 注入降级消失，capability 回默认开', () => {
    setupFs({ config: `{"append": {"enabled": true, "prompt": "P1"}, ${CAP_OFF}}` })
    expect(runHook('base')).toEqual({ systemPrompt: 'base\n\nP1' })
    setupFs() // config 恢复默认 ENOENT → defaults：append 无、capability 默认开
    expect(runHook('base')).toEqual({ systemPrompt: expect.stringContaining(CAP_HEADER) })
  })
})
