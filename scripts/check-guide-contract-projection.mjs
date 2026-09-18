#!/usr/bin/env node
/**
 * 引擎开发指南契约投影守卫（guide-contract-projection）。
 *
 * [HISTORICAL] 起因 2026-09-18：docs/extensions/subagents/engine-development-guide.md
 * 的能力位/错误码两张契约表与源码词表之间无机器对账——指南头部的「更新触发（同 commit
 * 义务）」只约束人，源码枚举新增成员后指南漏同步无任何机器信号（与 doc-symbol-drift
 * 同族问题：drift 只查反引号内 UPPER_SNAKE/get* 符号，错误码小写蛇形与能力位表不在其
 * 候选集）。本脚本把「指南契约表 ↔ 源码词表」变成可机检的投影一致性。
 *
 * 检查逻辑（正则提取，零依赖）：
 *   1. 宿主词表：errors.ts 的 ENGINE_ERROR_CODES as-const 数组 ↔ 指南 §4「封闭枚举 N 条」
 *      行的全量反引号码表——集合相等 + 计数一致（双向：源码新增/删除成员、指南漏改/错改均拦）。
 *   2. SDK 协议码：error-codes.ts 的 ENGINE_PROTOCOL_ERROR_CODES ↔ 指南 §4「N 条固定词表」
 *      计数一致（指南按 §4 F13 裁决「指全不列全」，故只对账计数）。
 *   3. 能力位：engine-manifest.ts 的 CAPABILITY_ENUMS 键集 ∪ {maxTurns}（knownKeys 同源，
 *      :131）↔ 指南 §3「能力位全集 N 位」计数 + §3 表逐键行存在。
 *
 * 书写契约（指南侧）：§4 宿主词表行保持「封闭枚举 N 条——`code` / `code` / …」全量列举
 * 形态；§3 保持「能力位全集 N 位」标题 + 表首列 `capabilityKey` 形态。破坏形态 = 本守卫红。
 *
 * 触发面：pre-commit 按 staged 路径接线（指南 / errors.ts / error-codes.ts /
 * engine-manifest.ts / contract-types.ts），见 .githooks/install-hooks.sh 对应块。
 * 不设独立 SKIP_* 开关（R1 后惯例，总闸 SKIP_ALL_CHECKS 兜底）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GUIDE = 'docs/extensions/subagents/engine-development-guide.md'

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 从 as-const 数组声明提取字符串成员。 */
function extractConstArray(src, name, file) {
  const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`, 's'))
  if (!m) fail(`源码解析失败：${file} 中找不到 export const ${name} = [...]（源码形态变更须同步本守卫）`)
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

/** 从 CAPABILITY_ENUMS 块提取键集（值域校验交编译层，此处只对账键集投影）。 */
function extractCapabilityKeys(src) {
  const m = src.match(/const CAPABILITY_ENUMS[^=]*= \{([\s\S]*?)\n\}/)
  if (!m) fail('源码解析失败：engine-manifest.ts 中找不到 const CAPABILITY_ENUMS 块（源码形态变更须同步本守卫）')
  return [...m[1].matchAll(/^\s{2}(\w+): \[/gm)].map((x) => x[1])
}

const failures = []
function fail(msg) {
  failures.push(msg)
}

// ── 源码侧词表 ──────────────────────────────────────────────────────────────
const ERRORS_FILE = 'packages/subagent-core/src/execution/engine/common/errors.ts'
const SDK_CODES_FILE = 'packages/subagent-engine-sdk/src/protocol/error-codes.ts'
const MANIFEST_FILE = 'packages/subagent-core/src/execution/engine/engine-manifest.ts'

const hostCodes = extractConstArray(read(ERRORS_FILE), 'ENGINE_ERROR_CODES', ERRORS_FILE)
const sdkCodes = extractConstArray(read(SDK_CODES_FILE), 'ENGINE_PROTOCOL_ERROR_CODES', SDK_CODES_FILE)
const capabilityKeys = [...extractCapabilityKeys(read(MANIFEST_FILE)), 'maxTurns'] // knownKeys 同源并集（engine-manifest.ts knownKeys = CAPABILITY_ENUMS 键 + maxTurns）

// ── 指南侧投影 ──────────────────────────────────────────────────────────────
const guide = read(GUIDE)

// 1. 宿主词表：计数 + 集合双向对账
const hostLine = guide.split('\n').find((l) => l.includes('封闭枚举') && l.includes('条——'))
if (!hostLine) {
  fail(`${GUIDE} §4 找不到宿主词表行（书写契约：「封闭枚举 N 条——\`code\` / …」全量列举形态，破坏形态 = 投影守卫红）`)
} else {
  const countClaim = Number((hostLine.match(/封闭枚举 (\d+) 条/) || [])[1])
  const guideCodes = [...hostLine.matchAll(/`([a-z_]+)`/g)].map((x) => x[1])
  if (countClaim !== hostCodes.length) {
    fail(`宿主词表计数失同步：指南写「封闭枚举 ${countClaim} 条」，源码 ENGINE_ERROR_CODES 实为 ${hostCodes.length} 条（${ERRORS_FILE}）——同 commit 更新指南 §4`)
  }
  const missing = hostCodes.filter((c) => !guideCodes.includes(c))
  const extra = guideCodes.filter((c) => !hostCodes.includes(c))
  if (missing.length) fail(`指南 §4 宿主词表缺码：${missing.join(' / ')}——源码词表新增成员未同步指南（登记义务见指南 §4）`)
  if (extra.length) fail(`指南 §4 宿主词表多码（源码词表不存在）：${extra.join(' / ')}——已删除/改名码须从指南移除`)
}

