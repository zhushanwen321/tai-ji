/**
 * guard-report.mjs —— scripts/check-*.mjs 检查家族共享骨架（呈报 + 源文本提取原语）。
 *
 * 各检查脚本（check-capability-allowlist-sync / check-pi-sync / check-thinking-levels /
 * check-artifact-dir-formula-sync / check-posix-resolve-mirror-sync）的对拍判定各不相同，
 * 但呈报骨架同一形态：
 * - 逐项 `✓`/`✗` 行 + 全局 failed 旗标（任一 ✗ 即整体失败）；
 * - 「双方集合 setDiff → 一致报 ok / 漂移报 fail（多出/缺失分项以『；』连接）」的对拍呈报；
 * - 尾部汇总出口（全绿打印通过文案 exit 0，否则打印修复提示 exit 1）；
 * - 源文件读取（缺失报 ✗ 带恢复动作）与提取阶段 fail-fast 出口；
 * - `--self-test` 断言骨架（✓/✗ 计数 + 尾部出口）。
 * 骨架收敛到本模块单一实现，检查本体只写各自的判定与文案。
 *
 * 状态旗标是模块级单例：检查脚本都是「一进程一跑」的 CLI（含 tmp-mirror 集成用例经
 * spawnSync 子进程运行），单例语义与原先各脚本内的 `let failed = 0` 完全一致。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failed = false

/** 报一条失败项（✗ 行），并置全局失败旗标。 */
export function fail(msg) {
  console.error(`  ✗ ${msg}`)
  failed = true
}

/** 报一条通过项（✓ 行）。 */
export function ok(msg) {
  console.log(`  ✓ ${msg}`)
}

/** 全局失败旗标：任一 fail 后为 true（exitIfFailed / guardExit 消费）。 */
function isFailed() {
  return failed
}

/** 集合差异：extra = a 有 b 无；missing = b 有 a 无。 */
export function setDiff(a, b) {
  const bs = new Set(b)
  const as = new Set(a)
  return {
    extra: [...as].filter((x) => !bs.has(x)),
    missing: [...bs].filter((x) => !as.has(x)),
  }
}

/**
 * 双向集合对拍呈报：一致 → ok(okMsg)；漂移 → fail（多出/缺失分项存在才产出，
 * 以『；』连接，前后接 failHeader / failSuffix——各检查的漂移文案与恢复动作在调用点给全）。
 */
export function reportSetCompare(values, expected, { okMsg, extraPart, missingPart, failHeader, failSuffix = '' }) {
  const { extra, missing } = setDiff(values, expected)
  if (extra.length === 0 && missing.length === 0) {
    ok(okMsg)
    return
  }
  const parts = []
  if (extra.length > 0) parts.push(extraPart(extra))
  if (missing.length > 0) parts.push(missingPart(missing))
  fail(`${failHeader}${parts.join('；')}${failSuffix}`)
}

/**
 * 截取 `anchor` 起、到下一个行首 `}`（函数体结束）为止的源码块（源文件字面量对拍检查的
 * 共享提取原语：check-artifact-dir-formula-sync / check-posix-resolve-mirror-sync 同款收敛）。
 * 目标函数的收尾 `}` 均在行首，体内模板串的 `${...}` 不落行首——截取安全。
 */
export function extractFunctionBlock(text, anchor) {
  const start = text.indexOf(anchor)
  if (start < 0) return { error: `未找到 ${anchor}（改名 / 移动？）` }
  const end = text.indexOf('\n}', start)
  if (end < 0) return { error: `${anchor} 未找到行首收尾的 '}'（形态变化？）` }
  return { text: text.slice(start, end + 2) }
}

/** 检查汇总出口：全绿 → 打印通过文案 exit 0；否则打印修复提示 exit 1。 */
export function guardExit(okText, failText) {
  if (isFailed()) {
    console.error(failText)
    process.exit(1)
  }
  console.log(okText)
  process.exit(0)
}

/**
 * 检查脚本仓库根推导：scripts/<check>.mjs 上一级 = 仓库根。调用方必须传自己的
 * import.meta.url——lib 内取 import.meta.url 指向 lib 自身（scripts/lib/），层级不同。
 */
export function repoRootFrom(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), '..')
}

/** CLI 直跑判定：检查脚本作为脚本直接执行（node scripts/<check>.mjs）时为 true，被 import 时为 false。 */
export function isDirectRun(metaUrl) {
  return Boolean(process.argv[1] && metaUrl === pathToFileURL(resolve(process.argv[1])).href)
}

/** 提取阶段 fail-fast 出口：有 ✗ 记录时打印提示并 exit 1（检查的提取失败一律红灯停）。 */
export function exitIfFailed(hint) {
  if (!isFailed()) return
  console.error(hint)
  process.exit(1)
}

/** 读单份源文件文本；缺失报 ✗（带恢复动作）并返回 null（readSourcesOrFail 内部消费）。 */
function readTextOrFail(filePath, label) {
  if (!existsSync(filePath)) {
    fail(`${label} 缺失: ${filePath}——恢复动作：确认文件未被移动 / 删除（迁移时同步本检查的路径）`)
    return null
  }
  return readFileSync(filePath, 'utf-8')
}

/**
 * 批量读对拍源文件：entries 为 [绝对路径, label] 对；任一缺失（readTextOrFail 已报 ✗）即
 * fail-fast 出口。返回与 entries 同序的文本数组——检查 main 的读取段一行收尾。
 */
export function readSourcesOrFail(entries) {
  const texts = entries.map(([filePath, label]) => readTextOrFail(filePath, label))
  exitIfFailed('检查源文件读取失败，按上方 ✗ 修复后重跑')
  return texts
}

/**
 * `--self-test` 骨架：body 收到 assert(cond, name)，跑完按失败计数出口（失败 → ✗ 明细 +
 * exit 1；全绿 → ✓ 汇总 + exit 0）。检查本体只写断言内容，不复制 assert 与出口样板
 * （三检查曾各持一份同款样板，fallow 报为跨文件重复块后收敛于此）。
 */
export function runSelfTest(guardName, body) {
  let failures = 0
  const assert = (cond, name) => {
    if (!cond) {
      failures++
      console.error(`  ✗ self-test: ${name}`)
    } else {
      console.log(`  ✓ self-test: ${name}`)
    }
  }
  body(assert)
  if (failures > 0) {
    console.error(`${guardName} self-test 未通过`)
    process.exit(1)
  }
  console.log(`✓ ${guardName} self-test 全部通过`)
  process.exit(0)
}
