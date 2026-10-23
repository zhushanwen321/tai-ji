/**
 * shared constants 单测（wave-env-check TC1）。
 *
 * 守护：ENV_WHITELIST_PREFIXES 含 6 个 ambient 具体变量名（spec §7 最小暴露面）；
 * AMBIENT_ENV_NAMES 与追加名单一致（shell-env.ts 回写复用，漂移会破坏 ambient 透传）。
 * 用例拆细（每名一用例）：wave testCommand 的 vitest 输出解析取最后一段计数，
 * 本文件是 testCommand 最后一跳，用例数需 >= wave testCases 数。
 */
import { describe, it, expect } from 'vitest'
import { ENV_WHITELIST_PREFIXES, AMBIENT_ENV_NAMES, KNOWN_PI_API_TYPES, ENGINE_ENV_DENY_LIST, PRESET_FALLBACK_ENV_KEYS, SUBAGENT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '../constants.js'

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

  it('含 PI_（pi 域 env 整域准入——PI_CODING_AGENT_DIR / PI_WORKFLOW_SCHEMA 等 ambient 值随 spawn 链流转；目录权威值由派发链终态写入，本白名单只管 ambient 流转）', () => {
    expect(ENV_WHITELIST_PREFIXES).toContain('PI_')
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

describe('ENGINE_ENV_DENY_LIST 与预设回落 env 名 SSOT 联动', () => {
  // 原因（构造性防漂移）：deny 面按字面量登记（guard 只提取引号条目 + 本常量声明序），
  // 若改 PRESET_FALLBACK_ENV_KEYS 值而忘同步 deny 面 → 引擎出站重新放行陈旧回落值，
  // 子 agent pi 会记一个从未发生的 presetFallback 假披露。本断言把该联动机器化。
  it('deny 清单包含模式回落两键（防枚举改名后静默漂移）', () => {
    expect(
      ENGINE_ENV_DENY_LIST,
      'PRESET_FALLBACK_ENV_KEYS.FROM 未同步进 ENGINE_ENV_DENY_LIST——改名后忘了同步 deny 面（引擎出站 deny 失效 → 子 agent pi 假披露回归）',
    ).toContain(PRESET_FALLBACK_ENV_KEYS.FROM)
    expect(
      ENGINE_ENV_DENY_LIST,
      'PRESET_FALLBACK_ENV_KEYS.TO 未同步进 ENGINE_ENV_DENY_LIST——同上，改名后忘了同步 deny 面',
    ).toContain(PRESET_FALLBACK_ENV_KEYS.TO)
  })
})

describe('SUBAGENT_TOOL_NAMES / WORKFLOW_TOOL_NAMES 工具族键控集合（tool-declaration-slimming §4 影响面修正声明）', () => {
  // 原因（集合键控防静默退化）：两集合是 agentgraph 渲染分类（assistant-blocks
  // isAgentgraphToolName）与 record 失效分流（event-interpreter）的键控源——成员被误删
  // 时新调用静默退化为普通工具块且无报错无红灯。本组断言把「新旧名成员在集」锁成常驻
  // 防线（首验由 i-a6 真机 DOM 断言一次性承载，此处承接持续锁，先例 =
  // SUBAGENT_RECORD_CUSTOM_TYPE 双侧字面量锁）。
  it('新名五成员在集（D3 拆分后调用形态的键控锚，误删即红灯）', () => {
    expect(SUBAGENT_TOOL_NAMES.has('subagent_start'), 'subagent_start 不在集——新调用 agentgraph 渲染分类静默退化').toBe(true)
    expect(SUBAGENT_TOOL_NAMES.has('subagent_manage'), 'subagent_manage 不在集——同上').toBe(true)
    expect(SUBAGENT_TOOL_NAMES.has('subagent_message'), 'subagent_message 不在集——同上').toBe(true)
    expect(WORKFLOW_TOOL_NAMES.has('workflow_run'), 'workflow_run 不在集——workflow 调用 record 失效分流静默退化').toBe(true)
    expect(WORKFLOW_TOOL_NAMES.has('workflow_control'), 'workflow_control 不在集——同上').toBe(true)
  })

  it('旧名成员在集（历史会话 toolCall 渲染依赖，§4 影响面修正声明的保留裁决）', () => {
    expect(SUBAGENT_TOOL_NAMES.has('subagent')).toBe(true)
    expect(WORKFLOW_TOOL_NAMES.has('workflow')).toBe(true)
    expect(WORKFLOW_TOOL_NAMES.has('subagents')).toBe(true)
  })

  it('SUBAGENT_TOOL_NAMES 刻意不含 subagents（批量派发跑 workflow run，双收录会误路由进 subagent 分支）', () => {
    expect(SUBAGENT_TOOL_NAMES.has('subagents')).toBe(false)
  })
})
