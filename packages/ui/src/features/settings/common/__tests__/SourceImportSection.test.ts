/**
 * SourceImportSection 组件单测（code-harden RT-5#5 消费面）。
 *
 * 锁定「不可读」三态区分：目录存在但不可读（error='unreadable'）的源渲染「目录不可读」
 * 文案，不渲染「未安装」也不渲染计数——「不可读」≠「未安装」≠「0 个」。
 *
 * i18n 经 vitest.setup mock（t 返回 key，断言 key 形态）；detectSources 经 provide mock。
 * 运行：cd packages/ui && npx vitest run src/features/settings/common/__tests__/SourceImportSection.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SourceImportSection from '../SourceImportSection.vue'
import { SETTINGS_CONFIG_API_KEY } from '../../injection-keys'
import type { SourceDetectResult } from '@taiji/shared'

const K = {
  unreadable: 'settings.loadPaths.importFromAgents.unreadable',
  notInstalled: 'settings.loadPaths.importFromAgents.notInstalled',
  skillCount: 'settings.loadPaths.importFromAgents.skillCount',
} as const

function mountSection(results: SourceDetectResult[]) {
  return mount(SourceImportSection, {
    props: { kind: 'skill' as const, existingDirs: [] },
    global: {
      provide: {
        [SETTINGS_CONFIG_API_KEY]: { detectSources: vi.fn(async () => results) },
      },
    },
  })
}

describe('SourceImportSection · 不可读三态区分（RT-5#5）', () => {
  it('error=unreadable 的源渲染「目录不可读」，不渲染「未安装」也不渲染计数', async () => {
    const wrapper = mountSection([
      { source: 'claude', installed: true, dir: '/home/u/.claude/skills', error: 'unreadable' },
      { source: 'codex', installed: false, dir: '/home/u/.codex/skills' },
      { source: 'pi', installed: true, dir: '/home/u/.pi/agent/skills', skillCount: 3 },
    ])
    await flushPromises()

    const rows = wrapper.findAll('[data-testid="import-candidate"]')
    expect(rows).toHaveLength(3)

    // claude：不可读 → unreadable 文案；无 notInstalled / 计数
    const claudeText = rows[0]!.text()
    expect(claudeText).toContain(K.unreadable)
    expect(claudeText).not.toContain(K.notInstalled)
    expect(claudeText).not.toContain(K.skillCount)

    // codex：目录不存在 → notInstalled（三态区分的对照侧）
    expect(rows[1]!.text()).toContain(K.notInstalled)
    expect(rows[1]!.text()).not.toContain(K.unreadable)

    // pi：正常 → 计数
    expect(rows[2]!.text()).toContain(K.skillCount)
  })
})
