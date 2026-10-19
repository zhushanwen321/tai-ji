#!/usr/bin/env node
/**
 * verify-ci-release.mjs — 验证 tag 的 Release CI 构建完成且 GitHub Release 产物完整
 * （scripts/verify-ci-release.sh 的 Node 移植；入口经原路径薄壳 shim 保持不变）。
 *
 * 用法: verify-ci-release.mjs <tag> [--ci-timeout N]
 *   tag:          如 v0.4.7 或 v0.4.7-beta.1
 *   --ci-timeout: CI 等待超时分钟数（默认 30）
 *
 * Exit: 0 = CI 完成 + 产物完整, 1 = 参数/CI/产物校验失败（具体见输出）
 *
 * 三阶段（与原 bash 一致）：
 *   阶段 1/3  等待 Release workflow run 完成（30s 轮询，--ci-timeout 为上限）；
 *             run 命中且 completed 后按 conclusion 裁决，失败立即退出不等待
 *   阶段 2/3  等待 Release 创建（12×10s，耗尽 fatal）；等待产物 ≥3（12×10s，
 *             耗尽不报错，由阶段 3 完整性校验兜底——原语义保留）
 *   阶段 3/3  产物完整性：dmg/exe/AppImage 必备 + zip/deb 负向断言
 *
 * 依赖说明（相对原 bash 版）：JSON 解析改用 Node 内建 JSON.parse，jq 依赖移除；
 * run 匹配由 findRunForTag 纯函数承接（原 jq select 精确匹配 + test() 模糊备选），
 * 产物判定由 assetCompleteness 纯函数承接（原 grep 锚定匹配），行为等价。
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run } from './lib/exec.mjs'
import { RED, GREEN, NC } from './lib/output.mjs'
import { DEFAULT_REPO } from './lib/repo.mjs'

const USAGE = 'Usage: bash scripts/verify-ci-release.sh <tag> [--ci-timeout N]'

const POLL_INTERVAL_S = 30
const RELEASE_WAIT_POLLS = 12
const RELEASE_WAIT_INTERVAL_MS = 10_000
const MIN_ASSETS = 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 与原 bash log/err/fatal 同前缀同颜色的输出通道（fatal 打印即退出 1）。 */
const log = (m) => console.log(`${GREEN}[VERIFY]${NC} ${m}`)
const err = (m) => console.log(`${RED}[ERROR]${NC} ${m}`)
const fatal = (m) => {
  console.log(`${RED}[FATAL]${NC} ${m}`)
  process.exit(1)
}

/**
 * argv 解析（纯函数，供测试导入）。
 *
 * 与原 bash 一致：第一个参数无条件作 tag（即使形如选项名——bash 的 TAG="${1:-}"
 * 同样照单全收，后续轮到选项循环时才按 Unknown option 拒绝）。
 * 增强点：--ci-timeout 解析期校验为有限数字——原 bash 非数字值在算术展开处崩出；
 * Node 侧 NaN 会让轮询上限为 NaN、循环一次不跑直接判超时（防线失效形态），必须前置拒绝。
 */
export function parseArgs(argv) {
  const out = { tag: '', ciTimeout: 30 }
  const rest = [...argv]
  if (rest.length > 0) out.tag = rest.shift()
  while (rest.length > 0) {
    const a = rest.shift()
    if (a !== '--ci-timeout') return { ok: false, error: `Unknown option: ${a}` }
    const v = rest.shift()
    if (v === undefined) return { ok: false, error: 'Missing value for option: --ci-timeout' }
    out.ciTimeout = v
  }
  const timeout = Number(out.ciTimeout)
  if (!Number.isFinite(timeout)) {
    return { ok: false, error: `Invalid --ci-timeout value: ${String(out.ciTimeout)}` }
  }
  return { ok: true, tag: out.tag, ciTimeout: timeout }
}

/**
 * 从 Release workflow runs 中找 tag 触发的那条（纯函数，供测试导入）。
 *
 * 主匹配：headBranch 精确等于 tag 或 'refs/tags/' + tag（原 jq select 两分支）；
 * 无命中时备选 displayTitle 包含 tag（原 jq test() 正则模糊匹配——真实 tag 形态
 * 下字面 includes 等价）。各自取数组第一个命中；主匹配优先于备选（原 bash 先跑
 * 主 jq、空了才跑备选 jq）。无命中返回 null。
 */
