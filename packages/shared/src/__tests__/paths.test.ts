/**
 * paths.ts getPiSessionsDir 单测（PR #203 增量覆盖率门禁补测）。
 *
 * 覆盖：注入 dataDir 形态（join(dataDir, 'agent', 'sessions')）与缺省形态
 * （读 TAIJI_AGENT_DATA_DIR env，未设时 homedir() 兜底）。__tests__ 此前无
 * TAIJI_AGENT_DATA_DIR env 注入先例，缺省形态用 vitest 原生 vi.stubEnv 桩——
 * 被测函数是纯路径字符串推导，全程不触任何真实数据目录（~/.taiji）、
 * 不做任何 fs 读断言。
 *
 * 运行：cd packages/shared && npx vitest run src/__tests__/paths.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getPiSessionsDir, getImageCacheRoot, getImageCacheDir } from '../paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getPiSessionsDir', () => {
  it('注入 dataDir：join(dataDir, agent, sessions)（SSOT 同构推导，禁各进程手拼层级）', () => {
    expect(getPiSessionsDir('/tmp/taiji-shared-test-data')).toBe(
      join('/tmp/taiji-shared-test-data', 'agent', 'sessions'),
    )
  })

  it('缺省形态：读 TAIJI_AGENT_DATA_DIR env（vi.stubEnv 注入，无 env 注入先例故用 env 桩）', () => {
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', '/tmp/taiji-shared-test-data')
    expect(getPiSessionsDir()).toBe(join('/tmp/taiji-shared-test-data', 'agent', 'sessions'))
  })

  it('缺省且 env 未设：homedir() 兜底 ~/.taiji-dev（缺省反转，fail-safe default；纯字符串推导，不触 fs）', () => {
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', undefined)
    expect(getPiSessionsDir()).toBe(join(homedir(), '.taiji-dev', 'agent', 'sessions'))
  })
})

describe('getImageCacheRoot', () => {
  it('注入 dataDir：join(dataDir, cache, images)', () => {
    expect(getImageCacheRoot('/tmp/taiji-shared-test-data')).toBe(
      join('/tmp/taiji-shared-test-data', 'cache', 'images'),
    )
  })

  it('缺省形态：读 TAIJI_AGENT_DATA_DIR env（vi.stubEnv 桩，不触 fs）', () => {
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', '/tmp/taiji-shared-test-data')
    expect(getImageCacheRoot()).toBe(join('/tmp/taiji-shared-test-data', 'cache', 'images'))
  })
})

describe('getImageCacheDir', () => {
  it('合法 sessionId：join(root, sessionId)（字母数字下划线连字符）', () => {
    expect(getImageCacheDir('sess-AB_01', '/tmp/taiji-shared-test-data')).toBe(
      join('/tmp/taiji-shared-test-data', 'cache', 'images', 'sess-AB_01'),
    )
  })

  it('路径穿越形态 sessionId：throw（路径遍历防护守卫）', () => {
    for (const bad of ['../evil', 'a/b', 'a\\b', '..' , 'a b']) {
      expect(() => getImageCacheDir(bad, '/tmp/taiji-shared-test-data')).toThrow(
        /invalid sessionId \(path traversal blocked\)/,
      )
    }
  })
})
