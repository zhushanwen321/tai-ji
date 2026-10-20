/**
 * pi 子树 bundle 的 C-proc-26 准入检查门禁（单一实现，bundle 与 postbuild 共用）。
 *
 * 禁入物：@taiji/shared paths.ts 的 env 准入检查代码（函数定义/调用点字面量与错误
 * 文案段两种可执行形态，字面量见下方 PI_ENV_ADMISSION_GUARD_MARKERS）出现在任何
 * staged bundle（extension / 引擎）里。
 *
 * 为什么（C-ext-31，2026-10-19 打包版 subagent 全灭事故）：打包态 pi/引擎进程持有
 * TAIJI_AGENT_DATA_DIR=~/.taiji（入站白名单放行）但没有 TAIJI_AGENT_PACKAGED（C-proc-09
 * 出站 deny 清单剥除）——准入检查在该进程内第一个 getDataDir() 必抛，session_start
 * 装配失败、subagent 全灭。pi 子树的合法通道 = '@taiji/shared/session-store-paths'
 * 纯公式模块（零 env 读写）+ subagent-core resolveSessionStoreBase；只要准入检查
 * 代码进入 bundle，就说明有消费点走回了非法通道。
 *
 * 匹配策略 = 精确标记字符串，不做模糊启发式——误拦合法代码比漏拦更伤（门禁必须可解释）。
 * 标记一律取「只可能出现在可执行代码里」的字面量形态（函数定义/调用点的参数表、模板
 * 字符串内的错误文案段）：注释文本不可能逐字命中，因此「不误拦」是标记设计自身的性质，
 * 不依赖 bundler 默认丢注释的行为——legal-comments 开启或更换 bundler 时，合法 bundle
 * （其源码注释提及准入检查机制）依旧不会被误拦。
 *
 * 标记与真实来源（packages/shared/src/paths.ts）的漂移由单测对拍锁定：
 * scripts/__tests__/pi-env-admission-gate.test.mjs 断言每个标记字面量都真实出现在
 * paths.ts 源码中——paths.ts 改名/改文案后标记未同步即测试红，杜绝门禁对含准入检查
 * 代码的新 bundle 静默全绿（2026-10-19 事故形态复溜且无信号）。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 禁入标记（命中任一即红灯）。形态 = 只可能出现在可执行代码里，注释文本不可能
 * 逐字命中（「不误拦」不依赖 bundler 丢注释的行为）：
 *  - 函数定义/调用点的参数表：bundle 实测形态 `function assertNotLeakedProdDataDir(env)`
 *    与调用点 `assertNotLeakedProdDataDir(env)`（esbuild 不 minify、keepNames 保名，
 *    TS 类型擦除后定义与调用都带 `(env`；minify 场景由错误文案标记独立兜底）
 *  - 错误文案模板字符串内的约束 id 段：字符串字面量内容，minify 也不动
 *
 * 与 paths.ts 真实来源的对拍（漂移即红）见 scripts/__tests__/pi-env-admission-gate.test.mjs。
 */
export const PI_ENV_ADMISSION_GUARD_MARKERS = [
  'assertNotLeakedProdDataDir(env',
  '(C-proc-26 prod-admission guard)',
]

/**
 * 检查单份 bundle 源码是否含 pi 子树禁入的准入检查标记。
 *
 * @param {string} code bundle 源码文本
 * @returns {string | null} 命中的标记（红灯证据）；干净返回 null
 */
export function findPiEnvAdmissionGuardMarker(code) {
  for (const marker of PI_ENV_ADMISSION_GUARD_MARKERS) {
    if (code.includes(marker)) return marker
  }
  return null
}

/**
 * 扫描 staged 目录树（extension / 引擎共用形态：目录内含 index.js bundle）。
 *
 * @param {string[]} roots 要扫描的 staged 根目录列表（存在性由调用方保证——
 *   bundle 脚本先建目录再扫；verify-staged 对不存在目录静默跳过）
 * @returns {Promise<{file: string, marker: string}[]>} 违规清单（空数组 = 通过）
 */
export async function collectPiEnvAdmissionGuardViolations(roots) {
  const violations = []
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const bundlePath = join(root, entry.name, 'index.js')
      let code
      try {
        code = await readFile(bundlePath, 'utf8')
      } catch {
        continue
      }
      const marker = findPiEnvAdmissionGuardMarker(code)
      if (marker !== null) violations.push({ file: bundlePath, marker })
    }
  }
  return violations
}

/**
 * 门禁断言（fail-fast 出口）：违规即 throw，错误消息指向恢复动作。
 *
 * @param {{file: string, marker: string}[]} violations collectPiEnvAdmissionGuardViolations 产物
 * @param {string} fixHint 恢复动作前缀（调用方各自的上下文说明）
 */
export function assertNoPiEnvAdmissionGuard(violations, fixHint) {
  if (violations.length === 0) return
  const lines = violations.map((v) => `  - ${v.file}（标记: ${v.marker}）`).join('\n')
  throw new Error(
    `${fixHint}\n` +
      'pi 子树 bundle 禁含 @taiji/shared 的 C-proc-26 准入检查代码（C-ext-31）——打包态\n' +
      'pi/引擎进程没有 TAIJI_AGENT_PACKAGED（C-proc-09 剥除），该检查必抛并导致 subagent 全灭。\n' +
      '恢复动作：pi 子树消费点改用 @taiji/shared/session-store-paths 纯公式 + subagent-core\n' +
      `resolveSessionStoreBase 显式传 base。违规 bundle：\n${lines}`,
  )
}