// 2. SDK 协议码：计数对账（指南按「指全不列全」裁决只留计数）
const sdkCountClaim = Number((guide.match(/ENGINE_PROTOCOL_ERROR_CODES` (\d+) 条固定词表/) || [])[1])
if (!sdkCountClaim) {
  fail(`${GUIDE} §4 找不到 SDK 协议码计数（书写契约：「ENGINE_PROTOCOL_ERROR_CODES\` N 条固定词表」）`)
} else if (sdkCountClaim !== sdkCodes.length) {
  fail(`SDK 协议码计数失同步：指南写「${sdkCountClaim} 条」，源码 ENGINE_PROTOCOL_ERROR_CODES 实为 ${sdkCodes.length} 条（${SDK_CODES_FILE}）——同 commit 更新指南 §4`)
}

// 3. 能力位：计数 + §3 表逐键存在
const capCountClaim = Number((guide.match(/能力位全集 (\d+) 位/) || [])[1])
if (!capCountClaim) {
  fail(`${GUIDE} §3 找不到能力位计数（书写契约：「能力位全集 N 位」）`)
} else if (capCountClaim !== capabilityKeys.length) {
  fail(`能力位计数失同步：指南写「能力位全集 ${capCountClaim} 位」，源码实为 ${capabilityKeys.length} 位（CAPABILITY_ENUMS 键 + maxTurns，${MANIFEST_FILE}）——同 commit 更新指南 §3（新增位同步两镜像/保守值/gate 判据，见指南 §12 §3 行动作清单）`)
}
for (const key of capabilityKeys) {
  if (!guide.includes(`| \`${key}\` |`)) {
    fail(`指南 §3 能力位表缺行：\`${key}\`——源码能力位在指南 §3 表无对应行`)
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`[guide-contract-projection] 发现 ${failures.length} 处指南契约投影失同步：`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log('恢复动作：按 AGENTS.md 主题索引「更新触发」同 commit 更新指南对应节；若属源码误改则回退源码。')
  process.exit(1)
}
console.log(`[guide-contract-projection] OK：宿主词表 ${hostCodes.length} 条 / SDK 协议码 ${sdkCodes.length} 条 / 能力位 ${capabilityKeys.length} 位，指南投影逐项一致`)
