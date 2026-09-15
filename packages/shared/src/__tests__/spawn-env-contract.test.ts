/**
 * spawn-env-contract 单测：出站契约常量的结构不变量。
 *
 * 守护（设计文档 env-propagation-boundary.md §5-U1 完成条件）：
 * - deny 清单成员最小性 = 首版恰为 2 个实证害项（D3 决策：只增不减、增删过评审）；
 * - 成员无重复、全大写蛇形命名；
 * - forward 参考清单覆盖 B 组五项 + U0① 增补项，且每条带 pi 子树消费锚点。
 */
import { describe, it, expect } from 'vitest'
import {
  SPAWN_ENV_OUTBOUND_DENY_LIST,
  SPAWN_ENV_FORWARD_REFERENCE,
  buildOutboundChildEnv,
  composeChildEnvBase,
} from '../spawn-env-contract.js'
import { ENV_WHITELIST_PREFIXES } from '../constants'

describe('SPAWN_ENV_OUTBOUND_DENY_LIST 出站剥除清单', () => {
  it('成员最小性：恰为 2 个实证害项（D3：PACKAGED + TOKEN）', () => {
    expect(SPAWN_ENV_OUTBOUND_DENY_LIST).toHaveLength(2)
    expect([...SPAWN_ENV_OUTBOUND_DENY_LIST]).toEqual(['TAIJI_AGENT_PACKAGED', 'TAIJI_RUNTIME_TOKEN'])
  })

  it('无重复成员', () => {
    expect(new Set(SPAWN_ENV_OUTBOUND_DENY_LIST).size).toBe(SPAWN_ENV_OUTBOUND_DENY_LIST.length)
  })

  it('全大写蛇形命名', () => {
    for (const name of SPAWN_ENV_OUTBOUND_DENY_LIST) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })
})

describe('SPAWN_ENV_FORWARD_REFERENCE 参考清单（文档性质，不参与过滤）', () => {
  const names = SPAWN_ENV_FORWARD_REFERENCE.map(entry => entry.name)

  it('含 B 组五项', () => {
    expect(names).toContain('PI_CODING_AGENT_DIR')
    expect(names).toContain('TAIJI_AGENT_DEBUG')
    expect(names).toContain('TAIJI_GLOBAL_AGENTS_DIR')
    expect(names).toContain('TAIJI_SUBAGENT_RELAY_SOCKET/_NODE/_SCRIPT')
    expect(names).toContain('TAIJI_ZCODE_CLI')
  })

  it('含 U0① 增补项 TAIJI_SUBAGENT_IDLE_TIMEOUT_MS（通道核实结论：B3 白名单继承）', () => {
    expect(names).toContain('TAIJI_SUBAGENT_IDLE_TIMEOUT_MS')
  })

  it('每条目均带 injectionPath 与非空消费锚点', () => {
    for (const entry of SPAWN_ENV_FORWARD_REFERENCE) {
      expect(entry.injectionPath.trim()).not.toBe('')
      expect(entry.piConsumerAnchors.length).toBeGreaterThan(0)
      for (const anchor of entry.piConsumerAnchors) {
        expect(anchor.trim()).not.toBe('')
      }
    }
  })

  it('U0② 维持原判：LOG_LEVEL 族不入清单（extensions 零消费，仅 runtime 自身读取）', () => {
    for (const name of names) {
      expect(name.startsWith('TAIJI_LOG_')).toBe(false)
    }
  })
})

describe('buildOutboundChildEnv / composeChildEnvBase 出站构建器', () => {
  const parentEnv: Record<string, string | undefined> = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    SECRET_LEAK: 'nope',
    TAIJI_AGENT_PACKAGED: '1',
    TAIJI_RUNTIME_TOKEN: 'deadbeef',
    UNDEFINED_VAL: undefined,
  }

  it('基座 = 缺省白名单前缀过滤父 env，非白名单键被剥除', () => {
    const out = buildOutboundChildEnv({ parentEnv })
    expect(out.PATH).toBe('/usr/bin')
    expect(out.HOME).toBe('/home/u')
    expect('SECRET_LEAK' in out).toBe(false)
    expect('UNDEFINED_VAL' in out).toBe(false)
  })

  it('prefixes 覆盖缺省 SSOT：自定义前缀集合生效', () => {
    const out = buildOutboundChildEnv({ parentEnv, prefixes: ['SECRET_'] })
    expect(out.SECRET_LEAK).toBe('nope')
    expect('PATH' in out).toBe(false)
  })

  it('prefix 精确匹配：key === prefix 放行（startsWith 语义）', () => {
    const out = buildOutboundChildEnv({ parentEnv, prefixes: ['PATH'] })
    expect(out.PATH).toBe('/usr/bin')
  })

  it('extras 注入/覆盖；undefined 值 = 显式删除', () => {
    const out = buildOutboundChildEnv({
      parentEnv,
      extras: { HOME: '/custom', PATH: undefined, FOO: 'bar' },
    })
    expect(out.HOME).toBe('/custom')
    expect('PATH' in out).toBe(false)
    expect(out.FOO).toBe('bar')
  })

  it('deny 兜底：extras 注入 deny 键也会被终态剥除', () => {
    const out = buildOutboundChildEnv({
      parentEnv,
      extras: { TAIJI_AGENT_PACKAGED: '1', TAIJI_RUNTIME_TOKEN: 'tok' },
    })
    expect('TAIJI_AGENT_PACKAGED' in out).toBe(false)
    expect('TAIJI_RUNTIME_TOKEN' in out).toBe(false)
  })

  it('composeChildEnvBase 不含 deny 兜底（main→runtime B2 边界分层）', () => {
    const out = composeChildEnvBase({ parentEnv })
    expect(out.TAIJI_AGENT_PACKAGED).toBe('1')
    expect(out.TAIJI_RUNTIME_TOKEN).toBe('deadbeef')
  })

  it('纯函数：不 mutate 入参、返回全新对象', () => {
    const parent = { ...parentEnv }
    const extras = { HOME: '/x' }
    const out = buildOutboundChildEnv({ parentEnv: parent, extras })
    out.PATH = 'mutated'
    expect(parent.PATH).toBe('/usr/bin')
    expect(extras.HOME).toBe('/x')
    expect(out).not.toBe(parent)
  })

  it('deny 清单成员即使绕过白名单（extras 注入非白名单键路径）也不出站', () => {
    for (const denied of SPAWN_ENV_OUTBOUND_DENY_LIST) {
      const out = buildOutboundChildEnv({
        parentEnv: {},
        prefixes: ['TAIJI_'],
        extras: { [denied]: 'value' },
      })
      expect(denied in out).toBe(false)
    }
  })

  it('缺省 prefixes 与 ENV_WHITELIST_PREFIXES SSOT 一致', () => {
    const out = buildOutboundChildEnv({ parentEnv })
    const expected: Record<string, string> = {}
    for (const [key, value] of Object.entries(parentEnv)) {
      if (value === undefined) continue
      if (ENV_WHITELIST_PREFIXES.some(p => key.startsWith(p))) expected[key] = value
    }
    for (const denied of SPAWN_ENV_OUTBOUND_DENY_LIST) delete expected[denied]
    expect(out).toEqual(expected)
  })
})
