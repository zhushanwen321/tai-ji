/**
 * buildOutboundChildEnv 单测（U2 出站构建器）。
 *
 * 五类覆盖（设计文档 §5-U2 完成条件；红线用例以 [R1]/[R2] 显式标注可查）：
 * deny 键剔除 / 白名单基座完整保留 [R2] / extras undefined 删除语义 /
 * 不 mutate 入参 [R1] / 大输入幂等稳定。
 *
 * R3 合规：纯函数全程 DI，测试零 process.env 触碰（无 stub 必要）；所有 env
 * 输入均为本文件内构造的字面量快照，测试间零共享状态。
 */
import { describe, it, expect } from 'vitest'
import { buildOutboundChildEnv } from '../spawn-env.js'
import { SPAWN_ENV_OUTBOUND_DENY_LIST } from '../../../../shared/src/spawn-env-contract.js'

/** 模拟污染父 env：白名单合法变量 + 两个实证害项（探针 P1/P2 元凶） */
const POLLUTED_PARENT: Record<string, string | undefined> = {
  PATH: '/usr/bin:/bin:/usr/sbin',
  HOME: '/Users/tester',
  TERM: 'xterm-256color',
  USER: 'tester',
  NODE_OPTIONS: '--max-old-space-size=4096',
  XDG_CACHE_HOME: '/Users/tester/.cache',
  TAIJI_AGENT_DEBUG: '1',
  TAIJI_GLOBAL_AGENTS_DIR: '/tmp/agents',
  TAIJI_AGENT_PACKAGED: '1',
  TAIJI_RUNTIME_TOKEN: 'deadbeef-token',
}

describe('buildOutboundChildEnv · 出站契约三步语义', () => {
  it('deny 键剔除：基座与 extras 注入的实证害项一律剥除', () => {
    const out = buildOutboundChildEnv({
      parentEnv: POLLUTED_PARENT,
      // 即使调用方经 extras 强行注入，第三步仍兜底剥除
      extras: { TAIJI_AGENT_PACKAGED: '1', TAIJI_RUNTIME_TOKEN: 'renewed-token' },
    })
    for (const denied of SPAWN_ENV_OUTBOUND_DENY_LIST) {
      expect(out).not.toHaveProperty(denied)
    }
    expect(out.TAIJI_AGENT_PACKAGED).toBeUndefined()
    expect(out.TAIJI_RUNTIME_TOKEN).toBeUndefined()
  })

  it('[R2] 白名单基座完整保留：PATH/HOME/TERM/USER/NODE_*/XDG_* 原样透传', () => {
    const out = buildOutboundChildEnv({ parentEnv: POLLUTED_PARENT })
    expect(out.PATH).toBe('/usr/bin:/bin:/usr/sbin')
    expect(out.HOME).toBe('/Users/tester')
    expect(out.TERM).toBe('xterm-256color')
    expect(out.USER).toBe('tester')
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=4096')
    expect(out.XDG_CACHE_HOME).toBe('/Users/tester/.cache')
    expect(Object.keys(out)).toContain('PATH')
  })

  it('裸 TAIJI_ 前缀放行的功能契约变量保留（不误伤 forward 清单成员）', () => {
    const out = buildOutboundChildEnv({ parentEnv: POLLUTED_PARENT })
    expect(out.TAIJI_AGENT_DEBUG).toBe('1')
    expect(out.TAIJI_GLOBAL_AGENTS_DIR).toBe('/tmp/agents')
  })

  it('缺省 prefixes = shared 入站白名单 SSOT（非白名单键被过滤）', () => {
    const out = buildOutboundChildEnv({
      parentEnv: { ...POLLUTED_PARENT, SOME_RANDOM_VAR: 'noise', DOCKER_HOST: 'tcp://localhost' },
    })
    expect(out.SOME_RANDOM_VAR).toBeUndefined()
    expect(out.DOCKER_HOST).toBeUndefined()
  })

  it('prefixes 可自定义覆盖缺省 SSOT（B2 main 边界 ELECTRON_ 扩展场景）', () => {
    const out = buildOutboundChildEnv({
      parentEnv: { PATH: '/bin', HOME: '/h', ELECTRON_NO_ATTACH_CONSOLE: '1' },
      prefixes: ['PATH', 'HOME', 'ELECTRON_'],
    })
    expect(out.ELECTRON_NO_ATTACH_CONSOLE).toBe('1')
    expect(out.PATH).toBe('/bin')
  })
})

describe('extras merge（undefined = 显式删除，对齐 safe-env.ts 约定）', () => {
  it('值注入：覆盖父 env 同名键，新增键生效', () => {
    const out = buildOutboundChildEnv({
      parentEnv: { PATH: '/old-path', HOME: '/h' },
      extras: { PATH: '/new-path', PI_CODING_AGENT_DIR: '/data/agent' },
    })
    expect(out.PATH).toBe('/new-path')
    expect(out.PI_CODING_AGENT_DIR).toBe('/data/agent')
  })

  it('undefined 删除语义：删掉白名单已继承的父 env 键', () => {
    const out = buildOutboundChildEnv({
      parentEnv: { PATH: '/bin', HOME: '/h', TERM: 'xterm-256color' },
      extras: { TERM: undefined },
    })
    expect(out.TERM).toBeUndefined()
    expect(out).not.toHaveProperty('TERM')
    expect(out.PATH).toBe('/bin')
  })
})

describe('[R1] 纯函数与入参不可变', () => {
  it('返回全新对象，绝不 mutate 入参（parentEnv 与 extras 均不被改写）', () => {
    const parentEnv = { ...POLLUTED_PARENT }
    const extras: Record<string, string | undefined> = { TERM: undefined, FOO: 'bar' }
    const parentSnapshot = JSON.parse(JSON.stringify(parentEnv))
    const extrasSnapshot = JSON.parse(JSON.stringify(extras))

    const out = buildOutboundChildEnv({ parentEnv, extras })

    // deny 剔除/删除只发生在输出副本上，入参保持原样
    expect(parentEnv).toEqual(parentSnapshot)
    expect(extras).toEqual(extrasSnapshot)
    expect(parentEnv.TAIJI_AGENT_PACKAGED).toBe('1')
    expect(out).not.toBe(parentEnv)
  })

  it('冻结入参后调用不抛错（结构性证明内部零写入）', () => {
    const frozenParent = Object.freeze({ ...POLLUTED_PARENT }) as Record<string, string | undefined>
    const frozenExtras = Object.freeze({ TAIJI_AGENT_DATA_DIR: '/d' }) as Record<string, string | undefined>
    expect(() => buildOutboundChildEnv({ parentEnv: frozenParent, extras: frozenExtras })).not.toThrow()
  })
})

describe('幂等稳定性（大输入）', () => {
  it('1200 键大输入两次调用结果深度相等；再次应用构建器于其输出上结果不变', () => {
    const bigParent: Record<string, string | undefined> = { ...POLLUTED_PARENT }
    for (let i = 0; i < 1200; i++) {
      bigParent[`TAIJI_BULK_KEY_${i}`] = `value-${i}`
    }

    const first = buildOutboundChildEnv({ parentEnv: bigParent })
    const second = buildOutboundChildEnv({ parentEnv: bigParent })
    expect(first).toEqual(second)

    // 幂等：对已净化的输出再跑一遍构建器，无新变化（空 extras）
    const rerun = buildOutboundChildEnv({ parentEnv: first })
    expect(rerun).toEqual(first)
  })
})
