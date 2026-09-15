/**
 * TerminalConfig（Phase 6 settings）单元测试。
 *
 * 覆盖 ConfigService.getTerminalConfig / setTerminalConfig 的读写 + 校验语义，
 * 复刻 system-prompt config 的测试范式（真实 tmpdir + 最小 IConfigStore mock）。
 *
 * ConfigService 通过注入的 this.configStore.getConfigDir() 定位配置目录，
 * 故 mock 只需让 getConfigDir() 返回每个用例独立的 tmpdir（文件系统真实读写，
 * 不需 TAIJI_AGENT_DATA_DIR 环境变量，隔离更干净）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/__tests__/terminal-config.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TerminalConfig } from '@taiji/shared'
import { ConfigService } from '../config-service.js'
import type { IConfigStore } from '../ports/config.js'

/** 默认配置（与 defaultTerminalConfig 对齐，测试断言用）。 */
const DEFAULT_CONFIG: TerminalConfig = {
  version: 1,
  shell: '',
  shellArgs: [],
  fontSize: 14,
  fontFamily: '',
  scrollback: 5000,
  cursorStyle: 'block',
  bell: true,
}

/** 构造最小 IConfigStore mock——只让 getConfigDir() 指向给定目录。 */
function createMockConfigStore(dir: string): IConfigStore {
  // 其余方法用例不触达，cast as IConfigStore 省去全量桩（仅 ConfigService 终端相关方法被调）。
  return { getConfigDir: () => dir } as unknown as IConfigStore
}

describe('ConfigService terminal config (Phase 6)', () => {
  let dir: string
  let service: ConfigService

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'terminal-cfg-'))
    service = new ConfigService(dir, createMockConfigStore(dir))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  // ── getTerminalConfig ────────────────────────────────────────────

  it('TC-1: 文件不存在 → 返回默认配置 corrupted=false', () => {
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(false)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('TC-2: 文件损坏（非法 JSON）→ 返回默认配置 corrupted=true', () => {
    writeFileSync(join(dir, 'terminal.json'), '{ not valid json,,,', 'utf-8')
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(true)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('TC-3: 字段缺失 → merge 填默认值 corrupted=false', () => {
    // 空对象：所有字段都缺，merge 后应全等于默认（仅 version 被覆盖测试用）
    writeFileSync(join(dir, 'terminal.json'), JSON.stringify({ version: 2 }), 'utf-8')
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(false)
    expect(config).toEqual({ ...DEFAULT_CONFIG, version: 2 })
  })

  it('TC-4: 完整合法文件 → 原样返回 corrupted=false', () => {
    const full: TerminalConfig = {
      version: 3,
      shell: '/bin/zsh',
      shellArgs: ['-l', '-e'],
      fontSize: 16,
      fontFamily: 'Fira Code',
      scrollback: 10000,
      cursorStyle: 'underline',
      bell: false,
    }
    writeFileSync(join(dir, 'terminal.json'), JSON.stringify(full), 'utf-8')
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(false)
    expect(config).toEqual(full)
  })

  // ── setTerminalConfig 校验 ──────────────────────────────────────

  it('TC-5: fontSize 超范围 → ok:false + 不写盘', () => {
    const tooSmall: TerminalConfig = { ...DEFAULT_CONFIG, fontSize: 1 }
    const result = service.setTerminalConfig(tooSmall)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/fontSize out of range/)
    // 不写盘
    expect(existsSync(join(dir, 'terminal.json'))).toBe(false)
  })

  it('TC-6: 正常写入 → ok:true + 文件内容正确', () => {
    const valid: TerminalConfig = {
      ...DEFAULT_CONFIG,
      shell: '/bin/fish',
      shellArgs: ['--login'],
      fontSize: 18,
      scrollback: 8000,
      cursorStyle: 'bar',
    }
    const result = service.setTerminalConfig(valid)
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()

    // 文件内容 = 写入的 config（JSON 解析后逐字段比对）
    const written = JSON.parse(readFileSync(join(dir, 'terminal.json'), 'utf-8'))
    expect(written).toEqual(valid)

    // 回读一致（getTerminalConfig 不损坏）
    const { config, corrupted } = service.getTerminalConfig()
    expect(corrupted).toBe(false)
    expect(config).toEqual(valid)
  })

  it('TC-7: 无效 cursorStyle → ok:false', () => {
    const invalid = { ...DEFAULT_CONFIG, cursorStyle: 'invalid' as TerminalConfig['cursorStyle'] }
    const result = service.setTerminalConfig(invalid)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/invalid cursorStyle/)
  })
})
