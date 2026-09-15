#!/usr/bin/env node
/**
 * Provider 凭据读取单通道守卫（C-proc-14）+ upsertProvider 直调清单守卫（C-proc-15）。
 *
 * [HISTORICAL] 起因（设计 catalog-provider-field-authority v3.3 §3.3 D3/D6）：凭据读取
 * 历史上散落成 5 条互不知情的解析链（quota 私有三源链 / handleDiscoverModels 只查
 * models.json / pi-provider-store 私有裸读 auth.json / AuthService 单源 / listProviders
 * 内联判定），M2 系列单元收口到 ProviderCredentialResolver 唯一通道后，本脚本把
 * 「新代码自建第 6 条解析链 / 旁路防线载体直写 models.json」变成 pre-commit 可机检
 * 的失败。约束登记见 docs/constraints.json（C-proc-14 / C-proc-15）。
 *
 * 守卫 A（凭据直查禁令，D3）：packages/runtime/src 生产代码在白名单外出现以下模式即违规——
 *   1. 标识符 `getApiKeyForProvider`（pi-provider-store 直查函数，M2fg 已删除，防复活）
 *   2. 标识符 `readAuthCredentials`（绕过 AuthStorage 的私有裸读，M2c 已删除，防复活）
 *   3. 成员读取模式 `getProviderConfig(...)?.apiKey`（models.json 单源直查的现存形态）
 *   白名单 = resolver 唯一通道本体（services/auth/provider-credential-resolver.ts）仅此
 *   一个文件——白名单清零即「D3 唯一通道」成立的机器证据；新增合法读取点必须先走
 *   review 改白名单（白名单膨胀到 >1 文件 = 收口失效信号，应回到 resolver 设计重审）。
 *
 * 守卫 B（upsertProvider 直调清单，D6 姊妹守卫）：白名单外出现 `upsertProvider(` 调用
 * （含成员调用；接口方法签名声明同形，见 ports/config.ts 条目）即违规——models.json 的
 * provider 写入必须经防线载体（setProvider / applyProviderWritePolicy 托管的 importer
 * 主路径）或登记在案的历史迁移链，堵防线载体被旁路的复发通道。
 *
 * 扫描范围 = packages/runtime/src/** 生产代码；排除 *.test.ts 与 __tests__/ 目录——
 * 测试文件允许引用符号字符串做防回归断言（先例：runtime-wiring.test.ts 断言
 * pi-provider-store 源码不含 readAuthCredentials），扫描目标是「会进产物的代码」。
 *
 * 用法：node scripts/check-provider-credential-reads.mjs（始终全量扫描——纯文本匹配
 * 毫秒级，触发面由 pre-commit 按路径控制）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// fileURLToPath 而非 URL.pathname：Windows 上 pathname 返回 /D:/... 前导斜杠形态，
// path.resolve 会叠加当前盘符产生 D:\D:\... 双盘符路径（win runner 实测）
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOT = path.join(PROJECT_ROOT, 'packages/runtime/src')

// ─── 白名单（相对 packages/runtime/src 的 POSIX 路径）─────────────────────────

/** 守卫 A 白名单：凭据读取唯一通道本体（设计 D3「白名单清零」目标）。 */
const GUARD_A_ALLOWLIST = new Set([
  // resolver 唯一通道本体：models.json 源的 hasSync/readKey 必须直读 getProviderConfig().apiKey
  'services/auth/provider-credential-resolver.ts',
])

/**
 * 守卫 B 白名单：upsertProvider 直调清单（每条注明理由——新增条目须过 review 并同步
 * docs/constraints.json C-proc-15 的 summary 表述）。
 */
const GUARD_B_ALLOWLIST = new Set([
  // setProvider 写入载体（设计 D1 主路径：防线②③ 转译后的唯一 settings 写入点）
  'services/provider-config-helper.ts',
  // importer 主路径（载体 applyProviderWritePolicy 托管后直调，:294/:381）
  'services/migration/provider-importer.ts',
  // 启动 legacy 迁移（寄生字段剥离写回，:139/:233）
  'services/migration/legacy-provider-migration.ts',
  // extras 迁移剥除写回（models.json 寄生字段清理，:151）
  'services/migration/provider-extras-migration.ts',
  // IConfigStore 实现类自身（接口方法 → infra 模块函数的委托点）
  'infra/pi/pi-config-store.ts',
  // 模块函数定义文件本体 + clearProviderApiKey（I9 清理② 纯删键 RMW）
  'infra/pi/pi-provider-store.ts',
  // IConfigStore 接口方法签名声明（非调用；与实现/调用同形，按符号统一放行）
  'services/ports/config.ts',
])

// ─── 扫描器 ──────────────────────────────────────────────────────────────────

