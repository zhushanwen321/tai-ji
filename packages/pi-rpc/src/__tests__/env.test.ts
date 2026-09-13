// src/__tests__/env.test.ts
//
// pi 出站 env 组装测试：extras undefined 键跳过 / XYZ_AGENT_EXT_LOG 恒注入（不可
// extras 覆盖）/ 底层构建器 DI 调用 / PI_CODING_AGENT_DIR 追加。
// 语义锚点 = runtime rpc-client-start-args-anchor.test.ts E1（切换前行为）。

import { describe, expect, it, vi } from 'vitest'

import { buildPiOutboundEnv } from '../env.ts'
import type { BuildChildEnvFn } from '../env.ts'

/** 记录调用参数的 fake 底层构建器（模拟 shared buildOutboundChildEnv 契约）。 */
function makeFakeBuilder(base: Record<string, string> = { PATH: '/usr/bin', HOME: '/home' }) {
  const calls: Array<{ parentEnv: NodeJS.ProcessEnv; extras?: Record<string, string | undefined> }> = []
  const fn: BuildChildEnvFn = (opts) => {
    calls.push(opts)
    return { ...base, ...Object.fromEntries(Object.entries(opts.extras ?? {}).filter(([, v]) => v !== undefined)) }
  }
  return { fn, calls }
}

describe('buildPiOutboundEnv', () => {
  it('extras undefined 键跳过不写、非 undefined 键经底层构建器整体覆盖', () => {
    const { fn } = makeFakeBuilder()
    const env = buildPiOutboundEnv({
      parentEnv: { PATH: '/usr/bin' },
      extras: { GOOD_KEY: 'v1', SKIP_ME: undefined },
      buildChildEnv: fn,
      piAgentDir: '/data/agent',
    })
    expect('SKIP_ME' in env).toBe(false)
    expect(env.GOOD_KEY).toBe('v1')
  })

  it('XYZ_AGENT_EXT_LOG 恒注入 "1"（托管日志开关；extras 同名键也被覆盖——不开放覆盖）', () => {
    const { fn } = makeFakeBuilder()
    const env = buildPiOutboundEnv({ parentEnv: {}, buildChildEnv: fn, piAgentDir: '/d' })
    expect(env.XYZ_AGENT_EXT_LOG).toBe('1')

    const override = buildPiOutboundEnv({
      parentEnv: {},
      extras: { XYZ_AGENT_EXT_LOG: '0' },
      buildChildEnv: fn,
      piAgentDir: '/d',
    })
    expect(override.XYZ_AGENT_EXT_LOG).toBe('1')
  })

  it('PI_CODING_AGENT_DIR 在构建器输出之上追加（pi agent 目录隔离）', () => {
    const { fn } = makeFakeBuilder()
    const env = buildPiOutboundEnv({ parentEnv: {}, buildChildEnv: fn, piAgentDir: '/data/agent' })
    expect(env.PI_CODING_AGENT_DIR).toBe('/data/agent')
  })

  it('底层构建器收到 parentEnv 与过滤后的 extras（白名单基座 + deny 兜底语义归构建器）', () => {
    const { fn, calls } = makeFakeBuilder()
    const parentEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin', SECRET: 'leak' }
    buildPiOutboundEnv({ parentEnv, extras: { K: 'v' }, buildChildEnv: fn, piAgentDir: '/d' })
    expect(calls).toHaveLength(1)
    expect(calls[0].parentEnv).toBe(parentEnv)
    expect(calls[0].extras).toEqual({ K: 'v', XYZ_AGENT_EXT_LOG: '1' })
  })
})
