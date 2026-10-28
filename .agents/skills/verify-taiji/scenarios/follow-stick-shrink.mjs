/**
 * follow-stick-shrink —— 流式贴底跟随的持续性 + 窗口收缩落点（stream-follow-reshape 验收项 A2 + A12）。
 *
 * 设计依据：stream-follow-reshape.md §4 场景 S2（贴底跟随等价）+ 探针 PR2（数据信号套双 rAF
 * 后 scrollToIndex 落点准确，U5-V6 复测形态 = 收缩窗口场景）。
 * 验收项 A2 = 同一长流式回合内，末条内容持续可见于视口底部（DOM 断言 + scrollTop 采样）；
 * 验收项 A12 = 流式中收缩窗口一次后末条仍贴底。
 *
 * 断言形态（只含确定性断言；「无跳动/无半截」等视觉形态断言归 L4 inspect 节点，不在此写）：
 * - A2：流式期间以 ≥200ms 间隔采样 ≥10 次——每次 scrollEl 的
 *   distance = scrollHeight - scrollTop - clientHeight ≤ BOTTOM_THRESHOLD(40px，应用自身
 *   贴底判据，useVirtuaFollow.ts 常量)，且末条 turn 的 rect.bottom 距滚动容器底 ≤ 64px
 *   （32px 贴底 spacer + 余量）；
 * - A12：采样中段经真实用户路径收窄对话流宽度（侧栏文件 tab → 点开一个文件 → 右抽屉
 *   detail 打开 → 对话流变窄 → 文本回流 → 内容总高变化），断言收缩后采样 distance 收敛
 *   回 ≤40 且 scrollHeight 确实因回流变化（证明收缩真实发生）。
 *
 * 装配：faux + TAIJI_FAUX_TPS=30，长文本 ≈8800 字符（≈2200 token，窗口 ≈73s）。会话
 * cwd = <repo>（真实 git 仓库，侧栏文件树有内容——A12 的缩窗入口需要可点开的文件）。
 */

/** 贴底判据阈值 = useVirtuaFollow BOTTOM_THRESHOLD。 */
const BOTTOM_THRESHOLD = 40
/** 末条内容距容器底的容差 = 32px 贴底 spacer（composer-band.ts 契约）+ 余量。 */
const LAST_TURN_GAP_TOLERANCE = 64

function buildLongText() {
  const para = '贴底跟随采样段：文本持续追加维持流式窗口，采样循环在追加期间读取滚动几何。'
  let text = ''
  while (text.length < 8800) text += para
  return text
}

/** 页内读取滚动几何（A 通道 DOM 度量；只读）。 */
const METRICS_FN = `() => {
  const el = document.querySelector('.message-stream')
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const turns = [...document.querySelectorAll('[data-testid^="turn-"]')]
  const last = turns[turns.length - 1] ?? null
  const lastRect = last ? last.getBoundingClientRect() : null
  return {
    st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight,
    d: el.scrollHeight - el.scrollTop - el.clientHeight,
    turnCount: turns.length,
    lastGap: lastRect ? rect.bottom - lastRect.bottom : null,
  }
}`

