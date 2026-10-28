/**
 * wait-for-ci.mjs 的 argv 解析与 Release 产物判定（纯函数层）。
 *
 * 主循环判定（waitForRuns / judgeRuns / filterDependabot）由 merge-gate.test.mjs
 * 覆盖，此处不重复；本组固化命令行契约、verify-release 的判定分支、makeFetchRuns
 * （lib/fetch-runs.mjs，wait-for-ci 与 pr-merge 的共同查询闭包 SSOT）的
 * 「gh 查询失败与查询成功且空」分流契约（exit 0 放行只允许来自「查询成功且空」），
 * 以及 main() 对 gate 未知终态的白名单防御（不落穿放行）。
 */
import { describe, it, expect, vi } from 'vitest'
import { parseArgs, verifyReleasePayload, resolveShaFromState } from '../merge/wait-for-ci.mjs'
import { waitForRuns } from '../merge/lib/gate.mjs'
import { makeFetchRuns } from '../merge/lib/fetch-runs.mjs'

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

describe('makeFetchRuns（gh 查询失败与「成功且空」分流）', () => {
  /** 按 lib/exec.mjs run 的返回形态造假实现。 */
  const fakeRun = (over = {}) => (_cmd, _args, _opts) => ({
    code: 0,
    ok: true,
    stdout: '[]',
    stderr: '',
    error: null,
    ...over,
  })

  it('gh 退出非 0 → null（查询失败标记，区别于成功空 []）', async () => {
    const fetchRuns = makeFetchRuns({ REF: 'abc', WORKFLOW: '', GH_REPO: '', runImpl: fakeRun({ code: 1, ok: false }) })
    expect(await fetchRuns()).toBe(null)
  })

  it('stdout 非合法 JSON → null', async () => {
    const fetchRuns = makeFetchRuns({ REF: 'abc', WORKFLOW: '', GH_REPO: '', runImpl: fakeRun({ stdout: 'not-json' }) })
    expect(await fetchRuns()).toBe(null)
  })

  it('stdout JSON 非数组 → null（畸形输出不当空 runs）', async () => {
    const fetchRuns = makeFetchRuns({ REF: 'abc', WORKFLOW: '', GH_REPO: '', runImpl: fakeRun({ stdout: '{"total": 0}' }) })
    expect(await fetchRuns()).toBe(null)
  })

  it('查询成功 → 过滤 Dependabot 后的数组；成功空是 [] 而非 null（唯一可走 no-runs 放行的形态）', async () => {
    const stdout = JSON.stringify([
      { databaseId: 1, status: 'completed', conclusion: 'success', name: 'ci', workflowName: 'CI' },
      { databaseId: 2, status: 'completed', conclusion: 'failure', name: 'du', workflowName: 'Dependabot Updates' },
    ])
    const fetchRuns = makeFetchRuns({ REF: 'abc', WORKFLOW: '', GH_REPO: '', runImpl: fakeRun({ stdout }) })
    expect(await fetchRuns()).toEqual([
      { databaseId: 1, status: 'completed', conclusion: 'success', name: 'ci', workflowName: 'CI' },
    ])
    const fetchEmpty = makeFetchRuns({ REF: 'abc', WORKFLOW: '', GH_REPO: '', runImpl: fakeRun() })
    expect(await fetchEmpty()).toEqual([])
  })

  it('WORKFLOW 显式指定时不过滤（用户点名）', async () => {
    const stdout = JSON.stringify([{ databaseId: 2, status: 'completed', conclusion: 'failure', workflowName: 'Dependabot Updates' }])
    const fetchRuns = makeFetchRuns({ REF: 'abc', WORKFLOW: 'Dependabot Updates', GH_REPO: '', runImpl: fakeRun({ stdout }) })
    expect((await fetchRuns()).length).toBe(1)
  })

  it('【审查修复回归】全程查询失败 → fetch-error 而非 no-runs——no-runs 是 printNoRunsDetected exit 0 放行的唯一来源，查询失败不得静默跳过 main push CI 验证', async () => {
    const fetchRuns = makeFetchRuns({ REF: 'abc', WORKFLOW: '', GH_REPO: '', runImpl: fakeRun({ code: 1, ok: false }) })
    const v = await waitForRuns({ fetchRuns, sleep: async () => {}, pollMs: 15_000, deadlineMs: 30_000, notTriggeredGraceMs: 30_000 })
    expect(v.status).toBe('fetch-error')
  })
})

describe('main() 未知终态白名单防御（与 pr-merge 合并前防御对称）', () => {
  it('waitForRuns 返回未知终态 → 不打印「CI 全部通过」、exit 2（不落穿放行 = 防假绿）', async () => {
    vi.resetModules()
    vi.doMock('../merge/lib/gate.mjs', async (importOriginal) => {
      const actual = await importOriginal()
      return { ...actual, waitForRuns: async () => ({ status: 'weird-new-terminal' }) }
    })
    // gh 前置检查（--version / auth status）走假 run，不依赖本机 gh 安装与登录态
    vi.doMock('../merge/lib/exec.mjs', () => ({
      run: () => ({ code: 0, ok: true, stdout: '', stderr: '', error: null }),
    }))
    const logs = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // exit 打哨兵异常而非静默返回：静默返回会让 main 继续落穿到 pass 打印 + exit 0，
    // 恰是要防御的假绿形态，测试必须区分「先 exit 2」与「exit 0 兜底」
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit:${String(code)}`)
    })
    const argvBackup = process.argv
    const logFileBackup = process.env.MERGE_LOG_FILE
    process.argv = ['node', 'vitest-runner', 'deadbeef']
    delete process.env.MERGE_LOG_FILE
    try {
      const mod = await import('../merge/wait-for-ci.mjs')
      await expect(mod.main()).rejects.toThrow('process.exit:2')
      expect(logs.join('\n')).not.toContain('CI 全部通过')
    } finally {
      process.argv = argvBackup
      if (logFileBackup === undefined) delete process.env.MERGE_LOG_FILE
      else process.env.MERGE_LOG_FILE = logFileBackup
      exitSpy.mockRestore()
      logSpy.mockRestore()
      errSpy.mockRestore()
      vi.doUnmock('../merge/lib/gate.mjs')
      vi.doUnmock('../merge/lib/exec.mjs')
      vi.resetModules()
    }
  })
})
