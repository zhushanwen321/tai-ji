/**
 * 合并产物（round5-f S2，簇 1-5 拆对子集）。
 *
 * 来源七文件（describe/it 原样搬运）：session-list-project-groups /
 * session-item-force-quit / session-list-folder-delete / SegmentedTab.spec /
 * useSidebar-get-commands / utils/truncate-tool-output / v6-visual/tokens。
 * 剔出五文件——session-list-project-groups / session-list-folder-delete（SessionList 挂载
 * 跨用例残留 window keydown 监听，Esc 用例与组头用例被残留组件 patch 崩）、
 * SegmentedTab.spec（sidebar-mount helper 单例共享）、useSidebar-get-commands（@/api
 * mock 成员面不足）、v6-visual/tokens——均单文件保留。
 * 环境说明：force-quit 默认环境；truncate-tool-output 原为 node 环境纯函数测试，
 * 并入默认环境产物（波 1 簇 1-10 等迁移先例）。产物零 vi.mock（五源文件均零 mock）。辅助函数按节
 * 改名消歧（mountForceQuitItem / mountForceQuitList / makeFolderGroups /
 * mountFolderList）。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionGroup, SessionSummary, Message } from '@taiji/shared'
import SessionList from '@/components/sidebar/SessionList.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import { useProjectStore, DEFAULT_PROJECT_ID } from '@/stores/project'
import { flipProjectGroupToggle, expectTextOnlyTabs } from '../helpers/sidebar-mount'
import { truncateToolOutput, TRUNCATE_TOOLS, TOOL_OUTPUT_MAX_BYTES } from '@taiji/core'

// ═══ 来源：session-item-force-quit.test.ts ═══
/** 普通 user session fixture（无 agent 血缘） */
const USER_SESSION = {
  id: 'fq-user-1',
  label: '卡死的会话',
  cwd: '/p',
  lastActiveAt: 0,
  spawnSource: 'user' as const,
}

function mountForceQuitItem(sessionOverrides: Record<string, unknown> = {}) {
  return mount(SessionItem, {
    attachTo: document.body,
    props: {
      session: { ...USER_SESSION, ...sessionOverrides },
      active: false,
      status: 'done' as never,
    },
  })
}

/** 挂载含一条 user session 的 SessionList（转发链路用） */
function mountForceQuitList(sessions: Array<Record<string, unknown>>) {
  // 装载 loaded + 默认项目（connection-datasync-ssot §6.7 三形态：idle 分组区渲染占位，会话行不渲染）
  const store = useProjectStore()
  store.projects = [{ id: DEFAULT_PROJECT_ID, name: '', lastUsedAt: 0 }]
  store.activeProjectId = DEFAULT_PROJECT_ID
  store.revision = 1
  store.loadState = 'loaded'
  return mount(SessionList, {
    attachTo: document.body,
    props: {
      groups: [{ cwd: '/p', sessions }] as unknown as SessionGroup[],
      activeId: null,
      statusOf: () => 'done' as never,
    },
  })
}

async function openContextMenu(wrapper: { find: (sel: string) => { trigger: (ev: string) => Promise<void> } }) {
  await wrapper.find('.session-item').trigger('contextmenu')
  await nextTick()
  await nextTick()
}

