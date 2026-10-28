/**
 * verify-ci-release.mjs 的纯函数层（argv 解析 / run 匹配 / 产物完整性判定）
 * 与注入 IO 的查询闭包/轮询编排层（makeFetchRuns 三态契约、pollRunForTag
 * 查询失败与未完成轮分流——MF-3-4：gh 全程故障报「查询持续失败」而非误报
 * 「CI 超时」）。
 *
 * 覆盖对应原 bash verify-ci-release.sh 的 jq 匹配段与 grep 产物校验段的等价固化；
 * 轮询编排用注入的假 fetcher + 假时钟驱动（形态对齐 merge-gate.test.mjs），不触网。
 */
import { describe, it, expect } from 'vitest'
import {
  parseArgs,
  findRunForTag,
  assetCompleteness,
  isDraftRelease,
  makeFetchRuns,
  pollRunForTag,
} from '../merge/verify-ci-release.mjs'

describe('parseArgs（argv 解析）', () => {
  it('tag 必填缺省：无参时 tag 为空串（由主流程打 Usage 退出）', () => {
    expect(parseArgs([])).toEqual({ ok: true, tag: '', ciTimeout: 30 })
  })

  it('默认 --ci-timeout 为 30 分钟', () => {
    expect(parseArgs(['v1.2.3'])).toEqual({ ok: true, tag: 'v1.2.3', ciTimeout: 30 })
  })

  it('--ci-timeout 显式取值', () => {
    expect(parseArgs(['v1.2.3', '--ci-timeout', '45'])).toEqual({ ok: true, tag: 'v1.2.3', ciTimeout: 45 })
  })

  it('未知选项报错（原文案 Unknown option）', () => {
    const v = parseArgs(['v1.2.3', '--bogus'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Unknown option: --bogus')
  })

  it('与原 bash 一致：第一个参数无条件作 tag，形如选项名时在选项循环处被拒', () => {
    // verify-ci-release.sh --ci-timeout 60 → tag='--ci-timeout'，'60' 按未知选项拒绝
    const v = parseArgs(['--ci-timeout', '60'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Unknown option: 60')
  })

  it('--ci-timeout 缺值报错', () => {
    const v = parseArgs(['v1.2.3', '--ci-timeout'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Missing value for option: --ci-timeout')
  })

  it('--ci-timeout 非数字报错（NaN 会让轮询上限失效，必须前置拒绝）', () => {
    const v = parseArgs(['v1.2.3', '--ci-timeout', 'abc'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Invalid --ci-timeout value: abc')
  })
})

describe('findRunForTag（tag 触发的 run 匹配）', () => {
  const run = (over = {}) => ({
    databaseId: 111,
    status: 'completed',
    conclusion: 'success',
    headBranch: 'main',
    displayTitle: 'Release v1.2.3',
    ...over,
  })

  it('headBranch 精确等于 tag → 命中', () => {
    const runs = [run({ databaseId: 1, headBranch: 'v1.2.3' })]
    expect(findRunForTag(runs, 'v1.2.3')?.databaseId).toBe(1)
  })

  it('headBranch 为 refs/tags/ 形态 → 命中', () => {
    const runs = [run({ databaseId: 2, headBranch: 'refs/tags/v1.2.3' })]
    expect(findRunForTag(runs, 'v1.2.3')?.databaseId).toBe(2)
  })

  it('headBranch 不匹配时备选 displayTitle 包含 tag → 命中', () => {
    const runs = [run({ databaseId: 3, headBranch: 'main', displayTitle: 'Release v1.2.3 workflow' })]
    expect(findRunForTag(runs, 'v1.2.3')?.databaseId).toBe(3)
  })

  it('主匹配优先于备选：displayTitle 命中在先也不影响 headBranch 主命中', () => {
    const runs = [
      run({ databaseId: 4, headBranch: 'main', displayTitle: 'Release v1.2.3' }),
      run({ databaseId: 5, headBranch: 'v1.2.3', displayTitle: '其他标题' }),
    ]
    expect(findRunForTag(runs, 'v1.2.3')?.databaseId).toBe(5)
  })

  it('多命中取第一个（主匹配内与备选内各自如此）', () => {
    const runs = [
      run({ databaseId: 6, headBranch: 'v1.2.3' }),
      run({ databaseId: 7, headBranch: 'refs/tags/v1.2.3' }),
    ]
    expect(findRunForTag(runs, 'v1.2.3')?.databaseId).toBe(6)

    const byTitle = [
      run({ databaseId: 8, headBranch: 'main', displayTitle: 'Release v1.2.3 (retry)' }),
      run({ databaseId: 9, headBranch: 'dev', displayTitle: 'chore: bump to v1.2.3' }),
    ]
    expect(findRunForTag(byTitle, 'v1.2.3')?.databaseId).toBe(8)
  })

  it('无命中 → null', () => {
    const runs = [run({ databaseId: 10, headBranch: 'main', displayTitle: '无关标题' })]
    expect(findRunForTag(runs, 'v9.9.9')).toBeNull()
    expect(findRunForTag([], 'v1.2.3')).toBeNull()
    expect(findRunForTag(undefined, 'v1.2.3')).toBeNull()
  })

  it('tag 前缀互斥：v0.11.1 不得命中标题 v0.11.15（裸 includes 会把新 release 的结论当本次结论）', () => {
    const runs = [run({ databaseId: 12, headBranch: 'main', displayTitle: 'Release v0.11.15' })]
    expect(findRunForTag(runs, 'v0.11.1')).toBeNull()
  })

  it('边界判定锚定：tag 后跟数字/字母/点视为更长版本号不命中，跟其他字符或行尾命中', () => {
    const titles = (t) => [run({ databaseId: 13, headBranch: 'main', displayTitle: t })]
    // 后跟 [0-9a-zA-Z.]（更长版本号的延续字符）→ 不命中
    expect(findRunForTag(titles('Release v0.11.15'), 'v0.11.1')).toBeNull()
    expect(findRunForTag(titles('bump v0.11.1a1'), 'v0.11.1')).toBeNull()
    expect(findRunForTag(titles('bump v0.11.1.2'), 'v0.11.1')).toBeNull()
    // 后跟空格 / 括号 / 行尾 → 命中
    expect(findRunForTag(titles('Release v0.11.1 (hotfix)'), 'v0.11.1')?.databaseId).toBe(13)
    expect(findRunForTag(titles('chore: bump to v0.11.1'), 'v0.11.1')?.databaseId).toBe(13)
  })
})

describe('assetCompleteness（产物完整性判定）', () => {
  it('三平台产物齐全 → 零缺失零多余', () => {
    const names = ['TaiJi-1.2.3-arm64.dmg', 'TaiJi Setup 1.2.3.exe', 'tai-ji-1.2.3-arm64.AppImage']
    expect(assetCompleteness(names)).toEqual({ missing: [], unexpected: [] })
  })

  it('缺 dmg → missing 含 dmg', () => {
    const v = assetCompleteness(['TaiJi Setup 1.2.3.exe', 'tai-ji-1.2.3-arm64.AppImage'])
    expect(v.missing).toEqual(['dmg'])
    expect(v.unexpected).toEqual([])
  })

  it('缺 exe → missing 含 exe', () => {
    const v = assetCompleteness(['TaiJi-1.2.3-arm64.dmg', 'tai-ji-1.2.3-arm64.AppImage'])
    expect(v.missing).toEqual(['exe'])
  })

  it('缺 AppImage（不含该子串）→ missing 含 appimage', () => {
    const v = assetCompleteness(['TaiJi-1.2.3-arm64.dmg', 'TaiJi Setup 1.2.3.exe'])
    expect(v.missing).toEqual(['appimage'])
  })

  it('意外 zip → unexpected（zip target 已移除，残留即发布管线配置回退）', () => {
    const v = assetCompleteness([
      'TaiJi-1.2.3-arm64.dmg',
      'TaiJi Setup 1.2.3.exe',
      'tai-ji-1.2.3-arm64.AppImage',
      'tai-ji-1.2.3-win.zip',
    ])
    expect(v.unexpected).toEqual(['zip'])
    expect(v.missing).toEqual([])
  })

  it('意外 deb → unexpected（deb target 已移除）', () => {
    const v = assetCompleteness([
      'TaiJi-1.2.3-arm64.dmg',
      'TaiJi Setup 1.2.3.exe',
      'tai-ji-1.2.3-arm64.AppImage',
      'tai-ji-1.2.3-amd64.deb',
    ])
    expect(v.unexpected).toEqual(['deb'])
  })

  it('空产物名单 → 三平台全缺', () => {
    expect(assetCompleteness([])).toEqual({ missing: ['dmg', 'exe', 'appimage'], unexpected: [] })
  })

  it('多项问题一次报全（缺项与意外并存）', () => {
    const v = assetCompleteness(['TaiJi Setup 1.2.3.exe', 'legacy.zip'])
    expect(v.missing).toEqual(['dmg', 'appimage'])
    expect(v.unexpected).toEqual(['zip'])
  })
})

describe('isDraftRelease（draft 滞留判定，阶段 3 第二道防线）', () => {
  it('isDraft=true → true（draft 对用户不可见，产物齐全也不能判绿）', () => {
    expect(isDraftRelease({ isDraft: true, names: ['a.dmg', 'b.exe', 'c.AppImage'] })).toBe(true)
    expect(isDraftRelease({ isDraft: true })).toBe(true)
  })

  it('isDraft=false / 字段缺失 / 查不到（null，gh 失败）→ false（null 场景由产物校验兜底 fatal）', () => {
    expect(isDraftRelease({ isDraft: false })).toBe(false)
    expect(isDraftRelease({})).toBe(false)
    expect(isDraftRelease(null)).toBe(false)
  })
})

describe('makeFetchRuns（gh run list 查询闭包，三态契约）', () => {
  const fetchWith = (res) => makeFetchRuns({ REPO: 'zhushanwen321/tai-ji', runImpl: () => res })

  it('gh 退出非 0 → null（查询失败，不归一成空数组）', () => {
    expect(fetchWith({ ok: false, stdout: '' })()).toBeNull()
  })

  it('stdout 非合法 JSON / JSON 非数组 → null（输出畸形同属查询失败）', () => {
    expect(fetchWith({ ok: true, stdout: 'not-json' })()).toBeNull()
    expect(fetchWith({ ok: true, stdout: '{"a":1}' })()).toBeNull()
  })

  it('查询成功 → runs 数组；空数组 = 查询成功且无 runs（与查询失败的 null 分流）', () => {
    expect(fetchWith({ ok: true, stdout: '[]' })()).toEqual([])
    const runs = [{ databaseId: 1, status: 'completed', conclusion: 'success', headBranch: 'v1.2.3' }]
    expect(fetchWith({ ok: true, stdout: JSON.stringify(runs) })()).toEqual(runs)
  })
})

describe('pollRunForTag（阶段 1 轮询编排——查询失败轮与未完成轮分流）', () => {
  const runItem = (over = {}) => ({
    databaseId: 111,
    status: 'completed',
    conclusion: 'success',
    headBranch: 'v1.2.3',
    displayTitle: 'Release v1.2.3',
    ...over,
  })

  /** 假时钟 + 可编排的假 fetcher：seq 依次返回，耗尽后重复末项。 */
  function fakeWorld(seq) {
    let cursor = 0
    let sleeps = 0
    const fetcher = () => {
      const item = seq[Math.min(cursor, seq.length - 1)]
      cursor += 1
      return item
    }
    const sleep = async () => {
      sleeps += 1
    }
    return { fetcher, sleep, get sleeps() { return sleeps } }
  }

  it('【MF-3-4 回归】gh 全程失败 → fetch-error 而非 timeout，不烧满预算', async () => {
    const w = fakeWorld([null])
    const v = await pollRunForTag({ TAG: 'v1.2.3', MAX_POLLS: 60, fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('fetch-error')
    // 连续 3 轮失败即退出：只睡 2 次（第 3 轮失败即刻返回），远小于 60 轮（30 分钟）预算
    expect(w.sleeps).toBe(2)
  })

  it('查询失败后恢复 → 连续计数清零，正常等待至完成', async () => {
    const w = fakeWorld([
      null,
      null,
      [runItem({ status: 'in_progress', conclusion: null })],
      [runItem()],
    ])
    const v = await pollRunForTag({ TAG: 'v1.2.3', MAX_POLLS: 60, fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('completed')
    expect(v.run.databaseId).toBe(111)
    expect(w.sleeps).toBe(3)
  })

  it('预算耗尽且存在成功查询轮 → timeout（CI 慢，不是通道故障）', async () => {
    const w = fakeWorld([[runItem({ status: 'in_progress', conclusion: null })]])
    const v = await pollRunForTag({ TAG: 'v1.2.3', MAX_POLLS: 3, fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('timeout')
    expect(w.sleeps).toBe(3)
  })

  it('极小预算下全部轮次皆查询失败 → fetch-error（不误报「CI 超时」）', async () => {
    const w = fakeWorld([null])
    const v = await pollRunForTag({ TAG: 'v1.2.3', MAX_POLLS: 2, fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('fetch-error')
  })

  it('命中 completed run → completed 附原 run（conclusion 裁决留给调用方），命中轮不睡', async () => {
    const w = fakeWorld([[runItem({ conclusion: 'failure' })]])
    const v = await pollRunForTag({ TAG: 'v1.2.3', MAX_POLLS: 3, fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('completed')
    expect(v.run.conclusion).toBe('failure')
    expect(w.sleeps).toBe(0)
  })

  it('查询成功但无匹配 run（空数组）→ 继续轮询到预算耗尽 → timeout', async () => {
    const w = fakeWorld([[]])
    const v = await pollRunForTag({ TAG: 'v9.9.9', MAX_POLLS: 2, fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('timeout')
    expect(w.sleeps).toBe(2)
  })

  it('【MF-5-2 回归】fetchRuns 返回 Promise<null>（async 闭包形态，如误接 lib/fetch-runs 的 SSOT 工厂）→ 也被计为查询失败轮', async () => {
    const w = fakeWorld([null])
    const asyncFetcher = async () => w.fetcher()
    const v = await pollRunForTag({ TAG: 'v1.2.3', MAX_POLLS: 60, fetchRuns: asyncFetcher, sleep: w.sleep })
    // 修复前（调用点无 await）：Promise 非 null 落入 findRunForTag 被 Array.isArray
    // 守卫归一为 []，全程「无 run」耗尽预算误报 timeout；修复后 await 解包 → null
    // 正确计入查询失败轮 → fetch-error
    expect(v.status).toBe('fetch-error')
    expect(w.sleeps).toBe(2)
  })

  it('【MF-5-2 回归】fetchRuns 返回 Promise<runs>（async 闭包）→ 解包后正常命中 completed', async () => {
    const asyncFetcher = async () => [runItem()]
    const sleeps = []
    const v = await pollRunForTag({ TAG: 'v1.2.3', MAX_POLLS: 3, fetchRuns: asyncFetcher, sleep: async () => { sleeps.push(1) } })
    expect(v.status).toBe('completed')
    expect(v.run.databaseId).toBe(111)
    expect(sleeps.length).toBe(0)
  })
})
