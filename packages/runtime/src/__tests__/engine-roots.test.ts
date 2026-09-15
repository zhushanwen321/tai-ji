/**
 * W9 runtime 侧引擎根推导/注入（services/session/engine-roots.ts）单测：
 * - dev/打包双形态 staged 目录推导（isPackaged 判定 + 目录存在性门控）；
 * - 注入面矩阵：staged 存在才注入 ROOTS；打包态才注入执行器两键（dev 不注入）；
 * - ensureRuntimeEngineRootsEnv 幂等 + 显式值不覆盖。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ENGINE_NODE_ENV,
  ENGINE_ROOTS_ENV,
  ensureRuntimeEngineRootsEnv,
  getEngineRootsSpawnEnv,
  getStagedEnginesDir,
} from '../services/session/engine-roots.js'

let tmpRoot: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'engine-roots-test-'))
  savedEnv = {
    TAIJI_AGENT_PACKAGED: process.env.TAIJI_AGENT_PACKAGED,
    [ENGINE_ROOTS_ENV]: process.env[ENGINE_ROOTS_ENV],
  }
  delete process.env.TAIJI_AGENT_PACKAGED
  delete process.env[ENGINE_ROOTS_ENV]
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getStagedEnginesDir（dev/打包双形态）', () => {
  it('dev：projectRoot/resources/engines 存在 → 返回绝对路径', () => {
    const staged = join(tmpRoot, 'resources', 'engines')
    mkdirSync(staged, { recursive: true })
    expect(getStagedEnginesDir(tmpRoot)).toBe(staged)
  })

  it('dev：目录不存在 → undefined（不注入，发现回落 L2/L3）', () => {
    expect(getStagedEnginesDir(tmpRoot)).toBeUndefined()
  })

  it('打包：<cwd>/engines 推导与 projectRoot 无关（不真实创建 cwd 目录——fs-guard 纪律）', () => {
    process.env.TAIJI_AGENT_PACKAGED = '1'
    // cwd = packages/runtime（vitest 运行处），不含 engines → undefined；
    // 关键断言：打包态不再回退 dev 形态路径（projectRoot/resources/engines 恒不返回）
    expect(getStagedEnginesDir(tmpRoot)).not.toBe(join(tmpRoot, 'resources', 'engines'))
  })
})

describe('getEngineRootsSpawnEnv（注入面矩阵）', () => {
  it('dev：staged 存在 → 只注入 ROOTS，不注入执行器两键', () => {
    const staged = join(tmpRoot, 'resources', 'engines')
    mkdirSync(staged, { recursive: true })
    expect(getEngineRootsSpawnEnv(tmpRoot)).toEqual({ [ENGINE_ROOTS_ENV]: staged })
  })

  it('dev：staged 不存在 → 空对象', () => {
    expect(getEngineRootsSpawnEnv(tmpRoot)).toEqual({})
  })

  it('打包：执行器两键恒注入（TAIJI_AGENT_ENGINE_NODE=process.execPath + RUN_AS_NODE），ROOTS 仅在 staged 存在时', () => {
    process.env.TAIJI_AGENT_PACKAGED = '1'
    // staged（<cwd>/engines）不存在：ROOTS 缺席、执行器两键仍在
    const env = getEngineRootsSpawnEnv(tmpRoot)
    expect(env[ENGINE_ROOTS_ENV]).toBeUndefined()
    expect(env[ENGINE_NODE_ENV]).toBe(process.execPath)
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('ensureRuntimeEngineRootsEnv（幂等补齐）', () => {
  it('staged 存在 + env 未设 → 写入并返回 true；二次调用幂等 false', () => {
    const staged = join(tmpRoot, 'resources', 'engines')
    mkdirSync(staged, { recursive: true })
    writeFileSync(join(staged, '.keep'), '')
    expect(ensureRuntimeEngineRootsEnv(tmpRoot)).toBe(true)
    expect(process.env[ENGINE_ROOTS_ENV]).toBe(staged)
    expect(ensureRuntimeEngineRootsEnv(tmpRoot)).toBe(false)
  })

  it('已有显式值 → 不覆盖（返回 false）', () => {
    const staged = join(tmpRoot, 'resources', 'engines')
    mkdirSync(staged, { recursive: true })
    process.env[ENGINE_ROOTS_ENV] = '/explicit/user/value'
    expect(ensureRuntimeEngineRootsEnv(tmpRoot)).toBe(false)
    expect(process.env[ENGINE_ROOTS_ENV]).toBe('/explicit/user/value')
  })

  it('staged 不存在 → 不写 env', () => {
    expect(ensureRuntimeEngineRootsEnv(tmpRoot)).toBe(false)
    expect(process.env[ENGINE_ROOTS_ENV]).toBeUndefined()
  })
})
