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
 *             run 命中且 completed 后按 conclusion 裁决，失败立即退出不等待；
 *             gh 查询持续失败（连续 3 轮）按 fetch-error 提前退出，不烧满预算误报「CI 超时」
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
 * 无命中时备选 displayTitle 含 tag——带尾部边界：tag 后必须紧跟非 [0-9a-zA-Z.]
 * 字符或行尾（裸 includes 会把标题 v0.11.15 当成 v0.11.1 命中，新 release 的
 * conclusion 被误当本次结论）。各自取数组第一个命中；主匹配优先于备选（原 bash
 * 先跑主 jq、空了才跑备选 jq）。无命中返回 null。
 */
export function findRunForTag(runs, tag) {
  const list = Array.isArray(runs) ? runs : []
  const byHeadBranch = list.find((r) => r?.headBranch === tag || r?.headBranch === `refs/tags/${tag}`)
  if (byHeadBranch !== undefined) return byHeadBranch
  // tag 里的 . 是版本分隔符不是通配符，先转义再拼边界（负向先行断言等价于
  // 「后跟非 [0-9a-zA-Z.] 字符或行尾」）
  const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tagWithBoundary = new RegExp(`${escaped}(?![0-9a-zA-Z.])`)
  const byTitle = list.find((r) => typeof r?.displayTitle === 'string' && tagWithBoundary.test(r.displayTitle))
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

/**
 * release 滞留 draft 判定（纯函数，供测试导入）。
 * 发布管线终点 release 必须非 draft：isDraft=true 意味着阶段 5 的 --draft=false
 * 发布动作失败或漏跑，draft 对用户不可见而管线已判绿——本断言为第二道防线
 * （第一道在 release.mjs 发布动作本身）。查不到（null，gh 失败）不触发本断言，
 * 该场景由紧随的产物校验兜底（同一数据源失败 → 0 产物 fatal）。
 */
export function isDraftRelease(rel) {
  return rel?.isDraft === true
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

/**
 * gh run list 查询闭包（三态契约，形态对齐 lib/fetch-runs.mjs 的 makeFetchRuns）：
 * 返回 runs 数组 = 查询成功（空数组 = 查询成功且无 runs）；返回 null = 查询失败
 * （gh 退出非 0 / JSON 输出畸形 / 非数组——网络/限流/登录态失效）。两类结果绝不
 * 归一：原 bash `|| echo "[]"` 兜底会把查询通道故障混成「无 runs」，gh 全程故障
 * 时空转 30 分钟后误报「CI 超时」（诊断指向错误）。runImpl 注入点供测试替换，
 * 生产路径用 lib/exec.mjs 的 run。
 */
export function makeFetchRuns({ REPO, runImpl = run }) {
  return () => {
    const res = runImpl('gh', [
      'run', 'list',
      '--repo', REPO,
      '--workflow', 'Release',
      '--limit', '5',
      '--json', 'databaseId,status,conclusion,headBranch,displayTitle',
    ], { stdio: 'capture' })
    if (!res.ok) return null
    try {
      const runs = JSON.parse(res.stdout)
      return Array.isArray(runs) ? runs : null
    } catch {
      return null
    }
  }
}

/**
 * release 的产物名单与 draft 态；gh 失败 / JSON 解析失败 → null（调用方按 0 个
 * 产物处理，对应原 bash `|| echo ""` / `|| echo "0"` 的兜底形态）。
 * 原 bash 此处两次调用分别用 --jq 取计数与名单，此处收敛为一个 JSON 取数函数，
 * 计数 = 名单长度（数据源相同，行为等价）。
 * isDraft 一并取回：产物校验与非 draft 断言（阶段 3）共用同一份数据源，一次
 * 调用供两个判定消费。
 */
function fetchReleaseView(tag, repo) {
  const res = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets,isDraft'], { stdio: 'capture' })
  if (!res.ok) return null
  try {
    const j = JSON.parse(res.stdout)
    const assets = Array.isArray(j.assets) ? j.assets : []
    return { names: assets.map((a) => String(a?.name ?? '')), isDraft: j.isDraft === true }
  } catch {
    return null
  }
}

/**
 * release 是否存在（原 bash 只判 gh release view 退出码，不读输出）。
 *
 * 设计裁决（保留两态，不改三态）：gh release view 对「release 不存在」与「gh
 * 查询故障」返回相同退出码 1（2026-10-27 实测：不存在 → stderr "release not
 * found"、网络故障 → stderr "error connecting"，均 exit 1），退出码通道无法区分
 * 二者，三态化只能依赖 stderr 文案匹配（脆弱、随 gh 版本漂移）。残余风险已被
 * 上游收窄：gh 全程故障在阶段 1 即被 fetch-error 分流拦截（pollRunForTag），
 * 到达此处时通道故障只剩轮询中途抖动形态——误判为「未创建」最多多等 12×10s
 * 后 fatal，方向失败安全（不存在放行路径）。
 */
function releaseExists(tag, repo) {
  return run('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' }).ok
}

/** ── 阶段 1 轮询编排核心（IO 全注入，供测试导入）── */

/** 连续查询失败上限：达到即判「查询通道持续故障」提前退出（3 轮 × 30s = 90s
 *  全失败）。CI 等待预算是给构建跑完的，查询通道坏了继续等只会推迟诊断——
 *  不烧满预算（对照 gate.mjs 的 fetch-error 策略：那边 deadline 本身就是判定
 *  预算故重试到耗尽，这边 30 分钟是 CI 构建预算，不属于查询失败可占用的时间）。 */
const MAX_CONSECUTIVE_FETCH_FAILURES = 3

const defaultLog = () => {}

/**
 * 每轮查 runs、找 tag 触发的那条；命中且 completed → 交调用方按 conclusion
 * 裁决（本函数只管等待，不做裁决/退出）。
 *
 * 注入契约：fetchRuns 可同步或异步返回（数组 = 查询成功 / null = 查询失败），
 * 调用点统一 await 解包——否则误接 lib/fetch-runs.mjs 的 async 闭包
 * （makeFetchRuns SSOT，同名不同步）时，返回的 Promise 被 findRunForTag 的
 * Array.isArray 守卫归一为空数组，每轮误判「无 run」，轮询耗尽误报
 * 「CI 超时」且三态分流静默失效。
 *
 * 查询失败轮（fetchRuns 返回 null）与「查到但未完成轮」分流：失败只累计连续
 * 计数（任一成功查询即清零），达到 MAX_CONSECUTIVE_FETCH_FAILURES 直接返回
 * fetch-error；预算耗尽时若全部轮次皆查询失败同样返回 fetch-error——极小预算
 * 下通道故障不得误报「CI 超时」。
 */
export async function pollRunForTag({ TAG, MAX_POLLS, fetchRuns, sleep: sleepImpl = sleep, log: logImpl = defaultLog }) {
  let consecutiveFetchFailures = 0
  let fetchFailurePolls = 0
  let polls = 0
  for (let i = 1; i <= MAX_POLLS; i++) {
    polls += 1
    const runs = await fetchRuns()
    if (runs === null) {
      consecutiveFetchFailures += 1
      fetchFailurePolls += 1
      if (consecutiveFetchFailures >= MAX_CONSECUTIVE_FETCH_FAILURES) {
        return { status: 'fetch-error', failedPolls: consecutiveFetchFailures }
      }
      logImpl(`CI 状态查询失败（gh 网络/限流/登录态），重试... (${i}/${MAX_POLLS})`)
      await sleepImpl(POLL_INTERVAL_S * 1000)
      continue
    }
    consecutiveFetchFailures = 0
    const found = findRunForTag(runs, TAG)
    if (found !== null && found.status === 'completed') {
      return { status: 'completed', run: found }
    }
    logImpl(`等待 CI 完成... (${i}/${MAX_POLLS})`)
    await sleepImpl(POLL_INTERVAL_S * 1000)
  }
  // 全部轮次皆查询失败 = 通道故障而非 CI 慢，按 fetch-error 报（不误报「CI 超时」）
  if (polls > 0 && fetchFailurePolls === polls) {
    return { status: 'fetch-error', failedPolls: fetchFailurePolls }
  }
  return { status: 'timeout' }
}

/** ── 阶段 1 驱动：轮询等 CI run 完成；success 通过，失败/超时/查询持续失败 fatal ── */
async function waitForRunCompleted(TAG, REPO, MAX_POLLS) {
  const verdict = await pollRunForTag({
    TAG,
    MAX_POLLS,
    fetchRuns: makeFetchRuns({ REPO }),
    log,
  })
  if (verdict.status === 'fetch-error') {
    fatal('CI 状态查询持续失败（gh 网络/限流/登录态），排查: gh auth status / gh run list --workflow Release --limit 5')
  }
  if (verdict.status === 'timeout') {
    fatal(`CI 超时（${MAX_POLLS * POLL_INTERVAL_S / 60} 分钟），未找到完成的 workflow run`)
  }
  const found = verdict.run
  log(`CI workflow: https://github.com/${REPO}/actions/runs/${found.databaseId}`)
  // conclusion 大小写归一化比对（gh run list 返回小写；toLowerCase 对大小写漂移保持稳健）
  if (String(found.conclusion ?? '').toLowerCase() === 'success') {
    log('CI 构建成功')
    return
  }
  fatal(`CI 构建失败 (conclusion: ${found.conclusion})`)
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
    const count = (fetchReleaseView(TAG, REPO)?.names ?? []).length
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
  const rel = fetchReleaseView(TAG, REPO)
  // 非 draft 断言（第二道防线）：draft 对用户不可见，产物齐全也不能判绿
  if (isDraftRelease(rel)) {
    fatal(`Release ${TAG} 仍为 draft（未发布）。恢复: gh release edit ${TAG} --repo ${REPO} --draft=false 后重跑本验证`)
  }
  const assets = rel?.names ?? []
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
