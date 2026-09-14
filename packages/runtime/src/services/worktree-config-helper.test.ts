import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import lockfile from 'proper-lockfile'
import { getAutoRenameEnabled, setAutoRenameEnabled, getAutoRenameEnabledPath, ensureAutoRenameDefault, getRenameModel, setRenameModel, getRenameConfigPath, setRenameConfigLockTimingForTest, getRenameMode, setRenameMode } from './worktree-config-helper.js'
import type { RenameMode } from '@xyz-agent/shared'

describe('auto-rename enabled 标志文件', () => {
  let tmpRoot: string

  beforeEach(() => {
    // 每个测试独立临时目录，避免互相干扰
    tmpRoot = mkdtempSync(join(tmpdir(), 'auto-rename-test-'))
    // getPiAgentDir 经 getDataDir 读 XYZ_AGENT_DATA_DIR → 临时目录/agent
    vi.stubEnv('XYZ_AGENT_DATA_DIR', tmpRoot)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('getAutoRenameEnabledPath 解析到 <XYZ_AGENT_DATA_DIR>/agent/auto-rename-enabled', () => {
    expect(getAutoRenameEnabledPath()).toBe(join(tmpRoot, 'agent', 'auto-rename-enabled'))
  })

  it('文件不存在时 getAutoRenameEnabled 返回 false（默认关闭）', () => {
    expect(getAutoRenameEnabled()).toBe(false)
  })

  it('setAutoRenameEnabled(true) 创建文件后 getAutoRenameEnabled 返回 true', () => {
    setAutoRenameEnabled(true)
    expect(existsSync(getAutoRenameEnabledPath())).toBe(true)
    expect(getAutoRenameEnabled()).toBe(true)
  })

  it('setAutoRenameEnabled(false) 删除已存在的文件', () => {
    setAutoRenameEnabled(true)
    expect(getAutoRenameEnabled()).toBe(true)
    setAutoRenameEnabled(false)
    expect(existsSync(getAutoRenameEnabledPath())).toBe(false)
    expect(getAutoRenameEnabled()).toBe(false)
  })

  it('文件不存在时 setAutoRenameEnabled(false) 不报错（吞 ENOENT）', () => {
    expect(() => setAutoRenameEnabled(false)).not.toThrow()
    expect(getAutoRenameEnabled()).toBe(false)
  })
})

describe('ensureAutoRenameDefault', () => {
  let tmpRoot: string
  const initializedPath = () => join(tmpRoot, 'agent', 'auto-rename-initialized')

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'auto-rename-init-'))
    vi.stubEnv('XYZ_AGENT_DATA_DIR', tmpRoot)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('首次调用：创建 initialized 标记 + 开启 auto-rename', () => {
    expect(existsSync(initializedPath())).toBe(false)
    expect(getAutoRenameEnabled()).toBe(false)

    ensureAutoRenameDefault()

    // initialized 标记已写
    expect(existsSync(initializedPath())).toBe(true)
    // 默认开启 auto-rename
    expect(getAutoRenameEnabled()).toBe(true)
  })

  it('幂等性：initialized 标记存在时不干预，不覆盖用户的关闭操作', () => {
    // 模拟用户已关闭 auto-rename（initialized 标记存在，但 enabled 文件不存在）
    setAutoRenameEnabled(false)
    // 手动创建 initialized 标记（表示已完成首次初始化）
    // 先建好 agent/ 目录再写标记（ensureAutoRenameDefault 检测到标记存在会直接 return，
    // 不会自己 mkdir，所以测试要预先把目录和标记造好）
    const { writeFileSync, mkdirSync } = require('node:fs')
    const { dirname } = require('node:path')
    mkdirSync(dirname(initializedPath()), { recursive: true })
    writeFileSync(initializedPath(), '', 'utf-8')

    ensureAutoRenameDefault()

    // 用户关闭的状态被保留，没有被 boot 反复重开
    expect(getAutoRenameEnabled()).toBe(false)
    // initialized 标记仍在
    expect(existsSync(initializedPath())).toBe(true)
  })

  it('初始化失败不抛错（不阻塞 boot）', () => {
    // 让 getPiAgentDir 抛错：把 XYZ_AGENT_DATA_DIR 指向一个不存在的根，使 mkdirSync 失败
    // （mock 一个不可创建的路径：指向一个已被删除的目录的子路径）
    const { mkdirSync } = require('node:fs')
    const origMkdir = mkdirSync
    require('node:fs').mkdirSync = vi.fn(() => { throw new Error('mock mkdir failure') })

    expect(() => ensureAutoRenameDefault()).not.toThrow()

    // 恢复
    require('node:fs').mkdirSync = origMkdir
  })
})

