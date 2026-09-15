/**
 * ConfigService system-prompt 新方法单测（TDD 红灯）。
 *
 * 覆盖：getSystemPromptConfig / setSystemPromptConfig / getReplaceSystemPrompt 的常规与异常路径。
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
}

const DEFAULT_SYSTEM_PROMPT_CONFIG: SystemPromptConfig = {
  version: 1,
  replace: { enabled: false, prompt: '' },
  append: { enabled: false, prompt: '' },
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
})
