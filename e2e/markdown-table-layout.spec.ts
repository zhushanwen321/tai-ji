/**
 * markdown 表格列宽地板 E2E —— L1 行为轨（@p0-smoke，零 token mock）。
 *
 * 背景（2026-09-18 用户截图事故）：对话流表格 CSS 是 GitHub 四条声明
 * （display:block / overflow-x:auto / width:max-content / max-width:100%）。表格自然宽
 * 超容器时 auto table layout 把所有列压向各自 min-content；拉丁文 min-content = 最长单词
 * （合理地板），CJK = 任意两汉字间可断行 → 1 个汉字（病态地板）——短中文标签列
 * （「维度」「报告目录」）被合法压成 1 字宽竖排，含长 inline code token 的列占住大部分宽度。
 * 修复 = th/td 抬地板到 min-width:4em（packages/ui/src/features/chat/MarkdownRenderer.vue，
 * packages/renderer/src/components/sidebar/UpdateButton.vue 同源同步）。
 *
 * 为什么落 e2e 而非单测：本条断言全是布局量（列宽 / 行数），jsdom 无 layout 引擎，
 * vitest 测不了——按 TEST-STRATEGY 三态纪律归 L1 CI 固定环节（e2e-behavior P0 smoke 轨）。
 *
 * 数据流：composer 发哨兵词 'md-table' → mock runSendStream 把回复体换成复刻宽表
 * （TABLE_REPLY，packages/core/src/transport/mock/run-send-stream.ts）→ Block text →
 * MarkdownRenderer 渲染出 .md-render table。
 *
 * 运行：npx playwright test e2e/markdown-table-layout.spec.ts --project=electron-smoke
 */
import { test, expect } from './fixtures/launch-app'

/**
 * 激活 s3 空 session（「API 性能优化」）——同 state-tearing.spec.ts activateSession 的
 * 成熟模式：session list 随 AppShell 挂载渲染，直接点目标 session，不切「会话」segmented
 * tab（icon-only 模式下其 accessible name 被计数徽标文本抢占，时序脆弱）。
 */
async function activateSession(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByText('API 性能优化')).toBeVisible({ timeout: 10_000 })
  await page.getByText('API 性能优化').click()
  await expect(page.getByTestId('composer-box')).toBeVisible({ timeout: 5_000 })
}

test.describe('markdown 表格列宽地板（CJK min-content 修正）', () => {
  test('对话流宽表：短中文列不竖排 + 不撑爆容器 + 长文本列仍折行 @p0-smoke', async ({ page }) => {
    await activateSession(page)
    const input = page.getByRole('textbox')
    await input.click()
    await input.pressSequentially('md-table')
    await input.press('Enter')

    // mock 流式约 15s（thinking → read tool_call → text 宽表 → file_changes → complete）
    const table = page.locator('[data-testid="block-text"] table').last()
    await expect(table).toBeVisible({ timeout: 45_000 })
    // 必须等 complete 再测宽：流式中途行数不足，表的自然宽没到峰值，压扁/地板判定不稳
    await expect(page.locator('.stop-btn')).toHaveCount(0, { timeout: 45_000 })

    const m = await table.evaluate((t) => {
      const th = t.querySelector('thead th') as HTMLElement
      const firstTd = t.querySelector('tbody td') as HTMLElement
      const lastTd = t.querySelector('tbody tr td:last-child') as HTMLElement
      const host = t.closest('.md-render') as HTMLElement
      // Range clientRects 数量 = 行数（jsdom 没有、真实 Chromium 才有，故只能落 e2e）
      const lines = (el: HTMLElement): number => {
        const r = document.createRange()
        r.selectNodeContents(el)
        return r.getClientRects().length
      }
      return {
        fontSize: parseFloat(getComputedStyle(th).fontSize),
        firstColW: th.getBoundingClientRect().width,
        headerLines: lines(th),
        firstCellLines: lines(firstTd),
        lastCellLines: lines(lastTd),
        tableW: t.getBoundingClientRect().width,
        tableScrollW: t.scrollWidth,
        hostW: host.getBoundingClientRect().width,
      }
    })
    // 诊断输出：失败时可见容器宽 / 列宽实际值，免二次复跑
    console.log('markdown table layout metrics:', JSON.stringify(m))

    // ① 列宽地板契约：首列 ≥ 4em（border-box 含 1.2em padding）。无地板时首列 ≈ 1.2em
    //    （1 个汉字 + padding），即截图里的竖排形态
    expect(m.firstColW).toBeGreaterThanOrEqual(m.fontSize * 4 - 1)
    // ② 表头不竖排：单行。无地板时「维度」折成 2 行
    expect(m.headerLines).toBe(1)
    // ③ 不撑爆宿主：table 仍在 max-width:100% 夹紧内，超宽由 overflow-x:auto 横滚承担
    expect(m.tableScrollW).toBeLessThanOrEqual(m.hostW + 1)
    // ④ 长文本列仍正常折行：地板不是 min-width:max-content / word-break:keep-all 式的禁折
    //    （后者在窄容器下会把无标点长中文变成不可断 → 表格被迫横滚）
    expect(m.lastCellLines).toBeGreaterThan(1)
  })
})