describe('rename-session 模型配置（config/rename-session-ext-config.json）', () => {
  let tmpRoot: string
  const configPath = () => join(tmpRoot, 'agent', 'config', 'rename-session-ext-config.json')

  /** 写入原始配置 JSON（预建目录）。 */
  function writeRawConfig(raw: unknown): void {
    mkdirSync(dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2), 'utf-8')
  }

  /** 读回配置 JSON（parse 后对象）。 */
  function readRawConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rename-model-test-'))
    vi.stubEnv('XYZ_AGENT_DATA_DIR', tmpRoot)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('getRenameConfigPath 解析到 <XYZ_AGENT_DATA_DIR>/agent/config/rename-session-ext-config.json', () => {
    expect(getRenameConfigPath()).toBe(join(tmpRoot, 'agent', 'config', 'rename-session-ext-config.json'))
  })

  it('getRenameModel：文件不存在返回空串（未设置）', () => {
    expect(getRenameModel()).toBe('')
  })

  it('getRenameModel：正常文件读出 model.ref', () => {
    writeRawConfig({ enabled: true, model: { type: 'ref', ref: 'p1/m1' }, maxTitleLength: 50, thinkingLevel: 'off' })
    expect(getRenameModel()).toBe('p1/m1')
  })

  it('getRenameModel：model 字段缺失 / 非法形态返回空串', () => {
    writeRawConfig({ enabled: true })
    expect(getRenameModel()).toBe('')
    writeRawConfig({ model: 'p1/m1' })
    expect(getRenameModel()).toBe('')
    writeRawConfig({ model: { type: 'scoped' } })
    expect(getRenameModel()).toBe('')
    writeRawConfig({ model: { type: 'ref', ref: 123 } })
    expect(getRenameModel()).toBe('')
  })

  it('getRenameModel：坏 JSON 返回空串（不抛错）', () => {
    writeRawConfig('{ not valid json')
    expect(getRenameModel()).toBe('')
  })

  it('setRenameModel：读改写保留其他字段与未知字段', () => {
    writeRawConfig({ enabled: true, model: { type: 'ref', ref: 'old/m' }, maxTitleLength: 30, thinkingLevel: 'low', futureField: { a: 1 } })
    setRenameModel('p1/m1')

    const saved = readRawConfig()
    expect(saved['model']).toEqual({ type: 'ref', ref: 'p1/m1' })
    expect(saved['enabled']).toBe(true)
    expect(saved['maxTitleLength']).toBe(30)
    expect(saved['thinkingLevel']).toBe('low')
    expect(saved['futureField']).toEqual({ a: 1 })
    // get/set roundtrip
    expect(getRenameModel()).toBe('p1/m1')
  })

  it('setRenameModel：文件不存在时以默认基底建文件', () => {
    setRenameModel('p1/m1')

    expect(existsSync(configPath())).toBe(true)
    const saved = readRawConfig()
    expect(saved['model']).toEqual({ type: 'ref', ref: 'p1/m1' })
    // 默认基底字段（与 extension DEFAULT_RENAME_CONFIG 一致）
    expect(saved['enabled']).toBe(false)
    expect(saved['maxTitleLength']).toBe(50)
    expect(saved['thinkingLevel']).toBe('off')
  })

  it('setRenameModel：空串清除回未设置', () => {
    writeRawConfig({ model: { type: 'ref', ref: 'p1/m1' } })
    setRenameModel('')
    expect(getRenameModel()).toBe('')
    expect(readRawConfig()['model']).toEqual({ type: 'ref', ref: '' })
  })

  it('setRenameModel：非空但不含 "/" 归一为空串（extension parseModelRef 不认）', () => {
    setRenameModel('garbage-no-slash')
    expect(getRenameModel()).toBe('')
    expect(readRawConfig()['model']).toEqual({ type: 'ref', ref: '' })
  })

  it('setRenameModel：坏 JSON 用默认基底覆写（与 extension 读取侧回退语义一致）', () => {
    writeRawConfig('{ corrupted')
    setRenameModel('p1/m1')
    expect(getRenameModel()).toBe('p1/m1')
    expect(readRawConfig()['enabled']).toBe(false)
  })
})

