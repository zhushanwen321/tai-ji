#!/usr/bin/env node
/**
 * check-domain-slices.mjs — docs/testing/domain-slices/ 切片注册表的机器自校验（Wave4）。
 *
 * 注册表 = 功能域垂直切片 SSOT（每域一个 JSON，登记即归属），三方消费：
 * select-affected-domain.mjs（选择/门禁/广播）、run-domain-tests.mjs（域执行清单）、
 * 本脚本（健康度）。与 domain-map.json（挂载重型排除 SSOT，W2-B 冻结）的一致性由
 * 本脚本交叉核对，不靠人记。本脚本同时导出 expandTestGlobs / readRegistry 纯函数
 * 供 run-domain-tests.mjs（展开同一份语义）与单测消费。
 *
 * 检查项：
 *   1. 结构：name 必须等于文件名去 .json；summary 非空；tests 为字符串数组；
 *      scope/sharedBy/contracts/e2eRules/layers 类型合法（layers 为 advisory 字段不设词表）
 *   2. 存在性：tests glob 展开必须是真实测试文件（.test.ts/.test.tsx/.spec.ts/.test.mjs），
 *      死 glob（零命中）/ 指向不存在文件 = 红；scope 路径（前缀目录或精确文件）必须在盘
 *   3. 唯一归属：同一测试文件出现在两个域的 tests 展开 = 红（owner 唯一）
 *   4. W2-B 交叉核对：domain-map.json 每域的每个 files 条目 ⊆ 同名切片域 tests 展开
 *      （tests 为空 = pending 骨架，核对挂起；status=enforced 即强制；声明与 tests 空非空
 *      不一致 = 红）；非 W2-B 域携带 w2bMountCompat = 红
 *   5. sharedBy：键必须是 owner 域 tests 展开中的真实测试文件；注记域名必须存在
 *   6. contracts：carrier 必须被本域 scope 覆盖（契约载体属本域触发范围）；on 域必须存在
 *   7. e2eRules：引用的 rule id 必须存在于 docs/testing/e2e-map.json
 *   8. uncategorized 纪律：只允许精确路径清单（禁 /** glob）；_meta.uncategorizedBaseline
 *      为数字时展开数 ≤ 基线（棘轮只降不升）
 *   9. 覆盖完备（coverageEnforced=true 时硬验收）：watched roots 内测试文件全部被
 *      某域/池覆盖，未覆盖清单非空 = 红（批 D 启用）
 *
 * 用法：
 *   node scripts/check-domain-slices.mjs               # 健康度校验（默认仓库根）
 *   node scripts/check-domain-slices.mjs --stats       # 追加全域统计（每域文件数/包分布/互斥/W2-B 进度）
 *   node scripts/check-domain-slices.mjs --uncovered   # 追加未覆盖测试文件完整清单（批 D 登记 uncategorized 的工作清单）
 *   node scripts/check-domain-slices.mjs --root <dir>  # 校验指定根下的注册表（夹具单测用）
 *
 * 退出码：0 通过 / 1 检出违规 / 2 环境错误（注册表/e2e-map 缺失）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path, { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

/** 测试文件后缀（实盘口径：.test.ts 1378 / .spec.ts 3 / .test.mjs，含近邻 .test.tsx 防漏）。 */
const TEST_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts', '.test.mjs']
/** 展开遍历时跳过的目录（依赖产物/构建产物，非测试归属对象）。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.pnpm', 'coverage', '.turbo'])
/** W2-B 挂载排除表（冻结）与本注册表的交叉核对对象。 */
const DOMAIN_MAP_REL = 'docs/testing/domain-map.json'
const E2E_MAP_REL = 'docs/testing/e2e-map.json'

// ---------- 纯函数（run-domain-tests.mjs 与 scripts/__tests__ 消费） ----------

