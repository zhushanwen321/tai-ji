/**
 * zcode 会话库路径段常量同源守卫（MF-1-2 收编后形态）。
 *
 * 路径段 SSOT = `@zhushanwen/subagent-engine-sdk` zcode-db-paths.ts（跨侧契约根）：
 * zcode-cli db-path.ts（引擎写侧）与 runtime sqlite-access.ts（import 读侧）import
 * 同一常量，不再是各自重声明的同形字面量。本守卫四层：
 *   ① 权威常量值独立展开断言（期望值逐段写死——SSOT 自身被改错时红）；
 *   ② runtime 侧函数输出与权威常量 join 等价（同源引用的行为面断言）；
 *   ③ 脚本投影文本比对：scripts/zcode-session-db-cleanup.mjs 为纯 ESM（无 TS 构建
 *      链）无法 import SSOT，保留等价 JS 字面量——逐段比对权威常量；
 *   ④ 重声明扫描：契约相关源码树内四段数组字面量只允许出现在 SSOT 与脚本投影
 *      两处（任何包新增重声明即红——取代旧「三处文本互相比对」形态）。
 *
 * 引擎侧（zcode-cli）的值正确性由其自身测试的独立展开断言守卫
 * （zcode-session-db-isolation.test.ts「路径单一来源」节），不在此重复。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { ZCODE_HOST_DB_SUFFIX, ZCODE_ISOLATED_DB_SEGMENTS } from '@zhushanwen/subagent-engine-sdk'

import { hostZcodeDbPath, zcodeIsolatedDbPath } from '@zhushanwen/zcode-session-source'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// ④ 重声明扫描的正则：`[` 锚定的四段数组字面量（引号风格/空白归一）。join 参数
// 形态（测试的独立展开断言）非数组形态，刻意不命中——只拦「重声明常量」回归。
const HOST_ARRAY_RE = /\[\s*['"]\.zcode['"]\s*,\s*['"]cli['"]\s*,\s*['"]db['"]\s*,\s*['"]db\.sqlite['"]/
const ISOLATED_ARRAY_RE = /\[\s*['"]engines['"]\s*,\s*['"]zcode['"]\s*,\s*['"]session-db['"]\s*,\s*['"]db\.sqlite['"]/

/** 从文件文本抽取 `<constName> = [ ... ]` 数组字面量的字符串段（引号/空白归一）。 */
function extractSuffixSegments(file: string, constName: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8')
  const m = text.match(new RegExp(`\\b${constName}\\b\\s*=\\s*\\[([^\\]]*)\\]`))
  if (!m) {
    throw new Error(`${file} 未找到 ${constName} 数组字面量——常量改名或迁移后须同步本守卫`)
  }
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1])
}

/** 从文件文本抽取 `<fnName>` 函数体内首个 `join(...)` 实参的引号段序列（引号/空白归一）。 */
function extractJoinSegments(file: string, fnName: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8')
  const m = text.match(new RegExp(`function ${fnName}\\([^)]*\\)[\\s\\S]*?\\bjoin\\(([^)]*)\\)`))
  if (!m) {
    throw new Error(`${file} 未找到 ${fnName} 的 join 调用——函数改名或迁移后须同步本守卫`)
  }
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1])
}

describe('① 路径段 SSOT（engine-sdk zcode-db-paths）值独立展开断言', () => {
  it('ZCODE_HOST_DB_SUFFIX = ~/.zcode/cli/db/db.sqlite 相对段（期望值逐段写死，SSOT 改错即红）', () => {
    // 逐段断言（不用数组字面量期望值——本文件自身在 ④ 的扫描范围内）
    expect(ZCODE_HOST_DB_SUFFIX.length).toBe(4)
    expect(ZCODE_HOST_DB_SUFFIX[0]).toBe('.zcode')
    expect(ZCODE_HOST_DB_SUFFIX[1]).toBe('cli')
    expect(ZCODE_HOST_DB_SUFFIX[2]).toBe('db')
    expect(ZCODE_HOST_DB_SUFFIX[3]).toBe('db.sqlite')
  })

  it('ZCODE_ISOLATED_DB_SEGMENTS = engines/zcode/session-db/db.sqlite 相对段', () => {
    expect(ZCODE_ISOLATED_DB_SEGMENTS.length).toBe(4)
    expect(ZCODE_ISOLATED_DB_SEGMENTS[0]).toBe('engines')
    expect(ZCODE_ISOLATED_DB_SEGMENTS[1]).toBe('zcode')
    expect(ZCODE_ISOLATED_DB_SEGMENTS[2]).toBe('session-db')
    expect(ZCODE_ISOLATED_DB_SEGMENTS[3]).toBe('db.sqlite')
  })
})

