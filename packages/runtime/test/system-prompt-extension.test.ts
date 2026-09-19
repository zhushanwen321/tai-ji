/**
 * @zhushanwen/pi-system-prompt（extensions/taiji/system-prompt/）before_agent_start hook 单测。
 *
 * 动态 import extensions/taiji/system-prompt/index.ts（npm 包源码），验证 hook 行为：
 * - append 开启且 prompt 非空 → 追加到 event.systemPrompt
 * - append 关闭 / append.prompt 空白 → 返回 undefined
 * - capability 段（schema v2，设计 D6）：默认开（文件缺失 / JSON 损坏也注入），
 *   仅显式布尔 false 关闭——与 append 的「缺省关」方向相反
 * - 支持 TAIJI_AGENT_DATA_DIR 与 PI_CODING_AGENT_DIR 回退两种目录解析
 * - 全局指令文件（~/.agents/AGENTS.md 等候选，TAIJI_GLOBAL_AGENTS_DIR 指向 tmp）：
 *   存在 → 带头部注入；空白 → 跳过；目录/缺失候选 → 顺延下一候选；
 *   --no-context-files 在 argv → 全局不注入（append 仍生效）
 *
 * 适配约定：聚焦 append/global 语义的既有用例写盘 config 显式带 CAP_OFF 隔离关注点；
 * 无法写 config 的用例（文件缺失 / JSON 损坏）期望如实更新为含 capability 段。
 * capability 自身三态已由扩展包内 __tests__/system-prompt.test.ts 专项锚定。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface SystemPromptConfig {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
  capability?: { enabled: boolean }
}

/** 既有用例隔离关注点用的「capability 显式关闭」片段（保持原精确断言） */
const CAP_OFF: { capability: { enabled: boolean } } = { capability: { enabled: false } }

/** capability 段 header 锚（与扩展源码 TAIJI_CAPABILITY_SECTION 的 header 一致） */
const CAP_HEADER = '# TaiJi capabilities'

const PLUGIN_PATH = new URL('../../../extensions/taiji/system-prompt/index.ts', import.meta.url).pathname

function writeConfig(dataDir: string, config: SystemPromptConfig): void {
  writeFileSync(join(dataDir, 'system-prompt.json'), JSON.stringify(config), 'utf-8')
}

/** 写入全局指令候选文件，返回其路径。 */
function writeGlobalAgents(content: string, name = 'AGENTS.md'): string {
  const p = join(agentsDir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

/** 期望的全局指令注入段（头部 + 内容）。 */
function globalSegment(p: string, content: string): string {
  return `\n\n# Global instructions (${p})\n\n${content}`
}

let tmpDir: string
let dataDir: string
let piAgentDir: string
let agentsDir: string
let originalDataDir: string | undefined
let originalPiAgentDir: string | undefined
let originalGlobalAgentsDir: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'system-prompt-ext-'))
  dataDir = tmpDir
  // 新布局形态（方案 B）：agentDir = <dataDir>/agent，插件回退推导 1 层上溯得 dataDir
  piAgentDir = join(tmpDir, 'agent')
  mkdirSync(piAgentDir, { recursive: true })
  agentsDir = join(tmpDir, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  originalDataDir = process.env.TAIJI_AGENT_DATA_DIR
  originalPiAgentDir = process.env.PI_CODING_AGENT_DIR
  originalGlobalAgentsDir = process.env.TAIJI_GLOBAL_AGENTS_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
  delete process.env.PI_CODING_AGENT_DIR
  process.env.TAIJI_GLOBAL_AGENTS_DIR = agentsDir
})

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.TAIJI_AGENT_DATA_DIR
  } else {
    process.env.TAIJI_AGENT_DATA_DIR = originalDataDir
  }
  if (originalPiAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR
  } else {
    process.env.PI_CODING_AGENT_DIR = originalPiAgentDir
  }
  if (originalGlobalAgentsDir === undefined) {
    delete process.env.TAIJI_GLOBAL_AGENTS_DIR
  } else {
    process.env.TAIJI_GLOBAL_AGENTS_DIR = originalGlobalAgentsDir
  }
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function loadPlugin(): Promise<(pi: unknown) => void> {
  const mod = await import(PLUGIN_PATH) as unknown as { default?: (pi: unknown) => void }
  if (!mod.default) throw new Error('plugin default export missing')
  return mod.default
}

type PiLike = { on: ReturnType<typeof vi.fn> }
type Handler = (event: { systemPrompt: string }) => { systemPrompt?: string } | undefined

function installPlugin(factory: (pi: unknown) => void): { pi: PiLike; handler: Handler } {
  const pi: PiLike = { on: vi.fn() }
  factory(pi)
  const call = pi.on.mock.calls.find((c) => c?.[0] === 'before_agent_start')
  expect(call).toBeDefined()
  return { pi, handler: call![1] as Handler }
}

