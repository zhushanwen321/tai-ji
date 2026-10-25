/**
 * U9-U1：full-e2e 探针基建的纯单元校验（不 spawn pi）。
 *
 * 覆盖两点：尾组注册（REAL_PI_TESTS 串行尾组 / INTEGRATION_TESTS 受控并行尾组——
 * spawnPiFixture 消费方必须登记其一，漏登记会在满并行下饿死，vitest.config 维护契约）
 * 的全量双向 diff 检查 + writeLine 的 stdin 写入形态（JSONL 行以换行结尾——rpc 协议按行解析）。
 *
 * faux LLM 层豁免（L2.5）：只 import FAUX_PI_READY（无 REAL_PI_READY）的消费文件是纯
 * faux 层（凭证无关，门控只判 binary），属 main 满并行组——real-pi 池的饿死模式（真实 LLM
 * 轮次长等待窗口在 CPU 饱和下超时）在 faux 毫秒级本地轮次下结构性不存在（见 vitest.config.ts
 * 维护契约），故豁免登记；混合形态文件（同时 import 两个 READY）含真实 LLM 用例，仍强制登记。
 * [HISTORICAL 2026-09-26] 例外：多 spawn + jiti 冷编译的重 faux 件（idle-pi-reclaim-
 * integration）在满并行下存在扩展注册/模型解析竞态，允许自愿登记进 REAL_PI_TESTS
 * 顺序尾组（豁免 = 不强制，非禁止；登记证据见 vitest.config.ts 同日注释）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, relative, join, sep } from 'node:path'

// runtime 包根（本文件位于 src/__tests__/equivalence/）——消费方相对路径基准，
// 输出形态与 REAL_PI_TESTS 成员一致（'src/...test.ts' / 'test/...test.ts'）
const RUNTIME_ROOT = resolve(__dirname, '..', '..', '..')

/** 递归收集 dir 下全部 .test.ts 的 POSIX 相对路径（标准库 readdirSync，勿引 glob 依赖） */
function collectTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectTestFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(relative(RUNTIME_ROOT, full).split(sep).join('/'))
    }
  }
  return out
}

