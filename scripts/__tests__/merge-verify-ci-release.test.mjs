/**
 * verify-ci-release.mjs 的纯函数层（argv 解析 / run 匹配 / 产物完整性判定）。
 *
 * 覆盖对应原 bash verify-ci-release.sh 的 jq 匹配段与 grep 产物校验段的等价固化；
 * 等待循环编排（轮询/超时）为 gh 只读调用的 IO 编排，不在纯函数层测。
 */
import { describe, it, expect } from 'vitest'
import { parseArgs, findRunForTag, assetCompleteness } from '../merge/verify-ci-release.mjs'

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
