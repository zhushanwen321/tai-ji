/**
 * ConfigService system-prompt 新方法单测（TDD 红灯）。
 *
 * 覆盖：getSystemPromptConfig / setSystemPromptConfig / getReplaceSystemPrompt 的常规与异常路径。
 * schema v2 增量：capability 段透传与非布尔回退（设计 D6：仅显式布尔 false 关闭，
 * 与扩展侧 readCapabilityEnabled 对齐——merge 若剥字段，用户关闭开关保存后重开设置页
 * 会误显「开」，且后续保存以 UI 态误开写回）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigService } from '../src/services/config-service.js'

/** 契约常量：replace.prompt 最大长度。 */
const SYSTEM_PROMPT_MAX_LENGTH = 16000

/** 将实现的契约类型（本地定义，避免引用尚不存在的 shared 导出导致编译失败）。 */
interface SystemPromptConfig {
  version: number
  replace: { enabled: boolean; prompt: string }
  append: { enabled: boolean; prompt: string }
  capability?: { enabled: boolean }
}

const DEFAULT_SYSTEM_PROMPT_CONFIG: SystemPromptConfig = {
  version: 1,
  replace: { enabled: false, prompt: '' },
  append: { enabled: false, prompt: '' },
  capability: { enabled: true },
}

/** 只暴露 getConfigDir 的最小假 configStore。 */
function makeFakeConfigStore(configDir: string) {
  return {
    getConfigDir: () => configDir,
  }
}

/** 把 ConfigService 强转成「将拥有 system-prompt 方法」的形状，让调用在运行时自然失败。 */
type SystemPromptSvc = {
  getSystemPromptConfig(): { config: SystemPromptConfig; corrupted: boolean }
  setSystemPromptConfig(config: SystemPromptConfig): { ok: boolean; error?: string }
  getReplaceSystemPrompt(): string | undefined
}

let tmpDir: string
let configDir: string
let rawService: ConfigService
let service: SystemPromptSvc

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'system-prompt-cfg-'))
  configDir = join(tmpDir, 'config')
  mkdirSync(configDir, { recursive: true })

  const store = makeFakeConfigStore(configDir)
  rawService = new ConfigService(
    tmpDir,
    store as unknown as ConstructorParameters<typeof ConfigService>[1],
  )
  service = rawService as unknown as SystemPromptSvc
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

function systemPromptPath(): string {
  return join(configDir, 'system-prompt.json')
}

describe('ConfigService system-prompt', () => {
  it('set 后再 get 返回相同配置且 corrupted=false', () => {
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'replace-me' },
      append: { enabled: true, prompt: 'append-me' },
      capability: { enabled: false },
    }

    const setResult = service.setSystemPromptConfig(cfg)
    expect(setResult.ok).toBe(true)

    const got = service.getSystemPromptConfig()
    expect(got.corrupted).toBe(false)
    expect(got.config).toEqual(cfg)
  })

  it('配置文件缺失时返回默认配置且 corrupted=false', () => {
    expect(existsSync(systemPromptPath())).toBe(false)

    const got = service.getSystemPromptConfig()
    expect(got.corrupted).toBe(false)
    expect(got.config).toEqual(DEFAULT_SYSTEM_PROMPT_CONFIG)
  })

  it('配置文件 JSON 损坏时返回默认配置且 corrupted=true', () => {
    writeFileSync(systemPromptPath(), '{ not valid json', 'utf-8')

    const got = service.getSystemPromptConfig()
    expect(got.corrupted).toBe(true)
    expect(got.config).toEqual(DEFAULT_SYSTEM_PROMPT_CONFIG)
  })

  it('replace.prompt 超长时返回 ok:false 且不写盘', () => {
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'x'.repeat(SYSTEM_PROMPT_MAX_LENGTH + 1) },
      append: { enabled: false, prompt: '' },
    }

    const setResult = service.setSystemPromptConfig(cfg)
    expect(setResult.ok).toBe(false)
    expect(setResult.error).toBeTruthy()
    expect(existsSync(systemPromptPath())).toBe(false)
  })

  it('getReplaceSystemPrompt：enabled + 非空时返回原文', () => {
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'custom core prompt' },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(cfg)

    expect(service.getReplaceSystemPrompt()).toBe('custom core prompt')
  })

  it('getReplaceSystemPrompt：enabled + 纯空白时视为未启用返回 undefined', () => {
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: '   \t\n  ' },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(cfg)

    expect(service.getReplaceSystemPrompt()).toBeUndefined()
  })

  it('getReplaceSystemPrompt：disabled 时返回 undefined', () => {
    const cfg: SystemPromptConfig = {
      version: 1,
      replace: { enabled: false, prompt: 'ignored' },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(cfg)

    expect(service.getReplaceSystemPrompt()).toBeUndefined()
  })

  it('setSystemPromptConfig 超长拒绝时不会覆盖已有的合法配置', () => {
    const valid: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'valid' },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(valid)
    const before = readFileSync(systemPromptPath(), 'utf-8')

    const invalid: SystemPromptConfig = {
      version: 1,
      replace: { enabled: true, prompt: 'x'.repeat(SYSTEM_PROMPT_MAX_LENGTH + 1) },
      append: { enabled: false, prompt: '' },
    }
    service.setSystemPromptConfig(invalid)

    const after = readFileSync(systemPromptPath(), 'utf-8')
    expect(after).toBe(before)
  })

  it('capability 透传：磁盘 v2 json 的 enabled 布尔原样读回（merge 不剥字段）', () => {
    writeFileSync(
      systemPromptPath(),
      JSON.stringify({
        version: 2,
        replace: { enabled: false, prompt: '' },
        append: { enabled: false, prompt: '' },
        capability: { enabled: false },
      }),
      'utf-8',
    )
    // 关闭态回读不丢失：若 merge 层剥字段，UI 重开设置页会误显「开」并误开写回
    expect(service.getSystemPromptConfig().config.capability).toEqual({ enabled: false })
  })

  it('capability 非布尔 / 缺字段 / 非对象 → 回退 enabled true（默认开，D6 解析方向）', () => {
    const bads: unknown[] = [
      // v1 存量 json：无 capability 字段
      { version: 1, replace: { enabled: false, prompt: '' }, append: { enabled: false, prompt: '' } },
      // 损坏形态：enabled 为字符串 "false"（非布尔）
      { capability: { enabled: 'false' } },
      // 损坏形态：capability 字段非对象
      { capability: 'off' },
    ]
    for (const bad of bads) {
      writeFileSync(systemPromptPath(), JSON.stringify(bad), 'utf-8')
      expect(service.getSystemPromptConfig().config.capability).toEqual({ enabled: true })
    }
  })
})
