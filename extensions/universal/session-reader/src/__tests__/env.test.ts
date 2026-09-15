import { describe, it, expect } from 'vitest'
import {
  detectEnvironment,
  TAIJI_AGENT_EXT_LOG_ENV,
  PI_CODING_AGENT_DIR_ENV,
  TAIJI_AGENT_DATA_DIR_ENV,
  type EnvironmentSignals,
} from '../discovery/env.js'

/**
 * U2 环境判定单测（design §6.2 / §4.4）。detectEnvironment 是纯函数：
 * 全部信号为构造的字面量字符串，无任何 fs / 真实数据目录触碰。
 */

/** 构造信号包的基线：agentDir 用假路径，不指向任何真实目录 */
function signals(overrides: Partial<EnvironmentSignals> = {}): EnvironmentSignals {
  return {
    env: {},
    agentDir: '/tmp/nonexistent-fixture/.pi/agent',
    ...overrides,
  }
}

describe('detectEnvironment 托管合取判定', () => {
  it('双信号齐备 + B 后新布局 <dataDir>/agent → taiji（packaged）', () => {
    const r = detectEnvironment(
      signals({
        env: {
          [TAIJI_AGENT_EXT_LOG_ENV]: '1',
          [PI_CODING_AGENT_DIR_ENV]: '/Users/u/.taiji/agent',
        },
        bundleUrl:
          'file:///Applications/TaiJi.app/Contents/Resources/extensions/@zhushanwen/pi-session-reader/index.mjs',
      }),
    )
    expect(r.kind).toBe('taiji')
    expect(r.distribution).toBe('packaged')
    expect(r.dataDir).toBe('/Users/u/.taiji')
  })

  it('双信号齐备 + B 前旧布局 <dataDir>/pi/agent → taiji（迁移窗口期双形态兼容）', () => {
    const r = detectEnvironment(
      signals({
        env: {
          [TAIJI_AGENT_EXT_LOG_ENV]: '1',
          [PI_CODING_AGENT_DIR_ENV]: '/Users/u/.taiji-dev/pi/agent',
        },
        bundleUrl: 'file:///Users/u/Code/taiji/extensions/universal/session-reader/src/index.ts',
      }),
    )
    expect(r.kind).toBe('taiji')
    expect(r.distribution).toBe('dev')
    expect(r.dataDir).toBe('/Users/u/.taiji-dev')
  })

  it('透传污染反例 1：仅 TAIJI_AGENT_EXT_LOG=1（PI_CODING_AGENT_DIR 未设）→ standalone-pi，evidence 点名孤置信号', () => {
    const r = detectEnvironment(
      signals({ env: { [TAIJI_AGENT_EXT_LOG_ENV]: '1' } }),
    )
    expect(r.kind).toBe('standalone-pi')
    expect(r.dataDir).toBeUndefined()
    const joined = r.evidence.join('\n')
    expect(joined).toContain(`${TAIJI_AGENT_EXT_LOG_ENV}='1' → 命中`)
    expect(joined).toContain('单独成立不合取')
    expect(joined).toContain(TAIJI_AGENT_EXT_LOG_ENV)
  })

  it('透传污染反例 2：仅 TAIJI_AGENT_EXT_LOG=1 且 PI_CODING_AGENT_DIR 为裸 pi 形态 → standalone-pi', () => {
    const r = detectEnvironment(
      signals({
        env: {
          [TAIJI_AGENT_EXT_LOG_ENV]: '1',
          [PI_CODING_AGENT_DIR_ENV]: '/home/u/.pi/agent',
        },
      }),
    )
    expect(r.kind).toBe('standalone-pi')
    expect(r.evidence.join('\n')).toContain('形态不匹配')
  })

  it('透传污染反例 3：仅 PI_CODING_AGENT_DIR 形态匹配（EXT_LOG 未设）→ standalone-pi，evidence 点名孤置信号', () => {
    const r = detectEnvironment(
      signals({
        env: { [PI_CODING_AGENT_DIR_ENV]: '/Users/u/.taiji/agent' },
      }),
    )
    expect(r.kind).toBe('standalone-pi')
    expect(r.dataDir).toBeUndefined()
    const joined = r.evidence.join('\n')
    expect(joined).toContain('形态匹配')
    expect(joined).toContain('单独成立不合取')
    expect(joined).toContain(PI_CODING_AGENT_DIR_ENV)
  })

  it('TAIJI_AGENT_EXT_LOG 非 1 值（如 0 / true）不构成命中', () => {
    for (const value of ['0', 'true', '']) {
      const r = detectEnvironment(
        signals({
          env: {
            [TAIJI_AGENT_EXT_LOG_ENV]: value,
            [PI_CODING_AGENT_DIR_ENV]: '/Users/u/.taiji/agent',
          },
        }),
      )
      expect(r.kind, `EXT_LOG='${value}' 不应判托管`).toBe('standalone-pi')
    }
  })

  it('形态防误报：无点前缀 taiji、嵌套浅段不匹配', () => {
    for (const dir of ['/home/u/taiji/agent', '/home/u/.foo/agent', '/.pi/agent']) {
      const r = detectEnvironment(
        signals({
          env: {
            [TAIJI_AGENT_EXT_LOG_ENV]: '1',
            [PI_CODING_AGENT_DIR_ENV]: dir,
          },
        }),
      )
      expect(r.kind, `${dir} 不应判托管`).toBe('standalone-pi')
    }
  })
})