export const meta = {
  id: 'follow-stick-shrink',
  priority: 'P0',
  title: '流式贴底持续性（A2：distance 采样 + 末条可见）+ 窗口收缩落点（A12：右抽屉收窄后仍贴底）',
  covers: ['chat.send', 'chat.stream', 'chat.wait'],
  requires: ['faux'],
  estimateSec: 240,
  faux: {
    responses: [{ text: buildLongText(), stopReason: 'stop' }],
    tps: 30,
  },
  provable: [
    'A2：流式期间 ≥10 次采样（间隔 ≥200ms）distance ≤ 40（贴底判据）且末条 turn rect.bottom 距容器底 ≤ 64px',
    'A12：点开侧栏文件 → 右抽屉打开（drawer-panel 可见）→ 对话流收窄（scrollHeight 回流变化 ≥50px）→ 收缩后采样 distance 收敛 ≤ 40（末条仍贴底）',
    'B：回合正常收尾（faux 轮消费完整）',
  ],
  notProvable: [
    '「无跳动/无半截再滚下去」视觉形态（归 L4 inspect 节点，本剧本刻意不断言——写了反而假绿）',
    '逐帧 Layout Forced 风暴消除（S2 Performance 面板人工对照，前提 P6 判定对象）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, instance, repo } = ctx
  const uncovered = []
  const gotchas = [
    'A12 缩窗入口 = 右抽屉（侧栏文件 tab 点文件打开）：对话流宽度收窄 → 文本回流 → 内容总高变化，与「窗口收缩」同一 RO 触发路径',
    'distance = scrollHeight - scrollTop - clientHeight；≤40 判据与 useVirtuaFollow BOTTOM_THRESHOLD 同值（应用自身贴底语义）',
    '末条 turn 取 [data-testid^="turn-"] 最后一个（流式轮 keepMounted，恒在 DOM）',
    'cwd 用 <repo>：侧栏文件树要有可点开的文件（mkdtemp 空目录无文件树）',
  ]

  const ui = ctx.ui
  const page = await instance.page()

  {
    // ── 建会话 + UI 激活链 ────────────────────────────────────────────────
    const created = await protocol.call('session.create', { cwd: repo, label: 'follow-stick-shrink' }, { timeoutMs: 120_000 })
    const sid = created.session?.id
    if (!sid) throw new Error(`session.create 未返回 sessionId：${JSON.stringify(created).slice(0, 200)}`)
    await protocol.subscribe(sid)
    await ui.click('css=.session-item', { timeoutMs: 30_000 })
    ev.step({ step: 'ui.activate', channel: 'A', exitCode: 0, stats: { sid } })

    // ── 发起长流式回合 ────────────────────────────────────────────────────
    const since = protocol.events.length
    await protocol.send(sid, '请输出一段很长的流式文本')
    await ui.expectVisible('css=.stop-btn', { timeoutMs: 30_000 })
    ev.step({ step: 'chat.send', channel: 'B', exitCode: 0, stats: { sid, streaming: true } })

    // ── A2：贴底采样循环（≥10 次 × ≥200ms；中段插入 A12 收缩动作）────────────
    const samples = []
    let shrinkAt = -1 // 收缩动作发生在第几个采样后
    let shrinkEffect = null
    for (let i = 0; i < 14; i++) {
      // 中段（第 6 次采样后）执行收缩：侧栏 → 文件 tab → 点第一个文件 → 右抽屉打开
      if (i === 6) {
        try {
          await ui.click('css=[data-testid="sidebar-view-tablist"] button[title="文件"]', { timeoutMs: 8_000 })
          await ui.click('css=[data-testid^="file-tree-file-"]', { timeoutMs: 8_000 })
          await ui.expectVisible('testid=drawer-panel', { timeoutMs: 10_000 })
          const before = await page.evaluate(METRICS_FN)
          // 给回流 + 跟随收敛留出观察拍：后续采样承担 A12 断言
          const afterWait = await (async () => {
            await new Promise((r) => setTimeout(r, 600))
            return page.evaluate(METRICS_FN)
          })()
          shrinkEffect = {
            shBefore: before?.sh ?? null,
            shAfter: afterWait?.sh ?? null,
            delta: before && afterWait ? afterWait.sh - before.sh : null,
          }
          shrinkAt = i
          ev.step({ step: 'a12.shrink.drawer', channel: 'A', exitCode: 0, stats: shrinkEffect })
        } catch (e) {
          // 缩窗入口不可达：如实登记 uncovered（A12 降级），不硬凑通过
          uncovered.push(`A12 缩窗入口不可达（文件 tab / 文件行 / drawer-panel 超时）：${String(e?.message ?? e).slice(0, 200)}`)
          ev.step({ step: 'a12.shrink.drawer', channel: 'A', exitCode: 1, stats: { error: String(e?.message ?? e).slice(0, 200) } })
        }
      }
      const m = await page.evaluate(METRICS_FN)
      if (m) samples.push({ i, ...m })
      await new Promise((r) => setTimeout(r, 250))
    }

    // 断言 1（A2 前半）：采样次数足额
    ev.assert('A2: 采样 ≥10 次（间隔 ≥200ms）', samples.length >= 10, {
      channel: 'A',
      expected: '>= 10',
      actual: String(samples.length),
    })

    // 断言 2（A2 主判据）：全程贴底（收缩前的采样全判；收缩后单独判）
    const preShrink = shrinkAt > 0 ? samples.slice(0, shrinkAt) : samples
    const postShrink = shrinkAt > 0 ? samples.slice(shrinkAt + 1) : []
    const preStick = preShrink.filter((s) => s.d <= BOTTOM_THRESHOLD).length
    ev.assert('A2: 流式期间采样 distance 全程 ≤ 40（贴底判据）', preShrink.length > 0 && preStick === preShrink.length, {
      channel: 'A',
      expected: `${preShrink.length}/${preShrink.length} 样本 distance ≤ 40`,
      actual: `${preStick}/${preShrink.length}（最大 d=${Math.max(...preShrink.map((s) => s.d), 0)}）`,
    })

    // 断言 3（A2 后半）：末条内容持续可见于视口底部
    const lastGaps = preShrink.map((s) => s.lastGap).filter((g) => g !== null && g !== undefined)
    const gapOk = lastGaps.length > 0 && lastGaps.every((g) => g <= LAST_TURN_GAP_TOLERANCE)
    ev.assert('A2: 末条 turn 持续可见于视口底部（rect.bottom 距容器底 ≤ 64px）', gapOk, {
      channel: 'A',
      expected: `每次采样 lastGap ≤ ${LAST_TURN_GAP_TOLERANCE}px`,
      actual: `样本 ${lastGaps.length} 个，最大 lastGap=${lastGaps.length ? Math.max(...lastGaps).toFixed(1) : 'n/a'}px`,
    })

    // 断言 4（A12）：收缩真实发生 + 收缩后仍贴底
    if (shrinkEffect && shrinkAt > 0) {
      const shChanged = Math.abs(shrinkEffect.delta ?? 0) >= 50
      ev.assert('A12: 收缩真实发生（抽屉打开后 scrollHeight 回流变化 ≥50px）', shChanged, {
        channel: 'A',
        expected: '|ΔscrollHeight| ≥ 50px',
        actual: `Δ=${shrinkEffect.delta}px（shBefore=${shrinkEffect.shBefore} → shAfter=${shrinkEffect.shAfter}）`,
      })
      const postStick = postShrink.filter((s) => s.d <= BOTTOM_THRESHOLD).length
      ev.assert('A12: 收缩窗口后末条仍贴底（收缩后采样 distance 收敛 ≤ 40）', postShrink.length > 0 && postStick >= postShrink.length - 1 && samples[samples.length - 1].d <= BOTTOM_THRESHOLD, {
        channel: 'A',
        expected: `收缩后 ${postShrink.length} 个采样至多 1 个瞬态越阈，且末采样 ≤ 40`,
        actual: `${postStick}/${postShrink.length}（d 序列：${postShrink.map((s) => s.d.toFixed(0)).join(',')}）`,
      })
      ev.step({ step: 'a12.assert', channel: 'A', exitCode: shChanged && postStick >= postShrink.length - 1 ? 0 : 1, stats: { postShrinkDs: postShrink.map((s) => Number(s.d.toFixed(1))) } })
      // 收尾：关抽屉恢复布局
      try {
        await ui.click('testid=drawer-close', { timeoutMs: 5_000 })
      } catch { /* 收尾动作失败不影响判定 */ }
    } else {
      ev.step({ step: 'a12.assert', channel: 'A', exitCode: 1, stats: { skipped: '收缩未发生（见 uncovered）' } })
    }

    ev.attach('stick-samples.json', JSON.stringify(samples, null, 2))
    await ev.shot(await instance.page(), 'stick-shrink-sampled')

    // 回合收尾（清态；断言随 B 通道 sanity）
    const end = await protocol.waitTurnEnd(sid, { since, timeoutMs: 180_000 })
    ev.assert('B: 长流式回合正常收尾', end.type === 'message.complete' && end.ok, {
      channel: 'B',
      expected: 'message.complete 非 error',
      actual: `${end.type} stop=${end.payload?.stopReason ?? 'n/a'}`,
    })

    log(`done sid=${sid} samples=${samples.length} preShrinkStick=${preStick}/${preShrink.length} shrink=${Boolean(shrinkEffect)}`)
  }
  return { uncovered, gotchas }
}
