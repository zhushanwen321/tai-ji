#!/usr/bin/env node
/**
 * run-domain-tests.mjs — 按功能域触发挂载渲染重型测试（round6 Wave2 范围收缩）。
 *
 * 背景：docs/testing/domain-map.json 登记的挂载渲染重型测试文件已移出默认档
 * （pnpm test 不收集不装载，排除机制见 test-guard/domain-exclusions.ts）。
 * 本脚本按域取回清单并触发执行：设置 TAIJI_TEST_DOMAIN（config 据此取消排除）
 * + 给 vitest 传该域的显式文件清单（精确选中，不跑其他域）。
 *
 * 用法：
 *   node scripts/run-domain-tests.mjs <domain>          跑指定域（跨包逐包执行，汇总退出码）
 *   node scripts/run-domain-tests.mjs <domain> --list   只打印将执行的文件清单，不执行
 *   node scripts/run-domain-tests.mjs --domains         列出全部域名与文件数
 *
 * 域清单的唯一权威源 = docs/testing/domain-map.json（本脚本只消费，不持清单）；
 * 表健康度由 scripts/check-domain-map.mjs 机器校验。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const MAP_PATH = path.join(ROOT, 'docs', 'testing', 'domain-map.json')
/** 与 test-guard/domain-exclusions.ts 的 DOMAIN_GATE_ENV 同名（mjs 侧不能 import ts，字面量 + check 脚本对拍）。 */
const DOMAIN_GATE_ENV = 'TAIJI_TEST_DOMAIN'

/** 包前缀 → 包 cwd（相对仓库根）。域内文件按此前缀分组到对应包的 vitest 实例。 */
const PKG_PREFIXES = ['packages/renderer/', 'packages/ui/']

function loadMap() {
  const raw = JSON.parse(readFileSync(MAP_PATH, 'utf-8'))
  const domains = raw?.domains
  if (!domains || typeof domains !== 'object') {
    console.error(`[run-domain-tests] domain-map.json 缺少 domains 对象：${MAP_PATH}`)
    process.exit(1)
  }
  return domains
}

function printHelp() {
  const domains = loadMap()
  console.error('用法: node scripts/run-domain-tests.mjs <domain> [--list]')
  console.error('      node scripts/run-domain-tests.mjs --domains')
  console.error('')
  console.error('可用域（docs/testing/domain-map.json）：')
  for (const [name, entry] of Object.entries(domains)) {
    console.error(`  ${name.padEnd(12)} ${String(entry.files.length).padStart(3)} 文件  ${entry.summary ?? ''}`)
  }
}

function main() {
  const args = process.argv.slice(2)
  const domains = loadMap()

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp()
    process.exit(args.length === 0 ? 1 : 0)
  }
  if (args.includes('--domains')) {
    for (const [name, entry] of Object.entries(domains)) {
      console.log(`${name}\t${entry.files.length}`)
    }
    return
  }

  const domain = args[0]
  const listOnly = args.includes('--list')
  const entry = domains[domain]
  if (!entry) {
    console.error(`[run-domain-tests] 未知域 "${domain}"——可用域见 node scripts/run-domain-tests.mjs --domains`)
    process.exit(1)
  }
  const files = entry.files
  if (!Array.isArray(files) || files.length === 0) {
    console.error(`[run-domain-tests] 域 "${domain}" 文件清单为空（domain-map.json 登记异常，先跑 node scripts/check-domain-map.mjs）`)
    process.exit(1)
  }

  // 按包分组：文件条目以包前缀开头，vitest 在包 cwd 下接收包内相对路径
  const byPkg = new Map()
  for (const file of files) {
    const prefix = PKG_PREFIXES.find((p) => file.startsWith(p))
    if (!prefix) {
      console.error(`[run-domain-tests] 文件 "${file}" 不在任何已知包前缀（${PKG_PREFIXES.join(' / ')}）下——domain-map.json 登记异常`)
      process.exit(1)
    }
    if (!byPkg.has(prefix)) byPkg.set(prefix, [])
    byPkg.get(prefix).push(path.relative(prefix, file))
  }

  if (listOnly) {
    for (const [prefix, pkgFiles] of byPkg) {
      for (const f of pkgFiles) console.log(`${prefix}${f}`)
    }
    return
  }

  let failed = 0
  for (const [prefix, pkgFiles] of byPkg) {
    const pkgDir = prefix.replace(/\/$/, '')
    console.log(`\n[run-domain-tests] 域 "${domain}" · ${pkgDir} · ${pkgFiles.length} 文件`)
    const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...pkgFiles], {
      cwd: path.join(ROOT, pkgDir),
      stdio: 'inherit',
      env: {
        ...process.env,
        // 域触发档：config 据此取消默认档排除，显式文件清单才能被收集
        [DOMAIN_GATE_ENV]: domain,
        // 与默认档同口径（AGENTS.md 测试章：跳过真进程层）
        TAIJI_SKIP_REAL_PI: '1',
      },
    })
    if (result.status !== 0) {
      failed++
      console.error(`[run-domain-tests] ${pkgDir} 退出码 ${result.status}`)
    }
  }

  if (failed > 0) {
    console.error(`\n[run-domain-tests] 域 "${domain}" 完成：${failed}/${byPkg.size} 包失败`)
    process.exit(1)
  }
  console.log(`\n[run-domain-tests] 域 "${domain}" 全绿（${byPkg.size} 包，${files.length} 文件）`)
}

main()
