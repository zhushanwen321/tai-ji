/**
 * zcode 宿主库路径后缀三处字面量一致性守卫（commit 即红，替代「运行时共同暴露」）。
 *
 * `~/.zcode/cli/db/db.sqlite` 后缀 `['.zcode','cli','db','db.sqlite']` 在三处以数组
 * 字面量分层重声明（跨包零 import——分层约束下不允许运行时共享常量）：
 *   ① 权威源：packages/zcode-subagent-cli/src/constants.ts `ZCODE_HOST_DB_SUFFIX`；
 *   ② runtime 投影：sqlite-access.ts `HOST_DB_SUFFIX`（本目录，zcode-import 只读访问）；
 *   ③ 脚本投影：scripts/zcode-session-db-cleanup.mjs `HOST_DB_SUFFIX`（ESM 无 TS 构建链）。
 * 漂移原本要等 zcode 安装布局变更断链时才暴露，且报错形态是误导性的「未安装 zcode」；
 * 本测试文本抽取三处数组字面量逐段比对，把漂移提前为测试即红。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 权威值（宿主 HOME 下 zcode 会话库相对段，`join(os.homedir(), ...suffix)`）。 */
const EXPECTED_SUFFIX = ['.zcode', 'cli', 'db', 'db.sqlite']

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

describe('zcode 宿主库路径后缀三处字面量一致性', () => {
  it('① 权威源 constants.ts ZCODE_HOST_DB_SUFFIX 逐段等于权威值', () => {
    expect(extractSuffixSegments('packages/zcode-subagent-cli/src/constants.ts', 'ZCODE_HOST_DB_SUFFIX')).toEqual(
      EXPECTED_SUFFIX,
    )
  })

  it('② runtime sqlite-access.ts HOST_DB_SUFFIX 与权威源一致', () => {
    expect(
      extractSuffixSegments('packages/runtime/src/services/session/zcode-import/sqlite-access.ts', 'HOST_DB_SUFFIX'),
    ).toEqual(EXPECTED_SUFFIX)
  })

  it('③ scripts/zcode-session-db-cleanup.mjs HOST_DB_SUFFIX 与权威源一致', () => {
    expect(extractSuffixSegments('scripts/zcode-session-db-cleanup.mjs', 'HOST_DB_SUFFIX')).toEqual(EXPECTED_SUFFIX)
  })
})

/** 隔离库相对段（`<dataDir>/engines/zcode/session-db/db.sqlite`，引擎包与 runtime 各自 join）。 */
const EXPECTED_ISOLATED_SEGMENTS = ['engines', 'zcode', 'session-db', 'db.sqlite']

describe('zcode 隔离库路径段两处字面量一致性', () => {
  it('引擎包 db-path.ts zcodeSessionDbPath 与权威段一致', () => {
    expect(
      extractJoinSegments('packages/zcode-subagent-cli/src/db-path.ts', 'zcodeSessionDbPath'),
    ).toEqual(EXPECTED_ISOLATED_SEGMENTS)
  })

  it('runtime sqlite-access.ts zcodeIsolatedDbPath 与权威段一致', () => {
    expect(
      extractJoinSegments('packages/runtime/src/services/session/zcode-import/sqlite-access.ts', 'zcodeIsolatedDbPath'),
    ).toEqual(EXPECTED_ISOLATED_SEGMENTS)
  })
})
