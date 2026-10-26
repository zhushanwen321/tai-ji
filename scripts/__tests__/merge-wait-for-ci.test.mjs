/**
 * wait-for-ci.mjs 的 argv 解析与 Release 产物判定（纯函数层）。
 *
 * 主循环判定（waitForRuns / judgeRuns / filterDependabot）由 merge-gate.test.mjs
 * 覆盖，此处不重复；本组只固化命令行契约与 verify-release 的判定分支。
 */
import { describe, it, expect } from 'vitest'
import { parseArgs, verifyReleasePayload, resolveShaFromState } from '../merge/wait-for-ci.mjs'

describe('parseArgs（argv 解析）', () => {
  it('全缺省值：仅位置参数，timeout=2400（main push CI 含 30 分钟档 e2e job）其余空串', () => {
    expect(parseArgs(['abc123'])).toEqual({
      ok: true,
      sha: 'abc123',
      timeout: 2400,
      workflow: '',
      verifyReleaseTag: '',
      repo: '',
    })
  })

  it('四个选项全部解析（可出现在位置参数之后）', () => {
    expect(
      parseArgs([
        'abc123',
        '--timeout', '1200',
        '--workflow', 'CI',
        '--verify-release', 'v1.2.3',
        '--repo', 'someone/repo',
      ]),
    ).toEqual({
      ok: true,
      sha: 'abc123',
      timeout: 1200,
      workflow: 'CI',
      verifyReleaseTag: 'v1.2.3',
      repo: 'someone/repo',
    })
  })

  it('位置参数可省略（sha 为空串，读 merge 状态由主流程负责）', () => {
    expect(parseArgs([])).toEqual({ ok: true, sha: '', timeout: 2400, workflow: '', verifyReleaseTag: '', repo: '' })
    expect(parseArgs(['--timeout', '60'])).toEqual({ ok: true, sha: '', timeout: 60, workflow: '', verifyReleaseTag: '', repo: '' })
  })

  it('未知选项报错（原文案 Unknown option）', () => {
    const v = parseArgs(['abc', '--bogus'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Unknown option: --bogus')
  })

  it('第二个位置参数同样按未知项拒绝（与原 bash case 默认分支一致）', () => {
    const v = parseArgs(['abc', 'def'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Unknown option: def')
  })

  it('--timeout 非数字报错（NaN 比较恒 false 会让超时判定永不触发，必须前置拒绝）', () => {
    const v = parseArgs(['abc', '--timeout', 'abc'])
    expect(v.ok).toBe(false)
    expect(v.error).toContain('--timeout')
  })

  it('选项缺值报错', () => {
    for (const flag of ['--timeout', '--workflow', '--verify-release', '--repo']) {
      const v = parseArgs(['abc', flag])
      expect(v.ok).toBe(false)
      expect(v.error).toBe(`Missing value for option: ${flag}`)
    }
  })
})

describe('resolveShaFromState（无参路径的判定对象门）', () => {
  it('stage=merged 且有 mergeSha → 放行（判定对象 = merge commit 的 push CI）', () => {
    expect(resolveShaFromState({ stage: 'merged', mergeSha: 'deadbeef', pr: 61 })).toEqual({
      ok: true,
      sha: 'deadbeef',
      pr: 61,
    })
  })

  it('只有 headSha（PR head）而无 mergeSha → 拒绝——判的是阶段 2 已裁决过的 PR 侧 runs，禁止复用', () => {
    const v = resolveShaFromState({ stage: 'merged', headSha: 'aaa', pr: 61 })
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('无 mergeSha')
  })

  it('stage 非 merged（init/released/缺失）→ 拒绝', () => {
    for (const state of [{ stage: 'init' }, { stage: 'released' }, null, undefined, {}]) {
      const v = resolveShaFromState(state)
      expect(v.ok).toBe(false)
    }
  })

  it('mergeSha 空串视为无值（写入失败的防护）', () => {
    expect(resolveShaFromState({ stage: 'merged', mergeSha: '' }).ok).toBe(false)
  })
})

describe('verifyReleasePayload（Release 产物判定）', () => {
  const payload = (tag, assetCount) => ({
    tag,
    draft: true,
    asset_count: assetCount,
    assets: Array.from({ length: assetCount }, (_, i) => `asset-${String(i + 1)}`),
  })

  it('tag 匹配且有产物 → ok', () => {
    expect(verifyReleasePayload(payload('v1.2.3', 3), 'v1.2.3')).toEqual({ status: 'ok' })
    expect(verifyReleasePayload(payload('v1.2.3', 1), 'v1.2.3')).toEqual({ status: 'ok' })
  })

  it('tag 不匹配 → mismatch（附实际 tag 供打印）', () => {
    expect(verifyReleasePayload(payload('v1.2.2', 3), 'v1.2.3')).toEqual({ status: 'mismatch', actualTag: 'v1.2.2' })
  })

  it('产物数量 0 → no-assets（tag 匹配也拦，source code 不算构建产物）', () => {
    expect(verifyReleasePayload(payload('v1.2.3', 0), 'v1.2.3')).toEqual({ status: 'no-assets' })
    // asset_count 字段缺失同样按无产物处理
    expect(verifyReleasePayload({ tag: 'v1.2.3', draft: true, assets: [] }, 'v1.2.3')).toEqual({ status: 'no-assets' })
  })

  it('payload 缺失（轮询 120s 未出现）→ missing', () => {
    expect(verifyReleasePayload(null, 'v1.2.3')).toEqual({ status: 'missing' })
  })
})
