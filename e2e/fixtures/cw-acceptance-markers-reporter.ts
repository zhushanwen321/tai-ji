/**
 * Playwright CW 验收标记行 reporter。
 *
 * 背景：cw verify 的 e2e-mock 适配器要求验收命令的 stdout 含标记行 `<验收id> PASS|FAIL`。
 * 本 reporter 适配 Playwright Reporter API，在 onEnd 时输出标记行。
 *
 * 语义：
 * - 遍历所有测试结果，词边界命中 `A<数字>` 形态验收 id 才输出标记。
 * - 同 id 多条用例：任一 fail 即 FAIL（与 cw nameMatch 折叠语义一致）。
 * - 标记行在 onEnd 输出（全部用例定局后），exit code 由 playwright 进程自身决定。
 *
 * 类型：使用 Playwright Reporter 接口（@playwright/test/reporter）。
 */

import type { Reporter, FullResult, TestCase, TestResult } from '@playwright/test/reporter'

/** 词边界验收 id（A + 数字；与 cw ACCEPTANCE_ID_RE 的 A 前缀形态对齐）。 */
const ACCEPTANCE_ID_RE = /\b(A\d+)\b/g

class CwAcceptanceMarkersReporter implements Reporter {
  /** id → 是否存在 fail 用例 */
  private readonly failById = new Map<string, boolean>()

  onTestEnd(test: TestCase, result: TestResult): void {
    // 从测试标题中提取验收 id
    const title = test.title
    for (const match of title.matchAll(ACCEPTANCE_ID_RE)) {
      const id = match[1]
      const failed = result.status !== 'passed' || (this.failById.get(id) ?? false)
      this.failById.set(id, failed)
    }
  }

  onEnd(_result: FullResult): void {
    // 输出标记行（stdout 契约）
    for (const [id, failed] of this.failById) {
      process.stdout.write(`${id} ${failed ? 'FAIL' : 'PASS'}\n`)
    }
  }
}

export default CwAcceptanceMarkersReporter
