/**
 * 仓库标识（slug）字面量对账：`zhushanwen321/tai-ji` 在脚本域只允许出现在登记的
 * 白名单文件——其余脚本一律从单一来源取值（Node = scripts/merge/lib/repo.mjs 的
 * DEFAULT_REPO；shell = git remote get-url github 一手推导；skill shell =
 * .agents/skills/merge/_lib/repo.sh）。仓库改名/迁移时漏改某处即本测试红，
 * 不再静默指向旧仓库（xyz-agent → tai-ji 改名时 6+ 处逐一找齐的教训）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SLUG = 'zhushanwen321/tai-ji'

/** 带登记理由的白名单：字面量在此是「源头」或「对 runtime 常量的镜像断言」，不是漂移面。 */
const ALLOW = new Set([
  'scripts/merge/lib/repo.mjs', // Node 侧单一来源本体
  '.agents/skills/merge/_lib/repo.sh', // skill shell 侧单一来源本体
  'scripts/verify-plugin-contract.sh', // 镜像断言 runtime 源码常量（plugin-bootstrap 的 issues URL）
  '.agents/skills/verify-taiji/scenarios/p1-plugin-a15-manifest-unreachable.mjs', // 场景 fixture，镜像 runtime 输出
])

const SCAN_DIRS = ['scripts', '.agents/skills']
const SCAN_EXT = /\.(sh|mjs|ts|js)$/

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__pycache__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (SCAN_EXT.test(entry)) yield full
  }
}

describe('repo slug 字面量对账（发现 12）', () => {
  it(`脚本域内 "${SLUG}" 只出现在白名单文件（新字面量 = 改从 repo.mjs / remote 推导取值）`, () => {
    const offenders = []
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file)
        if (rel.endsWith('.test.mjs')) continue // 测试域（含本文件）不扫——期望值与生产同源另有约定
        let text
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        if (text.includes(SLUG) && !ALLOW.has(rel)) offenders.push(rel)
      }
    }
    expect(offenders, `白名单外出现 slug 字面量：${offenders.join(', ')}——改从 scripts/merge/lib/repo.mjs（Node）或 git remote get-url github（shell）取值，或带理由登记进本测试 ALLOW`).toEqual([])
  })

  it('白名单文件自身仍持有 slug（防白名单条目过期成空挂）', () => {
    for (const rel of ALLOW) {
      expect(readFileSync(join(ROOT, rel), 'utf8')).toContain(SLUG)
    }
  })
})
