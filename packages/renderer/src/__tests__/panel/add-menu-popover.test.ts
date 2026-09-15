/**
 * AddMenuPopover 组件单测（TC4，slice5 attach-dragdrop-menu）。
 *
 * 覆盖：
 * - TC4a: 渲染含 3 项（attach / image / slash），image 项 label 显 image 文案
 * - TC4b: 点 image 项 → emit('select', 'image')
 * - TC4c: 点 attach 项 → emit('select', 'attach')
 *
 * AddMenuPopover 用 reka-ui Popover，PopoverContent teleport 到 body，需打开 popover 后
 * 在 body 内找命令项 Button（v-for 渲染为 native <button>）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/add-menu-popover.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AddMenuPopover from '@/components/panel/AddMenuPopover.vue'

describe('AddMenuPopover（TC4 slice5）', () => {
  let wrapper: ReturnType<typeof mount> | null = null

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  /** 打开 popover 并返回 body 内的命令项按钮（按渲染顺序：attach / image / slash） */
  async function openAndGetItems(): Promise<HTMLElement[]> {
    wrapper = mount(AddMenuPopover)
    ;(wrapper.vm as unknown as { open: boolean }).open = true
    await wrapper.vm.$nextTick()
    // PopoverContent teleport 到 body；命令项容器 w-[208px]，按钮按 v-for 顺序
    const list = document.body.querySelector('.w-\\[208px\\]') ?? document.body
    return Array.from(list.querySelectorAll('button'))
  }

  it('TC4a: 渲染 3 项（attach / image / slash），image 项显 image 文案', async () => {
    const items = await openAndGetItems()
    expect(items.length).toBe(3)
    // 顺序：attach / image / slash
    const labels = items.map((b) => b.textContent ?? '')
    expect(labels.some((l) => l.includes('附件') || l.includes('Attachment'))).toBe(true) // attach
    expect(labels.some((l) => l.includes('图片') || l.includes('Image'))).toBe(true) // image
    expect(labels.some((l) => l.includes('命令') || l.includes('Command'))).toBe(true) // slash
  })

  it('TC4b: 点 image 项 → emit("select", "image")', async () => {
    const items = await openAndGetItems()
    // image 是第 2 项（index 1）
    items[1].click()
    await wrapper!.vm.$nextTick()
    const selectEvents = wrapper!.emitted('select')
    expect(selectEvents).toBeTruthy()
    expect(selectEvents![0]).toEqual(['image'])
  })

  it('TC4c: 点 attach 项 → emit("select", "attach")', async () => {
    const items = await openAndGetItems()
    // attach 是第 1 项（index 0）
    items[0].click()
    await wrapper!.vm.$nextTick()
    const selectEvents = wrapper!.emitted('select')
    expect(selectEvents).toBeTruthy()
    expect(selectEvents![0]).toEqual(['attach'])
  })
})