/** 递归收集生产代码 .ts（排除测试目录/文件与 .d.ts，见头部「扫描范围」说明）。 */
function collectProductionTs(absDir) {
  const out = []
  for (const name of readdirSync(absDir)) {
    const full = path.join(absDir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
      out.push(...collectProductionTs(full))
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/** 标识符精确匹配（\b 词边界，readAuthCredentialKey 之类的近形名不误伤）。 */
const IDENTIFIER_RES = {
  getApiKeyForProvider: /\bgetApiKeyForProvider\b/g,
  readAuthCredentials: /\breadAuthCredentials\b/g,
}

/** 成员读取模式：getProviderConfig(...) 结果上取 .apiKey（?. 与 . 两种形态）。 */
const GET_CONFIG_APIKEY_RE = /\bgetProviderConfig\s*\([^)]*\)\s*\??\.\s*apiKey\b/g

/** 守卫 B：upsertProvider 调用形态（标识符/成员后紧跟 (，定义与签名声明由白名单放行）。 */
const UPSERT_CALL_RE = /\bupsertProvider\s*\(/g

/**
 * 主流程：逐文件逐行匹配，收集违规。
 * scanRoot / 白名单可注入（默认生产形态 = 全量扫 packages/runtime/src + 本脚本白名单）：
 * 测试用 fixture 目录（mkdtemp 自建自删）验证命中/放行矩阵，不对真实仓库跑正则验证。
 * @param {string} scanRoot 扫描根目录
 * @param {{ guardA?: Set<string>, guardB?: Set<string> }} allowlists 白名单覆盖（默认本模块常量）
 * @returns {{ violations: Array<{file: string, line: number, guard: string, hit: string}>, fileCount: number, lineCount: number }}
 */
function scanDir(scanRoot, allowlists = {}) {
  const guardAAllowlist = allowlists.guardA ?? GUARD_A_ALLOWLIST
  const guardBAllowlist = allowlists.guardB ?? GUARD_B_ALLOWLIST
  const violations = []
  const files = collectProductionTs(scanRoot)
  let lineCount = 0
  for (const file of files) {
    const rel = path.relative(scanRoot, file).split(path.sep).join('/')
    const lines = readFileSync(file, 'utf-8').split('\n')
    lineCount += lines.length
    lines.forEach((line, i) => {
      // 行内注释剔除后再匹配（注释提及旧符号做历史说明不算违规，与守卫 A 头注释自洽）
      const code = line.replace(/\/\/.*$/, '')
      if (!guardAAllowlist.has(rel)) {
        for (const [name, re] of Object.entries(IDENTIFIER_RES)) {
          re.lastIndex = 0
          if (re.test(code)) {
            violations.push({ file: rel, line: i + 1, guard: 'A', hit: name })
          }
        }
        GET_CONFIG_APIKEY_RE.lastIndex = 0
        if (GET_CONFIG_APIKEY_RE.test(code)) {
          violations.push({ file: rel, line: i + 1, guard: 'A', hit: 'getProviderConfig(...).apiKey' })
        }
      }
      if (!guardBAllowlist.has(rel)) {
        UPSERT_CALL_RE.lastIndex = 0
        if (UPSERT_CALL_RE.test(code)) {
          violations.push({ file: rel, line: i + 1, guard: 'B', hit: 'upsertProvider(' })
        }
      }
    })
  }
  return { violations, fileCount: files.length, lineCount }
}

// 导出面（测试消费）：scanDir 主体 + 三组正则（词边界行为直测）+ 白名单常量（收口计数断言）。
// 主流程仅直接执行时运行（node scripts/check-provider-credential-reads.mjs），测试 import
// 零副作用——否则测试会隐式全量扫真实仓库（结果依赖工作区状态），且守卫红时
// process.exit(1) 会杀死 vitest worker。
export { scanDir, IDENTIFIER_RES, GET_CONFIG_APIKEY_RE, UPSERT_CALL_RE, GUARD_A_ALLOWLIST, GUARD_B_ALLOWLIST }

// 主模块判定（pathToFileURL 归一化大小写/编码，防 argv 相对路径或 URL 转义误判）
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  const { violations, fileCount, lineCount } = scanDir(SCAN_ROOT)

  if (violations.length > 0) {
    console.error(`[provider-credential-reads] 发现 ${violations.length} 处违规（C-proc-14/15）：`)
    for (const v of violations) {
      const fix = v.guard === 'A'
        ? '凭据读取走唯一通道 ProviderCredentialResolver（services/auth/provider-credential-resolver.ts，接口在 services/ports/）'
        : 'models.json 写入走防线载体（setProvider / applyProviderWritePolicy 托管的 importer 主路径）'
      console.error(`  ✗ [守卫 ${v.guard}] packages/runtime/src/${v.file}:${v.line}  命中：${v.hit}`)
      console.error(`    修复：${fix}；确属例外先过 review 并把文件加进本脚本白名单（附理由注释）`)
    }
    console.error('')
    console.error('恢复动作：按上方 ✗ 明细改走 resolver / 写入载体后重试；白名单膨胀到守卫 A >1 文件')
    console.error('或守卫 B >8 文件 = 收口失效信号，应回到 use-provider-edit.ts 防线注释重审（原设计文档 catalog-provider-field-authority.md 已删除，git 可追溯）。')
    process.exit(1)
  }

  console.log(`[provider-credential-reads] OK：${fileCount} 个生产文件 / ${lineCount} 行，凭据直查（守卫 A，白名单 ${GUARD_A_ALLOWLIST.size} 文件）与 upsertProvider 直调（守卫 B，白名单 ${GUARD_B_ALLOWLIST.size} 文件）零违规`)
}
