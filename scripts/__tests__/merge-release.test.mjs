/**
 * release.mjs 的纯函数层：CLI 解析 / conventional commit 分组 / 双语 notes 模板 /
 * 覆盖保护判定。
 *
 * 模板期望串逐字节手写（对齐原 bash release.sh 109-160 / 167-185 行的 echo 序列），
 * 不从实现拼装——notes 模板「逐字节保真」是本移植的最高验收项。
 */
import { describe, it, expect } from 'vitest'
import {
  parseArgs,
  parseCommitGroups,
  buildBilingualNotes,
  buildPrTitleFallbackNotes,
  notesFinalized,
} from '../merge/release.mjs'

const REPO_URL = 'https://github.com/zhushanwen321/tai-ji'

/** 手写行序列 → 落盘字节串（bash echo 逐行输出：每行一个换行，串尾恒以 \n 结束）。 */
const md = (lines) => `${lines.join('\n')}\n`

describe('parseArgs（argv 解析）', () => {
  it('tag + --notes 全解析', () => {
    expect(parseArgs(['v1.2.3', '--notes', '/tmp/notes.md'])).toEqual({ ok: true, tag: 'v1.2.3', notesFile: '/tmp/notes.md' })
  })

  it('两者均可缺省（tag 缺省读 package.json、notes 缺省自动生成，由主流程负责）', () => {
    expect(parseArgs([])).toEqual({ ok: true, tag: '', notesFile: '' })
    expect(parseArgs(['--notes', 'n.md'])).toEqual({ ok: true, tag: '', notesFile: 'n.md' })
    expect(parseArgs(['v1.2.3'])).toEqual({ ok: true, tag: 'v1.2.3', notesFile: '' })
  })

  it('未知选项报错', () => {
    const v = parseArgs(['v1.2.3', '--bogus'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Unknown option: --bogus')
  })

  it('多余位置参数报错（移植规格收紧：原 bash 静默忽略）', () => {
    const v = parseArgs(['v1.2.3', 'v1.2.4'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Unknown option: v1.2.4')
  })

  it('--notes 缺值报错', () => {
    const v = parseArgs(['v1.2.3', '--notes'])
    expect(v.ok).toBe(false)
    expect(v.error).toBe('Missing value for option: --notes')
  })
})

describe('parseCommitGroups（conventional commit 分组）', () => {
  it('四类前缀 + scope 形态分组，其余行忽略', () => {
    expect(
      parseCommitGroups([
        'feat(canvas): 生长人机共编论证图',
        'fix: 修复会话切换竞态',
        'fix(runtime): 修复 WS 重连丢消息',
        'perf: 优化消息流渲染',
        'breaking(api): 删除旧版接口',
        'chore: bump version',
        'docs: 更新文档',
        'refactor: 整理目录',
        'test: 补测试',
        'Merge pull request #45 from zhushanwen321/fix-x',
      ]),
    ).toEqual({
      features: ['生长人机共编论证图'],
      fixes: ['修复会话切换竞态', '修复 WS 重连丢消息'],
      perfs: ['优化消息流渲染'],
      breaking: ['删除旧版接口'],
    })
  })

  it('条目文本 = 第一个 ": " 之后的剩余部分（对齐 bash ${line#*: } 最短前缀剥除）', () => {
    expect(parseCommitGroups(['feat: add x: y', 'feat(scope): a: b'])).toEqual({
      features: ['add x: y', 'a: b'],
      fixes: [],
      perfs: [],
      breaking: [],
    })
  })

  it('规范前缀但无 ": " 的行整行入组（bash 剥除无匹配时回退整行）', () => {
    expect(parseCommitGroups(['feat:'])).toEqual({ features: ['feat:'], fixes: [], perfs: [], breaking: [] })
  })

  it('空输入 → 四组全空', () => {
    expect(parseCommitGroups([])).toEqual({ features: [], fixes: [], perfs: [], breaking: [] })
  })
})

describe('buildBilingualNotes（双语 notes 模板，逐字节断言）', () => {
  it('全组 + lastTag（en/zh 两段各节次序与段间空行保真）', () => {
    const groups = {
      features: ['新增 provider 用量统计面板', '支持 worktree 并行验收'],
      fixes: ['修复会话切换竞态'],
      perfs: ['优化消息流渲染'],
      breaking: ['移除旧版 config 字段'],
    }
    expect(buildBilingualNotes({ groups, lastTag: 'v0.6.4', tag: 'v0.6.5', repoUrl: REPO_URL })).toBe(
      md([
        '<!-- LANG:en -->',
        '## Breaking Changes',
        '  - 移除旧版 config 字段',
        '',
        '## New Features',
        '  - 新增 provider 用量统计面板',
        '  - 支持 worktree 并行验收',
        '',
        '## Improvements',
        '  - 优化消息流渲染',
        '',
        '## Bug Fixes',
        '  - 修复会话切换竞态',
        '',
        '**Full Changelog**: https://github.com/zhushanwen321/tai-ji/compare/v0.6.4...v0.6.5',
        '',
        '<!-- LANG:zh -->',
        '## 重大变更',
        '  - 移除旧版 config 字段',
        '',
        '## 新增功能',
        '  - 新增 provider 用量统计面板',
        '  - 支持 worktree 并行验收',
        '',
        '## 功能优化',
        '  - 优化消息流渲染',
        '',
        '## 修复缺陷',
        '  - 修复会话切换竞态',
        '',
        '**完整变更**: https://github.com/zhushanwen321/tai-ji/compare/v0.6.4...v0.6.5',
        '',
      ]),
    )
  })

  it('只有 features（节尾空行与 Changelog 的相对位置保真）', () => {
    const groups = { features: ['新增 xx'], fixes: [], perfs: [], breaking: [] }
    expect(buildBilingualNotes({ groups, lastTag: 'v0.6.4', tag: 'v0.6.5', repoUrl: REPO_URL })).toBe(
      md([
        '<!-- LANG:en -->',
        '## New Features',
        '  - 新增 xx',
        '',
        '**Full Changelog**: https://github.com/zhushanwen321/tai-ji/compare/v0.6.4...v0.6.5',
        '',
        '<!-- LANG:zh -->',
        '## 新增功能',
        '  - 新增 xx',
        '',
        '**完整变更**: https://github.com/zhushanwen321/tai-ji/compare/v0.6.4...v0.6.5',
        '',
      ]),
    )
  })

  it('全空组 + lastTag（只有 Changelog 行，wc -l = 6 不触发 PR 标题兜底）', () => {
    const groups = { features: [], fixes: [], perfs: [], breaking: [] }
    const notes = buildBilingualNotes({ groups, lastTag: 'v0.6.4', tag: 'v0.6.5', repoUrl: REPO_URL })
    expect(notes).toBe(
      md([
        '<!-- LANG:en -->',
        '**Full Changelog**: https://github.com/zhushanwen321/tai-ji/compare/v0.6.4...v0.6.5',
        '',
        '<!-- LANG:zh -->',
        '**完整变更**: https://github.com/zhushanwen321/tai-ji/compare/v0.6.4...v0.6.5',
        '',
      ]),
    )
    expect(notes.split('\n').length - 1).toBe(6)
  })

  it('全空组 + 无 lastTag（两行标记，wc -l = 2 触发 PR 标题兜底的形态）', () => {
    const groups = { features: [], fixes: [], perfs: [], breaking: [] }
    const notes = buildBilingualNotes({ groups, lastTag: '', tag: 'v0.6.5', repoUrl: REPO_URL })
    expect(notes).toBe('<!-- LANG:en -->\n<!-- LANG:zh -->\n')
    expect(notes.split('\n').length - 1).toBe(2)
  })
})

describe('buildPrTitleFallbackNotes（PR 标题兜底模板，逐字节断言）', () => {
  it('含 lastTag', () => {
    expect(
      buildPrTitleFallbackNotes({ prTitle: 'Merge PR #45: fix session race', lastTag: 'v0.6.4', tag: 'v0.6.5', repoUrl: REPO_URL }),
    ).toBe(
      md([
        '<!-- LANG:en -->',
        '## New Features',
        '',
        '- Merge PR #45: fix session race',
        '',
        '**Full Changelog**: https://github.com/zhushanwen321/tai-ji/compare/v0.6.4...v0.6.5',
        '',
        '<!-- LANG:zh -->',
        '## 新增功能',
        '',
        '- Merge PR #45: fix session race',
        '',
        '**完整变更**: https://github.com/zhushanwen321/tai-ji/compare/v0.6.4...v0.6.5',
      ]),
    )
  })

  it('不含 lastTag（串尾无 Changelog 也无多余空行）', () => {
    expect(buildPrTitleFallbackNotes({ prTitle: 'Init', lastTag: '', tag: 'v0.1.0', repoUrl: REPO_URL })).toBe(
      md([
        '<!-- LANG:en -->',
        '## New Features',
        '',
        '- Init',
        '',
        '<!-- LANG:zh -->',
        '## 新增功能',
        '',
        '- Init',
      ]),
    )
  })
})

describe('notesFinalized（覆盖保护判定）', () => {
  const finalizedBody = '<!-- LANG:en -->\n## New Features\n- 双语定稿\n\n<!-- LANG:zh -->\n## 新增功能\n- 双语定稿'
  const legacyBody = '## v0.6.5\n\n- 旧版单语 notes（无语言标记）'

  it('truth table：draft × 含/不含 <!-- LANG: 标记', () => {
    expect(notesFinalized(finalizedBody, false)).toBe(true)
    expect(notesFinalized(finalizedBody, true)).toBe(false)
    expect(notesFinalized(legacyBody, false)).toBe(false)
    expect(notesFinalized(legacyBody, true)).toBe(false)
  })

  it('body 缺失（null/undefined）按未定稿处理', () => {
    expect(notesFinalized(null, false)).toBe(false)
    expect(notesFinalized(undefined, false)).toBe(false)
  })
})