describe('U9-U1 full-e2e 探针基建单元校验', () => {
  it('REAL_PI_TESTS 与 spawnPiFixture 消费方全量双向同步', () => {
    const configPath = resolve(RUNTIME_ROOT, 'vitest.config.ts')
    const config = readFileSync(configPath, 'utf-8')

    // 消费侧：src/ 与 test/ 两目录中 import spawnPiFixture 的 .test.ts 全集。
    // 文本匹配不做 AST 解析；import 存在单行与多行两种书写形态，故先把全文空白归一，
    // 再做「整句结构」匹配：导入清单花括号内含目标名，且来源模块指向 pi-fixture，两者
    // 同时成立才算消费方。不能退化为裸标识符匹配——本检查文件也在被扫描目录内，自身
    // 错误消息里的同名文案会造成自匹配假红。
    const importShape = /import\s*\{[^{}]*\bspawnPiFixture\b[^{}]*\}\s*from\s*['"][^'"]*pi-fixture(\.js)?['"]/
    // 轨道判定的 import 信号（同款「整句结构」匹配，防裸标识符自匹配）：REAL_PI_READY =
    // 真实 LLM 层门控（SSOT 在 real-pi-gate.ts，历史形态自 pi-fixture import 亦兼容）；
    // FAUX_PI_READY = faux 层门控（凭证无关）。
    const realReadyShape =
      /import\s*\{[^{}]*\bREAL_PI_READY\b[^{}]*\}\s*from\s*['"][^'"]*(pi-fixture|real-pi-gate)(\.js)?['"]/
    const fauxReadyShape = /import\s*\{[^{}]*\bFAUX_PI_READY\b[^{}]*\}\s*from\s*['"][^'"]*pi-fixture(\.js)?['"]/
    // 集成门控信号：文件 import INTEGRATION_TESTS_ENABLED（test-guard/integration-gate.ts
    // 或引擎包内 integration-gate.local 副本）→ spawnPiFixture 调用位于门控 describe 内，
    // 本地默认跳过、CI 由 env=1 启用——真进程面受控，豁免串行尾组登记（文件保留的
    // 快速用例继续占 main 满并行组）。
    const integrationGateShape =
      /import\s*\{[^{}]*\bINTEGRATION_TESTS_ENABLED\b[^{}]*\}\s*from\s*['"][^'"]*integration-gate(\.local)?(\.ts)?['"]/
    const consumers: string[] = []
    /** 纯 faux 层文件（有 FAUX 门控、无 REAL 门控 → 无真实 LLM turn 用例，豁免登记） */
    const fauxTrackFiles: string[] = []
    /** 集成门控文件（spawn 用例受 TAIJI_TEST_INTEGRATION 门控，豁免登记） */
    const integrationGatedFiles: string[] = []
    for (const dir of ['src', 'test']) {
      for (const rel of collectTestFiles(join(RUNTIME_ROOT, dir))) {
        const flattened = readFileSync(resolve(RUNTIME_ROOT, rel), 'utf-8').replace(/\s+/g, ' ')
        if (!importShape.test(flattened)) continue
        consumers.push(rel)
        if (!realReadyShape.test(flattened) && fauxReadyShape.test(flattened)) fauxTrackFiles.push(rel)
        if (integrationGateShape.test(flattened)) integrationGatedFiles.push(rel)
      }
    }

    // 配置侧：按字符串字面量静态提取（走配置 import 会拉起 globalSetup，超出 unit 校验边界）。
    // 数组成员行间穿插 // 注释，注释内可含方括号（如 [HISTORICAL ...]）——结束边界不能用
    // 「下一个 ']' 字符」判定：会命中注释内的闭合括号，把提取截断成空集（2026-10-20 真实
    // LLM 层用例登记后即触发「已登记却报未登记」误报）。改按行扫描：注释行跳过，行首
    // （去缩进）']' 即数组结束（'] as const' 同形态命中）。
    const extractPoolArray = (decl: string): string[] => {
      const start = config.indexOf(decl)
      expect(start, `vitest.config.ts 找不到 ${decl} 数组声明——检查提取逻辑需随配置形态更新`).toBeGreaterThanOrEqual(0)
      const members: string[] = []
      for (const line of config.slice(start).split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('//')) continue
        if (trimmed.startsWith(']')) break
        for (const match of trimmed.matchAll(/['"]([^'"]+\.test\.ts)['"]/g)) {
          if (match[1]) members.push(match[1])
        }
      }
      return members
    }
    const registeredRealPi = extractPoolArray('const REAL_PI_TESTS = [')
    const registeredIntegration = extractPoolArray('const INTEGRATION_TESTS = [')
    const registered = [...registeredRealPi, ...registeredIntegration]
    // [L2.5 二批后允许空池] 全部真实 LLM 用例已迁组 faux，REAL_PI_TESTS 当前 0 成员是合法
    // 终态（数组保留为「新增真实 LLM 文件必须登记」的注册位）；检查的提取断言点 =
    // 数组声明可定位（上方 start），不再要求非空。

    // 双向 diff：漏登记（消费方未进任一尾组，落回 main 满并行组复发饿死超时；纯 faux
    // 层例外，见文件头豁免说明）+ 失效项（清单成员在磁盘已不存在，文件删除/改名后清单未同步）
    const unregistered = consumers
      .filter((p) => !registered.includes(p) && !fauxTrackFiles.includes(p) && !integrationGatedFiles.includes(p))
      .sort()
    const staleOnDisk = registered.filter((p) => !existsSync(resolve(RUNTIME_ROOT, p)))

    const problems: string[] = []
    if (unregistered.length > 0) {
      problems.push(
        `以下 ${unregistered.length} 个文件 import spawnPiFixture 但未登记任一尾组（REAL_PI_TESTS / INTEGRATION_TESTS）：\n`
          + unregistered.map((p) => `  ${p}`).join('\n')
          + '\n👉 真实 LLM 层文件把该路径加入 packages/runtime/vitest.config.ts 的 REAL_PI_TESTS；'
          + '真进程 / 真 IO 集成组文件加入 INTEGRATION_TESTS（用例挂 TAIJI_TEST_INTEGRATION 门控）；'
          + 'spawn 用例用例级门控（文件 import INTEGRATION_TESTS_ENABLED、快速用例留默认组）同样合法；'
          + '纯 faux 层文件（无真实 LLM turn 用例）改为门控 FAUX_PI_READY'
          + '（describe.skipIf(!FAUX_PI_READY) + spawn 传 fauxResponses）即豁免登记',
      )
    }
    if (staleOnDisk.length > 0) {
      problems.push(
        `REAL_PI_TESTS / INTEGRATION_TESTS 中 ${staleOnDisk.length} 个路径在磁盘上不存在（文件删除/改名后清单未同步）：\n`
          + staleOnDisk.map((p) => `  ${p}`).join('\n')
          + '\n👉 从 packages/runtime/vitest.config.ts 的对应数组移除失效路径',
      )
    }
    if (problems.length > 0) throw new Error(`\n${problems.join('\n\n')}`)
  })

  // [2026-09 测试舰队审查 r2-26] it2「writeLine 行以换行符结尾」已删：它构造等价闭包
  // （endsWith 条件追加）再断言闭包自身——恒真且与 pi-fixture.ts:521-523 真实实现
  // （无条件 `line + '\n'`）行为不一致，属「恒真 + 语义漂移」双重问题。
})
