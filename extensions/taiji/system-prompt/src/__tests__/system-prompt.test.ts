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
import createExtension, {
  CAPABILITY_FORBIDDEN,
  CAPABILITY_INLINE_TAG_FAMILIES,
  CAPABILITY_PRESENTATION_ATTRS,
  SESSION_ARTIFACTS_DIR_SEGMENT,
  resolveSessionArtifactsDir,
} from '../index'
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

/** hook 注册表桩（参照 msg-id-mapper harness 模式）——handler 第二参 ctx 透传（路径注入测试用） */
function createHarness(): { beforeAgentStart: (event: BeforeAgentStartEvent, ctx?: unknown) => unknown } {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const pi = {
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler)
    },
  } as unknown as ExtensionAPI
  createExtension(pi)
  return {
    beforeAgentStart: (event, ctx) => handlers.get('before_agent_start')!(event, ctx),
  }
}

/** 触发一次 hook 的便捷封装（常规 event：systemPrompt 字符串；ctx 可选） */
function runHook(systemPrompt: string, ctx?: unknown): { systemPrompt?: string } | undefined {
  const h = createHarness()
  return h.beforeAgentStart({ type: 'before_agent_start', prompt: 'hi', systemPrompt }, ctx) as
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

  it('argv 含 -nc 短形式 → 同样跳过 global 注入（pi CLI 等价短形式，守卫两种形式都命中）', () => {
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
  it('候选序优先：AGENTS.md 与 AGENTS.MD 并存 → AGENTS.md 胜（候选列表顺序的第一个存在者）', () => {
    setupFs({
      globalEntries: ['AGENTS.md', 'AGENTS.MD'],
      globalFiles: { 'AGENTS.md': 'FROM-LOWER', 'AGENTS.MD': 'FROM-UPPER' },
    })
    const result = runHook('BASE-PROMPT')
    expect(result!.systemPrompt).toContain('FROM-LOWER')
    expect(result!.systemPrompt).not.toContain('FROM-UPPER')
    expect(result!.systemPrompt).toContain(path.join(GLOBAL_DIR, 'AGENTS.md'))
  })

  it('首候选内容空白 → 跳过继续找下一候选（AGENTS.md 空白 + AGENTS.MD 有内容 → 注入 AGENTS.MD）', () => {
    setupFs({
      globalEntries: ['AGENTS.md', 'AGENTS.MD'],
      globalFiles: { 'AGENTS.md': '   \n\t', 'AGENTS.MD': 'FROM-UPPER' },
    })
    const result = runHook('BASE-PROMPT')
    expect(result!.systemPrompt).toContain('FROM-UPPER')
    expect(result!.systemPrompt).toContain(path.join(GLOBAL_DIR, 'AGENTS.MD'))
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

// ── 能力段 ①② 渲染锁定 + 产物目录镜像常量（chat-html-support u1-prompt）──────────

/** 能力段清单区的边界标签（文案与源码 TAIJI_CAPABILITY_SECTION 同字面量）。 */
const POS_TAGS_LABEL = 'You may use these tags: '
const POS_ATTRS_LABEL = 'Presentational attributes allowed: '
const FORBIDDEN_TAGS_LABEL = 'Do not use these tags (they are stripped before rendering): '
const FORBIDDEN_ATTRS_LABEL = 'Do not use these attributes (they are stripped and have no effect): '

/** 从能力段截取 startLabel..endLabel 之间的逗号分隔清单。缺失边界 → 断言失败（防静默跳过）。 */
function parseListRegion(section: string, startLabel: string, endLabel: string): string[] {
  const i = section.indexOf(startLabel)
  expect(i, `能力段缺少清单标签: ${startLabel}`).toBeGreaterThanOrEqual(0)
  const start = i + startLabel.length
  const j = section.indexOf(endLabel, start)
  expect(j, `能力段缺少清单结束标签: ${endLabel}`).toBeGreaterThan(start)
  return section.slice(start, j).split(', ').map((s) => s.trim())
}

/** 集合比较用：去重 + 稳定排序（渲染顺序不参与断言，成员集合才是契约）。 */
const asSet = (xs: readonly string[]): string[] => [...new Set(xs)].sort()

/** 触发一次 hook 并返回 capability 段全文（默认开关开、无 append / global）。 */
function capabilitySectionText(): string {
  setupFs({ config: `{"append": {"enabled": false, "prompt": ""}, "capability": {"enabled": true}}` })
  const prompt = runHook('BASE-PROMPT')!.systemPrompt as string
  const i = prompt.indexOf(CAP_HEADER)
  expect(i).toBeGreaterThanOrEqual(0)
  return prompt.slice(i)
}

describe('capability 段 ①② 渲染锁定（文案 = 常量渲染产物，手写散文旁路即红）', () => {
  it('正面清单逐项等于常量集合（含全部成员、无旁路成员、无重复）', () => {
    const section = capabilitySectionText()
    const tags = parseListRegion(section, POS_TAGS_LABEL, '. ' + POS_ATTRS_LABEL)
    const attrs = parseListRegion(section, POS_ATTRS_LABEL, '.\n')
    const allTags = Object.values(CAPABILITY_INLINE_TAG_FAMILIES).flat()

    // 无重复（渲染旁路/手写追加会引入重复项）
    expect(tags.length).toBe(new Set(tags).size)
    expect(attrs.length).toBe(new Set(attrs).size)
    // 集合逐项相等：缺成员 = 文案旁路漏写；多成员 = 手写散文多出
    expect(asSet(tags)).toEqual(asSet(allTags))
    expect(asSet(attrs)).toEqual(asSet(CAPABILITY_PRESENTATION_ATTRS))
  })

  it('负面清单逐项等于常量集合（构造性剥除的标签与属性）', () => {
    const section = capabilitySectionText()
    const forbiddenTags = parseListRegion(section, FORBIDDEN_TAGS_LABEL, '. ' + FORBIDDEN_ATTRS_LABEL)
    const forbiddenAttrs = parseListRegion(section, FORBIDDEN_ATTRS_LABEL, '.\n')

    expect(asSet(forbiddenTags)).toEqual(asSet(CAPABILITY_FORBIDDEN.tags))
    expect(asSet(forbiddenAttrs)).toEqual(asSet(CAPABILITY_FORBIDDEN.attributes))
  })

  it('capability.enabled=false → 整段（含 ①② 清单）不注入', () => {
    setupFs({ config: `{"append": {"enabled": false, "prompt": ""}, ${CAP_OFF}}` })
    expect(runHook('BASE-PROMPT')).toBeUndefined()
  })

  it('清单常量成员与渲染管线白名单同域（包内自锚：52 标签 / 76 属性）', () => {
    expect(Object.values(CAPABILITY_INLINE_TAG_FAMILIES).flat()).toHaveLength(52)
    expect(CAPABILITY_PRESENTATION_ATTRS).toHaveLength(76)
    // 族归类不重复：每个标签恰出现一次
    const all = Object.values(CAPABILITY_INLINE_TAG_FAMILIES).flat()
    expect(all.length).toBe(new Set(all).size)
    // 禁用清单与正面清单不相交（构造性剥除语义）
    const positive = new Set(all)
    for (const tag of CAPABILITY_FORBIDDEN.tags) expect(positive.has(tag)).toBe(false)
  })
})

describe('产物目录镜像常量与推导 helper（设计 D1/D7，供 u-artifacts 公式对拍消费）', () => {
  it('段名字面量为 artifacts', () => {
    expect(SESSION_ARTIFACTS_DIR_SEGMENT).toBe('artifacts')
  })

  it('合法 pi sid → <dataDir>/artifacts/<sessionId>', () => {
    expect(resolveSessionArtifactsDir('0198ab12-cdef-7000-8000-1234567890ab')).toBe(
      path.join(DATA_DIR, 'artifacts', '0198ab12-cdef-7000-8000-1234567890ab'),
    )
    // 允许 `.` 与 `_`（与 isPiSessionId 同域）
    expect(resolveSessionArtifactsDir('a.b-c_d')).toBe(path.join(DATA_DIR, 'artifacts', 'a.b-c_d'))
  })

  it('非法 sessionId（含冒号 / 空串 / 首尾非字母数字）→ throw（防路径穿越）', () => {
    for (const bad of ['btw:x', '', '_leading', 'trailing-', 'a/b', '..', 'a b']) {
      expect(() => resolveSessionArtifactsDir(bad)).toThrow(/invalid sessionId/)
    }
  })

  it('resolveDataDir 回退（无 TAIJI_AGENT_DATA_DIR 时取 PI_CODING_AGENT_DIR 上级）', () => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    process.env.PI_CODING_AGENT_DIR = path.join('/tmp/fallback-data', 'agent')
    expect(resolveSessionArtifactsDir('abc')).toBe(path.join('/tmp/fallback-data', 'artifacts', 'abc'))
  })
})

// ── 能力段 ③④ 与产物目录路径注入（chat-html-support §6.1 D1 / §5.1 样例）────────────

/** 触发一次 hook 并返回 capability 段全文（capability 开、无 append / global；ctx 可选）。 */
function capabilityTextWithCtx(ctx?: unknown): string {
  setupFs({ config: `{"append": {"enabled": false, "prompt": ""}, "capability": {"enabled": true}}` })
  const prompt = runHook('BASE-PROMPT', ctx)!.systemPrompt as string
  const i = prompt.indexOf(CAP_HEADER)
  expect(i).toBeGreaterThanOrEqual(0)
  return prompt.slice(i)
}

/** ctx 桩：sessionManager.getSessionId 返回给定值（u-foundation 核实的 pi ExtensionContext 形状） */
function ctxWithSessionId(getSessionId: () => string): unknown {
  return { sessionManager: { getSessionId } }
}

describe('capability 段 ③④（HTML 交付约定 + 预览约束）与产物目录路径注入', () => {
  const SID = '0198ab12-cdef-7000-8000-1234567890ab'

  it('ctx 会话 id 在 → ③ 段含产物目录绝对路径（与会话 id 匹配）', () => {
    const text = capabilityTextWithCtx(ctxWithSessionId(() => SID))
    // 路径 = <dataDir>/artifacts/<sid>（与 shared getSessionArtifactsDir 同公式）
    expect(text).toContain(resolveSessionArtifactsDir(SID))
    expect(text).toContain(path.join(DATA_DIR, 'artifacts', SID))
    // ③ 段交付约定与 ④ 段预览约束齐备
    expect(text).toContain('info string is html-preview')
    expect(text).toContain("that file's absolute path")
    expect(text).toContain('update the file in place on later changes')
    expect(text).toContain('recycled automatically once stale')
    expect(text).toContain('Previewed HTML runs sandboxed with no network access')
    expect(text).toContain('CDN links will not load')
  })

  it('会话 id 缺失（无 ctx / getSessionId 空串 / sessionManager 缺失）→ 该处退化且其余文案完整', () => {
    const cases: (unknown | undefined)[] = [
      undefined,
      ctxWithSessionId(() => ''),
      {},
    ]
    for (const ctx of cases) {
      const text = capabilityTextWithCtx(ctx)
      expect(text).toContain('session artifacts directory (unavailable this turn)')
      // 其余 ③④ 文案完整（只路径处退化）
      expect(text).toContain('info string is html-preview')
      expect(text).toContain('regenerate on reference failure instead of assuming persistence')
      expect(text).toContain('scripts/styles/images may be inline or reference local files')
      expect(text).toContain('fonts must be inlined as data: URIs')
      expect(text).toContain('blocked by the browser CORS policy')
      expect(text).toContain('CDN links will not load')
      // 不出现半截/伪造路径
      expect(text).not.toContain(path.join(DATA_DIR, 'artifacts'))
    }
  })

  it('getSessionId 抛错 / 非法 id（含冒号 virtual id）→ 退化不阻塞，其余文案完整', () => {
    const throwing = ctxWithSessionId(() => { throw new Error('no session context') })
    const virtualId = ctxWithSessionId(() => 'btw:0198ab12-cdef')
    for (const ctx of [throwing, virtualId]) {
      const text = capabilityTextWithCtx(ctx)
      expect(text).toContain('(unavailable this turn)')
      expect(text).toContain('info string is html-preview')
      expect(text).not.toContain(path.join(DATA_DIR, 'artifacts'))
    }
  })

  it('capability.enabled=false → ③④ 同整段一起不注入', () => {
    setupFs({ config: `{"append": {"enabled": false, "prompt": ""}, ${CAP_OFF}}` })
    expect(runHook('BASE-PROMPT', ctxWithSessionId(() => SID))).toBeUndefined()
  })
})