function findForceQuitItem(): HTMLElement | null {
  return document.body.querySelector('[data-testid="session-force-quit-item"]')
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.removeItem('taiji:session-markers')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('强制退出菜单条件渲染（SessionItem）', () => {
  it('user session 右键 → 出现「强制退出」菜单项（此前 user session 无任何菜单项，现在有逃生入口）（使用者黑盒）', async () => {
    const wrapper = mountForceQuitItem()
    await openContextMenu(wrapper)

    const item = findForceQuitItem()
    expect(item).not.toBeNull()
    expect(item!.textContent).toContain('强制退出')
    // 初始为非确认态文案（不含「确认」前缀）
    expect(item!.textContent).not.toContain('确认')
  })

  it('dead session 右键 → 不出现「强制退出」（进程已退出无需强杀，点击走 restore）（构建者白盒）', async () => {
    const wrapper = mountForceQuitItem({ status: 'dead' })
    await openContextMenu(wrapper)

    expect(findForceQuitItem()).toBeNull()
    // 2026-10-10 入口重设计：菜单恒渲染（标记完成/引用到输入区/移动到项目分组常驻），
    // 但条件项（强退/停止/查看父）仍按状态缺席
    expect(document.body.querySelector('[data-testid="session-context-menu"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="session-mark-done-item"]')).not.toBeNull()
  })

  it('agent-spawned session（有父 id）→ 「查看父 session」与「强制退出」两项并存（条件组合）', async () => {
    const wrapper = mountForceQuitItem({
      id: 'fq-agent-1',
      spawnSource: 'agent',
      parentAgentSessionId: 'fq-parent-1',
    })
    await openContextMenu(wrapper)

    expect(document.body.querySelector('[data-testid="session-view-parent-item"]')).not.toBeNull()
    expect(findForceQuitItem()).not.toBeNull()
  })
})

describe('强制退出两段式确认（SessionItem）', () => {
  it('首击进入确认态（文案变「确认强制退出？」+ danger 底色）且菜单保持打开；再击才 emit forceQuit（使用者黑盒 + 观察者形态）', async () => {
    const wrapper = mountForceQuitItem()
    await openContextMenu(wrapper)

    // 首击：进入确认态，preventDefault 阻止 reka 自动关闭菜单
    findForceQuitItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    const confirmed = findForceQuitItem()
    expect(confirmed).not.toBeNull() // 菜单未关闭
    expect(confirmed!.textContent).toContain('确认强制退出？')
    expect(confirmed!.className).toContain('bg-danger')
    // 未 emit（两段式：首击不触发）
    expect(wrapper.emitted('forceQuit')).toBeUndefined()

    // 再击：emit 并复位
    confirmed!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('forceQuit')).toEqual([['fq-user-1']])
  })
})

describe('forceQuit 事件链（SessionItem → SessionList）', () => {
  it('SessionList 层：两段确认后收到 forceQuit 且 payload 为 sessionId（全链路）', async () => {
    const wrapper = mountForceQuitList([{ ...USER_SESSION }])
    await openContextMenu(wrapper)

    findForceQuitItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    findForceQuitItem()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(wrapper.emitted('forceQuit')).toEqual([['fq-user-1']])
  })

  it('SessionList 层：SessionItem 上透传监听已接线（vi 断言模板绑定存在性由上条用例覆盖，此处锁 dead 不渲染）', async () => {
    const wrapper = mountForceQuitList([
      { ...USER_SESSION, status: 'dead', id: 'fq-dead-1' },
    ])
    await openContextMenu(wrapper)

    expect(findForceQuitItem()).toBeNull()
    expect(wrapper.emitted('forceQuit')).toBeUndefined()
  })
})


// ═══ 来源：utils/truncate-tool-output.test.ts（原 node 环境，pragma 已去除）═══
function makeAssistantWithTool(toolName: string, output: string, outputRaw?: string): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    status: 'complete',
    timestamp: Date.now(),
    toolCalls: [
      {
        id: 'tc1',
        toolName,
        input: {},
        output,
        ...(outputRaw !== undefined ? { outputRaw } : {}),
        status: 'completed',
        startTime: Date.now(),
      },
    ],
  }
}

