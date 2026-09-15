/**
 * shared constants 单测（wave-env-check TC1）。
 *
 * 守护：ENV_WHITELIST_PREFIXES 含 6 个 ambient 具体变量名（spec §7 最小暴露面）；
 * AMBIENT_ENV_NAMES 与追加名单一致（shell-env.ts 回写复用，漂移会破坏 ambient 透传）。
 * 用例拆细（每名一用例）：wave testCommand 的 vitest 输出解析取最后一段计数，
 * 本文件是 testCommand 最后一跳，用例数需 >= wave testCases 数。
 */
import { describe, it, expect } from 'vitest'
import { ENV_WHITELIST_PREFIXES, AMBIENT_ENV_NAMES, KNOWN_PI_API_TYPES } from '../constants.js'

const AMBIENT_NAMES = [
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_PROFILE',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GCLOUD_PROJECT',
  'CLOUDSDK_REGION',
]

describe('ENV_WHITELIST_PREFIXES ambient 名单（spec §7 最小暴露面）', () => {
  it('含 GOOGLE_APPLICATION_CREDENTIALS（文件型 ADC 自定义路径，spec §7 点名）', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('GOOGLE_APPLICATION_CREDENTIALS')
  })

  it('含 AWS_PROFILE', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('AWS_PROFILE')
  })

  it('含 GOOGLE_CLOUD_PROJECT', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('GOOGLE_CLOUD_PROJECT')
  })

  it('含 GOOGLE_CLOUD_LOCATION', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('GOOGLE_CLOUD_LOCATION')
  })

  it('含 GCLOUD_PROJECT 与 CLOUDSDK_REGION', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('GCLOUD_PROJECT')
    expect(ENV_WHITELIST_PREFIXES).toContain('CLOUDSDK_REGION')
  })

  it('不含 AWS_/GOOGLE_/CLOUDSDK_ 整前缀（防生产凭证进 pi 子进程）', () => {
    expect(ENV_WHITELIST_PREFIXES).not.toContain('AWS_')
    expect(ENV_WHITELIST_PREFIXES).not.toContain('GOOGLE_')
    expect(ENV_WHITELIST_PREFIXES).not.toContain('CLOUDSDK_')
  })
})

describe('AMBIENT_ENV_NAMES', () => {
  it('与 ENV_WHITELIST_PREFIXES 的 ambient 追加名单一致（无漂移）', () => {
    expect([...AMBIENT_ENV_NAMES].sort()).toEqual([...AMBIENT_NAMES].sort())
  })

  it('名单去重', () => {
    expect(new Set(AMBIENT_ENV_NAMES).size).toBe(AMBIENT_ENV_NAMES.length)
  })

  it('每个名字都在 ENV_WHITELIST_PREFIXES 中（shell-env 回写与白名单透传闭环）', () => {
    for (const name of AMBIENT_ENV_NAMES) {
      expect(ENV_WHITELIST_PREFIXES).toContain(name)
    }
  })
})

describe('KNOWN_PI_API_TYPES（W2 A-09：pi-ai KnownApi 10 值全集）', () => {
  // 锚点：pi 0.84.1 实装依赖内嵌 pi-ai 0.84.2
  // node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts:15
  // 的 KnownApi 联合（与根 pi-ai 0.82.1 dist/types.d.ts:14 同集，2026-08-20 现场核实）。
  // 升级 pi / pi-ai 时 diff 锚点行同步——此前仅 3 值导致 7 种合法 api type 误报 warn。
  const PI_AI_KNOWN_API = [
    'openai-completions',
    'mistral-conversations',
    'openai-responses',
    'azure-openai-responses',
    'openai-codex-responses',
    'anthropic-messages',
    'bedrock-converse-stream',
    'google-generative-ai',
    'google-vertex',
    'pi-messages',
  ]

  it('= KnownApi 10 值全集（逐值对照）', () => {
    expect([...KNOWN_PI_API_TYPES].sort()).toEqual([...PI_AI_KNOWN_API].sort())
  })

  it('历史 3 值子集仍全在（前端已暴露的终值不丢）', () => {
    for (const t of ['anthropic-messages', 'openai-completions', 'openai-responses']) {
      expect(KNOWN_PI_API_TYPES.has(t)).toBe(true)
    }
  })

  it('不在 KnownApi 的值不误收（pi-ai 类型系统外）', () => {
    // ollama 经审计核实 pi 确不支持（A-09 附带核实），不得进白名单
    expect(KNOWN_PI_API_TYPES.has('ollama')).toBe(false)
    expect(KNOWN_PI_API_TYPES.has('')).toBe(false)
  })
})
