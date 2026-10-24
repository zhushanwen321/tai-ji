/**
 * p1-plugin-a1-family-cards —— D3 验收场景 A1（设计 S1）：插件 Provider 入口与家族卡。
 *
 * 装配：自建隔离实例（verify-d3-s1 家族）+ launch 前 seed demo fixture 插件与清单缓存
 * （scenarios/lib/plugin-provider-fixture.mjs；权限预置 = 审批落盘同文件，等价已批准态）。
 *
 * 路径：
 *   B：plugin.list 含 demo-wool（fixture 被 registry 扫描）→
 *   B：plugin.listAvailable 三条目、demo-wool installed=true（清单 ⊕ 本地已装比对）→
 *   A：设置 → Provider 页 → 「添加供应商 ▾」菜单三入口并列（内置模板/自定义/插件 Provider，
 *   D1）→ 点「插件 Provider」→ plugin-provider-flow 对话框 → 家族卡网格 3 张 →
 *   DemoWool 卡（已装徽标 + 厂商/授权方式/模型数）与 B/C 卡（「需要先安装插件」引导）→
 *   A↔B 对账：卡片数 = 清单条目数。
 *
 * 锚点事实（源码已核对）：菜单 testid = add-menu-builtin / add-menu-custom / add-menu-plugin
 * （ProviderTemplatePicker.vue）；家族卡 = plugin-family-card / plugin-family-installed
 * （PluginProviderFlow.vue）；已装判定文案「已安装」、未装引导「需要先安装插件」、
 * 授权方式「读取本机登录态」（ide-extract）/「需在浏览器授权」（oauth）——i18n
 * zh-CN/pluginProvider.ts。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

import {
  launchFixtureInstance,
  DEMO_PLUGIN_ID,
} from './lib/plugin-provider-fixture.mjs'

export const meta = {
  id: 'p1-plugin-a1-family-cards',
  priority: 'P1',
  title: 'D3/A1（设计 S1）：添加供应商菜单三入口并列 + 清单驱动的插件家族卡（已装/未装两态）',
  covers: ['settings.provider', 'plugin.list'],
  requires: [],
  estimateSec: 200,
  provable: [
    'C: fixture 插件落盘 <dataDir>/plugins/demo-wool + 清单缓存落盘（launch 前 seed，证据 stats）',
    'B: plugin.list 含 demo-wool（registry 扫描生效）',
    'B: plugin.listAvailable 三条目，demo-wool installed=true、demo-wool-b/c installed=false（清单 ⊕ 本地已装比对）',
    'A: 「添加供应商 ▾」菜单三入口并列（add-menu-builtin / add-menu-custom / add-menu-plugin，D1）',
    'A: 插件 Provider 流程对话框打开，家族卡 3 张，卡片数 = 清单条目数（A↔B 对账）',
    'A: DemoWool 卡含已装徽标（plugin-family-installed）+ 厂商/授权方式/模型数；未装卡含「需要先安装插件」引导',
  ],
  notProvable: [
    '清单远程热更新链（本剧本用节流窗内缓存 seed，不发远程请求——远程拉取归 S15）',
    '未装家族卡的安装动作（点击会走 npm 拉取，离线不可达——安装链归 S8/S18/S27 剧本族）',
    '真实羊毛三家家族卡（需 tai-ji-plugin 仓产物 + 远程清单，本剧本用 demo 清单验证宿主渲染契约）',
  ],
}

export async function run(ctx) {
  const { ev, log, repo } = ctx
  const uncovered = []
  const gotchas = [
    '家族卡数据源 = plugin.listAvailable（清单 ⊕ registry 已装版本比对），不是 plugin.list；卡片 installed 徽标依赖插件目录真实在场',
    '清单缓存 envelope 的 checkedAt 在 4h 节流窗内 → runtime 直用 seed 数据、不发远程请求（确定性）；数据目录一次性，run 后整删',
    '菜单项在 Popover portal（挂 body），全局查询命中；不要限定在触发按钮子树内找',
  ]
  const { createUI } = await import(path.join(SKILL_ROOT, 'scripts', 'lib', 'ui.mjs'))
  let instance = null
  let proto = null
  try {
    // ── 装配 ────────────────────────────────────────────────
    const fixture = await launchFixtureInstance({ repo, ev, tag: 'a1' })
    instance = fixture.instance
    proto = fixture.proto
    const ui = createUI({ page: await instance.page(), evidence: ev, repo })

    // B：registry 扫描到 fixture 插件（plugin.list；状态不强求 active——家族卡只依赖清单）
    const listed = await proto.call('plugin.list', {})
    const demoInfo = (listed.plugins ?? []).find((p) => p.pluginId === DEMO_PLUGIN_ID)
    ev.assert('B: plugin.list 含 demo-wool（fixture 被 registry 扫描）', Boolean(demoInfo), {
      channel: 'B',
      expected: `${DEMO_PLUGIN_ID} 在列表`,
      actual: demoInfo ? `status=${demoInfo.status} trust=${demoInfo.trustLevel}` : `ids=${(listed.plugins ?? []).map((p) => p.pluginId).join(',')}`,
    })

    // B：清单可安装视图（家族卡数据源）
    const available = await proto.call('plugin.listAvailable', {})
    const plugins = available.plugins ?? []
    const demo = plugins.find((p) => p.pluginId === DEMO_PLUGIN_ID)
    ev.assert('B: plugin.listAvailable 三条目且 demo-wool installed=true', plugins.length === 3 && demo?.installed === true, {
      channel: 'B',
      expected: '3 条目；demo-wool installed=true',
      actual: `count=${plugins.length} demo-wool.installed=${demo?.installed}`,
    })
    const uninstalled = plugins.filter((p) => p.pluginId !== DEMO_PLUGIN_ID)
    ev.assert('B: demo-wool-b/c installed=false（未装家族卡数据源）', uninstalled.length === 2 && uninstalled.every((p) => p.installed === false), {
      channel: 'B',
      expected: 'b/c 均 installed=false',
      actual: uninstalled.map((p) => `${p.pluginId}:${p.installed}`).join(','),
    })
    ev.attach('a1-list-available', JSON.stringify(plugins.map((p) => ({
      pluginId: p.pluginId, installed: p.installed, family: p.family, modelCount: p.family?.modelCount,
    })), null, 2))

    // ── A：入口菜单三入口并列（D1） ──────────────────────────
    await ui.click('testid=sidebar-settings')
    await ui.expectVisible('testid=settings-nav-provider')
    await ui.click('testid=settings-nav-provider')
    await ui.expectVisible('testid=provider-list-header')
    ev.step({ step: 'open-provider-page', channel: 'A', exitCode: 0, stats: {} })

    await ui.click('testid=provider-template-picker')
    await ui.expectVisible('testid=add-menu-builtin')
    await ui.expectVisible('testid=add-menu-custom')
    await ui.expectVisible('testid=add-menu-plugin')
    const menuHtml = await ui.html('testid=add-menu-plugin')
    ev.assert('A: 菜单三入口并列（内置模板/自定义/插件 Provider）', menuHtml.length > 0, {
      channel: 'A',
      expected: 'add-menu-builtin / add-menu-custom / add-menu-plugin 三项同时可见',
      actual: '三项均命中（add-menu-plugin html 长度 ' + menuHtml.length + '）',
    })
    await ui.screenshot('a1-add-menu')

    // ── A：家族卡网格 ────────────────────────────────────────
    await ui.click('testid=add-menu-plugin')
    await ui.expectVisible('testid=plugin-provider-flow')
    await ui.expectVisible('testid=plugin-family-grid')
    await ui.expectCount('testid=plugin-family-card', 3)
    ev.assert('A: 家族卡 3 张（= 清单条目数，A↔B 对账）', true, {
      channel: 'A',
      expected: 'plugin-family-card × 3',
      actual: 'plugin.listAvailable plugins.length=3',
    })

    // 已装卡：demo-wool（唯一的 plugin-family-installed 徽标持有者）
    const installedCard = 'css=[data-testid="plugin-family-card"]:has([data-testid="plugin-family-installed"])'
    await ui.expectVisible(installedCard)
    const installedText = await ui.text(installedCard)
    const installedChecks = {
      displayName: installedText.includes('DemoWool'),
      vendor: installedText.includes('演示厂商'),
      credentialSource: installedText.includes('读取本机登录态'),
      modelCount: installedText.includes('3 个可用模型'),
      installedBadge: installedText.includes('已安装'),
    }
    ev.assert('A: DemoWool 卡含名称/厂商/授权方式/模型数/已装徽标', Object.values(installedChecks).every(Boolean), {
      channel: 'A',
      expected: 'DemoWool + 演示厂商 + 读取本机登录态 + 3 个可用模型 + 已安装',
      actual: JSON.stringify(installedChecks),
    })

    // 未装卡：引导文案两处 + oauth 授权方式
    const gridText = await ui.text('testid=plugin-family-grid')
    const hintCount = (gridText.match(/需要先安装插件/g) ?? []).length
    ev.assert('A: 未装卡含「需要先安装插件」引导 ×2 + oauth 授权方式文案', hintCount === 2 && gridText.includes('需在浏览器授权'), {
      channel: 'A',
      expected: '引导 ×2（B/C 卡）+「需在浏览器授权」（oauth 家族）',
      actual: `hintCount=${hintCount} oauthText=${gridText.includes('需在浏览器授权')}`,
    })
    ev.attach('a1-family-grid-text', gridText)
    await ui.screenshot('a1-family-cards')

    log('a1 done')
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
