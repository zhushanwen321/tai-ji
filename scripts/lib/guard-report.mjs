/**
 * guard-report.mjs —— scripts/check-*.mjs 守卫家族共享骨架（呈报 + 源文本提取原语）。
 *
 * 各守卫脚本（check-capability-allowlist-sync / check-pi-sync / check-thinking-levels /
 * check-artifact-dir-formula-sync / check-posix-resolve-mirror-sync）的对拍判定各不相同，
 * 但呈报骨架同一形态：
 * - 逐项 `✓`/`✗` 行 + 全局 failed 旗标（任一 ✗ 即整体失败）；
 * - 「双方集合 setDiff → 一致报 ok / 漂移报 fail（多出/缺失分项以『；』连接）」的对拍呈报；
 * - 尾部汇总出口（全绿打印通过文案 exit 0，否则打印修复提示 exit 1）。
 * 骨架收敛到本模块单一实现，守卫本体只写各自的判定与文案。
 *
 * 状态旗标是模块级单例：守卫脚本都是「一进程一跑」的 CLI（含 tmp-mirror 集成用例经
 * spawnSync 子进程运行），单例语义与原先各脚本内的 `let failed = 0` 完全一致。
 */

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

/** 全局失败旗标：任一 fail 后为 true（提取阶段 fail-fast 等中途出口判断用）。 */
export function isFailed() {
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
 * 以『；』连接，前后接 failHeader / failSuffix——各守卫的漂移文案与恢复动作在调用点给全）。
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
 * 截取 `anchor` 起、到下一个行首 `}`（函数体闭合）为止的源码块（源文件字面量对拍守卫的
 * 共享提取原语：check-artifact-dir-formula-sync / check-posix-resolve-mirror-sync 同款收敛）。
 * 目标函数的闭合 `}` 均在行首，体内模板串的 `${...}` 不落行首——截取安全。
 */
export function extractFunctionBlock(text, anchor) {
  const start = text.indexOf(anchor)
  if (start < 0) return { error: `未找到 ${anchor}（改名 / 移动？）` }
  const end = text.indexOf('\n}', start)
  if (end < 0) return { error: `${anchor} 未找到行首闭合 '}'（形态变化？）` }
  return { text: text.slice(start, end + 2) }
}

/** 守卫汇总出口：全绿 → 打印通过文案 exit 0；否则打印修复提示 exit 1。 */
export function guardExit(okText, failText) {
  if (isFailed()) {
    console.error(failText)
    process.exit(1)
  }
  console.log(okText)
  process.exit(0)
}