export function findRunForTag(runs, tag) {
  const list = Array.isArray(runs) ? runs : []
  const byHeadBranch = list.find((r) => r?.headBranch === tag || r?.headBranch === `refs/tags/${tag}`)
  if (byHeadBranch !== undefined) return byHeadBranch
  const byTitle = list.find((r) => typeof r?.displayTitle === 'string' && r.displayTitle.includes(tag))
  return byTitle ?? null
}

/**
 * 产物完整性判定（纯函数，供测试导入）。
 *
 * missing：.dmg / .exe 后缀、名字含 AppImage 三平台各一项，缺哪记哪（原 grep
 * 锚定匹配逐条对应）；unexpected：出现 .zip / .deb 后缀（负向断言——2026-09
 * 产物形态收敛，残留即发布管线配置回退）。
 */
export function assetCompleteness(assetNames) {
  const names = (Array.isArray(assetNames) ? assetNames : []).map((n) => String(n ?? ''))
  const missing = []
  if (!names.some((n) => n.endsWith('.dmg'))) missing.push('dmg')
  if (!names.some((n) => n.endsWith('.exe'))) missing.push('exe')
  if (!names.some((n) => n.includes('AppImage'))) missing.push('appimage')
  const unexpected = []
  if (names.some((n) => n.endsWith('.zip'))) unexpected.push('zip')
  if (names.some((n) => n.endsWith('.deb'))) unexpected.push('deb')
  return { missing, unexpected }
}

/** 产物缺失/多余的面向用户文案（与原 bash 逐条一致）。 */
const MISSING_TEXT = {
  dmg: '缺少 macOS .dmg',
  exe: '缺少 Windows .exe',
  appimage: '缺少 Linux AppImage',
}
const UNEXPECTED_TEXT = {
  zip: 'unexpected .zip asset (zip target removed)',
  deb: 'unexpected .deb asset (deb target removed)',
}

/** gh run list 最近 5 条 Release workflow runs；gh 失败按无 runs 处理（原 `|| echo "[]"`）。 */
function fetchRuns(repo) {
  const res = run('gh', [
    'run', 'list',
    '--repo', repo,
    '--workflow', 'Release',
    '--limit', '5',
    '--json', 'databaseId,status,conclusion,headBranch,displayTitle',
  ], { stdio: 'capture' })
  if (!res.ok) return []
  try {
    const runs = JSON.parse(res.stdout)
    return Array.isArray(runs) ? runs : []
  } catch {
    return []
  }
}

/**
 * release 的产物名单；gh 失败 / JSON 解析失败 → null（调用方按 0 个产物处理，
 * 对应原 bash `|| echo ""` / `|| echo "0"` 的兜底形态）。
 * 原 bash 此处两次调用分别用 --jq 取计数与名单，此处收敛为一个 JSON 取数函数，
 * 计数 = 名单长度（数据源相同，行为等价）。
 */
function fetchAssetNames(tag, repo) {
  const res = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], { stdio: 'capture' })
  if (!res.ok) return null
  try {
    const j = JSON.parse(res.stdout)
    const assets = Array.isArray(j.assets) ? j.assets : []
    return assets.map((a) => String(a?.name ?? ''))
  } catch {
    return null
  }
}

/** release 是否存在（原 bash 只判 gh release view 退出码，不读输出）。 */
function releaseExists(tag, repo) {
  return run('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' }).ok
}

/** ── 阶段 1：轮询等 CI run 完成；success 通过，失败/超时 fatal ── */
async function waitForRunCompleted(TAG, REPO, MAX_POLLS) {
  for (let i = 1; i <= MAX_POLLS; i++) {
    const found = findRunForTag(fetchRuns(REPO), TAG)
    if (found !== null && found.status === 'completed') {
      log(`CI workflow: https://github.com/${REPO}/actions/runs/${found.databaseId}`)
      // conclusion 大小写归一化比对（gh run list 返回小写；toLowerCase 对大小写漂移保持稳健）
      if (String(found.conclusion ?? '').toLowerCase() === 'success') {
        log('CI 构建成功')
        return
      }
      fatal(`CI 构建失败 (conclusion: ${found.conclusion})`)
    }
    log(`等待 CI 完成... (${i}/${MAX_POLLS})`)
    await sleep(POLL_INTERVAL_S * 1000)
  }
  fatal(`CI 超时（${MAX_POLLS * POLL_INTERVAL_S / 60} 分钟），未找到完成的 workflow run`)
}

