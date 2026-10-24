/**
 * p1-plugin-a5-no-status-guessing —— D3 验收场景 A5（设计 S5，负面验证）：
 * 宿主不猜测凭据状态——从不上报状态的 demo 插件条目默认态。
 *
 * 装配：自建隔离实例（verify-d3-s1 家族）+ launch 前 seed demo fixture 插件
 * （getStatus 恒返回 null、从不 events.report——契约见 fixtures/plugin-provider/demo-wool.index.js）
 * + config.setProvider 预置 demo-wool provider 条目（宿主写策略链 = 真实落盘路径）。
 *
 * 路径：
 *   B：plugin.invoke getStatus → result null（插件明确「未上报」，两次校验含 providerId 参数）→
 *   C：models.json 落盘 demo-wool 条目 →
 *   A：Provider 页 demo 行被识别为插件来源（provider-plugin-badge 在场 = entryOfProvider 命中，
 *   展开时 pullStatus 链路真实被触发的前提）→ 展开条目 → provider-plugin-status 零 DOM
 *   （条件窗口轮询：出现即判负）→ 状态点非失效配色 + 常驻「重新授权」按钮在场（D5 正面）。
 *
 * 锚点事实（源码已核对）：provider-plugin-status 仅在 credentialStatus 非 undefined 时渲染
 * （ProviderRowCard.vue，undefined = 未上报/未拉取 → 零 DOM）；provider-reauthorize-btn
 * 为插件条目常驻动作（不判断是否失效，D5）；statusOf 仅由 pullStatus（invoke getStatus）与
 * plugin:event（CREDENTIAL_STATUS_CHANNEL 上报）两个入口写入（PluginProviderSource.ts）。
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
} from './lib/plugin-provider-fixture.mjs'

export const meta = {
  id: 'p1-plugin-a5-no-status-guessing',
  priority: 'P1',
  title: 'D3/A5（设计 S5 负面）：从不上报状态的 demo 条目——无失效标记零 DOM、状态点默认、常驻重新授权按钮',
  covers: ['settings.provider', 'plugin.list'],
  requires: [],
  estimateSec: 200,
  provable: [
    'B: plugin.invoke getStatus(demo-wool, {providerId}) 返回 null（插件明确「未上报」，通路可达即插件 active）',
    'C: config.setProvider 落盘 models.json demo-wool 条目（含 apiKey）',
    'A: demo 行被识别为插件来源条目（provider-plugin-badge 在场）',
    'A: 展开条目后 provider-plugin-status 零 DOM（4s 条件窗口轮询，出现即判负——宿主不猜测、不显示任何失效标记）',
    'A: 行头状态点非失效配色（bg-warn/bg-danger 均不在）+ 常驻「重新授权」按钮在场（D5 正面）',
  ],
  notProvable: [
    'S17 正面（插件上报后的状态点与文案变化）——demo 插件按 S5 契约从不上报，正面链归 S17 剧本',
    '宿主代码内不存在其他猜测路径（穷举证明不可达——本剧本锁定的是用户可见面零标记 + 状态通道双入口均无数据）',
  ],
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    'statusOf 的两个写入入口：pullStatus（展开/页进入 invoke getStatus）与 plugin:event（provider.credentialStatus 上报）——demo 插件两路都给空，零标记即两入口均无数据',
    'pullStatus 对 getStatus 失败的降级 = 保持现状（warn），不阻断展开——所以「插件挂了」与「插件未上报」在 UI 上同为零标记（D5 不猜测语义的推论）',
    'provider-plugin-status 渲染判据 = credentialStatus 非 undefined（ProviderRowCard.vue）；断言零 DOM 而不是断言「空文案」',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  let instance = null
  let proto = null
  try {
    const fixture = await launchFixtureInstance({ repo, ev, tag: 'a5' })
    instance = fixture.instance
    proto = fixture.proto
    const ui = createUI({ page: await instance.page(), evidence: ev, repo })

    // B：getStatus 通路可达（插件 active）且恒返回 null（S5 契约）
    await waitPluginActive(proto, DEMO_PLUGIN_ID)
    const invoke1 = await proto.call('plugin.invoke', {
      pluginId: DEMO_PLUGIN_ID, method: 'getStatus', params: { providerId: DEMO_PROVIDER_ID },
    })
    ev.assert('B: getStatus 返回 null（插件明确「未上报」）', invoke1?.result === null, {
      channel: 'B',
      expected: 'result === null',
      actual: JSON.stringify(invoke1?.result ?? invoke1)?.slice(0, 200),
    })

    // provider 条目预置（宿主写策略链）+ C 落盘对照
    await seedDemoProvider(proto, fixture.dataDir, ev)

    // A：识别 + 展开
    await openProviderPage(ui)
    const card = demoCardSelector()
    await ui.expectVisible(card)
    await ui.expectVisible(`${card} [data-testid="provider-plugin-badge"]`)
    ev.assert('A: demo 行被识别为插件来源条目（provider-plugin-badge）', true, {
      channel: 'A',
      expected: 'provider-plugin-badge 在场（entryOfProvider 命中 → 展开时 pullStatus 真实触发）',
      actual: '徽标在场',
    })
    await expandDemoProviderRow(ui)
    await ui.expectVisible(`${card} [data-testid="provider-reauthorize-btn"]`)
    await ui.screenshot('a5-expanded-no-status')

    // 负面断言：4s 条件窗口内 provider-plugin-status 保持零 DOM（出现立即判负）
    const page = await instance.page()
    const appeared = await pollUntil(async () => {
      const n = await page.locator('[data-testid="provider-plugin-status"]').count()
      return n > 0
    }, { timeoutMs: 4_000 })
    ev.assert('A: provider-plugin-status 零 DOM（宿主不猜测，无任何失效标记）', appeared === null, {
      channel: 'A',
      expected: '4s 窗口内保持 0（未上报 → 零 DOM）',
      actual: appeared === null ? '窗口内保持 0' : '出现失效标记行（宿主猜测了状态）',
    })

    // 状态点默认配色（非失效）+ 常驻重新授权按钮
    const dotClass = await page.evaluate((name) => {
      const cardEl = [...document.querySelectorAll('[data-testid="provider-card"]')]
        .find((el) => el.textContent?.includes(name))
      const dot = cardEl?.querySelector('span.size-\\[7px\\]')
      return dot?.getAttribute('class') ?? '(dot not found)'
    }, 'DemoWool (verify fixture)')
    const dotNeutral = !dotClass.includes('bg-warn') && !dotClass.includes('bg-danger')
    ev.assert('A: 行头状态点非失效配色（保持默认）', dotNeutral, {
      channel: 'A',
      expected: 'class 不含 bg-warn / bg-danger',
      actual: dotClass,
    })
    ev.assert('A: 常驻「重新授权」按钮在场（D5：不判断是否失效）', true, {
      channel: 'A',
      expected: 'provider-reauthorize-btn 在场',
      actual: '在场',
    })
    ev.attach('a5-status-dot-class', dotClass)

    log('a5 done')
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
