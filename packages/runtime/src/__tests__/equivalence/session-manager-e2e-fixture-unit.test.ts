/**
 * U9-U1：full-e2e 探针基建的纯单元校验（不 spawn pi）。
 *
 * 覆盖两点：REAL_PI_TESTS 分池注册（全量双向 diff 守卫——漏登记会在满并行下饿死，
 * vitest.config 维护契约）+ writeLine 的 stdin 写入形态（JSONL 行以换行结尾——rpc 协议按行解析）。
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
    // 同时成立才算消费方。不能退化为裸标识符匹配——本守卫文件也在被扫描目录内，自身
    // 错误消息里的同名文案会造成自匹配假红。
    const importShape = /import\s*\{[^{}]*\bspawnPiFixture\b[^{}]*\}\s*from\s*['"][^'"]*pi-fixture(\.js)?['"]/
    const consumers: string[] = []
    for (const dir of ['src', 'test']) {
      for (const rel of collectTestFiles(join(RUNTIME_ROOT, dir))) {
        const flattened = readFileSync(resolve(RUNTIME_ROOT, rel), 'utf-8').replace(/\s+/g, ' ')
        if (importShape.test(flattened)) consumers.push(rel)
      }
    }

    // 配置侧：按字符串字面量静态提取（走配置 import 会拉起 globalSetup，超出 unit 校验边界）
    const arrayStart = config.indexOf('const REAL_PI_TESTS = [')
    expect(arrayStart, 'vitest.config.ts 找不到 REAL_PI_TESTS 数组声明——守卫提取逻辑需随配置形态更新').toBeGreaterThanOrEqual(0)
    const arrayText = config.slice(arrayStart, config.indexOf(']', arrayStart))
    const registered: string[] = []
    for (const match of arrayText.matchAll(/['"]([^'"]+\.test\.ts)['"]/g)) {
      if (match[1]) registered.push(match[1])
    }
    expect(registered.length, 'REAL_PI_TESTS 未提取出任何成员——守卫提取逻辑需随配置形态更新').toBeGreaterThan(0)

    // 双向 diff：漏登记（消费方未进清单，落回 main 满并行组复发饿死超时）
    // + 失效项（清单成员在磁盘已不存在，文件删除/改名后清单未同步）
    const unregistered = consumers.filter((p) => !registered.includes(p)).sort()
    const staleOnDisk = registered.filter((p) => !existsSync(resolve(RUNTIME_ROOT, p)))

    const problems: string[] = []
    if (unregistered.length > 0) {
      problems.push(
        `以下 ${unregistered.length} 个文件 import spawnPiFixture 但未登记 REAL_PI_TESTS：\n`
          + unregistered.map((p) => `  ${p}`).join('\n')
          + '\n👉 把该路径加入 packages/runtime/vitest.config.ts 的 REAL_PI_TESTS（漏加会落回 main 满并行组，复发饿死超时）',
      )
    }
    if (staleOnDisk.length > 0) {
      problems.push(
        `REAL_PI_TESTS 中 ${staleOnDisk.length} 个路径在磁盘上不存在（文件删除/改名后清单未同步）：\n`
          + staleOnDisk.map((p) => `  ${p}`).join('\n')
          + '\n👉 从 packages/runtime/vitest.config.ts 的 REAL_PI_TESTS 移除失效路径',
      )
    }
    if (problems.length > 0) throw new Error(`\n${problems.join('\n\n')}`)
  })

  // [2026-09 测试舰队审查 r2-26] it2「writeLine 行以换行符结尾」已删：它构造等价闭包
  // （endsWith 条件追加）再断言闭包自身——恒真且与 pi-fixture.ts:521-523 真实实现
  // （无条件 `line + '\n'`）行为不一致，属「恒真 + 语义漂移」双重问题。
})
