/**
 * RelayRegistry.buildChildEnv 出站接线单测（U4-B8，docs/architecture/env-propagation-boundary.md §5-U4/D4）。
 *
 * 覆盖验收断言点：
 * - 五键剥离范式保留（RELAY_ENV_* 经 extras undefined=删除语义迁入构建器）；
 * - 叠加 deny 两键剔除（D4：「叠加 deny 过滤后不多不少」）；
 * - 帧 env 全量拷贝拓扑不变（pass-all：schemaEnv/worktree 标志类非白名单键必须原样保留）；
 * - 不 mutate 帧 env 输入（R1）。
 *
 * 直接导入纯函数验（handleConnection 全链路已有 relay-registry.test.ts 真 socket 覆盖）。
 * 运行：cd packages/runtime && npx vitest run src/__tests__/infra/relay/relay-build-child-env.test.ts
 */
import { describe, it, expect } from 'vitest'
import { buildChildEnv } from '../../../infra/relay/relay-registry.js'
import {
  RELAY_ENV_SOCKET,
  RELAY_ENV_NODE,
  RELAY_ENV_SCRIPT,
  RELAY_ENV_SESSION_ID,
  RELAY_ENV_RECORD_ID,
} from '@zhushanwen/subagent-core/relay-env'

/** 构造带污染项的最小握手帧（env 混合：五定位键 + deny 键 + 非白名单业务标志 + 正常键）。 */
function createPollutedFrame(): {
  v: number
  kind: 'handshake'
  mainSessionId: string
  recordId: string
  argv: string[]
  cwd: string
  env: Record<string, string | undefined>
} {
  return {
    v: 1,
    kind: 'handshake',
    mainSessionId: 'sid-main',
    recordId: 'rec-1',
    argv: ['--mode', 'rpc'],
    cwd: '/tmp/project',
    env: {
      [RELAY_ENV_SOCKET]: '/tmp/relay.sock',
      [RELAY_ENV_NODE]: '/usr/local/bin/node',
      [RELAY_ENV_SCRIPT]: '/x/relay-agent.mjs',
      [RELAY_ENV_SESSION_ID]: 'sid-main',
      [RELAY_ENV_RECORD_ID]: 'rec-1',
      // deny 清单两键：孙进程绝不允许带走生命周期标志 / 凭证
      XYZ_AGENT_PACKAGED: '1',
      XYZ_RUNTIME_TOKEN: 'secret-token',
      // 帧承载的业务标志（非白名单前缀）：D4「原样使用」拓扑 → 必须原样保留
      SCHEMA_FLAG_SESSION_X: 'schema-content',
      WORKTREE_BRANCH_FLAG: 'wt-fix-branch',
      HOME: '/Users/tester',
    },
  }
}

describe('buildChildEnv 出站叠加 deny（U4/D4）', () => {
  it('剥离 relay 五键 + deny 两键；非白名单业务标志原样保留（拷贝拓扑不变）', () => {
    const frame = createPollutedFrame()
    const out = buildChildEnv(frame)

    expect(out[RELAY_ENV_SOCKET]).toBeUndefined()
    expect(out[RELAY_ENV_NODE]).toBeUndefined()
    expect(out[RELAY_ENV_SCRIPT]).toBeUndefined()
    expect(out[RELAY_ENV_SESSION_ID]).toBeUndefined()
    expect(out[RELAY_ENV_RECORD_ID]).toBeUndefined()
    expect(out.XYZ_AGENT_PACKAGED).toBeUndefined()
    expect(out.XYZ_RUNTIME_TOKEN).toBeUndefined()

    expect(out.SCHEMA_FLAG_SESSION_X).toBe('schema-content')
    expect(out.WORKTREE_BRANCH_FLAG).toBe('wt-fix-branch')
    expect(out.HOME).toBe('/Users/tester')
  })

  it('帧 env 为空对象时输出为空对象（全有或全无等价的下界形态）', () => {
    const frame = createPollutedFrame()
    frame.env = {}
    const out = buildChildEnv(frame)
    expect(Object.keys(out)).toHaveLength(0)
  })

  it('undefined 值不入产出且不 mutate 帧 env（R1：只动副本）', () => {
    const frame = createPollutedFrame()
    const snapshot = JSON.parse(JSON.stringify(frame.env)) as Record<string, string | undefined>

    const out = buildChildEnv(frame)

    expect('SCHEMA_FLAG_SESSION_X' in out).toBe(true)
    // 输入对象未被改动
    expect(frame.env).toEqual(snapshot)
    expect(frame.env.XYZ_RUNTIME_TOKEN).toBe('secret-token')
  })
})