describe('@zhushanwen/pi-system-prompt', () => {
  it('append 开启且非空 → 返回 BASE + "\\n\\n" + EXTRA', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    const result = handler({ systemPrompt: 'BASE' })
    expect(result).toEqual({ systemPrompt: 'BASE\n\nEXTRA' })
  })

  it('append 关闭 → 返回 undefined', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: 'ignored' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('配置文件缺失 → capability 默认开，仅注入 capability 段（D6：缺字段 → true）', async () => {
    const factory = await loadPlugin()
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: expect.stringContaining(CAP_HEADER),
    })
  })

  it('配置文件 JSON 损坏 → 同缺省语义，capability 默认开', async () => {
    const factory = await loadPlugin()
    writeFileSync(join(dataDir, 'system-prompt.json'), '{ not json', 'utf-8')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: expect.stringContaining(CAP_HEADER),
    })
  })

  it('append.prompt 纯空白 → 返回 undefined', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: '   \t\n  ' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('未设 TAIJI_AGENT_DATA_DIR 时可用 PI_CODING_AGENT_DIR 回退定位配置', async () => {
    delete process.env.TAIJI_AGENT_DATA_DIR
    process.env.PI_CODING_AGENT_DIR = piAgentDir

    const factory = await loadPlugin()
    // PI_CODING_AGENT_DIR/.. === tmpDir === dataDir（<dataDir>/agent 1 层上溯）
    writeConfig(tmpDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'FALLBACK' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({ systemPrompt: 'BASE\n\nFALLBACK' })
  })

  it('全局 AGENTS.md 存在 → 追加带头部的内容', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      ...CAP_OFF,
    })
    const p = writeGlobalAgents('GLOBAL_RULES')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: 'BASE' + globalSegment(p, 'GLOBAL_RULES'),
    })
  })

  it('全局 AGENTS.md + append 配置 → 全局在前、append 在后', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
      ...CAP_OFF,
    })
    const p = writeGlobalAgents('GLOBAL_RULES')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: 'BASE' + globalSegment(p, 'GLOBAL_RULES') + '\n\nEXTRA',
    })
  })

  it('全局文件内容纯空白 → 不注入（返回 undefined）', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      ...CAP_OFF,
    })
    writeGlobalAgents('   \n\t  ')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toBeUndefined()
  })

  it('AGENTS.md 是目录（非文件）→ 跳过该候选，注入 CLAUDE.md', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      ...CAP_OFF,
    })
    mkdirSync(join(agentsDir, 'AGENTS.md')) // 同名目录：existsSync 为真但 isFile 为假
    const p = writeGlobalAgents('CLAUDE_RULES', 'CLAUDE.md')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: 'BASE' + globalSegment(p, 'CLAUDE_RULES'),
    })
  })

  it('AGENTS.MD（大写变体）被识别为全局指令文件', async () => {
    const factory = await loadPlugin()
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: false, prompt: '' },
      ...CAP_OFF,
    })
    const p = writeGlobalAgents('UPPER_RULES', 'AGENTS.MD')
    const { handler } = installPlugin(factory)

    expect(handler({ systemPrompt: 'BASE' })).toEqual({
      systemPrompt: 'BASE' + globalSegment(p, 'UPPER_RULES'),
    })
  })

  it('--no-context-files 在 argv → 全局不注入，append 仍生效', async () => {
    const factory = await loadPlugin()
    writeGlobalAgents('GLOBAL_RULES')
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    process.argv.push('--no-context-files')
    try {
      expect(handler({ systemPrompt: 'BASE' })).toEqual({ systemPrompt: 'BASE\n\nEXTRA' })
    } finally {
      const idx = process.argv.lastIndexOf('--no-context-files')
      if (idx >= 0) process.argv.splice(idx, 1)
    }
  })

  // [review 修复 R4] pi CLI 的 -nc 是 --no-context-files 的等价短形式（cli/args.ts），
  // 守卫须双形式命中——只匹配长形式时手动以 -nc 启动 pi 的用户绕过 opt-out。
  it('-nc 短形式在 argv → 全局同样不注入，append 仍生效', async () => {
    const factory = await loadPlugin()
    writeGlobalAgents('GLOBAL_RULES')
    writeConfig(dataDir, {
      version: 1,
      replace: { enabled: false, prompt: '' },
      append: { enabled: true, prompt: 'EXTRA' },
      ...CAP_OFF,
    })
    const { handler } = installPlugin(factory)

    process.argv.push('-nc')
    try {
      expect(handler({ systemPrompt: 'BASE' })).toEqual({ systemPrompt: 'BASE\n\nEXTRA' })
    } finally {
      const idx = process.argv.lastIndexOf('-nc')
      if (idx >= 0) process.argv.splice(idx, 1)
    }
  })
})
