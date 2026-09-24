import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  assertZcodeDbPathAllowed,
  zcodeDbAllowlistFor,
} from '../discovery/whitelist.js'

// ============================================================
// P-whitelist（design session-reader-shared-core §3.3 D5 / §3.4 检查顺序 / 附录 A）：
// 派生白名单在 taiji dataDir 布局下精确命中隔离库。
//
// 布局（mkdtemp 自建自删）：root/agent = agentDir（dirname = dataDir root），
// root/engines/zcode/session-db/db.sqlite = 隔离库。测试内手拼路径段是**测试对
// 派生正确性的唯一验证手段**（生产 src 禁手拼，段单源 = SDK ZCODE_ISOLATED_DB_
// SEGMENTS 经 zcode-session-source zcodeImportDbAllowlist 引用）。
//
// 检查顺序铁律断言：存在性（不存在 → unreadable）先于路径（集合外 → forbidden）——
// 集合外且不存在的路径必须报 unreadable 而非 forbidden（场景 5 ④ 顺序断言的单元锚）。
// ============================================================

const ISOLATED_DB_SEGMENTS = ['engines', 'zcode', 'session-db', 'db.sqlite']

let root: string
let agentDir: string
let isolatedDbPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zcode-whitelist-test-'))
  agentDir = join(root, 'agent')
  mkdirSync(agentDir, { recursive: true })
  isolatedDbPath = join(root, ...ISOLATED_DB_SEGMENTS)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('zcodeDbAllowlistFor：tmp dataDir 布局精确命中隔离库（P-whitelist）', () => {
  it('第一项 = zcodeIsolatedDbPath(dirname(agentDir))，集合共两项（隔离库 + 宿主库）', () => {
    const allow = zcodeDbAllowlistFor(agentDir)
    expect(allow).toHaveLength(2)
    // 精确命中：手拼段与派生结果逐字节相等（同源常量 + 同一 join 派生式的行为锚）
    expect(allow[0]).toBe(isolatedDbPath)
  })

  it('realpath 对齐：agentDir 经 symlink 到达（macOS /var → /private/var 形态）仍命中', () => {
    // tmpdir 本身在 macOS 即 symlink 链（/var → /private/var）：mkdtemp 产物 realpath
    // 后 ≠ 字面串。允许集合与 dbPath 同经 realpath 归一（whitelist.ts realOf），
    // 两侧一致归一后比对 = 命中。isolatedDbPath 真实存在才有 realpath 归一输入。
    mkdirSync(join(root, ...ISOLATED_DB_SEGMENTS.slice(0, -1)), { recursive: true })
    writeFileSync(isolatedDbPath, '', 'utf8')
    expect(() => assertZcodeDbPathAllowed(isolatedDbPath, agentDir)).not.toThrow()
  })

  it('纯 pi 宿主边界（D5）：agentDir 无对应 dataDir 布局时集合外路径照常拒绝', () => {
    const outside = join(root, 'somewhere-else', 'db.sqlite')
    mkdirSync(join(root, 'somewhere-else'), { recursive: true })
    writeFileSync(outside, '', 'utf8')
    expect(() => assertZcodeDbPathAllowed(outside, agentDir)).toThrow('zcode_db_path_forbidden')
  })
})

describe('assertZcodeDbPathAllowed：检查顺序三段递进（存在性先于路径）', () => {
  it('第 1 段存在性：白名单内路径但文件不存在 → zcode_db_unreadable（不误报 forbidden）', () => {
    expect(() => assertZcodeDbPathAllowed(isolatedDbPath, agentDir)).toThrow(
      'zcode_db_unreadable',
    )
  })

  it('第 1 段先于第 2 段：集合外且文件不存在的路径 → 仍是 unreadable（不是 forbidden）', () => {
    const outsideMissing = join(root, 'nowhere', 'evil.sqlite')
    expect(() => assertZcodeDbPathAllowed(outsideMissing, agentDir)).toThrow(
      'zcode_db_unreadable',
    )
  })

  it('第 2 段路径：存在但集合外 → zcode_db_path_forbidden（安全面错误语义更重）', () => {
    const outside = join(root, 'evil.sqlite')
    writeFileSync(outside, '', 'utf8')
    try {
      assertZcodeDbPathAllowed(outside, agentDir)
      expect.unreachable('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('zcode_db_path_forbidden')
      expect(msg).toContain(outside)
      expect(msg).toContain('👉')
    }
  })

  it('通过闸（集合内且存在）→ 不抛错（开库由调用方进行）', () => {
    mkdirSync(join(root, ...ISOLATED_DB_SEGMENTS.slice(0, -1)), { recursive: true })
    writeFileSync(isolatedDbPath, '', 'utf8')
    expect(() => assertZcodeDbPathAllowed(isolatedDbPath, agentDir)).not.toThrow()
  })

  it('unreadable 指引含动态推导的隔离库路径与 -wal 告诫（§3.4 文案）', () => {
    try {
      assertZcodeDbPathAllowed(isolatedDbPath, agentDir)
      expect.unreachable('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain(isolatedDbPath)
      expect(msg).toContain('-wal')
      expect(msg).toContain('👉')
    }
  })

  it('宿主库第二项 = join(homedir(), SDK 宿主段)（存量兼容锚点，不在本梯队触碰）', () => {
    const allow = zcodeDbAllowlistFor(agentDir)
    // 第二项是 homedir 派生的宿主库（真实 HOME 下的 .zcode/cli/db/db.sqlite 形态）——
    // 测试不触碰真实文件，只断言其位于集合且 ≠ 隔离库项
    expect(allow[1]).not.toBe(allow[0])
    expect(allow[1].startsWith(homedir())).toBe(true)
  })
})
