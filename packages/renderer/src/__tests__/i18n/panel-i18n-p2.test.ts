/**
 * i18n-frontend-p2 U5 + U6: panel + sidebar 关键 UI 走 i18n（W3 + W4）。
 *
 * U5: GitPanel en-US locale 下 Stage/Unstage/Commit 按钮显示英文，pill 显示 Dirty。
 * U6: Sidebar zh-CN locale 下 sessionList 错误态重试按钮 === '重试'，SegmentedTab tab label 走 i18n。
 *
 * 验证策略：i18n key 的 en-US/zh-CN 值 + 源码 readFileSync 确认模板走 t()（不 mount 组件，
 * 避免 git provide/store 完整 mock 的脆弱性）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import i18n, { setLocale } from '@/i18n'

describe('U5: GitPanel en-US locale 显示英文按钮 + 状态 pill', () => {
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

describe('U6: Sidebar zh-CN locale + SegmentedTab tab label i18n', () => {
  it('sessionList 错误态重试按钮 === \'重试\'（zh-CN）', async () => {
    await setLocale('zh-CN')
    expect(i18n.global.t('sidebar.retry')).toBe('重试')
  })

  it('SegmentedTab tab label 走 i18n key（subagent/workflow 已新增 key）', async () => {
    await setLocale('zh-CN')
    const subagentLabel = i18n.global.t('sidebar.segmentedTab.subagent')
    const workflowLabel = i18n.global.t('sidebar.segmentedTab.workflow')
    expect(subagentLabel).toBeTruthy()
    expect(workflowLabel).toBeTruthy()
    // 不应回退到 key 本身（说明 key 缺失）
    expect(subagentLabel).not.toBe('sidebar.segmentedTab.subagent')
    expect(workflowLabel).not.toBe('sidebar.segmentedTab.workflow')
  })

  it('SegmentedTab.vue 源码不再含 \'Agents\' / \'Flows\' 硬编码字面量', () => {
    const source = readFileSync(
      resolve(__dirname, '../../components/sidebar/SegmentedTab.vue'),
      'utf-8',
    )
    expect(source).not.toMatch(/label:\s*['"]Agents['"]/)
    expect(source).not.toMatch(/label:\s*['"]Flows['"]/)
  })
})
