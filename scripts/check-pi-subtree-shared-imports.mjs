#!/usr/bin/env node
// check-pi-subtree-shared-imports.mjs —— pi 子树源码级 shared import 边界检查（C-ext-31）。
//
// 背景：pi 子树（packages/subagent-core/src + extensions/）禁入 shared 的 env 缺省
// 数据根模块。两条通道已有机检，但都只看 bundle 产物：
//   ① scripts/bundle-extensions.mjs 构建期 assertNoPiEnvAdmissionGuard（扫 staged
//      bundle 内的准入检查标记）；
//   ② scripts/verify-staged-extensions.mjs postbuild 复扫。
// 两者的检测 = 精确标记字符串匹配，而「import '@taiji/shared/paths' 的纯符号
// （如 encodeCwd）」这类违规不带守卫码——标记只在 getDataDir 真被调用时才进
// bundle，源码里 import 了但暂未调用时门禁恒绿，回归可悄悄溜过构建期。
//
// 本检查补源码级判定：扫 pi 子树源码的 import/from 语句，命中即红灯（不等 bundle）。
// 拦两类 import：
//   - `@taiji/shared/paths`：该模块的 getDataDir 族内置 C-proc-26 准入检查
//     （非 PACKAGED 进程持 prod 数据目录值即 throw），而 C-proc-09 出站契约把
//     TAIJI_AGENT_PACKAGED 从 pi/引擎进程剥除——打包态 taiji 里读它必抛，
//     session_start 装配失败、subagent 全灭（2026-10-19 事故形态）。
//   - 裸根 `@taiji/shared`：barrel 刻意不导出 paths（renderer 整包 import 的浏览器
//     兼容约束，packages/shared/src/index.ts:275 注释），且 extensions 包全体不依赖
//     @taiji/shared（包边界）——根 import 既越边界又给未来 barrel 变化留静默通道。
//
// 合法形态（不拦）：`@taiji/shared/session-store-paths` 纯公式模块（零 env 读写，
// C-ext-31 拆分产物）+ 数据根经 execution/assembly/store-base.ts 的
// resolveSessionStoreBase 显式传 base。
//
// 口径：只扫 import/from 语句（静态 from / 动态 import() / 副作用 import '...'），
// 注释行（// /* * 开头）不参与匹配——源码注释里引用 '@taiji/shared/paths' 说明
// 边界是合法文档形态（store-base.ts / path-encoding.ts 等均有）。测试文件
// （__tests__/*.test.ts）排除——存量测试仍 import @taiji/shared/paths 造 packaged
// env 场景，归属测试质量维度单独跟踪，不拦构建。
//
// 用法：
//   node scripts/check-pi-subtree-shared-imports.mjs                 # 常规校验（pre-commit 按路径触发）
//   node scripts/check-pi-subtree-shared-imports.mjs --root <dir>    # 指定仓库根（单测 tmp mirror 注入）
//
// 退出码：0 = 通过；1 = 存在 fail。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { repoRootFrom } from './lib/guard-report.mjs'

const args = process.argv.slice(2)
const rootFlagIdx = args.indexOf('--root')
const ROOT = resolve(rootFlagIdx >= 0 ? args[rootFlagIdx + 1] : repoRootFrom(import.meta.url))

/** 扫描范围：pi 子树两个源根（core 源码 + 全部 extensions 包源码）。 */
const SCAN_ROOTS = [join(ROOT, 'packages', 'subagent-core', 'src'), join(ROOT, 'extensions')]
/** 生成的 / 第三方目录，不扫。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'out', '.turbo', '.git'])
/** 扫描的源码扩展名（.d.ts 声明文件不参与——无运行期 import 语义）。 */
const SRC_EXTENSIONS = ['.ts', '.mts', '.tsx']

/** import 说明符提取（三类语句形态；注释行已在调用点剔除）。 */
const SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
]

/** 判定单个 import 说明符是否越界（返回 null = 合法）。 */
function classifySpecifier(specifier) {
  if (specifier === '@taiji/shared') return 'bare-root'
  if (specifier === '@taiji/shared/paths' || specifier.startsWith('@taiji/shared/paths/')) return 'paths'
  return null
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const violations = []
let scanned = 0

for (const scanRoot of SCAN_ROOTS) {
  let files
  try {
    files = walk(scanRoot)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error(`[pi-subtree-shared-imports] 失败：扫描根缺失 ${relative(ROOT, scanRoot)}——恢复动作：确认目录未被移动/删除（迁移时同步本检查的路径）`)
      process.exit(1)
    }
    throw err
  }
  for (const file of files) {
    if (!SRC_EXTENSIONS.some((ext) => file.endsWith(ext))) continue
    if (file.endsWith('.d.ts')) continue
    // 测试文件排除：__tests__ 目录下的 *.test.ts（存量测试造 packaged env 场景，见头注）。
    if (file.includes('/__tests__/') && /\.test\.(ts|mts|tsx)$/.test(file)) continue
    scanned++
    const text = readFileSync(file, 'utf-8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart()
      // 注释行不参与 import 匹配（源码注释引用旧路径说明边界 = 合法文档形态）。
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue
      for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0
        for (const m of lines[i].matchAll(pattern)) {
          const kind = classifySpecifier(m[1])
          if (!kind) continue
          const rel = `${relative(ROOT, file)}:${i + 1}`
          const fix =
            kind === 'paths'
              ? "改 import '@taiji/shared/session-store-paths' 纯公式；数据根经 execution/assembly/store-base.ts 的 resolveSessionStoreBase 显式传 base"
              : "extensions 包不依赖 @taiji/shared（包边界）；确需 shared 公式时 import '@taiji/shared/session-store-paths' 子路径"
          violations.push(`${rel}: import '${m[1]}'（pi 子树禁入 shared env 缺省模块，C-proc-26 准入检查在打包态 pi 进程抛）——${fix}`)
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`[pi-subtree-shared-imports] 失败：pi 子树源码检出 ${violations.length} 条越界 shared import（扫 ${scanned} 个源文件）`)
  for (const v of violations.slice(0, 20)) console.error(`  ✗ ${v}`)
  if (violations.length > 20) console.error(`  … 共 ${violations.length} 条`)
  process.exit(1)
}
console.log(`[pi-subtree-shared-imports] OK：${scanned} 个源文件无 '@taiji/shared/paths' / 裸根 '@taiji/shared' import（合法形态 = '@taiji/shared/session-store-paths' + resolveSessionStoreBase）`)
