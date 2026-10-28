#!/usr/bin/env node
/**
 * 测试文件合并/迁移前后的 JUnit 用例多重集对拍。
 *
 * 默认按「包路径 + classname + 完整测试名」逐项守恒。
 * --allow-relocation：允许 classname/包路径变化，仍要求完整测试名一致。
 * --allow-describe-prefix：额外允许 current = 一个新外层 describe + " > " + baseline；
 *   只做无歧义一对一配对，其余改名仍报 missing/extra。
 *
 * 用法：
 *   node scripts/check-test-junit-parity.mjs --baseline <目录|xml> --current <目录|xml> \
 *     [--allow-relocation] [--allow-describe-prefix]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    console.error(`[junit-parity] ${name} 需要目录或 XML 文件参数`)
    process.exit(2)
  }
  return path.resolve(value)
}

const baselineRoot = option('--baseline')
const currentRoot = option('--current')
if (!baselineRoot || !currentRoot) {
  console.error('[junit-parity] 必须同时提供 --baseline 与 --current；先保存修改前 JUnit，再跑修改后同范围测试')
  process.exit(2)
}
const allowRelocation = args.includes('--allow-relocation')
const allowDescribePrefix = args.includes('--allow-describe-prefix')

function decodeXml(value) {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|lt|gt|quot|apos|amp);/gi, (entity, decimal, hex) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    return { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }[entity.toLowerCase()]
  })
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))
  return match ? decodeXml(match[1]) : ''
}

function xmlFiles(root) {
  const stat = statSync(root)
  if (stat.isFile()) return root.endsWith('.xml') ? [root] : []
  const files = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...xmlFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.xml')) files.push(full)
  }
  return files.sort()
}

function packageKey(root, file) {
  if (statSync(root).isFile()) return ''
  const parts = path.relative(root, file).split(path.sep)
  const marker = parts.lastIndexOf('test-results')
  return marker >= 0 ? parts.slice(0, marker).join('/') : ''
}

function loadCases(root) {
  const files = xmlFiles(root)
  if (files.length === 0) throw new Error(`未找到 XML：${root}`)
  const cases = []
  for (const file of files) {
    const pkg = packageKey(root, file)
    const xml = readFileSync(file, 'utf8')
    for (const match of xml.matchAll(/<testcase\b[^>]*>/g)) {
      const tag = match[0]
      cases.push({
        pkg,
        classname: attribute(tag, 'classname'),
        name: attribute(tag, 'name'),
        file,
      })
    }
  }
  if (cases.length === 0) throw new Error(`XML 中没有 testcase：${root}`)
  return cases
}

function locationOf(testCase) {
  return allowRelocation ? '' : `${testCase.pkg}\0${testCase.classname}`
}

function identityOf(testCase) {
  return `${locationOf(testCase)}\0${testCase.name}`
}

function display(testCase) {
  const location = [testCase.pkg, testCase.classname].filter(Boolean).join('/')
  return `${location} :: ${testCase.name}`
}

function hasSingleDescribePrefix(before, after) {
  const suffix = ` > ${before}`
  if (!after.endsWith(suffix)) return false
  const prefix = after.slice(0, -suffix.length)
  return prefix.length > 0 && !prefix.includes(' > ')
}

function subtract(baseline, current) {
  const remainingCurrent = new Set(current.map((_, index) => index))
  const remainingBaseline = new Set()
  const byIdentity = new Map()
  current.forEach((testCase, index) => {
    const identity = identityOf(testCase)
    if (!byIdentity.has(identity)) byIdentity.set(identity, [])
    byIdentity.get(identity).push(index)
  })

  let exactMatches = 0
  baseline.forEach((testCase, baselineIndex) => {
    const candidates = byIdentity.get(identityOf(testCase)) ?? []
    const currentIndex = candidates.find((index) => remainingCurrent.has(index))
    if (currentIndex === undefined) {
      remainingBaseline.add(baselineIndex)
      return
    }
    remainingCurrent.delete(currentIndex)
    exactMatches++
  })

  let prefixMatches = 0
  if (allowDescribePrefix) {
    let progressed = true
    while (progressed) {
      progressed = false
      const candidatesByBaseline = new Map()
      const baselinesByCurrent = new Map()
      for (const baselineIndex of remainingBaseline) {
        const before = baseline[baselineIndex]
        const candidates = []
        for (const currentIndex of remainingCurrent) {
          const after = current[currentIndex]
          if (locationOf(after) === locationOf(before) && hasSingleDescribePrefix(before.name, after.name)) {
            candidates.push(currentIndex)
            if (!baselinesByCurrent.has(currentIndex)) baselinesByCurrent.set(currentIndex, [])
            baselinesByCurrent.get(currentIndex).push(baselineIndex)
          }
        }
        candidatesByBaseline.set(baselineIndex, candidates)
      }
      for (const [baselineIndex, candidates] of candidatesByBaseline) {
        if (candidates.length !== 1) continue
        const currentIndex = candidates[0]
        if (baselinesByCurrent.get(currentIndex)?.length !== 1) continue
        remainingBaseline.delete(baselineIndex)
        remainingCurrent.delete(currentIndex)
        prefixMatches++
        progressed = true
      }
    }
  }

  return { remainingBaseline, remainingCurrent, exactMatches, prefixMatches }
}

let baseline
let current
try {
  baseline = loadCases(baselineRoot)
  current = loadCases(currentRoot)
} catch (error) {
  console.error(`[junit-parity] ${error.message}`)
  process.exit(2)
}

const result = subtract(baseline, current)
const missing = [...result.remainingBaseline]
const extra = [...result.remainingCurrent]
console.log(
  `[junit-parity] baseline=${baseline.length} current=${current.length} exact=${result.exactMatches} describe-prefix=${result.prefixMatches} missing=${missing.length} extra=${extra.length}`,
)

for (const [label, cases, records] of [
  ['MISSING', missing, baseline],
  ['EXTRA', extra, current],
]) {
  for (const index of cases.slice(0, 50)) console.error(`  ${label} ${display(records[index])}`)
  if (cases.length > 50) console.error(`  ${label} ... 其余 ${cases.length - 50} 条省略`)
}

if (missing.length > 0 || extra.length > 0) {
  console.error('[junit-parity] 用例多重集不守恒。文件迁移须显式加 --allow-relocation；新增外层 describe 须再加 --allow-describe-prefix；其他改名请恢复原测试名。')
  process.exit(1)
}
console.log('[junit-parity] OK：用例多重集守恒')
