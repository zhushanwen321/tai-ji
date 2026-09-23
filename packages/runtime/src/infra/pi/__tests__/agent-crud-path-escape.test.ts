/**
 * RT-3#11 agent 写入路径越界修复验证（code-harden 审计批次 1）：
 * `join(getAgentsDir(), name)` 的 name 取用户可编辑的 agent.name||id（链路
 * resources-message-handler → config-service → agent-crud），未做单段校验时
 * `../` 可越界写/删 agents 目录之外的任意 *.md。修复 = 写/删前单段断言
 * （basename 自等 + 非 .. + 无分隔符）+ 读/删侧静默失败收口（ENOENT 安静、
 * 非 ENOENT warn 含路径与原因）。
 *
 * 隔离：TAIJI_AGENT_DATA_DIR 指向 mkdtempSync 临时目录（getDataDir 每次调用
 * 动态读 env），全程不触碰真实 ~/.taiji。fs 故障注入用 vi.spyOn(node:fs)，
 * mock 实现内只 throw/返回字面量（不回调真实实现，避免 spy 递归）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/agent-crud-path-escape.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  writeAgentFile,
  deleteAgentFile,
  listAgentFiles,
} from '../agent-crud.js'
import { getAgentsDir } from '../pi-paths.js'
import { logger } from '../../logger.js'

let dataDir: string
let savedEnv: string | undefined

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'agent-crud-escape-'))
  mkdirSync(join(dataDir, 'agent', 'agents'), { recursive: true })
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = dataDir
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  vi.restoreAllMocks()
})

function agentsDir(): string {
  return getAgentsDir()
}

function errnoError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('RT-3#11: writeAgentFile 单段校验（越界名抛错且不产生越界文件）', () => {
  it.each([
    ['../evil', '相对上跳'],
    ['../../deeper-evil', '多级上跳'],
    ['sub/evil', '子目录形态'],
    ['..', '纯上跳段'],
    ['evil\\name', '反斜杠分隔'],
    ['../evil.md', '带 .md 后缀的上跳'],
  ])('name = %s（%s）：抛错 + 越界位置无文件产生', (name) => {
    expect(() => writeAgentFile(name, 'content')).toThrow(/非法的 agent 名称/)
    expect(() => writeAgentFile(name, 'content')).toThrow(/单段文件名/)
    // 越界写未发生：agents 目录本身、其父层（agent/）、数据根均无 evil*.md
    expect(existsSync(join(dataDir, 'agent', 'evil.md'))).toBe(false)
    expect(existsSync(join(dataDir, 'evil.md'))).toBe(false)
    expect(readdirSync(agentsDir())).toHaveLength(0)
  })

  it('合法名正常写入 agents 目录（守卫不误伤正常路径）', () => {
    writeAgentFile('my-agent', '---\ndescription: x\n---\nbody')
    expect(existsSync(join(agentsDir(), 'my-agent.md'))).toBe(true)
    // 带后缀名也照常（fileName 不重复拼接）
    writeAgentFile('typed.md', 'body')
    expect(existsSync(join(agentsDir(), 'typed.md'))).toBe(true)
  })
})

describe('RT-3#11: deleteAgentFile 单段校验（删除向量对称守卫）', () => {
  it.each([
    ['../evil', '相对上跳'],
    ['sub/evil', '子目录形态'],
  ])('name = %s（%s）：抛错（不静默返回 false 掩盖越界删除）', (name) => {
    expect(() => deleteAgentFile(name)).toThrow(/非法的 agent 名称/)
  })

  it('不存在的合法名：安静返回 false（保留原语义）', () => {
    expect(deleteAgentFile('nonexistent')).toBe(false)
  })

  it('存在的合法名：删除成功返回 true', () => {
    writeAgentFile('gone', 'body')
    expect(deleteAgentFile('gone')).toBe(true)
    expect(existsSync(join(agentsDir(), 'gone.md'))).toBe(false)
  })

  it('unlink 非 ENOENT 失败：warn 留痕（含路径与原因）+ 返回 false，与「不存在」可区分', async () => {
    writeAgentFile('victim', 'body')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const victimPath = join(agentsDir(), 'victim.md')
    const fs = await import('node:fs')
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw errnoError('EACCES: permission denied, unlink', 'EACCES')
    })

    expect(deleteAgentFile('victim')).toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('[agent-crud] failed to delete agent file')
    expect(warnSpy.mock.calls[0]![1]).toMatchObject({ file: victimPath })
    expect(existsSync(victimPath)).toBe(true)
  })

  it('unlink ENOENT 竞态：保持安静返回 false（不 warn）', async () => {
    writeAgentFile('raced', 'body')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fs = await import('node:fs')
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw errnoError('ENOENT: no such file or directory', 'ENOENT')
    })

    expect(deleteAgentFile('raced')).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('RT-3#11: listAgentFiles 读侧静默失败收口', () => {
  it('readdir 非 ENOENT 失败：warn 含目录路径与原因，返回空列表不抛', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fs = await import('node:fs')
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw errnoError('EACCES: permission denied, scandir', 'EACCES')
    })

    const result = listAgentFiles()
    expect(result).toEqual([])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('failed to read agent directory')
    expect(warnSpy.mock.calls[0]![1]).toMatchObject({ dir: agentsDir() })
  })

  it('readdir ENOENT（existsSync 后目录被移走竞态）：保持安静', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fs = await import('node:fs')
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw errnoError('ENOENT: no such file or directory', 'ENOENT')
    })

    expect(listAgentFiles()).toEqual([])
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('单文件读失败：跳过该文件、其余正常返回，非 ENOENT 时 warn 含文件路径', async () => {
    writeFileSync(join(agentsDir(), 'good.md'), 'good content', 'utf-8')
    writeFileSync(join(agentsDir(), 'bad.md'), 'bad content', 'utf-8')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const fs = await import('node:fs')
    // 选择性故障：bad.md 抛错，其余路径返回占位内容（mock 内不回调真实实现，防递归）
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('bad.md')) {
        throw errnoError('EISDIR: illegal operation on a directory', 'EISDIR')
      }
      return 'stub-content'
    }) as typeof fs.readFileSync)

    const entries = listAgentFiles()
    expect(entries.map(e => e.name)).toEqual(['good'])
    expect(entries[0]!.content).toBe('stub-content')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toContain('failed to read agent file')
    expect(warnSpy.mock.calls[0]![1]).toMatchObject({ file: join(agentsDir(), 'bad.md') })
  })
})
