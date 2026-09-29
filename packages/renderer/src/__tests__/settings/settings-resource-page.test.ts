/**
 * SettingsResourcePage 刷新扫描测试（ADR-0021 §5 只读预览模型的扫描入口）。
 *
 * 覆盖：
 *  - skill 页点「刷新」→ transport.scanSkills 被调，且只传 enabled 目录路径（目录级管道模型）；
 *  - agent 页点「刷新」→ transport.scanAgents 被调（kind 驱动的 API 内聚差异）。
 *
 * mock 策略：
 *  - SettingsTransport seam 桩（makeSettingsTransportStub + overrides 注入 scan 两键，[C3]）；
 *  - '@/api/domains/settings' mock getDataDir（undefined → user 级强制目录不展示）与
 *    chooseDirectory（LoadPaths 的目录选择 dialog 缝）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/settings-resource-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import type { SkillDirConfig } from '@taiji/shared'

const scanMock = vi.hoisted(() => ({
  scanSkills: vi.fn(() => Promise.resolve([])),
  scanAgents: vi.fn(() => Promise.resolve([])),
}))

vi.mock('@/api/domains/settings', () => ({
  getDataDir: vi.fn(async () => undefined),
  chooseDirectory: vi.fn(async () => null),
}))

import SettingsResourcePage from '@/components/settings/resource/SettingsResourcePage.vue'

let wrapper: ReturnType<typeof mount> | null = null

const DIRS: SkillDirConfig[] = [
  { path: '/enabled/first', enabled: true, scope: 'global' },
  { path: '/disabled/second', enabled: false, scope: 'global' },
  { path: '/enabled/third', enabled: true, scope: 'global' },
]

function mountPage(kind: 'skill' | 'agent') {
  return mount(SettingsResourcePage, {
    props: { kind, items: [], dirs: DIRS },
    attachTo: document.body,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  scanMock.scanSkills.mockClear()
  scanMock.scanAgents.mockClear()
  provideSettingsTransport(makeSettingsTransportStub(scanMock))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SettingsResourcePage 刷新扫描（transport seam）', () => {
  it('skill 页点「刷新」→ scanSkills 只传 enabled 目录路径', async () => {
    wrapper = mountPage('skill')
    await flushPromises()

    const refreshBtn = wrapper.findAll('button').find((b) => b.text() === '刷新')
    expect(refreshBtn).toBeTruthy()
    await refreshBtn!.trigger('click')
    await flushPromises()

    expect(scanMock.scanSkills).toHaveBeenCalledTimes(1)
    expect(scanMock.scanSkills).toHaveBeenCalledWith(['/enabled/first', '/enabled/third'])
    expect(scanMock.scanAgents).not.toHaveBeenCalled()
  })

  it('agent 页点「刷新」→ scanAgents 被调（kind 驱动 API 差异内聚）', async () => {
    wrapper = mountPage('agent')
    await flushPromises()

    const refreshBtn = wrapper.findAll('button').find((b) => b.text() === '刷新')
    expect(refreshBtn).toBeTruthy()
    await refreshBtn!.trigger('click')
    await flushPromises()

    expect(scanMock.scanAgents).toHaveBeenCalledTimes(1)
    expect(scanMock.scanAgents).toHaveBeenCalledWith(['/enabled/first', '/enabled/third'])
    expect(scanMock.scanSkills).not.toHaveBeenCalled()
  })
})
