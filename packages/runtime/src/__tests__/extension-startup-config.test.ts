/**
 * extension startupConfig 声明机制测试（启动配置统一 ensure）。
 *
 * 锁定语义：
 * - 已存在 → 一律跳过，绝不覆盖（用户配置神圣，含用户改坏的内容）
 * - 缺失 → 首建：声明 content 原样序列化（2 空格缩进 + 尾换行）+ mode 0o600 + 递归建父目录
 * - 逐条目独立容错：坏 package.json / 声明非数组 / 条目形状非法（绝对路径 / `..` / content
 *   非 object）→ 跳过该条不影响其余
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/extension-startup-config.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readDeclaredStartupConfigs,
  ensureDeclaredStartupConfigs,
} from '../services/extension-startup-config.js'

let root: string
let agentDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ext-startup-config-'))
  agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** 造一个 fixture extension 目录（package.json 含给定 taiji 字段），返回目录路径。 */
function makeExtDir(name: string, taijiPlugin: Record<string, unknown> | null): string {
  const dir = join(root, 'ext', name)
  mkdirSync(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name: `fixture-${name}`, version: '0.0.0' }
  if (taijiPlugin !== null) pkg['taiji'] = taijiPlugin
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  return dir
}

describe('readDeclaredStartupConfigs', () => {
  it('收集合法声明并保留 content 深结构', () => {
    const dir = makeExtDir('ok', {
      startupConfig: [{ path: 'config/a-ext-config.json', content: { x: { y: [1, 2] } } }],
    })
    const entries = readDeclaredStartupConfigs([dir])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('config/a-ext-config.json')
    expect(entries[0]!.content).toEqual({ x: { y: [1, 2] } })
    expect(entries[0]!.source).toBe('ok')
  })

  it('目录无 package.json → 静默跳过（discovery 噪音非错误）', () => {
    const dir = join(root, 'ext', 'no-pkg')
    mkdirSync(dir, { recursive: true })
    expect(readDeclaredStartupConfigs([dir])).toEqual([])
  })

  it('坏 JSON package.json / startupConfig 非数组 / 无 taiji 字段 → 跳过', () => {
    const badJson = join(root, 'ext', 'bad-json')
    mkdirSync(badJson, { recursive: true })
    writeFileSync(join(badJson, 'package.json'), '{not json')
    const notArray = makeExtDir('not-array', { startupConfig: 'nope' })
    const noField = makeExtDir('no-field', { role: 'universal' })

    expect(readDeclaredStartupConfigs([badJson, notArray, noField])).toEqual([])
  })

  it('非法条目形状逐条拒绝：绝对路径 / `..` 段 / content 非 object', () => {
    const dir = makeExtDir('mixed', {
      startupConfig: [
        { path: '/etc/passwd', content: { a: 1 } },
        { path: 'config/../../escape.json', content: { a: 1 } },
        { path: 'config/b.json', content: [1, 2] },
        { path: 'config/b.json', content: 'str' },
        { path: '', content: { a: 1 } },
        { path: 'config/ok.json', content: { a: 1 } },
      ],
    })
    const entries = readDeclaredStartupConfigs([dir])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.path).toBe('config/ok.json')
  })
})

