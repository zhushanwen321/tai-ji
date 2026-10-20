import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import lockfile from 'proper-lockfile'
import { getAutoRenameEnabled, setAutoRenameEnabled, getAutoRenameEnabledPath, ensureAutoRenameDefault, getRenameModel, setRenameModel, getRenameConfigPath, setRenameConfigLockTimingForTest, getRenameMode, setRenameMode, getRenamePrompt, setRenamePrompt, getRenameMaxLength, setRenameMaxLength } from './rename-session-config.js'
import { logger } from '../infra/logger.js'
import { RENAME_INSTRUCTION_MAX_LENGTH } from '@taiji/shared'
import type { RenameMode } from '@taiji/shared'

// ── 共用装置（各 describe 的 tmp 数据目录 + ext 配置文件读写）──────────
// 收敛自各 describe 内的重复副本（fallow 重复块告警：装置曾按 describe 复制六份）。
// beforeEach/afterEach 须在 describe 体内调用才注册到对应 scope，故以工厂函数形态提供。

/**
 * 临时数据目录装置：beforeEach 建目录并 stub TAIJI_AGENT_DATA_DIR，afterEach 还原 env
 * 并删目录。返回 tmpRoot 取值函数（测试体内调用取当前用例的目录）。
 * extraTeardown 在 afterEach 最先执行（域专属还原，如锁参数复位）。
 */
function useTmpDataDir(prefix: string, extraTeardown?: () => void): () => string {
  let tmpRoot = ''
  beforeEach(() => {
    // 每个测试独立临时目录，避免互相干扰
    tmpRoot = mkdtempSync(join(tmpdir(), prefix))
    // getPiAgentDir 经 getDataDir 读 TAIJI_AGENT_DATA_DIR → 临时目录/agent
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', tmpRoot)
  })
  afterEach(() => {
    extraTeardown?.()
    vi.unstubAllEnvs()
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return () => tmpRoot
}

/** rename-session ext 配置文件路径（<TAIJI_AGENT_DATA_DIR>/agent/config/...，各域 describe 共用）。 */
const renameConfigPath = (tmpRoot: string) =>
  join(tmpRoot, 'agent', 'config', 'rename-session-ext-config.json')

/** 写入原始配置 JSON（预建目录）。 */
function writeRawConfig(tmpRoot: string, raw: unknown): void {
  const p = renameConfigPath(tmpRoot)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2), 'utf-8')
}

/** 读回配置 JSON（parse 后对象）。 */
function readRawConfig(tmpRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(renameConfigPath(tmpRoot), 'utf-8')) as Record<string, unknown>
}