describe('rename-session 模式配置（config/rename-session-ext-config.json 的 mode 字段，设计 D1）', () => {
  let tmpRoot: string
  const configPath = () => join(tmpRoot, 'agent', 'config', 'rename-session-ext-config.json')

  /** 写入原始配置 JSON（预建目录）。 */
  function writeRawConfig(raw: unknown): void {
    mkdirSync(dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2), 'utf-8')
  }

  /** 读回配置 JSON（parse 后对象）。 */
  function readRawConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
  }

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rename-mode-test-'))
    vi.stubEnv('XYZ_AGENT_DATA_DIR', tmpRoot)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('getRenameMode：文件不存在返回默认 first-stop（旧 config 零迁移，与 extension normalize 同语义）', () => {
    expect(getRenameMode()).toBe('first-stop')
  })

  it('getRenameMode：正常文件读出三值', () => {
    writeRawConfig({ mode: 'first-prompt' })
    expect(getRenameMode()).toBe('first-prompt')
    writeRawConfig({ mode: 'first-stop' })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig({ mode: 'agent-tool' })
    expect(getRenameMode()).toBe('agent-tool')
  })

  it('getRenameMode：字段缺失 / 非法值回默认 first-stop', () => {
    writeRawConfig({ enabled: true })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig({ mode: 'weird-mode' })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig({ mode: 123 })
    expect(getRenameMode()).toBe('first-stop')
  })

  it('getRenameMode：坏 JSON 回默认 first-stop（不抛错）', () => {
    writeRawConfig('{ not valid json')
    expect(getRenameMode()).toBe('first-stop')
  })

  it('setRenameMode：读改写保留其他字段（含 model）与未知字段 + set-get 往返', () => {
    writeRawConfig({ enabled: true, mode: 'first-stop', model: { type: 'ref', ref: 'p1/m1' }, maxTitleLength: 30, futureField: { a: 1 } })
    setRenameMode('agent-tool')

    const saved = readRawConfig()
    expect(saved['mode']).toBe('agent-tool')
    expect(saved['model']).toEqual({ type: 'ref', ref: 'p1/m1' })
    expect(saved['enabled']).toBe(true)
    expect(saved['maxTitleLength']).toBe(30)
    expect(saved['futureField']).toEqual({ a: 1 })
    // set-get roundtrip
    expect(getRenameMode()).toBe('agent-tool')
  })

  it('setRenameMode：文件不存在时以默认基底建文件（三处默认值真相收敛：基底含 mode: first-stop）', () => {
    setRenameMode('first-prompt')

    expect(existsSync(configPath())).toBe(true)
    const saved = readRawConfig()
    expect(saved['mode']).toBe('first-prompt')
    // 默认基底字段（与 extension DEFAULT_RENAME_CONFIG 一致，含 mode）
    expect(saved['enabled']).toBe(false)
    expect(saved['model']).toEqual({ type: 'ref', ref: '' })
    expect(saved['maxTitleLength']).toBe(50)
    expect(saved['thinkingLevel']).toBe('off')
  })

  it('setRenameMode：非法值归一为 first-stop（读侧同语义，写侧不放大坏值）', () => {
    setRenameMode('not-a-mode' as unknown as RenameMode)
    expect(getRenameMode()).toBe('first-stop')
    expect(readRawConfig()['mode']).toBe('first-stop')
  })

  it('setRenameMode：坏 JSON 用默认基底覆写（与 setRenameModel 同款回退）', () => {
    writeRawConfig('{ corrupted')
    setRenameMode('first-prompt')
    expect(getRenameMode()).toBe('first-prompt')
    expect(readRawConfig()['enabled']).toBe(false)
  })

  it('mode 写锁与 model 写锁同源：setRenameMode 后无 .lock 残留且 setRenameModel 仍可写（同一把锁协议）', () => {
    setRenameMode('agent-tool')
    setRenameModel('p1/m1')
    expect(existsSync(`${configPath()}.lock`)).toBe(false)
    expect(getRenameMode()).toBe('agent-tool')
    expect(getRenameModel()).toBe('p1/m1')
  })
})

