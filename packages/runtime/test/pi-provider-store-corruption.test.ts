/**
 * models.json 损坏防覆写单测（code-harden M4 / RT-3#4）。
 *
 * 修复语义链（pi-provider-store.ts）：createModelsStore 的自定义 deserialize 在
 * schema 不匹配时 quarantineCorruptFile 隔离保现场（此前只 warn + 静默回空骨架，
 * 绕过了 JsonStore 默认路径的 quarantine）→ writeModels 在降级态（原位文件已被
 * 隔离移走）拒绝写入，抛 ModelsStoreCorruptedError（code='models_store_corrupted'）→
 * isModelsStoreCorrupted() 随 config.providers RPC 下发 UI（字段名 corrupted）。
 *
 * 两条隔离路径同测：schema 不匹配（本修复补的 deserialize 路径）与 JSON 畸形
 * （JsonStore readFromDisk 既有路径）——降级态判定是磁盘真值（.corrupt 副本存在
 * 且原位文件不在），两条路径殊途同归。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readModels,
  writeModels,
  upsertProvider,
  getProviderConfig,
  isModelsStoreCorrupted,
  ModelsStoreCorruptedError,
  refreshModels,
  setModelsPath,
  type PiProviderConfig,
} from '../src/infra/pi/pi-provider-store.js'
import { setSettingsPath } from '../src/infra/pi/pi-settings-store.js'

let tmpDir: string
let agentDir: string
let savedEnv: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pi-provider-corruption-'))
  agentDir = join(tmpDir, 'agent')
  mkdirSync(agentDir, { recursive: true })
  // overlay 读侧（provider-catalog-refresh）与 auth.json 读经 getDataDir()/getPiAgentDir()
  // 实时解析 env，必须隔离到 tmpDir（复用 pi-provider-store.test.ts 的隔离模式）
  savedEnv = process.env.TAIJI_AGENT_DATA_DIR
  process.env.TAIJI_AGENT_DATA_DIR = tmpDir
  setModelsPath(join(agentDir, 'models.json'))
  setSettingsPath(join(agentDir, 'settings.json'))
  refreshModels()
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.TAIJI_AGENT_DATA_DIR
  else process.env.TAIJI_AGENT_DATA_DIR = savedEnv
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

const modelsPath = (): string => join(agentDir, 'models.json')

/** 找到 models.json 的 .corrupt-<ts> 隔离副本路径（无则 undefined）。 */
function findCorruptCopy(): string | undefined {
  return readdirSync(agentDir).find(name => name.startsWith('models.json.corrupt-'))
}

const SAMPLE_PROVIDER: PiProviderConfig = {
  name: 'Sample',
  api: 'anthropic-messages',
  apiKey: 'sk-sample',
  models: [{ id: 'sample-model' }],
}

describe('RT-3#4 schema 不匹配路径（deserialize 补隔离）', () => {
  it('providers 非对象：读回空骨架 + 隔离保现场；upsert/writeModels 拒绝并抛带 code 错误', () => {
    const broken = '{"providers": "not-an-object", "leftover": true}'
    writeFileSync(modelsPath(), broken, 'utf-8')

    // 触发读取：空骨架（不炸消费方）
    expect(readModels()).toEqual({ providers: {} })
    expect(getProviderConfig('sample')).toBeUndefined()

    // ① 原损坏内容未被空骨架覆盖：被隔离为 .corrupt-* 副本、原信息可找回
    const copyName = findCorruptCopy()
    expect(copyName).toBeDefined()
    expect(readFileSync(join(agentDir, copyName!), 'utf-8')).toBe(broken)
    expect(existsSync(modelsPath())).toBe(false)

    // ② setter/save 抛错而非成功；降级标志下发面为 true
    expect(() => upsertProvider('sample', SAMPLE_PROVIDER)).toThrowError(ModelsStoreCorruptedError)
    let caught: unknown
    try {
      upsertProvider('sample', SAMPLE_PROVIDER)
    } catch (e) {
      caught = e
    }
    expect((caught as ModelsStoreCorruptedError).code).toBe('models_store_corrupted')
    expect((caught as ModelsStoreCorruptedError).message).toContain(copyName!)
    expect(() => writeModels({ providers: { sample: SAMPLE_PROVIDER } })).toThrowError(ModelsStoreCorruptedError)
    expect(isModelsStoreCorrupted()).toBe(true)
    // 拒绝写盘：原位文件未被空骨架重建
    expect(existsSync(modelsPath())).toBe(false)
  })

  it('providers 为 null / 顶层非对象：同样按损坏隔离（穿透原 typeof 守卫的形态）', () => {
    writeFileSync(modelsPath(), '{"providers": null}', 'utf-8')
    expect(readModels()).toEqual({ providers: {} })
    expect(findCorruptCopy()).toBeDefined()
    expect(isModelsStoreCorrupted()).toBe(true)
  })
})

describe('RT-3#4 JSON 畸形路径（JsonStore 既有隔离）', () => {
  it('非法 JSON：JsonStore 隔离后降级态判定同样成立、写同样拒绝', () => {
    const broken = '{ "providers": { "p1": { "apiKey": "sk-'
    writeFileSync(modelsPath(), broken, 'utf-8')

    expect(readModels()).toEqual({ providers: {} })
    const copyName = findCorruptCopy()
    expect(copyName).toBeDefined()
    expect(readFileSync(join(agentDir, copyName!), 'utf-8')).toBe(broken)

    expect(() => upsertProvider('sample', SAMPLE_PROVIDER)).toThrowError(ModelsStoreCorruptedError)
    expect(isModelsStoreCorrupted()).toBe(true)
  })
})

describe('RT-3#4 降级态判定边界', () => {
  it('全新环境（无文件无副本）：非降级态，写入正常', () => {
    expect(isModelsStoreCorrupted()).toBe(false)
    upsertProvider('sample', SAMPLE_PROVIDER)
    expect(getProviderConfig('sample')?.apiKey).toBe('sk-sample')
    expect(isModelsStoreCorrupted()).toBe(false)
  })

  it('用户把副本内容写回原位：降级态自愈，写入恢复可用', () => {
    writeFileSync(modelsPath(), 'not-json', 'utf-8')
    readModels()
    expect(isModelsStoreCorrupted()).toBe(true)

    writeFileSync(modelsPath(), JSON.stringify({ providers: { sample: SAMPLE_PROVIDER } }), 'utf-8')
    expect(readModels().providers.sample?.apiKey).toBe('sk-sample')
    expect(isModelsStoreCorrupted()).toBe(false)
    expect(() => upsertProvider('other', SAMPLE_PROVIDER)).not.toThrow()
  })
})
