/**
 * i18n 翻译值 smoke（原 panel-i18n-p2 / thinking-levels-i18n / w3-i18n-keys 三文件并入——
 * 同质同构：无 mock、直 import locale 模块或 i18n 单例，锁「key 存在 + 翻译值」双语文案）。
 *
 * 覆盖：
 * - panel.git 按钮与状态 pill 的 en-US 值 + 源码 t() 接线（GitPanel）
 * - SideDrawer tab / SegmentedTab label 走 i18n key（不回退 key 本身）
 * - SegmentedTab.vue 不再含 'Agents'/'Flows' 英文硬编码（locale-sync-check U8 只防 CJK，
 *   此断言是其英文侧补集）
 * - thinking-levels 7 档 labelKey 完整 + getDisplayLabel 双语值 + minimal 补齐（U10）
 * - THINKING_STRATEGIES 3 项 labelKey + en-US 值
 * - sidebar.update 命名空间双语存在（useAppUpdate.ts:101 动态组装
 *   `sidebar.update.${mapped}`，escape 出 locale-key-usage-guard 的字面扫描，本文件是
 *   该命名空间唯一存在性守卫）+ 插值占位符（{version}/{from}/{to}）
 * - settings.update testProxy keys 完整性
 * - landing 模式改名（D4）值的回归锁定：`newTask.presetSelect.*` 用「模式」措辞
 *   （R3 补完——landing 侧曾漏改，改名落地无测试覆盖即会再次回退）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/i18n/i18n-value-smoke.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import i18n, { setLocale } from '@/i18n'
import zhCN from '@/i18n/locales/zh-CN/sidebar'
import enUS from '@/i18n/locales/en-US/sidebar'
import zhCNSettings from '@/i18n/locales/zh-CN/settings'
import enUSSettings from '@/i18n/locales/en-US/settings'
import zhNewTask from '@/i18n/locales/zh-CN/newTask'
import enNewTask from '@/i18n/locales/en-US/newTask'
import {
  THINKING_LEVELS,
  getDisplayLabel,
} from '@/components/panel/thinking-levels'
import { THINKING_STRATEGIES } from '@taiji/core'

// ── panel（原 panel-i18n-p2.test.ts U5）──

describe('GitPanel en-US locale 显示英文按钮 + 状态 pill', () => {
  it('Stage / Unstage / Commit 三按钮英文文案 + 源码走 t()', async () => {
    await setLocale('en-US')
    expect(i18n.global.t('panel.git.stage')).toBe('Stage')
    expect(i18n.global.t('panel.git.unstage')).toBe('Unstage')
    expect(i18n.global.t('panel.git.commit')).toBe('Commit')
    // 源码验证模板走 t() 调用（非硬编码）
    const source = readFileSync(
      resolve(__dirname, '../../components/panel/GitPanel.vue'),
      'utf-8',
    )
    expect(source).toContain("t('panel.git.stage')")
    expect(source).toContain("t('panel.git.unstage')")
    expect(source).toContain("t('panel.git.commit')")
  })

  it('状态 pill en-US 值: Clean / Staged / Dirty / Conflict', async () => {
    await setLocale('en-US')
    expect(i18n.global.t('panel.git.pillClean')).toBe('Clean')
    expect(i18n.global.t('panel.git.pillStaged')).toBe('Staged')
    expect(i18n.global.t('panel.git.pillDirty')).toBe('Dirty')
    expect(i18n.global.t('panel.git.pillConflict')).toBe('Conflict')
  })

  it('SideDrawer 5 tab label 走 i18n key', async () => {
    await setLocale('en-US')
    // tabTerminal / tabBrowser / tabGit / tabDoc / tabDetail key 存在且非空
    for (const k of ['tabTerminal', 'tabBrowser', 'tabGit', 'tabDoc', 'tabDetail']) {
      const label = i18n.global.t(`panel.sideDrawer.${k}`)
      expect(label).toBeTruthy()
      expect(label).not.toBe(`panel.sideDrawer.${k}`)
    }
  })
})

// ── sidebar（原 panel-i18n-p2.test.ts U6）──

describe('Sidebar zh-CN locale + SegmentedTab tab label i18n', () => {
  it('sessionList 错误态重试按钮 === \'重试\'（zh-CN）', async () => {
    await setLocale('zh-CN')
    expect(i18n.global.t('sidebar.retry')).toBe('重试')
  })

  it('SegmentedTab tab label 走 i18n key（三 tab 终态：session/file/plugin）', async () => {
    await setLocale('zh-CN')
    const sessionLabel = i18n.global.t('sidebar.segmentedTab.session')
    const fileLabel = i18n.global.t('sidebar.segmentedTab.file')
    const pluginLabel = i18n.global.t('sidebar.segmentedTab.plugin')
    expect(sessionLabel).toBeTruthy()
    expect(fileLabel).toBeTruthy()
    expect(pluginLabel).toBeTruthy()
    // 不应回退到 key 本身（说明 key 缺失）
    expect(sessionLabel).not.toBe('sidebar.segmentedTab.session')
    expect(fileLabel).not.toBe('sidebar.segmentedTab.file')
    expect(pluginLabel).not.toBe('sidebar.segmentedTab.plugin')
  })

  it('SegmentedTab.vue 源码不再含 \'Agents\' / \'Flows\' 硬编码字面量', () => {
    const source = readFileSync(
      resolve(__dirname, '../../components/sidebar/SegmentedTab.vue'),
      'utf-8',
    )
    expect(source).not.toMatch(/label:\s*['"]Agents['"]/)
    expect(source).not.toMatch(/label:\s*['"]Flows['"]/)
    // 2026-09-16 三 tab 终态：subagents / workflows 两枚 tab 值不再出现在 tab 定义里
    expect(source).not.toMatch(/value:\s*['"]subagents['"]/)
    expect(source).not.toMatch(/value:\s*['"]workflows['"]/)
  })
})

// ── thinking-levels（原 thinking-levels-i18n.test.ts；死 import ThinkingLevelPopover 已删）──

describe('thinking-levels 数据源 i18n 化', () => {
  it('THINKING_LEVELS 7 档全部带 labelKey 字段', () => {
    expect(THINKING_LEVELS).toHaveLength(7)
    for (const opt of THINKING_LEVELS) {
      expect(opt.labelKey).toBeDefined()
      expect(typeof opt.labelKey).toBe('string')
      expect(opt.labelKey).toMatch(/^composable\.thinkingLevel\./)
    }
  })

  it('en-US + on-off map 时 high 档 currentLabel === \'On\'', async () => {
    await setLocale('en-US')
    // on-off 模式：map 只有 off + high
    const map = { off: 'off', high: 'high' }
    const label = getDisplayLabel('high', map)
    expect(label).toBe('On')
  })

  it('zh-CN + 全档 map 时 high 档 currentLabel === \'高\'', async () => {
    await setLocale('zh-CN')
    const map = { off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }
    const label = getDisplayLabel('high', map)
    expect(label).toBe('高')
  })

  it('THINKING_STRATEGIES 3 项全部带 labelKey 字段', () => {
    expect(THINKING_STRATEGIES).toHaveLength(3)
    for (const s of THINKING_STRATEGIES) {
      expect(s.labelKey).toBeDefined()
      expect(typeof s.labelKey).toBe('string')
      expect(s.labelKey).toMatch(/^composable\.thinkingStrategy\./)
    }
  })

  it('en-US locale 下 THINKING_STRATEGIES 翻译为 All Levels / On / Off / High / Max', async () => {
    await setLocale('en-US')
    const labels = THINKING_STRATEGIES.map((s) => i18n.global.t(s.labelKey!))
    expect(labels).toEqual(['All Levels', 'On / Off', 'High / Max'])
  })

  it('zh-CN/en-US 均存在 composable.thinkingLevel.minimal（pi 七档枚举补齐）', async () => {
    const minimalOpt = THINKING_LEVELS.find((o) => o.level === 'minimal')
    expect(minimalOpt).toBeDefined()
    await setLocale('zh-CN')
    expect(i18n.global.t(minimalOpt!.labelKey)).toBe('极简')
    await setLocale('en-US')
    expect(i18n.global.t(minimalOpt!.labelKey)).toBe('Minimal')
  })
})

// ── sidebar.update / settings.update keys（原 w3-i18n-keys.test.ts）──

describe('sidebar.update / settings.update 双语 keys 存在', () => {
  it('sidebar.update 新增 keys 中英双语存在（含插值占位符）', () => {
    // newVersionWithVersion
    expect(zhCN.update.newVersionWithVersion).toBeDefined()
    expect(enUS.update.newVersionWithVersion).toBeDefined()
    expect(zhCN.update.newVersionWithVersion).toContain('{version}')
    expect(enUS.update.newVersionWithVersion).toContain('{version}')

    // versionTransition
    expect(zhCN.update.versionTransition).toBeDefined()
    expect(enUS.update.versionTransition).toBeDefined()
    expect(zhCN.update.versionTransition).toContain('{from}')
    expect(zhCN.update.versionTransition).toContain('{to}')
    expect(enUS.update.versionTransition).toContain('{from}')
    expect(enUS.update.versionTransition).toContain('{to}')
  })

  it('sidebar.update 原有 keys 仍存在', () => {
    expect(zhCN.update.newVersion).toBeDefined()
    expect(enUS.update.newVersion).toBeDefined()
    expect(zhCN.update.downloading).toBeDefined()
    expect(enUS.update.downloading).toBeDefined()
    expect(zhCN.update.error).toBeDefined()
    expect(enUS.update.error).toBeDefined()
    expect(zhCN.update.retry).toBeDefined()
    expect(enUS.update.retry).toBeDefined()
  })

  it('settings.update testProxy 相关 keys 存在', () => {
    expect(zhCNSettings.update.testProxy).toBeDefined()
    expect(enUSSettings.update.testProxy).toBeDefined()
    expect(zhCNSettings.update.testSuccess).toBeDefined()
    expect(enUSSettings.update.testSuccess).toBeDefined()
    expect(zhCNSettings.update.testFailed).toBeDefined()
    expect(enUSSettings.update.testFailed).toBeDefined()
  })
})

// ── landing 模式改名（D4，设计 `.tmp/tech-design/mode-system-composer-density.md` §6.4）──

describe('landing 改名 D4：newTask.presetSelect 用户可见文案用「模式」', () => {
  it('zh-CN 标题 / 空态不做旧词，锁定 tooltip 用「以「{name}」创建」', async () => {
    await setLocale('zh-CN')
    expect(i18n.global.t('newTask.presetSelect.title')).toBe('选择启动模式')
    expect(i18n.global.t('newTask.presetSelect.noPresets')).toBe('暂无模式')
    // 占位符必须是 {name}（消费方 @taiji/ui PresetSelectChip.vue 传 { name }）
    expect(
      i18n.global.t('newTask.presetSelect.presetLockedTooltip', { name: '调度模式' }),
    ).toBe('此会话以「调度模式」创建，不可更改')
  })

  it('en-US 镜像同义文案（title / 空态 / 锁定 tooltip）', async () => {
    await setLocale('en-US')
    expect(i18n.global.t('newTask.presetSelect.title')).toBe('Launch mode')
    expect(i18n.global.t('newTask.presetSelect.noPresets')).toBe('No modes')
    expect(
      i18n.global.t('newTask.presetSelect.presetLockedTooltip', { name: 'Dispatch' }),
    ).toBe('This session was created with "Dispatch" and cannot be changed')
  })

  it('已改值的叶子不含旧词（zh「预设」/ en "preset"）', () => {
    // 词表断言（不经 t()）：防未来用「旧词 + 模式」这类混合形态绕过
    expect(zhNewTask.presetSelect.title).not.toContain('预设')
    expect(zhNewTask.presetSelect.noPresets).not.toContain('预设')
    expect(zhNewTask.presetSelect.legacySessionTooltip).not.toContain('预设')
    expect(enNewTask.presetSelect.title.toLowerCase()).not.toContain('preset')
    expect(enNewTask.presetSelect.noPresets.toLowerCase()).not.toContain('preset')
    expect(enNewTask.presetSelect.legacySessionTooltip.toLowerCase()).not.toContain('preset')
  })
})