/** ── 阶段 2a：轮询等 Release 创建（循环内成功 break，循环外再终检一次，失败才 fatal）── */
async function waitForReleaseCreated(TAG, REPO) {
  for (let i = 1; i <= RELEASE_WAIT_POLLS; i++) {
    if (releaseExists(TAG, REPO)) {
      log(`Release ${TAG} 已创建`)
      return
    }
    log(`等待 Release 创建... (${i}/${RELEASE_WAIT_POLLS})`)
    await sleep(RELEASE_WAIT_INTERVAL_MS)
  }
  if (!releaseExists(TAG, REPO)) {
    fatal(`Release ${TAG} 未创建，CI 可能未完成 release 步骤`)
  }
}

/** ── 阶段 2b：轮询等 assets 上传（至少 MIN_ASSETS 个；耗尽不报错，阶段 3 完整性校验兜底）── */
async function waitForAssetsUploaded(TAG, REPO) {
  for (let i = 1; i <= RELEASE_WAIT_POLLS; i++) {
    const count = (fetchAssetNames(TAG, REPO) ?? []).length
    if (count >= MIN_ASSETS) {
      log(`产物已上传 (${count} 个)`)
      return
    }
    log(`等待产物上传... (${i}/${RELEASE_WAIT_POLLS}, 当前 ${count} 个)`)
    await sleep(RELEASE_WAIT_INTERVAL_MS)
  }
}

/** ── 阶段 3：产物完整性核验（缺平台/意外产物逐项 ERROR，任何问题 fatal）── */
function verifyAssetsOrFatal(TAG, REPO) {
  const assets = fetchAssetNames(TAG, REPO) ?? []
  if (assets.length === 0) {
    fatal(`Release ${TAG} 没有任何产物`)
  }

  console.log('')
  console.log('产物列表:')
  for (const name of assets) console.log(name)
  console.log('')

  const completeness = assetCompleteness(assets)
  const problems = [
    ...completeness.missing.map((k) => MISSING_TEXT[k]),
    ...completeness.unexpected.map((k) => UNEXPECTED_TEXT[k]),
  ]
  for (const p of problems) err(p)

  if (problems.length > 0) {
    console.log('')
    fatal(`产物校验失败（${problems.length} 项问题，详见上方 ERROR）`)
  }

  log('验证通过：CI 成功，3 个平台产物完整（mac + win + linux）')
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) fatal(parsed.error)
  const TAG = parsed.tag
  if (TAG === '') fatal(USAGE)
  const CI_TIMEOUT_MINS = parsed.ciTimeout
  const REPO = DEFAULT_REPO

  // ── 阶段 1: 等待 CI workflow 完成 ──
  log('=== 阶段 1/3: 等待 Release CI ===')
  log(`Tag: ${TAG}, 超时: ${CI_TIMEOUT_MINS} 分钟`)

  const MAX_POLLS = (CI_TIMEOUT_MINS * 60) / POLL_INTERVAL_S
  await waitForRunCompleted(TAG, REPO, MAX_POLLS)

  // ── 阶段 2: 等待 Release 创建 + 产物上传 ──
  log('=== 阶段 2/3: 等待 Release 产物 ===')
  await waitForReleaseCreated(TAG, REPO)
  await waitForAssetsUploaded(TAG, REPO)

  // ── 阶段 3: 验证产物完整性 ──
  log('=== 阶段 3/3: 验证产物完整性 ===')
  verifyAssetsOrFatal(TAG, REPO)

  log(`下载链接: https://github.com/${REPO}/releases/tag/${TAG}`)
  process.exit(0)
}

// 直接执行（node scripts/merge/verify-ci-release.mjs ...）时进入主流程；被测试 import 纯函数时不触发
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
