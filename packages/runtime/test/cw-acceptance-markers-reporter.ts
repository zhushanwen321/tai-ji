/**
 * cw 验收标记行 reporter（e2e-mock 型验收的 stdout 契约）。
 *
 * 背景：cw verify 的 e2e-sh 适配器要求验收命令的 stdout 含标记行 `<验收id> PASS|FAIL`
 * （spec trace-runtime 的 A31 是 e2e-mock 型——vitest 适配器解析不了它）。vitest 型验收
 * 由 cw 自动追加 `--reporter=json` 整体解析 stdout，因此本 reporter 检测到该 flag 时**完全
 * 静默**（任何额外输出都会破坏 JSON.parse）。
 *
 * 语义：
 * - 递归遍历（describe 套 describe）本轮全部测试 fullName，词边界命中 `A<数字>` 形态
 *   验收 id 才输出标记（未运行的 id 不输出——vitest 型验收按文件过滤跑时不会误发其他
 *   id 的标记）。
 * - 同 id 多条用例：任一 fail 即 FAIL（与 cw nameMatch 折叠语义一致）。
 * - 标记行在 onTestRunEnd 输出（全部用例定局后），exit code 由 vitest 进程自身决定，
 *   与标记行天然一致。
 *
 * 类型：不 import 'vitest/node'（其类型链经 happy-dom 撞 runtime 的 @types/node 22
 * stream/web 定义），改用最小结构类型（vitest 运行时加载本文件，鸭子类型足够）。
 *
 * [已知坑] TestCollection.tests() 实测只返回**本层**直接用例（module 层为 0，用例都在
 * describe suite 层），须递归 suites() —— 与 d.ts 注释「and its children」表述不符，
 * 以运行为准。
 */

/** 最小结构类型（vitest TestModule / TestCollection / TestCase 的消费面切片）。 */
interface MinimalTestCase {
  readonly fullName: string
  ok(): boolean
}
interface MinimalTestCollection {
  tests(): Generator<MinimalTestCase, undefined, void>
  suites(): Generator<{ readonly children: MinimalTestCollection }, undefined, void>
}
interface MinimalTestModule {
  readonly children: MinimalTestCollection
}

/** 词边界验收 id（A + 数字；与 cw ACCEPTANCE_ID_RE 的 A 前缀形态对齐）。 */
const ACCEPTANCE_ID_RE = /\b(A\d+)\b/g

/** 递归收集 collection 子树全部用例（suite 层嵌套逐层下钻）。 */
function collectTests(collection: MinimalTestCollection, out: MinimalTestCase[] = []): MinimalTestCase[] {
  out.push(...collection.tests())
  for (const suite of collection.suites()) {
    collectTests(suite.children, out)
  }
  return out
}

export default class CwAcceptanceMarkersReporter {
  /** id → 是否存在 fail 用例 */
  private readonly failById = new Map<string, boolean>()

  onTestRunEnd(testModules: ReadonlyArray<MinimalTestModule>): void {
    // JSON 模式静默：vitest 型验收的 stdout 必须是纯 JSON（cw vitest 适配器整体 JSON.parse）
    if (process.argv.some((a) => a.includes('--reporter=json'))) return

    for (const mod of testModules) {
      for (const test of collectTests(mod.children)) {
        const { fullName } = test
        for (const match of fullName.matchAll(ACCEPTANCE_ID_RE)) {
          const id = match[1]
          const failed = !test.ok() || (this.failById.get(id) ?? false)
          this.failById.set(id, failed)
        }
      }
    }
    for (const [id, failed] of this.failById) {
      process.stdout.write(`${id} ${failed ? 'FAIL' : 'PASS'}\n`)
    }
  }
}