describe('auto-rename enabled 标志文件', () => {
  const tmpRoot = useTmpDataDir('auto-rename-test-')

  it('getAutoRenameEnabledPath 解析到 <TAIJI_AGENT_DATA_DIR>/agent/auto-rename-enabled', () => {
    expect(getAutoRenameEnabledPath()).toBe(join(tmpRoot(), 'agent', 'auto-rename-enabled'))
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
  const tmpRoot = useTmpDataDir('auto-rename-init-')
  const initializedPath = () => join(tmpRoot(), 'agent', 'auto-rename-initialized')

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
    mkdirSync(dirname(initializedPath()), { recursive: true })
    writeFileSync(initializedPath(), '', 'utf-8')

    ensureAutoRenameDefault()

    // 用户关闭的状态被保留，没有被 boot 反复重开
    expect(getAutoRenameEnabled()).toBe(false)
    // initialized 标记仍在
    expect(existsSync(initializedPath())).toBe(true)
  })

  it('初始化失败不抛错（不阻塞 boot）', () => {
    // 让 getPiAgentDir 抛错：把 TAIJI_AGENT_DATA_DIR 指向一个不存在的根，使 mkdirSync 失败
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
  const tmpRoot = useTmpDataDir('rename-model-test-')
  const configPath = () => renameConfigPath(tmpRoot())

  it('getRenameConfigPath 解析到 <TAIJI_AGENT_DATA_DIR>/agent/config/rename-session-ext-config.json', () => {
    expect(getRenameConfigPath()).toBe(join(tmpRoot(), 'agent', 'config', 'rename-session-ext-config.json'))
  })

  it('getRenameModel：文件不存在返回空串（未设置）', () => {
    expect(getRenameModel()).toBe('')
  })

  it('getRenameModel：正常文件读出 model.ref', () => {
    writeRawConfig(tmpRoot(), { enabled: true, model: { type: 'ref', ref: 'p1/m1' }, maxTitleLength: 50, thinkingLevel: 'off' })
    expect(getRenameModel()).toBe('p1/m1')
  })

  it('getRenameModel：model 字段缺失 / 非法形态返回空串', () => {
    writeRawConfig(tmpRoot(), { enabled: true })
    expect(getRenameModel()).toBe('')
    writeRawConfig(tmpRoot(), { model: 'p1/m1' })
    expect(getRenameModel()).toBe('')
    writeRawConfig(tmpRoot(), { model: { type: 'scoped' } })
    expect(getRenameModel()).toBe('')
    writeRawConfig(tmpRoot(), { model: { type: 'ref', ref: 123 } })
    expect(getRenameModel()).toBe('')
  })

  it('getRenameModel：坏 JSON 返回空串（不抛错）', () => {
    writeRawConfig(tmpRoot(), '{ not valid json')
    expect(getRenameModel()).toBe('')
  })

  it('setRenameModel：读改写保留其他字段与未知字段', () => {
    writeRawConfig(tmpRoot(), { enabled: true, model: { type: 'ref', ref: 'old/m' }, maxTitleLength: 30, thinkingLevel: 'low', futureField: { a: 1 } })
    setRenameModel('p1/m1')

    // 整对象断言：被写域更新 + 其余字段（含未知字段）原样保留 + 无多余字段
    expect(readRawConfig(tmpRoot())).toEqual({
      model: { type: 'ref', ref: 'p1/m1' },
      enabled: true,
      maxTitleLength: 30,
      thinkingLevel: 'low',
      futureField: { a: 1 },
    })
    // get/set roundtrip
    expect(getRenameModel()).toBe('p1/m1')
  })

  it('setRenameModel：文件不存在时以默认基底建文件（基底七字段与 extension DEFAULT_RENAME_CONFIG 同批收敛）', () => {
    setRenameModel('p1/m1')

    expect(existsSync(configPath())).toBe(true)
    // 默认基底字段（与 extension DEFAULT_RENAME_CONFIG 一致，全字段锁定）
    expect(readRawConfig(tmpRoot())).toEqual({
      model: { type: 'ref', ref: 'p1/m1' },
      enabled: false,
      mode: 'first-stop',
      maxTitleLength: 50,
      thinkingLevel: 'off',
      style: 'slug',
      customInstruction: '',
    })
  })

  it('setRenameModel：空串清除回未设置', () => {
    writeRawConfig(tmpRoot(), { model: { type: 'ref', ref: 'p1/m1' } })
    setRenameModel('')
    expect(getRenameModel()).toBe('')
    expect(readRawConfig(tmpRoot())['model']).toEqual({ type: 'ref', ref: '' })
  })

  it('setRenameModel：非空但不含 "/" 归一为空串（extension parseModelRef 不认）', () => {
    setRenameModel('garbage-no-slash')
    expect(getRenameModel()).toBe('')
    expect(readRawConfig(tmpRoot())['model']).toEqual({ type: 'ref', ref: '' })
  })

  it('setRenameModel：坏 JSON 用默认基底覆写（与 extension 读取侧回退语义一致）', () => {
    writeRawConfig(tmpRoot(), '{ corrupted')
    setRenameModel('p1/m1')
    expect(getRenameModel()).toBe('p1/m1')
    expect(readRawConfig(tmpRoot())['enabled']).toBe(false)
  })
})

describe('rename-session 模式配置（config/rename-session-ext-config.json 的 mode 字段，设计 D1）', () => {
  const tmpRoot = useTmpDataDir('rename-mode-test-')

  it('getRenameMode：文件不存在返回默认 first-stop（旧 config 零迁移，与 extension normalize 同语义）', () => {
    expect(getRenameMode()).toBe('first-stop')
  })

  it('getRenameMode：正常文件读出三值', () => {
    writeRawConfig(tmpRoot(), { mode: 'first-prompt' })
    expect(getRenameMode()).toBe('first-prompt')
    writeRawConfig(tmpRoot(), { mode: 'first-stop' })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig(tmpRoot(), { mode: 'agent-tool' })
    expect(getRenameMode()).toBe('agent-tool')
  })

  it('getRenameMode：字段缺失 / 非法值回默认 first-stop', () => {
    writeRawConfig(tmpRoot(), { enabled: true })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig(tmpRoot(), { mode: 'weird-mode' })
    expect(getRenameMode()).toBe('first-stop')
    writeRawConfig(tmpRoot(), { mode: 123 })
    expect(getRenameMode()).toBe('first-stop')
  })

  it('getRenameMode：坏 JSON 回默认 first-stop（不抛错）', () => {
    writeRawConfig(tmpRoot(), '{ not valid json')
    expect(getRenameMode()).toBe('first-stop')
  })

  it('setRenameMode：读改写保留其他字段（含 model）与未知字段 + set-get 往返', () => {
    writeRawConfig(tmpRoot(), { enabled: true, mode: 'first-stop', model: { type: 'ref', ref: 'p1/m1' }, maxTitleLength: 30, futureField: { a: 1 } })
    setRenameMode('agent-tool')

    expect(readRawConfig(tmpRoot())).toEqual({
      mode: 'agent-tool',
      model: { type: 'ref', ref: 'p1/m1' },
      enabled: true,
      maxTitleLength: 30,
      futureField: { a: 1 },
    })
    // set-get roundtrip
    expect(getRenameMode()).toBe('agent-tool')
  })

  it('setRenameMode：文件不存在时以默认基底建文件（三处默认值真相收敛：基底含 mode: first-stop）', () => {
    setRenameMode('first-prompt')

    expect(existsSync(renameConfigPath(tmpRoot()))).toBe(true)
    // 默认基底七字段（与 setRenameModel 用例同款基底，mode 为本域写入值）
    expect(readRawConfig(tmpRoot())).toEqual({
      mode: 'first-prompt',
      enabled: false,
      model: { type: 'ref', ref: '' },
      maxTitleLength: 50,
      thinkingLevel: 'off',
      style: 'slug',
      customInstruction: '',
    })
  })

  it('setRenameMode：非法值归一为 first-stop（读侧同语义，写侧不放大坏值）', () => {
    setRenameMode('not-a-mode' as unknown as RenameMode)
    expect(getRenameMode()).toBe('first-stop')
    expect(readRawConfig(tmpRoot())['mode']).toBe('first-stop')
  })

  it('setRenameMode：坏 JSON 用默认基底覆写（与 setRenameModel 同款回退）', () => {
    writeRawConfig(tmpRoot(), '{ corrupted')
    setRenameMode('first-prompt')
    expect(getRenameMode()).toBe('first-prompt')
    expect(readRawConfig(tmpRoot())['enabled']).toBe(false)
  })

  it('mode 写锁与 model 写锁同源：setRenameMode 后无 .lock 残留且 setRenameModel 仍可写（同一把锁协议）', () => {
    setRenameMode('agent-tool')
    setRenameModel('p1/m1')
    expect(existsSync(`${renameConfigPath(tmpRoot())}.lock`)).toBe(false)
    expect(getRenameMode()).toBe('agent-tool')
    expect(getRenameModel()).toBe('p1/m1')
  })
})

describe('rename-session-ext-config 写锁（D1e 跨进程锁）', () => {
  // 参照 pi-settings-store.test.ts 的锁测试模式：同一把 lockfile（<config>.json.lock，
  // realpath:false）模拟 extension 侧写方，验证 runtime RMW 的互斥与降级语义。
  // extraTeardown：恢复锁参数默认值，避免压缩预算泄漏到后续用例
  const tmpRoot = useTmpDataDir('rename-model-lock-test-', () => setRenameConfigLockTimingForTest({}))
  const configPath = () => renameConfigPath(tmpRoot())

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

describe('rename-session 标题提示词（style + customInstruction 合并读写，rename-prompt-config）', () => {
  const tmpRoot = useTmpDataDir('rename-prompt-test-')

  it('getRenamePrompt：文件不存在 = 从未配置（corrupted:false，默认 slug + 空指令）', () => {
    expect(getRenamePrompt()).toEqual({ style: 'slug', instruction: '', corrupted: false })
  })

  it('getRenamePrompt：正常文件读出 style + customInstruction', () => {
    writeRawConfig(tmpRoot(), { style: 'sentence', customInstruction: '' })
    expect(getRenamePrompt()).toEqual({ style: 'sentence', instruction: '', corrupted: false })
    writeRawConfig(tmpRoot(), { style: 'custom', customInstruction: '生成不超过 12 字的中文标题' })
    expect(getRenamePrompt()).toEqual({ style: 'custom', instruction: '生成不超过 12 字的中文标题', corrupted: false })
  })

  it('getRenamePrompt：坏 JSON / 非 object → corrupted:true 防御回默认（不抛错）', () => {
    writeRawConfig(tmpRoot(), '{ not valid json')
    expect(getRenamePrompt()).toEqual({ style: 'slug', instruction: '', corrupted: true })
    writeRawConfig(tmpRoot(), [1, 2])
    expect(getRenamePrompt().corrupted).toBe(true)
  })

  it('getRenamePrompt：字段级回退（style 非法 → slug；instruction 非法 → 空串；corrupted 不误报）', () => {
    writeRawConfig(tmpRoot(), { style: 'weird', customInstruction: 42 })
    const snap = getRenamePrompt()
    expect(snap.style).toBe('slug')
    expect(snap.instruction).toBe('')
    expect(snap.corrupted).toBe(false)
  })

  it('setRenamePrompt：合并写两字段，保留其他字段（含 model/maxTitleLength/未知字段）', () => {
    writeRawConfig(tmpRoot(), { enabled: true, mode: 'first-prompt', model: { type: 'ref', ref: 'p1/m1' }, maxTitleLength: 30, futureField: { a: 1 } })
    const applied = setRenamePrompt('custom', '自定义指令')

    expect(applied).toEqual({ style: 'custom', instruction: '自定义指令', corrupted: false })
    expect(readRawConfig(tmpRoot())).toEqual({
      style: 'custom',
      customInstruction: '自定义指令',
      mode: 'first-prompt',
      model: { type: 'ref', ref: 'p1/m1' },
      enabled: true,
      maxTitleLength: 30,
      futureField: { a: 1 },
    })
  })

  it('setRenamePrompt：文件不存在时以默认基底建文件', () => {
    setRenamePrompt('emoji', '')

    expect(existsSync(renameConfigPath(tmpRoot()))).toBe(true)
    const saved = readRawConfig(tmpRoot())
    expect(saved['style']).toBe('emoji')
    expect(saved['customInstruction']).toBe('')
    expect(saved['enabled']).toBe(false)
  })

  it('setRenamePrompt：非法 style 归一 slug；非 string instruction 归一空串（reply = 生效值）', () => {
    const applied = setRenamePrompt('fancy' as unknown as ReturnType<typeof getRenamePrompt>['style'], undefined as unknown as string)
    expect(applied).toEqual({ style: 'slug', instruction: '', corrupted: false })
    expect(readRawConfig(tmpRoot())['style']).toBe('slug')
  })

  it('setRenamePrompt：超长 instruction 防御截断（与 extension normalize 同限 2000 码点）', () => {
    const long = 'a'.repeat(2500)
    const applied = setRenamePrompt('custom', long)
    expect(Array.from(applied.instruction)).toHaveLength(2000)
    expect(Array.from(readRawConfig(tmpRoot())['customInstruction'] as string)).toHaveLength(2000)
  })
})

describe('rename-session 标题最大长度（maxTitleLength 字段）', () => {
  const tmpRoot = useTmpDataDir('rename-maxlen-test-')

  it('getRenameMaxLength：文件不存在 / 字段非法 / 坏 JSON → 默认 50（与 extension normalize 同语义）', () => {
    expect(getRenameMaxLength()).toBe(50)
    writeRawConfig(tmpRoot(), { maxTitleLength: 30.5 })
    expect(getRenameMaxLength()).toBe(50)
    writeRawConfig(tmpRoot(), { maxTitleLength: 0 })
    expect(getRenameMaxLength()).toBe(50)
    writeRawConfig(tmpRoot(), '{ bad')
    expect(getRenameMaxLength()).toBe(50)
  })

  it('getRenameMaxLength：正常文件读出值', () => {
    writeRawConfig(tmpRoot(), { maxTitleLength: 80 })
    expect(getRenameMaxLength()).toBe(80)
  })

  it('getRenameMaxLength：文件不存在（ENOENT）→ 静默回默认 50，不留痕（从未配置属正常回退）', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      expect(getRenameMaxLength()).toBe(50)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('getRenameMaxLength：非 ENOENT 读失败（EISDIR 等真 IO 故障）→ warn 留痕且返回默认 50', () => {
    // 把配置路径置换成同名目录：readFileSync(目录) 抛 EISDIR（非 ENOENT），命中读失败留痕分支
    mkdirSync(renameConfigPath(tmpRoot()), { recursive: true })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      expect(getRenameMaxLength()).toBe(50)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('getRenameMaxLength')
      expect(warnSpy.mock.calls[0]?.[0]).toContain('50')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('setRenameMaxLength：读改写只覆盖 maxTitleLength，保留其他字段 + 合法值往返', () => {
    writeRawConfig(tmpRoot(), { enabled: true, mode: 'first-stop', model: { type: 'ref', ref: 'p1/m1' } })
    setRenameMaxLength(24)

    expect(readRawConfig(tmpRoot())).toEqual({
      maxTitleLength: 24,
      enabled: true,
      mode: 'first-stop',
      model: { type: 'ref', ref: 'p1/m1' },
    })
    expect(getRenameMaxLength()).toBe(24)
  })

  it('setRenameMaxLength：非法值（小数/0/负数/非数字）归一默认 50', () => {
    for (const bad of [30.5, 0, -5, NaN]) {
      setRenameMaxLength(bad as number)
      expect(readRawConfig(tmpRoot())['maxTitleLength']).toBe(50)
    }
  })
})

describe('rename 跨包镜像同值锁定（跨包不 import 的手写镜像，改任一侧须双侧同步，对侧测试同值锁定）', () => {
  it('RENAME_INSTRUCTION_MAX_LENGTH 协议字面值 = 2000（extension pure.ts 手写镜像侧由 pure.test.ts 锁定）', () => {
    expect(RENAME_INSTRUCTION_MAX_LENGTH).toBe(2000)
  })

  it('style 词表五值往返 = 协议 RenameStyle 值域（slug/sentence/emoji/topic/custom，与 extension pure.ts RENAME_STYLES 同构）', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'rename-mirror-test-'))
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', tmpRoot)
    try {
      for (const style of ['slug', 'sentence', 'emoji', 'topic', 'custom'] as const) {
        setRenamePrompt(style, '')
        expect(getRenamePrompt().style).toBe(style)
      }
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  })
})
