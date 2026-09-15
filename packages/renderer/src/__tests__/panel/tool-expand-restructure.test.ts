/**
 * W3 红灯测试 —— tool call 展开体统一重构。
 *
 * 防的 bug：
 * - 展开体重复打印 toolName(args)，与 header 完全重复（冗余）
 * - result 区 Check/XCircle 图标与 header 状态指示重复（冗余）
 * - 普通 tool 展开体缺少补充细节（如耗时），信息架构与 subagent 不统一
 *
 * 三视角：
 * - 观察者（形态）：展开后无重复的 toolName(args) 行；result 区无 Check/XCircle 图标
 * - 使用者（黑盒）：展开看到耗时 + 结果，不看到重复信息
 * - 构建者（白盒）：耗时从 startTime+endTime 计算
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/panel/tool-expand-restructure.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { Block } from '@taiji/ui'
import type { ToolCall } from '@taiji/shared'

function makeTool(over: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    toolName: 'edit',
    input: { path: 'src/App.vue' },
    output: 'done',
    status: 'completed',
    startTime: 1000,
    endTime: 2500, // 耗时 1.5s
    ...over,
  }
}

describe('W3: 普通 tool 展开体去重复 + 加补充细节条', () => {
  it('展开后不重复打印 toolName(args) 行（header 已有）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool(), working: false },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 关键断言：展开体内不应再有 "edit(src/App.vue)" 这样的重复行
    // 当前实现 :103-106 会打印 <span>edit</span><span>(src/App.vue)</span>（红灯）
    // 展开 body 的文本里，toolName + ( + argPath 组合不应出现
    const expandText = wrapper.text()
    // "edit(src/App.vue)" 或 "edit (src/App.vue)" 是重复行的特征
    expect(expandText).not.toMatch(/edit\s*\(src\/App\.vue\)/)
  })

  it('展开后 result 区无 Check/XCircle 图标（header 状态指示已覆盖）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ output: 'success result' }), working: false },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 当前实现 :112-113 在 result 前放 Check/XCircle（红灯——改后应移除）
    // 展开 body 内的 svg 图标：header 的 svg 是状态指示（保留），result 区的 svg 是重复（应删）
    // 验证方式：header 外不应有额外的 Check 图标
    const header = wrapper.find('[data-testid="tool-block-header"]')
    const headerSvgs = header.findAll('svg')
    const allSvgs = wrapper.findAll('svg')
    // header 自带 chevron + wrench + status = 3 个 svg
    // result 区有 1 个 copy 按钮的 CopyIcon svg（hover overlay，始终在 DOM）
    expect(allSvgs.length).toBe(headerSvgs.length + 1)
  })

  it('展开后显示补充细节条（耗时，从 startTime+endTime 计算）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ startTime: 1000, endTime: 3000 }), working: false },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 关键断言：展开后显示耗时（diff=2000ms → formatDuration "2s"）
    // 当前展开体无耗时信息（红灯）
    const expandText = wrapper.text()
    expect(expandText).toContain('2s')
  })

  it('展开后结果文本仍可见（去重复不影响结果展示）', async () => {
    const wrapper = mount(Block, {
      props: { type: 'tool', tool: makeTool({ output: 'file content here' }), working: false },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 结果仍可见
    expect(wrapper.text()).toContain('file content here')
  })

  it('失败 tool 终态挂载默认展开 error 直显（584869378 §3.3.1 选项 A），无鲜红框——Demo H 去鲜红', async () => {
    const wrapper = mount(Block, {
      props: {
        type: 'tool',
        tool: makeTool({ status: 'error', output: 'old_string not found', startTime: 1000, endTime: 1200 }),
        working: false,
      },
    })
    // failed 终态挂载默认展开（错误输出立即可见），error text 通过 displayContent 兜底显示
    expect(wrapper.text()).toContain('old_string not found')
    // Demo H：鲜红框已删（无 border-danger / bg-danger-soft）
    expect(wrapper.find('.border-danger').exists()).toBe(false)
    expect(wrapper.find('.bg-danger-soft').exists()).toBe(false)
    // 无重复 toolName(args) 行
    expect(wrapper.text()).not.toMatch(/edit\s*\(src\/App\.vue\)/)
    // 手动点击可收起
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    expect(wrapper.text()).not.toContain('old_string not found')
  })
})

describe('W3 补充：read/bash 工具特化 meta（行数/字符数自算）', () => {
  it('read 工具展开后细节条含行数 + 字符数 + 耗时', async () => {
    const fileContent = 'line1\nline2\nline3' // 3 行 17 字符
    const wrapper = mount(Block, {
      props: {
        type: 'tool',
        tool: makeTool({ toolName: 'read', output: fileContent, startTime: 1000, endTime: 3000 }),
        working: false,
      },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const text = wrapper.text()
    // 3 行（output.split('\n').length = 3）
    expect(text).toContain('3 行')
    // 字符数 17（< 1000，显示原值）
    expect(text).toContain('17 chars')
    // 耗时（diff 2000ms → formatDuration "2s"）
    expect(text).toContain('2s')
  })

  it('bash 工具展开后细节条不含行数统计（filteredMetaItems 已过滤），只有耗时', async () => {
    const output = 'stdout line1\nstdout line2\nstdout line3\nstdout line4'
    const wrapper = mount(Block, {
      props: {
        type: 'tool',
        tool: makeTool({ toolName: 'bash', output, startTime: 1000, endTime: 5200 }),
        working: false,
      },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const text = wrapper.text()
    // bash filteredMetaItems 过滤掉了行数统计（命令+output 已完整展示，行数无参考价值）
    expect(text).not.toContain('4 行')
    // bash 不显示字符数（read/cat 才显示）
    expect(text).not.toContain('chars')
    // 耗时（diff=4200ms → formatDuration toFixed(0) → "4s"）
    expect(text).toContain('4s')
  })

  it('read 大文件字符数格式化为 XK chars（>1000 字符）', async () => {
    const bigContent = 'x'.repeat(2500) // 1 行 2500 字符
    const wrapper = mount(Block, {
      props: {
        type: 'tool',
        tool: makeTool({ toolName: 'read', output: bigContent, startTime: 1000, endTime: 2000 }),
        working: false,
      },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    // 2500 字符 → 2.5K chars
    expect(wrapper.text()).toContain('2.5K chars')
  })

  it('edit 工具细节条只有耗时（output 是简短确认，行数无意义）', async () => {
    const wrapper = mount(Block, {
      props: {
        type: 'tool',
        tool: makeTool({ toolName: 'edit', output: 'done', startTime: 1000, endTime: 1500 }),
        working: false,
      },
    })
    await wrapper.find('[data-testid="tool-block-header"]').trigger('click')
    const text = wrapper.text()
    // edit 不在 OUTPUT_META_TOOLS，无行数
    expect(text).not.toContain('行')
    // 只有耗时（500ms → formatDuration "500ms"）
    expect(text).toContain('500ms')
  })

  it('read 失败时错误移至内容区（displayContent 兜底 tool.error，终态挂载默认展开），meta 不含错误摘要', async () => {
    const wrapper = mount(Block, {
      props: {
        type: 'tool',
        tool: makeTool({
          toolName: 'read',
          status: 'error',
          output: 'File not found: src/missing.ts',
          startTime: 1000,
          endTime: 1100,
        }),
        working: false,
      },
    })
    // failed 终态挂载默认展开（584869378）：错误文本通过 displayContent（兜底 tool.error）在内容区可见
    expect(wrapper.text()).toContain('File not found: src/missing.ts')
    // meta 不含错误摘要（已移至内容区），无 text-neutral-mid.font-semibold meta 项
    expect(wrapper.find('.text-neutral-mid.font-semibold').exists()).toBe(false)
    // M1 T1（584869378）：failed tool header 状态色染 danger（唯一 text-danger 来源），不含错误摘要文本
    const danger = wrapper.find('.text-danger')
    expect(danger.exists()).toBe(true)
    expect(danger.text()).not.toContain('File not found')
  })
})