describe('ensureDeclaredStartupConfigs', () => {
  it('缺失 → 首建：内容 2 空格缩进 + 尾换行 + 0600 + 递归建父目录', () => {
    const dir = makeExtDir('creator', {
      startupConfig: [{ path: 'config/deep/nested/x-ext-config.json', content: { enabled: true, list: [] } }],
    })
    const report = ensureDeclaredStartupConfigs([dir], agentDir)
    expect(report).toEqual({ ensured: 1, skipped: 0, failed: 0 })

    const target = join(agentDir, 'config/deep/nested/x-ext-config.json')
    expect(readFileSync(target, 'utf-8')).toBe(`${JSON.stringify({ enabled: true, list: [] }, null, 2)}\n`)
    const mode = statSync(target).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('已存在 → 一律跳过，绝不覆盖（含用户改过的内容）', () => {
    const dir = makeExtDir('keeper', {
      startupConfig: [{ path: 'config/x-ext-config.json', content: { enabled: true } }],
    })
    const target = join(agentDir, 'config/x-ext-config.json')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    writeFileSync(target, '{"user":"edited"}\n', 'utf-8')

    const report = ensureDeclaredStartupConfigs([dir], agentDir)
    expect(report).toEqual({ ensured: 0, skipped: 1, failed: 0 })
    expect(readFileSync(target, 'utf-8')).toBe('{"user":"edited"}\n')
  })

  it('read 阶段被拒的条目不进 ensure（不影响其余条目）', () => {
    const dir = makeExtDir('mixed', {
      startupConfig: [
        { path: '/abs/path.json', content: { a: 1 } }, // read 阶段形状校验被拒
        { path: 'config/ok.json', content: { a: 1 } },
      ],
    })
    const report = ensureDeclaredStartupConfigs([dir], agentDir)
    expect(report).toEqual({ ensured: 1, skipped: 0, failed: 0 })
    expect(existsSync(join(agentDir, 'config/ok.json'))).toBe(true)
  })

  it('ensure 阶段 IO 失败计入 failed：父路径被同名普通文件占住（mkdir EEXIST）不炸不误计 skipped', () => {
    const dir = makeExtDir('blocked', {
      startupConfig: [{ path: 'config/x.json', content: { a: 1 } }],
    })
    const dirOk = makeExtDir('after', {
      startupConfig: [{ path: 'other/ok.json', content: { a: 1 } }],
    })
    // agentDir/config 是普通文件（非目录）→ mkdirSync(dirname) 抛错 → failed；
    // 同批其余条目（other/ok.json）不受影响
    writeFileSync(join(agentDir, 'config'), 'not a dir', 'utf-8')
    const report = ensureDeclaredStartupConfigs([dir, dirOk], agentDir)
    expect(report).toEqual({ ensured: 1, skipped: 0, failed: 1 })
    expect(existsSync(join(agentDir, 'other/ok.json'))).toBe(true)
  })

  it('病态竞态：broken symlink 占位 → O_EXCL 拒写穿，EEXIST 落 failed 且指向处无泄漏', { skip: process.platform === 'win32' }, () => {
    const dir = makeExtDir('symlinked', {
      startupConfig: [{ path: 'config/linked.json', content: { a: 1 } }],
    })
    const target = join(agentDir, 'config/linked.json')
    mkdirSync(join(agentDir, 'config'), { recursive: true })
    // broken symlink：existsSync 沿链接解析为 false，但 O_EXCL 对符号链接恒 EEXIST（POSIX）
    symlinkSync(join(agentDir, 'nowhere.json'), target)
    const report = ensureDeclaredStartupConfigs([dir], agentDir)
    expect(report).toEqual({ ensured: 0, skipped: 0, failed: 1 })
    // 未写穿链接：指向处不产生文件，占位仍是符号链接本身
    expect(existsSync(join(agentDir, 'nowhere.json'))).toBe(false)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
  })

  it('跨包重复 path 声明：仅首个生效（先到者 ensured），后续不覆盖', () => {
    const dirA = makeExtDir('first', {
      startupConfig: [{ path: 'config/dup.json', content: { who: 'first' } }],
    })
    const dirB = makeExtDir('second', {
      startupConfig: [{ path: 'config/dup.json', content: { who: 'second' } }],
    })
    const report = ensureDeclaredStartupConfigs([dirA, dirB], agentDir)
    expect(report).toEqual({ ensured: 1, skipped: 0, failed: 0 })
    expect(JSON.parse(readFileSync(join(agentDir, 'config/dup.json'), 'utf-8'))).toEqual({ who: 'first' })
  })

  it('多 extension 多条目全部处理，幂等二次跑全 skipped', () => {
    const dirA = makeExtDir('a', {
      startupConfig: [{ path: 'config/a.json', content: { from: 'a' } }],
    })
    const dirB = makeExtDir('b', {
      startupConfig: [
        { path: 'config/b.json', content: { from: 'b' } },
        { path: 'subagents/config.json', content: { version: 1 } },
      ],
    })
    const first = ensureDeclaredStartupConfigs([dirA, dirB], agentDir)
    expect(first).toEqual({ ensured: 3, skipped: 0, failed: 0 })
    const second = ensureDeclaredStartupConfigs([dirA, dirB], agentDir)
    expect(second).toEqual({ ensured: 0, skipped: 3, failed: 0 })
  })
})