describe('rename-session-ext-config 写锁（D1e 跨进程锁）', () => {
  // 参照 pi-settings-store.test.ts 的锁测试模式：同一把 lockfile（<config>.json.lock，
  // realpath:false）模拟 extension 侧写方，验证 runtime RMW 的互斥与降级语义。
  let tmpRoot: string
  const configPath = () => join(tmpRoot, 'agent', 'config', 'rename-session-ext-config.json')

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'rename-model-lock-test-'))
    vi.stubEnv('XYZ_AGENT_DATA_DIR', tmpRoot)
  })

  afterEach(() => {
    // 恢复锁参数默认值，避免压缩预算泄漏到后续用例
    setRenameConfigLockTimingForTest({})
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  it('写完释放锁：.lock 目录不残留（残留会困住后续写方）', () => {
    setRenameModel('p1/m1')
    expect(existsSync(`${configPath()}.lock`)).toBe(false)
    expect(getRenameModel()).toBe('p1/m1')
  })

  it('锁内重读最新：外部持锁写方（模拟 extension）写的字段不被本次 RMW 覆盖', () => {
    setRenameModel('p1/m1')
    // 模拟 pi-rename-session extension 持同一把锁写 enabled/maxTitleLength
    //（llm-shared saveConfig 约定的 lockfile 路径 = 目标文件 + '.lock'）
    const release = lockfile.lockSync(configPath(), { realpath: false })
    try {
      const raw = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
      raw['enabled'] = true
      raw['maxTitleLength'] = 30
      writeFileSync(configPath(), JSON.stringify(raw, null, 2), 'utf-8')
    } finally {
      release()
    }
    setRenameModel('p2/m2')
    const saved = JSON.parse(readFileSync(configPath(), 'utf-8')) as Record<string, unknown>
    // model 域被本次写更新，extension 写的域被锁内重读吃进（不覆盖）
    expect(saved['model']).toEqual({ type: 'ref', ref: 'p2/m2' })
    expect(saved['enabled']).toBe(true)
    expect(saved['maxTitleLength']).toBe(30)
  })

  it('fail-fast：锁被外部持有超出重试预算 → 抛 ELOCKED，文件保持原样', () => {
    setRenameModel('p1/m1')
    // 压缩预算：10ms/次 × 预算 60ms，快速走完 fail-fast 路径
    setRenameConfigLockTimingForTest({ retryDelayMs: 10, retryBudgetMs: 60 })
    const release = lockfile.lockSync(configPath(), { realpath: false })
    let err: unknown
    try {
      setRenameModel('blocked/m')
    } catch (e) {
      err = e
    } finally {
      release()
    }
    // fail-fast：预算耗尽抛错（对齐 pi 放弃保存语义），而非静默丢弃或死等
    expect((err as { code?: string } | undefined)?.code).toBe('ELOCKED')
    expect(getRenameModel()).toBe('p1/m1') // 本次写入被放弃
    // 锁释放后恢复正常
    setRenameModel('after/m')
    expect(getRenameModel()).toBe('after/m')
  })

  it('目录不存在时首写：锁工具先建父目录，写入成功', () => {
    expect(existsSync(dirname(configPath()))).toBe(false)
    setRenameModel('first/m')
    expect(existsSync(configPath())).toBe(true)
    expect(getRenameModel()).toBe('first/m')
  })
})
