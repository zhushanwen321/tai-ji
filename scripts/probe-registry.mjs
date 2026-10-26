#!/usr/bin/env node
/**
 * probe-registry.mjs — npm registry 版本上线探测（merge 阶段 4N.5）
 *
 * 断言「新版本已在 registry 可查」：必须带具体版本号查版本端点
 * （packument 任何版本都返回 200，验不出新版本发布）。
 *
 * registry 最终一致性：publish 成功 ≠ 版本端点立即可查，新版本索引传播有延迟
 * （v0.10.3 实测 60s 内收敛；v0.11.16 实测 2 包第 4-6 分钟才可查、超出旧 3 分钟窗口）。
 * 带上限重试（默认 60s × 6，覆盖实测最长传播），禁无限等待；单次请求 20s 超时
 * （fetch + AbortSignal.timeout，无 curl 依赖、无挂起——旧 inline bash 的 curl
 * 无超时上限曾整批挂起）。
 *
 * 超限语义 = 给判断材料，不硬判发布失败：「逐包 200 才算过」的底线不变
 * （禁止放宽为「CI 绿即过」——防漏发布），但超限时输出区分「传播延迟 vs 真失败」
 * 的材料与下一步动作，延长等待（--retries 加大重跑）或按发布失败处理由执行方裁决。
 *
 * 用法: node scripts/probe-registry.mjs [flags] <pkg@ver> [<pkg@ver> ...]
 *   pkg@ver 形如 @zhushanwen/extension-protocol@0.24.0（scoped 名取最后一个 @ 分割）
 * flags: --retries <n>（默认 6） --interval-ms <n>（默认 60000） --timeout-ms <n>（默认 20000）
 * 退出码: 0 = 全部上线；1 = 有包超限；2 = 用法错误
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const REGISTRY_BASE = 'https://registry.npmjs.org'
export const DEFAULTS = { retries: 6, intervalMs: 60_000, timeoutMs: 20_000 }

/** 拆 pkg@ver。scoped 名内部含 @，取最后一个 @ 为版本分隔。 */
export function parseSpec(spec) {
  const i = String(spec ?? '').lastIndexOf('@')
  if (i <= 0 || i === String(spec).length - 1) {
    throw new Error(`非法 <pkg@ver> 参数：${String(spec)}（期望形如 @scope/name@1.2.3 或 name@1.2.3）`)
  }
  return { pkg: String(spec).slice(0, i), ver: String(spec).slice(i + 1) }
}

/** 版本端点 URL：scoped 名的 `/` 编码为 %2f（与既有 inline bash 的 sed 口径一致）。 */
export function buildUrl(pkg, ver) {
  return `${REGISTRY_BASE}/${pkg.replace('/', '%2f')}/${ver}`
}

/** 默认单次探测：返回 HTTP 状态码。网络/超时异常由 probePackage 统一归一为 'ERR'。 */
async function defaultFetch(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return res.status
}

export function parseArgs(argv) {
  const out = { specs: [], ...DEFAULTS }
  const numFlags = {
    '--retries': 'retries',
    '--interval-ms': 'intervalMs',
    '--timeout-ms': 'timeoutMs',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (numFlags[a]) {
      const v = Number(argv[i + 1])
      if (!Number.isInteger(v) || v <= 0) throw new Error(`${a} 需要正整数，实得：${argv[i + 1]}`)
      out[numFlags[a]] = v
      i += 1
    } else if (a === '--help' || a === '-h') {
      out.help = true
    } else if (a.startsWith('--')) {
      throw new Error(`未知 flag：${a}`)
    } else {
      out.specs.push(parseSpec(a))
    }
  }
  if (!out.help && out.specs.length === 0) throw new Error('至少提供一个 <pkg@ver> 参数')
  return out
}

/** 单包探测：重试至上限或 200。fetchImpl/sleep 注入（测试零等待）。 */
export async function probePackage({ pkg, ver }, { retries, intervalMs, timeoutMs, fetchImpl = defaultFetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const url = buildUrl(pkg, ver)
  let attempts = 0
  let lastCode = null
  while (attempts < retries) {
    attempts += 1
    let code
    try {
      code = await fetchImpl(url, timeoutMs)
    } catch {
      code = 'ERR'
    }
    lastCode = code
    if (lastCode === 200) {
      log(`✓ ${pkg}@${ver} 已上线（第 ${attempts} 次探测）`)
      return { pkg, ver, ok: true, attempts, lastCode }
    }
    if (attempts < retries) {
      log(`  ${pkg}@${ver} 第 ${attempts} 次探测 ${lastCode}，${Math.round(intervalMs / 1000)}s 后重试`)
      await sleep(intervalMs)
    }
  }
  log(`✗ ${pkg}@${ver} ${retries} 次探测后仍不可查（最后一次 ${lastCode}）`)
  return { pkg, ver, ok: false, attempts, lastCode }
}

/** 全量探测（逐包串行）。返回 { ok, results }——ok = 全部包 200。 */
export async function runProbe(specs, opts) {
  const results = []
  for (const s of specs) {
    results.push(await probePackage(s, opts))
  }
  return { ok: results.every((r) => r.ok), results }
}

function printVerdict({ ok, results }) {
  const failed = results.filter((r) => !r.ok)
  if (!ok) {
    console.log(`──── 探测超限：已上线 ${results.length - failed.length}/${results.length} ────`)
    console.log('判断材料（区分「传播延迟」vs「真发布失败」）：')
    console.log('  1. 查本次 release-npm.yml run 的 publish 步骤日志（gh run view <run-id> --log）：')
    console.log('     - 日志中该包 publish 报错 → 真失败：按发布失败处理（勿盲目重打 tag）')
    console.log('     - 日志全部成功 → 大概率是 registry 索引传播延迟（历史实测最长 6 分钟）')
    console.log('  2. 判定为传播延迟时可延长等待后重跑（例：--retries 10）')
    console.log('底线不变：逐包确认 200 才算发布完成，禁止放宽为「CI 绿即过」。')
  }
  return failed
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`✗ ${err.message}`)
    console.error('用法: node scripts/probe-registry.mjs [--retries N] [--interval-ms N] [--timeout-ms N] <pkg@ver> ...')
    process.exit(2)
  }
  if (args.help) {
    console.log('用法: node scripts/probe-registry.mjs [--retries N] [--interval-ms N] [--timeout-ms N] <pkg@ver> ...')
    return
  }
  const verdict = await runProbe(args.specs, { ...args, log: (m) => console.log(m) })
  const failed = printVerdict(verdict)
  if (failed.length > 0) process.exit(1)
}

// 直接执行时进入主流程；被测试 import 纯函数时不触发（与 wait-for-ci.mjs 同款守卫）
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