describe('detectEnvironment distribution（bundle 路径三态）', () => {
  it('.app/Contents/Resources/extensions/ → packaged', () => {
    const r = detectEnvironment(
      signals({
        bundleUrl:
          'file:///Applications/TaiJi.app/Contents/Resources/extensions/@zhushanwen/pi-session-reader/index.mjs',
      }),
    )
    expect(r.distribution).toBe('packaged')
  })

  it('Windows/Linux 安装资源目录 resources/extensions/ → packaged', () => {
    const r = detectEnvironment(
      signals({
        bundleUrl:
          'file:///C:/Users/u/AppData/Local/Programs/taiji/resources/extensions/@zhushanwen/pi-session-reader/index.mjs',
      }),
    )
    expect(r.distribution).toBe('packaged')
  })

  it('仓库路径（源码与 dev staged 资源根两种）→ dev，staged 根不被误判 packaged', () => {
    for (const url of [
      'file:///Users/u/Code/taiji/extensions/universal/session-reader/src/index.ts',
      'file:///Users/u/Code/taiji/apps/electron/resources/extensions/@zhushanwen/pi-session-reader/index.mjs',
    ]) {
      const r = detectEnvironment(signals({ bundleUrl: url }))
      expect(r.distribution, `${url} 应判 dev`).toBe('dev')
    }
  })

  it('bundleUrl 缺失 → null（不猜）', () => {
    const r = detectEnvironment(signals({}))
    expect(r.distribution).toBeNull()
    expect(r.evidence.join('\n')).toContain('无法判定')
  })
})

describe('detectEnvironment dataDir 推导', () => {
  it('托管：TAIJI_AGENT_DATA_DIR 优先于 PI_CODING_AGENT_DIR 剥层', () => {
    const r = detectEnvironment(
      signals({
        env: {
          [TAIJI_AGENT_EXT_LOG_ENV]: '1',
          [PI_CODING_AGENT_DIR_ENV]: '/data/.taiji/pi/agent',
          [TAIJI_AGENT_DATA_DIR_ENV]: '/data/.taiji',
        },
      }),
    )
    expect(r.kind).toBe('taiji')
    expect(r.dataDir).toBe('/data/.taiji')
    expect(r.evidence.join('\n')).toContain(`来源：${TAIJI_AGENT_DATA_DIR_ENV}`)
  })

  it('托管：无 DATA_DIR 时按布局剥层——新布局剥一层、旧布局剥两层', () => {
    const newLayout = detectEnvironment(
      signals({
        env: {
          [TAIJI_AGENT_EXT_LOG_ENV]: '1',
          [PI_CODING_AGENT_DIR_ENV]: '/data/.taiji/agent',
        },
      }),
    )
    expect(newLayout.dataDir).toBe('/data/.taiji')

    const oldLayout = detectEnvironment(
      signals({
        env: {
          [TAIJI_AGENT_EXT_LOG_ENV]: '1',
          [PI_CODING_AGENT_DIR_ENV]: '/data/.taiji/pi/agent',
        },
      }),
    )
    expect(oldLayout.dataDir).toBe('/data/.taiji')
  })

  it('standalone：即使 TAIJI_AGENT_DATA_DIR 被设置也恒 undefined', () => {
    const r = detectEnvironment(
      signals({
        env: {
          [TAIJI_AGENT_DATA_DIR_ENV]: '/data/.taiji',
        },
      }),
    )
    expect(r.kind).toBe('standalone-pi')
    expect(r.dataDir).toBeUndefined()
  })
})

describe('detectEnvironment evidence', () => {
  const scenarios: Array<[string, EnvironmentSignals]> = [
    ['全信号缺失', signals({})],
    ['托管全信号', signals({
      env: {
        [TAIJI_AGENT_EXT_LOG_ENV]: '1',
        [PI_CODING_AGENT_DIR_ENV]: '/data/.taiji/agent',
        [TAIJI_AGENT_DATA_DIR_ENV]: '/data/.taiji',
      },
      bundleUrl:
        'file:///Applications/TaiJi.app/Contents/Resources/extensions/@zhushanwen/pi-session-reader/index.mjs',
    })],
    ['EXT_LOG 孤置', signals({ env: { [TAIJI_AGENT_EXT_LOG_ENV]: '1' } })],
    ['agentDir 孤置', signals({ env: { [PI_CODING_AGENT_DIR_ENV]: '/data/.taiji/agent' } })],
    ['bundleUrl 缺失', signals({})],
  ]

  it('各场景 evidence 恒非空', () => {
    for (const [name, s] of scenarios) {
      const r = detectEnvironment(s)
      expect(r.evidence.length, `${name} 场景 evidence 不应为空`).toBeGreaterThan(0)
    }
  })

  it('每条信号的原文（命中与否）都在 evidence 中', () => {
    const r = detectEnvironment(
      signals({
        env: {
          [TAIJI_AGENT_EXT_LOG_ENV]: '0',
          [PI_CODING_AGENT_DIR_ENV]: '/data/.taiji/pi/agent',
        },
        agentDir: '/data/.taiji/pi/agent',
      }),
    )
    const joined = r.evidence.join('\n')
    // 未命中信号：原文 + 未命中注记
    expect(joined).toContain(`${TAIJI_AGENT_EXT_LOG_ENV}='0' → 未命中`)
    // 命中信号：原文 + 匹配注记
    expect(joined).toContain(`${PI_CODING_AGENT_DIR_ENV}='/data/.taiji/pi/agent'`)
    expect(joined).toContain('形态匹配')
    // 第三条输入：agentDir 透传记录
    expect(joined).toContain(`agentDir='/data/.taiji/pi/agent'`)
    // 判定结论行
    expect(joined).toContain('standalone-pi')
  })
})
