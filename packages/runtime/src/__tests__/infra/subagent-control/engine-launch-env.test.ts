/**
 * buildEngineLaunchEnv 单测（L1，验收 ③⑦）：键集合锚定 u-foundation 冻结清单
 * （SDK ENGINE_ENV_L0_INFRA_KEYS / ENGINE_ENV_DENY_LIST）+ local vs runtime 的
 * task pi env 等价（设计 §3.3 D4「env 形状测试」）。
 */
import { describe, it, expect } from 'vitest'
import {
  buildEngineChildEnv,
  buildOutboundChildEnv,
  ENGINE_ENV_DENY_LIST,
  ENGINE_ENV_L0_INFRA_KEYS,
} from '@zhushanwen/subagent-engine-sdk'
import { buildEngineLaunchEnv } from '../../../infra/subagent-control/engine-launch-env.js'
import { CONTROL_ENV_ROOT_SESSION_ID, CONTROL_ENV_SOCKET } from '@zhushanwen/subagent-engine-sdk'

/** runtime 进程 env 快照（测试受控基座；注入必剥键证明 deny 链生效）。 */
const RUNTIME_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  TAIJI_RUNTIME_TOKEN: 'leak-me-not',
  TAIJI_AGENT_PACKAGED: '1',
  TERM: 'xterm-256color',
}

const BASE_OPTS = {
  runtimeEnv: RUNTIME_ENV,
  dataDir: '/tmp/dd',
  engineNode: '/usr/local/bin/node',
  electronRunAsNode: true,
  envPrefixes: ['MYENGINE_'],
  processEnv: { MYENGINE_FEATURE: 'on', LEAK_ME: 'no' },
  piAgentDir: '/tmp/dd/agent',
  piDir: '/opt/pi/bin',
  controlSocket: '/tmp/dd/run/subagent-1.sock',
  rootSessionId: 'sess-root-1',
  rawMirror: true,
}

/** L0 清单必需键集（runtime 宿主注入面必须全量在场）。 */
const REQUIRED_L0_KEYS = ENGINE_ENV_L0_INFRA_KEYS

describe('buildEngineLaunchEnv 键集合（锚定 u-foundation 冻结清单）', () => {
  const env = buildEngineLaunchEnv(BASE_OPTS)

  it('L0 基础设施键全部在场', () => {
    for (const key of REQUIRED_L0_KEYS) {
      expect(env[key], `L0 key ${key} must be present`).toBeTruthy()
    }
  })

  it('deny 清单键全不在场（runtime env 注入的 TOKEN/PACKAGED 被剥）', () => {
    for (const key of ENGINE_ENV_DENY_LIST) {
      expect(env[key], `deny key ${key} must be absent`).toBeUndefined()
    }
  })

  it('L2 manifest 放行：声明前缀进、未声明前缀不出', () => {
    expect(env.MYENGINE_FEATURE).toBe('on')
    expect(env.LEAK_ME).toBeUndefined()
  })

  it('runtime 宿主补齐键：PI_CODING_AGENT_DIR / PATH 前缀 / raw mirror', () => {
    expect(env.PI_CODING_AGENT_DIR).toBe('/tmp/dd/agent')
    expect(env.PATH?.startsWith('/opt/pi/bin:')).toBe(true)
    expect(env.TAIJI_ENGINE_RAW_MIRROR).toBe('1')
  })

  it('rawMirror=false / control 缺席 → 对应键显式删除（不残留基座旧值）', () => {
    const off = buildEngineLaunchEnv({ ...BASE_OPTS, rawMirror: false, controlSocket: undefined, rootSessionId: undefined })
    expect(off.TAIJI_ENGINE_RAW_MIRROR).toBeUndefined()
    expect(off[CONTROL_ENV_SOCKET]).toBeUndefined()
    expect(off[CONTROL_ENV_ROOT_SESSION_ID]).toBeUndefined()
  })

  it('纯函数：不 mutate 入参基座（runtimeEnv 快照零副作用）', () => {
    const snapshot = { ...RUNTIME_ENV }
    buildEngineLaunchEnv(BASE_OPTS)
    expect(RUNTIME_ENV).toEqual(snapshot)
  })
})

