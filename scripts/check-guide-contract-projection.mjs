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
 *   4. manifest 能力值三面对账：zcode-subagent-cli 包 package.json 的
 *      taiji.subagentEngine.capabilities ↔ zcode-engine.ts capabilities() 方法体 ↔
 *      指南 §1 manifest 完整示例 JSON——三方键集一致 + 逐键值相等（maxTurns 须 boolean，
 *      其余键须字符串字面量）。两镜像为权威，指南为投影面；两镜像互相不一致属源码误改。
 *
 * 书写契约（指南侧）：§4 宿主词表行保持「封闭枚举 N 条——`code` / `code` / …」全量列举
 * 形态；§3 保持「能力位全集 N 位」标题 + 表首列 `capabilityKey` 形态；§1 manifest 完整
 * 示例保持 ```json 围栏内含 "subagentEngine" 段形态。破坏形态 = 本守卫红。
 *
 * 触发面：pre-commit 按 staged 路径接线（指南 / errors.ts / error-codes.ts /
 * engine-manifest.ts / contract-types.ts / zcode-subagent-cli 的 package.json 与
 * zcode-engine.ts），见 .githooks/install-hooks.sh 对应块。
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

const fmtCapValue = (v) => (typeof v === 'string' ? `"${v}"` : String(v))

/** 从 package.json 的 taiji.subagentEngine.capabilities 提取键值（合法 JSON，直接结构化读取）。 */
function extractPkgManifestCapValues(rel) {
  let pkg
  try {
    pkg = JSON.parse(read(rel))
  } catch {
    fail(`源码解析失败：${rel} 不是合法 JSON（形态变更须同步本守卫）`)
    return {}
  }
  const caps = pkg?.taiji?.subagentEngine?.capabilities
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    fail(`源码解析失败：${rel} 缺 taiji.subagentEngine.capabilities 段（manifest 义务见指南 §1；形态变更须同步本守卫）`)
    return {}
  }
  return caps
}

/** 从 zcode-engine.ts 的 capabilities() 方法体提取键值（先剔除 // 注释行再提取，免疫注释内容漂移）。 */
function extractEngineMethodCapValues(rel) {
  const src = read(rel)
  const m = src.match(/capabilities\(\): EngineCapabilities \{([\s\S]*?)\n  \}/)
  if (!m) {
    fail(`源码解析失败：${rel} 中找不到 capabilities(): EngineCapabilities 方法体（源码形态变更须同步本守卫）`)
    return {}
  }
  const body = m[1]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  const values = {}
  for (const x of body.matchAll(/(\w+): ("([^"]*)"|true|false)/g)) {
    values[x[1]] = x[3] !== undefined ? x[3] : x[2] === 'true'
  }
  return values
}

/** 从指南 §1 manifest 完整示例（含 "subagentEngine" 的 ```json 围栏）提取 capabilities 键值。 */
function extractGuideManifestCapValues(guideText) {
  const block = [...guideText.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((f) => f[1])
    .find((b) => b.includes('"subagentEngine"'))
  if (!block) {
    fail(`${GUIDE} 找不到 manifest 完整示例（书写契约：§1 \`\`\`json 围栏内含 "taiji"."subagentEngine" 段，破坏形态 = 投影守卫红）`)
    return {}
  }
  const caps = block.match(/"capabilities"\s*:\s*\{([\s\S]*?)\}/)
  if (!caps) {
    fail(`${GUIDE} §1 manifest 示例缺 "capabilities" 对象（三面对账要求示例与两镜像同键集）`)
    return {}
  }
  const values = {}
  for (const x of caps[1].matchAll(/"(\w+)"\s*:\s*("([^"]*)"|true|false)/g)) {
    values[x[1]] = x[3] !== undefined ? x[3] : x[2] === 'true'
  }
  return values
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

// 4. manifest 能力值：指南 §1 manifest 示例 ↔ package.json ↔ zcode-engine.ts capabilities() 三面对账
const ENGINE_PKG_FILE = 'packages/zcode-subagent-cli/package.json'
const ENGINE_SRC_FILE = 'packages/zcode-subagent-cli/src/zcode-engine.ts'

const manifestCapSides = [
  { label: '指南 §1 manifest 示例', file: GUIDE, values: extractGuideManifestCapValues(guide) },
  { label: 'taiji.subagentEngine.capabilities', file: ENGINE_PKG_FILE, values: extractPkgManifestCapValues(ENGINE_PKG_FILE) },
  { label: 'capabilities() 方法体', file: ENGINE_SRC_FILE, values: extractEngineMethodCapValues(ENGINE_SRC_FILE) },
]
if (manifestCapSides.every((s) => Object.keys(s.values).length > 0)) {
  const allKeys = [...new Set(manifestCapSides.flatMap((s) => Object.keys(s.values)))]
  for (const key of allKeys) {
    for (const s of manifestCapSides) {
      if (!(key in s.values)) fail(`manifest 能力值缺键：\`${key}\` 在 ${s.label}（${s.file}）缺失——三面须同键集`)
    }
    const present = manifestCapSides.filter((s) => key in s.values)
    if (new Set(present.map((s) => JSON.stringify(s.values[key]))).size > 1) {
      fail(`manifest 能力值三面不一致：\`${key}\`——${present.map((s) => `${s.label}（${s.file}）= ${fmtCapValue(s.values[key])}`).join('；')}——同 commit 更新失同步面（指南 §1 向两镜像对齐；两镜像互相不一致属源码误改，回退源码）`)
    }
  }
  for (const s of manifestCapSides) {
    for (const [key, value] of Object.entries(s.values)) {
      if (key === 'maxTurns' ? typeof value !== 'boolean' : typeof value !== 'string') {
        fail(`manifest 能力值类型违规：\`${key}\` 在 ${s.label}（${s.file}）= ${fmtCapValue(value)}——maxTurns 须 boolean，其余键须字符串字面量`)
      }
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`[guide-contract-projection] 发现 ${failures.length} 处指南契约投影失同步：`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  console.log('恢复动作：按 AGENTS.md 主题索引「更新触发」同 commit 更新指南对应节；若属源码误改则回退源码。')
  process.exit(1)
}
console.log(`[guide-contract-projection] OK：宿主词表 ${hostCodes.length} 条 / SDK 协议码 ${sdkCodes.length} 条 / 能力位 ${capabilityKeys.length} 位 / manifest 能力值三面逐键一致，指南投影逐项一致`)