/** glob 匹配：'<prefix>/**' → startsWith(prefix/) 或全等 prefix；精确路径 → 全等。 */
export function globCovers(globList, file) {
  return (globList ?? []).some((s) => {
    if (s.endsWith('/**')) return file.startsWith(s.slice(0, -3) + '/') || file === s.slice(0, -3)
    return s === file
  })
}

const isTestFile = (f) => TEST_SUFFIXES.some((s) => f.endsWith(s))

function walkTests(absDir, relPrefix, out) {
  for (const name of readdirSync(absDir)) {
    const abs = path.join(absDir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    const rel = relPrefix ? `${relPrefix}/${name}` : name
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walkTests(abs, rel, out)
    } else if (st.isFile() && isTestFile(rel)) {
      out.push(rel)
    }
  }
}

/**
 * 展开 tests glob 为真实测试文件清单（posix 相对 root）。
 * 返回 { files: 排序后的文件数组, problems: 违规描述数组 }——problems 非空即登记漂移
 * （死 glob / 精确路径不存在 / 精确路径不是测试文件）。run-domain-tests 对 problems 直接报错退出。
 */
export function expandTestGlobs(root, globs) {
  const files = new Set()
  const problems = []
  for (const entry of globs) {
    if (entry.endsWith('/**')) {
      const prefix = entry.slice(0, -3) // 含末尾 '/'
      const abs = path.join(root, prefix)
      if (!existsSync(abs)) {
        problems.push(`glob "${entry}" 前缀目录不在盘上`)
        continue
      }
      const out = []
      walkTests(abs, prefix.replace(/\/$/, ''), out)
      if (out.length === 0) {
        problems.push(`glob "${entry}" 零命中（目录下没有任何测试文件）`)
        continue
      }
      for (const f of out) files.add(f)
    } else if (!existsSync(path.join(root, entry))) {
      problems.push(`精确路径 "${entry}" 不在盘上`)
    } else if (!isTestFile(entry)) {
      problems.push(`精确路径 "${entry}" 不是测试文件（${TEST_SUFFIXES.join(' / ')}）`)
    } else {
      files.add(entry)
    }
  }
  return { files: [...files].sort(), problems }
}

/**
 * 读取注册表目录：<domain>.json 全量 + _meta.json。
 * 只做逐文件 JSON 解析与最小防御（对象形态），域内字段校验归 validateSlices（main 内联）。
 */
export function readRegistry(registryDir) {
  if (!existsSync(registryDir)) {
    return { slices: [], byName: new Map(), meta: null, errors: [`注册表目录不存在：${registryDir}`] }
  }
  const slices = []
  const errors = []
  let meta = null
  for (const name of readdirSync(registryDir).sort()) {
    if (!name.endsWith('.json')) continue
    const p = path.join(registryDir, name)
    let doc
    try {
      doc = JSON.parse(readFileSync(p, 'utf-8'))
    } catch (err) {
      errors.push(`${name}：JSON 解析失败（${err.message}）`)
      continue
    }
    if (name === '_meta.json') {
      meta = doc
      continue
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      errors.push(`${name}：域条目必须是对象`)
      continue
    }
    slices.push(doc)
  }
  const byName = new Map(slices.map((s) => [s.name, s]))
  return { slices, byName, meta, errors }
}

/** watched roots 推导（与 select-affected-domain.mjs 同款目录结构口径，覆盖完备性的全集来源）。 */
function watchedRoots(root) {
  const roots = []
  const isDir = (p) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const pkgs = path.join(root, 'packages')
  if (isDir(pkgs)) {
    for (const name of readdirSync(pkgs)) if (isDir(path.join(pkgs, name, 'src'))) roots.push(`packages/${name}/src/`)
    if (isDir(path.join(pkgs, 'runtime', 'test'))) roots.push('packages/runtime/test/')
  }
  const apps = path.join(root, 'apps')
  if (isDir(apps)) {
    for (const name of readdirSync(apps)) if (isDir(path.join(apps, name, 'main'))) roots.push(`apps/${name}/main/`)
  }
  for (const group of ['universal', 'taiji', 'shared']) {
    const groupDir = path.join(root, 'extensions', group)
    if (!isDir(groupDir)) continue
    for (const name of readdirSync(groupDir)) {
      if (isDir(join(groupDir, name, 'src'))) roots.push(`extensions/${group}/${name}/src/`)
    }
  }
  return roots.sort()
}