describe('W2 truncateToolOutput 共享截断工具', () => {
  describe('AC-3: 超 4KB 截断为头部 4KB + 省略标记', () => {
    it('read 工具 output 超 4KB → 截断', () => {
      const bigOutput = 'x'.repeat(5000) // 5KB
      const msg = makeAssistantWithTool('read', bigOutput)
      const result = truncateToolOutput(msg)

      const tc = result.toolCalls![0]
      expect(Buffer.byteLength(tc.output!, 'utf-8')).toBeLessThanOrEqual(4096)
      expect(tc.output!.length).toBeGreaterThan(0)
      // 应包含截断标记（具体格式由实现定，但需有标识）
      expect(tc.output).toMatch(/截断|truncate|omit|\.\.\./i)
    })

    it('outputRaw 同步截断', () => {
      const bigOutput = 'x'.repeat(5000)
      const msg = makeAssistantWithTool('bash', bigOutput, '\x1b[31m' + bigOutput)
      const result = truncateToolOutput(msg)

      const tc = result.toolCalls![0]
      expect(Buffer.byteLength(tc.output!, 'utf-8')).toBeLessThanOrEqual(4096)
      expect(Buffer.byteLength(tc.outputRaw!, 'utf-8')).toBeLessThanOrEqual(4096)
    })
  })

  describe('AC-4: read/bash/grep 截断，write/edit 不截断', () => {
    it('read/bash/cat/grep/glob/list 都截断', () => {
      const bigOutput = 'x'.repeat(5000)
      for (const tool of ['read', 'bash', 'cat', 'grep', 'glob', 'list']) {
        const msg = makeAssistantWithTool(tool, bigOutput)
        const result = truncateToolOutput(msg)
        expect(Buffer.byteLength(result.toolCalls![0].output!, 'utf-8')).toBeLessThanOrEqual(4096)
      }
    })

    it('write/edit 不截断（短确认输出）', () => {
      const bigOutput = 'x'.repeat(5000)
      for (const tool of ['write', 'edit']) {
        const msg = makeAssistantWithTool(tool, bigOutput)
        const result = truncateToolOutput(msg)
        expect(result.toolCalls![0].output).toBe(bigOutput) // 原样保留
      }
    })
  })

  describe('AC-13: MCP 命名空间前缀兼容（mcp__server__read 命中截断）', () => {
    it('mcp__server__read 按末段匹配命中截断', () => {
      const bigOutput = 'x'.repeat(5000)
      const msg = makeAssistantWithTool('mcp__filesystem__read', bigOutput)
      const result = truncateToolOutput(msg)
      expect(Buffer.byteLength(result.toolCalls![0].output!, 'utf-8')).toBeLessThanOrEqual(4096)
    })
  })

  describe('AC-11: UTF-8 codepoint 边界对齐', () => {
    it('CJK 字符串截断不产生半个多字节字符', () => {
      // 5000 个中文字符（每个 3 字节 UTF-8 = 15000 字节）
      const bigCjk = '测'.repeat(5000)
      const msg = makeAssistantWithTool('read', bigCjk)
      const result = truncateToolOutput(msg)

      const output = result.toolCalls![0].output!
      // 截断后的字符串必须是合法 UTF-8（不含半个字符）
      // 验证：能被 round-trip encode/decode
      expect(() => Buffer.from(output, 'utf-8').toString('utf-8')).not.toThrow()
      // 长度 ≤ 4096 字节
      expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(4096)
    })
  })

  describe('≤4KB 不截断', () => {
    it('output ≤ 4KB 原样保留、不加标记', () => {
      const smallOutput = 'x'.repeat(3000) // 3KB
      const msg = makeAssistantWithTool('read', smallOutput)
      const result = truncateToolOutput(msg)
      expect(result.toolCalls![0].output).toBe(smallOutput) // 无截断标记
    })
  })

  describe('details.__gui__ 结构化数据不截断', () => {
    it('details 字段完整保留', () => {
      const bigGui = { __gui__: { tree: 'x'.repeat(5000) } }
      const msg: Message = {
        id: 'm1',
        role: 'assistant',
        content: '',
        status: 'complete',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc1',
            toolName: 'read',
            input: {},
            output: 'x'.repeat(5000),
            details: bigGui,
            status: 'completed',
            startTime: Date.now(),
          },
        ],
      }
      const result = truncateToolOutput(msg)
      expect(result.toolCalls![0].details).toEqual(bigGui) // 完整保留
    })
  })

  describe('无 toolCalls 的消息原样返回', () => {
    it('普通 assistant 消息（无 toolCalls）不受影响', () => {
      const msg: Message = {
        id: 'm1',
        role: 'assistant',
        content: 'hello',
        status: 'complete',
        timestamp: Date.now(),
      }
      const result = truncateToolOutput(msg)
      expect(result).toEqual(msg)
    })
  })

  describe('TRUNCATE_TOOLS 常量 + TOOL_OUTPUT_MAX_BYTES 常量', () => {
    it('TRUNCATE_TOOLS 包含 read/bash/cat/grep/glob/list', () => {
      expect(TRUNCATE_TOOLS).toContain('read')
      expect(TRUNCATE_TOOLS).toContain('bash')
      expect(TRUNCATE_TOOLS).toContain('grep')
    })

    it('TOOL_OUTPUT_MAX_BYTES 为 4096', () => {
      expect(TOOL_OUTPUT_MAX_BYTES).toBe(4096)
    })
  })
})
