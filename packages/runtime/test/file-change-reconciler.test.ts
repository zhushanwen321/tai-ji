/**
 * file-change-reconciler 单测（ADR-0024 D5：file_changes diff 引擎；W18 纯函数化）。
 *
 * 覆盖纯函数：parseGitStatusPorcelain / xyToStatus / diffSnapshots（单参数，R-09）/
 * computeLineCounts（numstat 注入纯函数，D4-5）。
 * numstat 解析已统一到 shared parseNumstatEntries（lossless SSOT），单测见 git-status-parser.test.ts。
 * 采集（status/numstat）已收进 GitStateService（W18），不在本模块——源码零子进程有测试锁定。
 *
 * 运行：npx vitest run test/file-change-reconciler.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FileChange, FileChangeStatus } from '@taiji/shared'
import {
  parseGitStatusPorcelain,
  xyToStatus,
  diffSnapshots,
  computeLineCounts,
} from '../src/infra/pi/file-change-reconciler.js'
import type { NumstatEntry } from '../src/infra/git/git-status-parser.js'

describe('file-change-reconciler', () => {
  describe('parseGitStatusPorcelain', () => {
    it('解析标准 A/M/D/?? 条目', () => {
      const output = [
        'A  src/new.ts',
        ' M src/modified.ts',
        'D  src/deleted.ts',
        '?? src/untracked.ts',
      ].join('\n')
      const entries = parseGitStatusPorcelain(output)
      expect(entries).toHaveLength(4)
      expect(entries[0]).toEqual({ xy: 'A ', path: 'src/new.ts' })
      expect(entries[1]).toEqual({ xy: ' M', path: 'src/modified.ts' })
      expect(entries[2]).toEqual({ xy: 'D ', path: 'src/deleted.ts' })
      expect(entries[3]).toEqual({ xy: '??', path: 'src/untracked.ts' })
    })

    it('解析重命名条目（取目标路径）', () => {
      const entries = parseGitStatusPorcelain('R  src/old.ts -> src/new.ts')
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual({ xy: 'R ', path: 'src/new.ts' })
    })

    it('空输出返回空数组', () => {
      expect(parseGitStatusPorcelain('')).toEqual([])
    })
  })

  describe('xyToStatus', () => {
    it('未跟踪 ?? → added', () => {
      expect(xyToStatus('??')).toBe('added')
    })
    it('新增 A → added', () => {
      expect(xyToStatus('A ')).toBe('added')
    })
    it('修改 M（staged/working）→ modified', () => {
      expect(xyToStatus('M ')).toBe('modified')
      expect(xyToStatus(' M')).toBe('modified')
    })
    it('删除 D（staged/working）→ deleted', () => {
      expect(xyToStatus('D ')).toBe('deleted')
      expect(xyToStatus(' D')).toBe('deleted')
    })
    it('重命名/拷贝 R/C → modified（目标路径）', () => {
      expect(xyToStatus('R ')).toBe('modified')
      expect(xyToStatus('C ')).toBe('modified')
    })
  })

  describe('diffSnapshots（W18 R-09：单参数，current 全集即变更清单）', () => {
    /** 辅助：构造快照（filePath → status） */
    const snap = (entries: Record<string, FileChangeStatus>) => new Map(Object.entries(entries))

    it('current 全集即变更清单（含 turn 前已 dirty 的文件也报告）', () => {
      // [HISTORICAL] dirty 漏报修复后输出只依赖 current——turn 开始前已 dirty 的文件照常报告，
      // 否则 pi 再改这些文件时 git status 仍是 modified → 漏报 → 变更集卡不显示。
      const current = snap({ 'src/a.ts': 'modified', 'src/b.ts': 'added', 'src/new.ts': 'added' })
      const changes = diffSnapshots(current)
      expect(changes).toHaveLength(3)
      const byPath = new Map(changes.map((c) => [c.filePath, c.status]))
      expect(byPath.get('src/a.ts')).toBe('modified')
      expect(byPath.get('src/b.ts')).toBe('added')
      expect(byPath.get('src/new.ts')).toBe('added')
    })

    it('current 为 null（非仓库/采集失败）→ 空数组', () => {
      expect(diffSnapshots(null)).toEqual([])
    })

    it('current 为空快照 → 空数组（无变更不推帧）', () => {
      expect(diffSnapshots(snap({}))).toEqual([])
    })

    it('R-09 死参数验证：输出形状只含 filePath/status，全集即清单（若恢复差集语义此测试提醒行为变化）', () => {
      // R-09 删除 baseline 的依据是「baseline 对输出零影响、current 全集即变更清单」。
      // 锁定输出形状与全集语义（W18 review：原断言 diffSnapshots(current) 自比较恒真，改为
      // 有实值的形状断言）；未来若有人恢复差集语义（baseline 有 current 无 → 排除），
      // 'gone-from-nowhere.ts'（仅 current 有）会从输出消失，此测试报警。
      const current = snap({ 'keep.ts': 'modified', 'gone-from-nowhere.ts': 'added' })
      expect(diffSnapshots(current)).toEqual([
        { filePath: 'keep.ts', status: 'modified' },
        { filePath: 'gone-from-nowhere.ts', status: 'added' },
      ])
    })
  })

  describe('computeLineCounts（W18 D4-5：numstat 注入纯函数）', () => {
    /** 构造 numstat 条目 */
    const ns = (path: string, add?: number, del?: number): NumstatEntry => ({ path, add, del })
    /** 构造待填充的 FileChange（FileChange[] 注解使 addLines/delLines 可选属性可写可断言） */
    const ch = (filePath: string, status: FileChange['status']): FileChange => ({ filePath, status })

    it('numstatMap 命中：填充 addLines/delLines', () => {
      const changes: FileChange[] = [ch('a.ts', 'modified'), ch('b.ts', 'added')]
      computeLineCounts(changes, new Map([['a.ts', ns('a.ts', 10, 2)], ['b.ts', ns('b.ts', 3, undefined)]]))
      expect(changes[0].addLines).toBe(10)
      expect(changes[0].delLines).toBe(2)
      expect(changes[1].addLines).toBe(3)
      expect(changes[1].delLines).toBeUndefined() // 二进制/缺失列不覆盖
    })

    it('numstatMap 为 null（采集失败）→ 行数靠 writeContents 回退（现状降级语义）', () => {
      const changes: FileChange[] = [ch('untracked.ts', 'added')]
      computeLineCounts(changes, null, new Map([['untracked.ts', 'line1\nline2\nline3']]))
      expect(changes[0].addLines).toBe(3)
    })

    it('numstatMap 缺项 + writeContents 命中 → untracked 文件从 content 分行计数', () => {
      const changes: FileChange[] = [ch('new.ts', 'added')]
      computeLineCounts(changes, new Map(), new Map([['new.ts', 'a\nb']]))
      expect(changes[0].addLines).toBe(2)
    })

    it('numstatMap 缺项 + writeContents 缺项/空串 → 行数保持 undefined（bash 建的 untracked 无行数）', () => {
      const changes: FileChange[] = [ch('bash-made.ts', 'added'), ch('empty.ts', 'added')]
      computeLineCounts(changes, new Map(), new Map([['empty.ts', '']]))
      expect(changes[0].addLines).toBeUndefined()
      expect(changes[1].addLines).toBeUndefined()
    })

    it('numstatMap 命中优先于 writeContents（已跟踪文件不读 content）', () => {
      const changes: FileChange[] = [ch('tracked.ts', 'modified')]
      computeLineCounts(
        changes,
        new Map([['tracked.ts', ns('tracked.ts', 7, 1)]]),
        new Map([['tracked.ts', 'x\ny\nz\nw\nv\nu\nt\ns\nr\nq']]),
      )
      expect(changes[0].addLines).toBe(7)
      expect(changes[0].delLines).toBe(1)
    })

    it('空 changes → no-op（不触碰任何输入）', () => {
      const changes: FileChange[] = []
      expect(() => computeLineCounts(changes, null)).not.toThrow()
    })

    it('纯函数性：同输入同输出（D4-5 验收——签名不含 cwd，numstat 结果注入）', () => {
      // 同输入两次调用结果 deepEqual（纯函数断言）
      const first: FileChange[] = [ch('a.ts', 'modified')]
      const second: FileChange[] = [ch('a.ts', 'modified')]
      const numstatMap = new Map([['a.ts', ns('a.ts', 5, 4)]])
      computeLineCounts(first, numstatMap)
      computeLineCounts(second, numstatMap)
      expect(first).toEqual(second)
    })
  })

  describe('源码零同步子进程（W18 主线程零同步 git 验收）', () => {
    // W18 review 扩范围：热路径 3 文件——采集/纯函数层（reconciler）+ 编排层（interpreter，
    // sendDiffFileChanges 链上采集点）+ port 适配层（diff-adapter，委托 GitStateService）。
    // 任何一处回流 execSync/execFileSync 都会在 streaming 期间阻塞事件循环（所有 session
    // 的 token 流排队等待）。
    const HOT_PATH_SOURCES = [
      '../src/infra/pi/file-change-reconciler.ts',
      '../src/services/session/event-interpreter.ts',
      '../src/infra/pi/file-change-diff-adapter.ts',
    ]

    it.each(HOT_PATH_SOURCES)('%s 不含 child_process import 与 execSync/execFileSync 调用（采集已收进 GitStateService 异步路径）', (rel) => {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      // 断言 import 与调用形态（注释中的历史说明不误伤）
      expect(source).not.toMatch(/from\s+'node:child_process'/)
      expect(source).not.toMatch(/\bexecSync\s*\(/)
      expect(source).not.toMatch(/\bexecFileSync\s*\(/)
    })
  })
})