describe('② runtime 侧函数输出与 SSOT 常量 join 等价（同源引用行为面）', () => {
  it('zcodeIsolatedDbPath(dataDir) = join(dataDir, ...ZCODE_ISOLATED_DB_SEGMENTS)', () => {
    expect(zcodeIsolatedDbPath('/data-root')).toBe(join('/data-root', ...ZCODE_ISOLATED_DB_SEGMENTS))
  })

  it('hostZcodeDbPath() = join(homedir(), ...ZCODE_HOST_DB_SUFFIX)', () => {
    expect(hostZcodeDbPath()).toBe(join(homedir(), ...ZCODE_HOST_DB_SUFFIX))
  })
})

describe('③ 脚本投影（zcode-session-db-cleanup.mjs，纯 ESM 无法 import SSOT）文本比对', () => {
  it('HOST_DB_SUFFIX 与 SSOT 逐段一致', () => {
    expect(extractSuffixSegments('scripts/zcode-session-db-cleanup.mjs', 'HOST_DB_SUFFIX')).toEqual([
      ...ZCODE_HOST_DB_SUFFIX,
    ])
  })

  it('zcodeSessionDbPathJs 的 join 段与 SSOT 逐段一致', () => {
    expect(extractJoinSegments('scripts/zcode-session-db-cleanup.mjs', 'zcodeSessionDbPathJs')).toEqual([
      ...ZCODE_ISOLATED_DB_SEGMENTS,
    ])
  })
})

describe('④ 重声明扫描：四段数组字面量只允许 SSOT 与脚本投影两处', () => {
  /** 契约相关源码树（两侧消费面 + 宿主侧大包 + 脚本目录）内扫描四段数组字面量的命中文件。 */
  function scanRedeclarations(): string[] {
    const roots = [
      'packages/runtime/src',
      'packages/runtime/test',
      'packages/zcode-subagent-cli/src',
      'packages/subagent-core/src',
      'packages/subagent-engine-sdk/src',
      'scripts',
    ]
    const exts = new Set(['.ts', '.mts', '.cts', '.mjs'])
    const hits: string[] = []
    const walk = (absDir: string, relDir: string) => {
      let entries: string[]
      try {
        entries = readdirSync(absDir)
      } catch {
        return // 目录不存在（root 集合里某包调整结构时该 root 静默缺席，白名单断言会捕获误配）
      }
      for (const e of entries) {
        if (e === 'node_modules' || e === 'dist' || e === '__snapshots__' || e === 'test-results') continue
        const abs = join(absDir, e)
        const rel = `${relDir}/${e}`
        if (statSync(abs).isDirectory()) {
          walk(abs, rel)
          continue
        }
        if (!exts.has(extname(e)) || e.endsWith('.d.ts')) continue
        const text = readFileSync(abs, 'utf8')
        if (HOST_ARRAY_RE.test(text) || ISOLATED_ARRAY_RE.test(text)) hits.push(rel)
      }
    }
    for (const r of roots) walk(resolve(REPO_ROOT, r), r)
    return hits.sort()
  }

  it('命中集合恰为 [SSOT, 脚本投影]（任何包重声明四段字面量即红）', () => {
    expect(scanRedeclarations()).toEqual([
      'packages/subagent-engine-sdk/src/zcode-db-paths.ts',
      'scripts/zcode-session-db-cleanup.mjs',
    ])
  })
})
