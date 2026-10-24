/**
 * p1-plugin-a7-text-input —— D3 验收场景 A7（设计 S7/D8）：text-input 输入回传 + 输入状态保持。
 *
 * 装配：自建隔离实例 + demo fixture 插件（detail-extra 树含 text-input(demo-pat) 与
 * 「确认回传」action-bar；uiEvent 变更只更新插件侧最新值，重推仅由确认命令触发——
 * D8「输入 + 确认」组合契约）+ config.setProvider 预置 demo-wool 条目。
 *
 * 路径：
 *   展开 demo 条目 → detail-extra 区 text-input 可见 → 初始无「已回传」行 →
 *   fill 哨兵值 DEMO-PAT-9K4（真 <input>，uiEvent change 即回传插件）→
 *   点确认回传按钮（gui-action-bar-item-demo-confirm → plugin.executeCommand）→
 *   插件推新树：「已回传: DEMO-PAT-9K4」出现（uiEvent 值回传 + 新树渲染闭环）→
 *   输入状态保持：输入框值仍为哨兵（插件重推 value 回显覆盖本地镜像，S7 语义）→
 *   B：plugin.ui.snapshot 树含回显 value 与已回传行（runtime 快照第二视角）。
 *
 * 锚点事实（源码已核对）：输入框 testid = gui-text-input-field-<id>（TextInput.vue，原生
 * <input>，fill 合法）；事件名固定 'change'（组件唯一事件形态）；值回传 provide 出口在
 * ProviderRowCard（pluginId = 条目归属插件）；action-bar item testid =
 * gui-action-bar-item-<item.id>（Actionbar.vue）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import {
  launchFixtureInstance,
  waitPluginActive,
  seedDemoProvider,
  openProviderPage,
  demoCardSelector,
  expandDemoProviderRow,
  pollUntil,
  DEMO_PLUGIN_ID,
  DEMO_PROVIDER_ID,
  DETAIL_EXTRA_MOUNT,
  PAT_INPUT_ID,
  CONFIRM_ACTION_ID,
} from './lib/plugin-provider-fixture.mjs'

const PAT_SENTINEL = 'DEMO-PAT-9K4'

export const meta = {
  id: 'p1-plugin-a7-text-input',
  priority: 'P1',
  title: 'D3/A7（设计 S7/D8）：text-input 输入 → uiEvent 回传 → 确认推新树（已回传行）→ 输入状态保持',
  covers: ['settings.provider', 'plugin.list'],
  requires: [],
  estimateSec: 200,
  provable: [
    'A: detail-extra 区插件 text-input 可输入（gui-text-input-field-demo-pat 可 fill）',
    'A: 初始树无「已回传」行；点确认回传后出现「已回传: <哨兵>」（uiEvent 值回传 + 插件推新树 + 渲染闭环）',
    'A: 输入状态保持：确认后输入框值仍为哨兵（插件重推 value 回显，宿主本地镜像跟随）',
    'B: plugin.ui.snapshot 的 detail-extra 树含已回传行与回显 value（runtime 快照与渲染同源）',
  ],
  notProvable: [
    'uiEvent 通道丢帧语义（fire-and-forget 的故障注入分支——单条丢失由下一条变更覆盖属协议注释语义，无脚本化注入通道）',
    'Qoder PAT 真实入口（设计 S7 demo-only 取舍：真实触发前提是上游改加密的不可控失败态，组件通路以 demo 覆盖）',
  ],
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    'text-input 值权威在插件侧（fire-and-forget 回传，变更不重推）；「插件推新树」由确认命令触发——确认前「已回传」行必须缺席',
    '输入框是原生 <input>（fill 合法）；contenteditable 纪律不适用于本组件',
    '确认后的输入值 = 插件重推的 value 回显 + 宿主本地镜像（TextInput.vue local ref），两路同值才保持',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  let instance = null
  let proto = null
  try {
    const fixture = await launchFixtureInstance({ repo, ev, tag: 'a7' })
    instance = fixture.instance
    proto = fixture.proto
    const ui = createUI({ page: await instance.page(), evidence: ev, repo })
    const page = await instance.page()

    await waitPluginActive(proto, DEMO_PLUGIN_ID)
    await seedDemoProvider(proto, fixture.dataDir, ev)

    // A：展开 → 插件输入组件可见
    await openProviderPage(ui)
    const card = demoCardSelector()
    await ui.expectVisible(`${card} [data-testid="provider-plugin-badge"]`)
    await expandDemoProviderRow(ui)
    const boundary = `${card} [data-testid="provider-detail-extra-boundary"]`
    await ui.expectVisible(boundary)
    const inputSel = `testid=gui-text-input-field-${PAT_INPUT_ID}`
    await ui.expectVisible(inputSel, { timeoutMs: 20_000 })

    // 初始：无「已回传」行（确认前插件不重推）
    const initialText = await ui.text(boundary)
    ev.assert('A: 初始树无「已回传」行（重推仅由确认命令触发）', !initialText.includes('已回传'), {
      channel: 'A',
      expected: '初始树无已回传行',
      actual: initialText.includes('已回传') ? '已出现（插件在确认前重推了）' : '未出现',
    })

    // 输入哨兵 → uiEvent change 回传插件（fire-and-forget）
    await ui.fill(inputSel, PAT_SENTINEL)
    ev.step({ step: 'text-input.fill', channel: 'A', exitCode: 0, stats: { value: PAT_SENTINEL } })

    // 点确认回传 → 插件推新树 → 「已回传: <哨兵>」渲染
    await ui.click(`testid=gui-action-bar-item-${CONFIRM_ACTION_ID}`)
    const confirmed = await pollUntil(async () => {
      const text = await ui.text(boundary)
      return text.includes(`已回传: ${PAT_SENTINEL}`)
    }, { timeoutMs: 15_000 })
    ev.assert('A: 确认后插件推新树（已回传: <哨兵> 渲染）', confirmed !== null, {
      channel: 'A',
      expected: `已回传: ${PAT_SENTINEL}`,
      actual: confirmed !== null ? '命中' : `15s 未出现（uiEvent 回传或重推链路断，现场见截图）`,
    })
    await ui.screenshot('a7-confirmed-echo')

    // 输入状态保持：插件重推 value 回显后输入框仍为哨兵
    const inputValue = await page.evaluate((id) => {
      const el = document.querySelector(`[data-testid="gui-text-input-field-${id}"]`)
      return el instanceof HTMLInputElement ? el.value : `(tag=${el?.tagName ?? 'missing'})`
    }, PAT_INPUT_ID)
    ev.assert('A: 输入状态保持（确认后输入框值仍为哨兵）', inputValue === PAT_SENTINEL, {
      channel: 'A',
      expected: PAT_SENTINEL,
      actual: inputValue,
    })
    ev.attach('a7-input-value', inputValue)

    // B：runtime 快照第二视角（树含已回传行 + 回显 value）
    const snapshot = await proto.call(
      'plugin.ui.snapshot',
      { mountId: DETAIL_EXTRA_MOUNT, pluginId: DEMO_PLUGIN_ID, viewId: DETAIL_EXTRA_MOUNT },
      { replyType: 'plugin:uiSnapshot', timeoutMs: 30_000 },
    )
    const snapshotText = JSON.stringify(snapshot?.views ?? [])
    ev.assert('B: 快照树含已回传行与回显 value（与渲染同源）', snapshotText.includes(`已回传: ${PAT_SENTINEL}`) && snapshotText.includes(PAT_SENTINEL), {
      channel: 'B',
      expected: 'views 内含已回传行 + value 回显',
      actual: `views=${snapshot?.views?.length ?? 0} 已回传=${snapshotText.includes(`已回传: ${PAT_SENTINEL}`)}`,
    })
    ev.attach('a7-ui-snapshot', JSON.stringify(snapshot, null, 2).slice(0, 4_000))

    log('a7 done')
  } finally {
    try {
      await proto?.close()
    } catch { /* ignore */ }
    if (instance) {
      await instance.dispose()
      try {
        fs.rmSync(instance.dataDir, { recursive: true, force: true })
      } catch { /* 清理失败由证据目录暴露 */ }
    }
  }
  return { uncovered, gotchas }
}