describe('local vs runtime launch env 等价（D4 env 形状测试，验收 ⑤）', () => {
  /**
   * 两侧归一到「task pi env」（引擎出站 = SDK buildOutboundChildEnv，deny 剥除后
   * pass-all 基座）再比较关键键——设计等价语义的锚点是 task pi 链，不是引擎 env 本体。
   * local 侧 = 扩展宿主（主 pi）ambient 携带 control 两键 + PI_CODING_AGENT_DIR + pi
   * 目录 PATH（taiji 托管形态的主 pi env），经 buildEngineChildEnv（local transport
   * 既有路径）；runtime 侧 = buildEngineLaunchEnv（本单元）。
   */
  const HOST_ENV_LOCAL = {
    ...RUNTIME_ENV,
    [CONTROL_ENV_SOCKET]: '/tmp/dd/run/subagent-1.sock',
    [CONTROL_ENV_ROOT_SESSION_ID]: 'sess-root-1',
    PI_CODING_AGENT_DIR: '/tmp/dd/agent',
    PATH: '/opt/pi/bin:/usr/bin:/bin',
    // 刻意不含 TAIJI_ENGINE_RAW_MIRROR：该键是 runtime 宿主宣告（D4 矩阵 engine 行），
    // local 形态无此键——见下方差集有界断言的注释。
  }

  const localTaskEnv = buildOutboundChildEnv({
    parentEnv: buildEngineChildEnv(HOST_ENV_LOCAL, {
      dataDir: BASE_OPTS.dataDir,
      engineNode: BASE_OPTS.engineNode,
      electronRunAsNode: BASE_OPTS.electronRunAsNode,
      envPrefixes: BASE_OPTS.envPrefixes,
      processEnv: BASE_OPTS.processEnv,
    }),
  })

  const runtimeTaskEnv = buildOutboundChildEnv({
    parentEnv: buildEngineLaunchEnv(BASE_OPTS),
  })

  /** 关键键锚单（impl-plan 验收 ⑤「关键键一致」；socket/root 为链路身份键，值同源相等）。 */
  const ANCHOR_KEYS = [
    'TAIJI_AGENT_DATA_DIR',
    'TAIJI_AGENT_ENGINE_NODE',
    'ELECTRON_RUN_AS_NODE',
    'TAIJI_AGENT_SUBAGENT',
    'PI_CODING_AGENT_DIR',
    CONTROL_ENV_SOCKET,
    CONTROL_ENV_ROOT_SESSION_ID,
  ]

  it('关键键双侧在场且值一致', () => {
    for (const key of ANCHOR_KEYS) {
      expect(localTaskEnv[key], `local task env missing ${key}`).toBeTruthy()
      expect(runtimeTaskEnv[key], `runtime task env missing ${key}`).toBeTruthy()
      expect(runtimeTaskEnv[key], `value mismatch on ${key}`).toBe(localTaskEnv[key])
    }
  })

  it('PATH 双侧可达 pi 目录（值形态等价：pi 目录前缀都在）', () => {
    expect(localTaskEnv.PATH?.includes('/opt/pi/bin')).toBe(true)
    expect(runtimeTaskEnv.PATH?.includes('/opt/pi/bin')).toBe(true)
  })

  it('deny 键双侧皆无（task pi 出站基座不泄漏 TOKEN/PACKAGED）', () => {
    for (const key of ENGINE_ENV_DENY_LIST) {
      expect(localTaskEnv[key]).toBeUndefined()
      expect(runtimeTaskEnv[key]).toBeUndefined()
    }
  })

  it('键集合差集有界：runtime 侧相对 local 的新增键 = raw mirror（runtime 宿主宣告键，SDK deny 未登记——过渡期事实锚定，u-m3-mirror/delete 终态复核）', () => {
    const localKeys = new Set(Object.keys(localTaskEnv))
    const runtimeOnly = Object.keys(runtimeTaskEnv).filter((k) => !localKeys.has(k))
    expect(new Set(runtimeOnly)).toEqual(new Set(['TAIJI_ENGINE_RAW_MIRROR']))
  })
})