/** 包归属分组（stats 与 uncovered 计数用）：packages/<p> / apps/<a> / extensions/<g>/<e>。 */
export function pkgOf(file) {
  const m = file.match(/^(packages\/[^/]+|apps\/[^/]+|extensions\/[^/]+\/[^/]+)\//)
  return m ? m[1] : file.split('/').slice(0, 2).join('/')
}

// ---------- main（校验管线） ----------

function main() {
  const args = process.argv.slice(2)
  function argValue(name) {
    const i = args.indexOf(name)
    return i !== -1 ? args[i + 1] : undefined
  }
  const root = path.resolve(argValue('--root') ?? REPO_ROOT)
  const wantStats = args.includes('--stats')
  const wantUncovered = args.includes('--uncovered')

  const failures = []
  const registryDir = path.join(root, 'docs', 'testing', 'domain-slices')
  const { slices, byName, meta, errors } = readRegistry(registryDir)
  if (errors.length > 0) {
    console.error(`[domain-slices] 环境错误：\n  ${errors.join('\n  ')}`)
    console.error('  恢复动作：确认 docs/testing/domain-slices/ 存在且各 JSON 合法')
    process.exit(2)
  }
  if (slices.length === 0) {
    console.error('[domain-slices] 环境错误：注册表为空（docs/testing/domain-slices/ 无任何域 JSON）')
    process.exit(2)
  }

  // ── 1. 结构 + 2. 存在性/展开 ──
  const expansion = new Map() // 域名 → 展开文件数组
  for (const slice of slices) {
    const stem = slice.name ?? '(缺 name)'
    const struct = (cond, msg) => {
      if (cond) failures.push(`域 "${stem}"：${msg}`)
    }
    struct(typeof slice.name !== 'string' || !slice.name, '缺 name（字符串）')
    struct(typeof slice.summary !== 'string' || slice.summary.length === 0, '缺 summary（一句话域覆盖说明）')
    struct(!Array.isArray(slice.tests), 'tests 必须是数组（骨架可为空数组）')
    struct(slice.tests?.some((t) => typeof t !== 'string'), 'tests 含非字符串条目')
    if (slice.layers !== undefined) {
      struct(!Array.isArray(slice.layers) || slice.layers.some((l) => typeof l !== 'string' || !l), 'layers 必须是字符串数组（advisory，无词表强校验）')
    }
    if (slice.scope !== undefined) {
      struct(slice.scope === null || typeof slice.scope !== 'object' || Array.isArray(slice.scope), 'scope 必须是「层名 → glob 数组」对象')
      for (const [layer, globs] of Object.entries(slice.scope ?? {})) {
        struct(!Array.isArray(globs) || globs.some((g) => typeof g !== 'string'), `scope.${layer} 必须是字符串数组`)
      }
    }
    if (slice.sharedBy !== undefined) {
      struct(slice.sharedBy === null || typeof slice.sharedBy !== 'object' || Array.isArray(slice.sharedBy), 'sharedBy 必须是「文件 → 域数组」对象')
      for (const [file, domains] of Object.entries(slice.sharedBy ?? {})) {
        struct(!Array.isArray(domains) || domains.some((d) => typeof d !== 'string'), `sharedBy["${file}"] 必须是字符串数组`)
      }
    }
    for (const [i, c] of (slice.contracts ?? []).entries()) {
      struct(!c || typeof c !== 'object', `contracts[${i}] 必须是对象`)
      struct(typeof c?.carrier !== 'string' || !c.carrier, `contracts[${i}].carrier 缺失（契约载体路径/glob）`)
      struct(!Array.isArray(c?.on) || c.on.length === 0 || c.on.some((d) => typeof d !== 'string'), `contracts[${i}].on 必须是非空字符串数组（对侧域）`)
    }
    if (slice.e2eRules !== undefined) {
      struct(!Array.isArray(slice.e2eRules) || slice.e2eRules.some((r) => typeof r !== 'string'), 'e2eRules 必须是字符串数组')
    }
    // name 与文件名一致（读不到文件名时跳过——readRegistry 已保证来自独立文件，此处用域文件反查）
    const stemFile = `${slice.name}.json`
    if (!existsSync(path.join(registryDir, stemFile))) {
      failures.push(`域 "${stem}"：name 与文件名不一致（应存于 ${stemFile}）`)
    }

    // scope 路径存在性（前缀目录或精确文件在盘）
    for (const [layer, globs] of Object.entries(slice.scope ?? {})) {
      for (const g of globs ?? []) {
        const target = g.endsWith('/**') ? g.slice(0, -3) : g
        if (!existsSync(path.join(root, target))) {
          failures.push(`域 "${stem}"：scope.${layer} 条目 "${g}" 指向的路径不在盘上`)
        }
      }
    }
    // tests 展开
    const { files, problems } = expandTestGlobs(root, slice.tests ?? [])
    for (const p of problems) failures.push(`域 "${stem}"：${p}`)
    expansion.set(slice.name, files)
  }

  // 域名重复（不同文件同 name）
  const nameCount = new Map()
  for (const s of slices) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1)
  for (const [name, n] of nameCount) if (n > 1) failures.push(`域名 "${name}" 重复登记（${n} 个文件）`)

  // ── 3. 唯一归属 ──
  const ownerOf = new Map()
  const overlaps = []
  for (const slice of slices) {
    for (const f of expansion.get(slice.name) ?? []) {
      const prev = ownerOf.get(f)
      if (prev !== undefined && prev !== slice.name) {
        overlaps.push(`文件 "${f}" 双归属：域 "${prev}" 与 "${slice.name}"（每测试文件必须唯一归属）`)
      } else {
        ownerOf.set(f, slice.name)
      }
    }
  }
  failures.push(...overlaps)

  // ── 4. W2-B 交叉核对（domain-map.json 冻结表 ⊆ 同名切片域展开） ──
  const domainMapPath = path.join(root, DOMAIN_MAP_REL)
  const w2bNames = new Set()
  if (existsSync(domainMapPath)) {
    let domainMap
    try {
      domainMap = JSON.parse(readFileSync(domainMapPath, 'utf-8'))
    } catch (err) {
      failures.push(`${DOMAIN_MAP_REL} 解析失败（${err.message}）——交叉核对无法进行`)
      domainMap = null
    }
    for (const [name, entry] of Object.entries(domainMap?.domains ?? {})) {
      w2bNames.add(name)
      const slice = byName.get(name)
      if (!slice) {
        failures.push(`W2-B 域 "${name}" 在切片注册表无同名文件（骨架必须先立）`)
        continue
      }
      const compat = slice.w2bMountCompat
      if (!compat || typeof compat !== 'object') {
        failures.push(`域 "${name}"：缺 w2bMountCompat 声明（W2-B 14 域必须携带前向兼容声明，见 _meta.json.fields）`)
        continue
      }
      const status = compat.status
      if (status !== 'pending' && status !== 'enforced') {
        failures.push(`域 "${name}"：w2bMountCompat.status 非法 "${status}"（合法值 pending | enforced）`)
        continue
      }
      const filled = (slice.tests ?? []).length > 0
      if (filled && status === 'pending') {
        failures.push(`域 "${name}"：tests 已填但 w2bMountCompat.status 仍为 pending（改 enforced 后交叉核对生效）`)
      }
      if (!filled && status === 'enforced') {
        failures.push(`域 "${name}"：w2bMountCompat.status=enforced 但 tests 为空（先填切片清单）`)
      }
      if (filled) {
        const expanded = new Set(expansion.get(name) ?? [])
        for (const f of entry.files ?? []) {
          if (!expanded.has(f)) {
            failures.push(
              `域 "${name}"：domain-map.json 挂载文件 "${f}" 未被本切片域 tests 展开收录（W2-B 归属冻结，切片必须收录同名域全部 files）`,
            )
          }
        }
      }
    }
  } else {
    failures.push(`${DOMAIN_MAP_REL} 不存在——W2-B 交叉核对无法进行`)
  }
  for (const slice of slices) {
    if (slice.w2bMountCompat !== undefined && !w2bNames.has(slice.name)) {
      failures.push(`域 "${slice.name}"：非 W2-B 域携带 w2bMountCompat（该声明仅 domain-map.json 14 域合法）`)
    }
  }

  // ── 5. sharedBy ──
  for (const slice of slices) {
    for (const [file, domains] of Object.entries(slice.sharedBy ?? {})) {
      const expanded = expansion.get(slice.name) ?? []
      if (!expanded.includes(file)) {
        failures.push(`域 "${slice.name}"：sharedBy 键 "${file}" 不在本域 tests 展开中（注记对象必须是 owner 域登记的测试文件）`)
      }
      for (const d of domains ?? []) {
        if (!byName.has(d)) failures.push(`域 "${slice.name}"：sharedBy["${file}"] 注记的域 "${d}" 不存在`)
      }
    }
  }

  // ── 6. contracts ──
  for (const slice of slices) {
    const scopeGlobs = Object.values(slice.scope ?? {}).flat()
    for (const c of slice.contracts ?? []) {
      if (typeof c?.carrier === 'string' && c.carrier && !globCovers(scopeGlobs, c.carrier)) {
        failures.push(
          `域 "${slice.name}"：contracts carrier "${c.carrier}" 未被本域 scope 覆盖（契约载体必须属本域触发范围）`,
        )
      }
      for (const d of c?.on ?? []) {
        if (!byName.has(d)) failures.push(`域 "${slice.name}"：contracts.on 引用的域 "${d}" 不存在`)
      }
    }
  }

  // ── 7. e2eRules ──
  const e2eMapPath = path.join(root, E2E_MAP_REL)
  let e2eIds = null
  if (existsSync(e2eMapPath)) {
    try {
      e2eIds = new Set(JSON.parse(readFileSync(e2eMapPath, 'utf-8')).rules.map((r) => r.id))
    } catch (err) {
      failures.push(`${E2E_MAP_REL} 解析失败（${err.message}）——e2eRules 交叉核对无法进行`)
    }
  } else {
    failures.push(`${E2E_MAP_REL} 不存在——e2eRules 交叉核对无法进行`)
  }
  if (e2eIds) {
    for (const slice of slices) {
      for (const id of slice.e2eRules ?? []) {
        if (!e2eIds.has(id)) failures.push(`域 "${slice.name}"：e2eRules 引用 "${id}" 不存在于 ${E2E_MAP_REL}`)
      }
    }
  }

  // ── 8. uncategorized 纪律 + 棘轮 ──
  const uncat = byName.get('uncategorized')
  if (uncat) {
    for (const t of uncat.tests ?? []) {
      if (t.endsWith('/**')) {
        failures.push('域 "uncategorized"：tests 只允许精确路径清单（池不吞并目录，禁 /** glob）')
        break
      }
    }
    if (meta && typeof meta.uncategorizedBaseline === 'number') {
      const n = (expansion.get('uncategorized') ?? []).length
      if (n > meta.uncategorizedBaseline) {
        failures.push(
          `域 "uncategorized"：展开 ${n} 文件 > 棘轮基线 ${meta.uncategorizedBaseline}（基线只降不升；缩趋手段 = 按内含域拆注 sharedBy / 归 host/foundation）`,
        )
      }
    }
  }

  // ── 9. 覆盖完备（coverageEnforced 硬验收；未启用时仅报告） ──
  const roots = watchedRoots(root)
  const universe = new Set()
  for (const r of roots) {
    const out = []
    walkTests(path.join(root, r), r.replace(/\/$/, ''), out)
    for (const f of out) universe.add(f)
  }
  const uncovered = [...universe].filter((f) => !ownerOf.has(f)).sort()

  if (meta?.coverageEnforced === true && uncovered.length > 0) {
    failures.push(`覆盖不完备：watched roots 内 ${uncovered.length} 个测试文件未被任何域/池覆盖（coverageEnforced 已启用，未覆盖 = 红；清单 --uncovered）`)
  }

  // ── 输出 ──
  if (failures.length > 0) {
    console.error(`[domain-slices] 检查拦截：${failures.length} 项违规\n`)
    for (const f of failures) console.error(`  ✗ ${f}`)
    console.error('')
    console.error('[FIX] 注册表 = docs/testing/domain-slices/（每域一个 JSON，字段说明见 _meta.json.fields）；')
    console.error('    域触发 = node scripts/run-domain-tests.mjs <domain>... [--list]；选择器 = node scripts/select-affected-domain.mjs')
    process.exit(1)
  }

  const filled = slices.filter((s) => (s.tests ?? []).length > 0)
  const pending = slices.filter((s) => (s.tests ?? []).length === 0)
  const enforcedN = slices.filter((s) => s.w2bMountCompat?.status === 'enforced').length
  const pendingW2b = slices.filter((s) => s.w2bMountCompat?.status === 'pending').length
  const totalFiles = [...ownerOf.keys()].length
  console.log(
    `[domain-slices] OK：${slices.length} 域（filled ${filled.length} / pending ${pending.length}），登记测试文件 ${totalFiles}，` +
      `唯一归属 0 冲突，W2-B 交叉核对 enforced ${enforcedN} / pending ${pendingW2b}，未覆盖 ${uncovered.length}（coverageEnforced=${meta?.coverageEnforced === true ? 'on' : 'off'}，完整清单 --uncovered）`,
  )

  if (wantStats) {
    console.log('\n[domain-slices] --stats 全域统计\n')
    console.log('| 域 | 状态 | 文件数 | 包分布 |')
    console.log('|---|---|---:|---|')
    const rows = slices
      .map((s) => {
        const files = expansion.get(s.name) ?? []
        const byPkg = new Map()
        for (const f of files) byPkg.set(pkgOf(f), (byPkg.get(pkgOf(f)) ?? 0) + 1)
        return { name: s.name, status: (s.tests ?? []).length > 0 ? 'filled' : 'pending', n: files.length, dist: [...byPkg.entries()].map(([p, n]) => `${p}: ${n}`).join(' / ') || '—' }
      })
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    for (const r of rows) console.log(`| ${r.name} | ${r.status} | ${r.n} | ${r.dist} |`)
    const byPkgUncovered = new Map()
    for (const f of uncovered) byPkgUncovered.set(pkgOf(f), (byPkgUncovered.get(pkgOf(f)) ?? 0) + 1)
    console.log(`\n未覆盖（watched roots 内测试文件不在任何域/池）：${uncovered.length}`)
    for (const [p, n] of [...byPkgUncovered.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${p}: ${n}`)
  }
  if (wantUncovered) {
    console.log('\n[domain-slices] --uncovered 完整清单（批 D 登记 uncategorized 的工作清单）')
    for (const f of uncovered) console.log(`  ${f}`)
  }
}

// walkTests 为模块内共享函数（watchedRoots 展开复用）；pkgOf / readRegistry / expandTestGlobs 为外部导出

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href
if (isMain) main()
