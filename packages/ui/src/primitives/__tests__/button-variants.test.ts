/**
 * Button 变体扩展测试（remote-use-mobile-v2 §6.9 / spec §6.1：quiet / destructive /
 * icon-44 净新增，存量 variant 零变化）。
 *
 * 三视角：构建者 = cva 变体表输出断言；使用者 = mount 后钮上类名（用户可见样式载体）；
 * 观察者 = 缺省 variant/size 拼接不变（桌面默认路径零变化的回归锁）。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/button-variants.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { buttonVariants, Button } from '../button'

describe('Button 变体扩展（spec §6.1，additive）', () => {
  it('quiet：透明底 + mid 字 + hover 提亮（静默图标钮档）', () => {
    expect(buttonVariants({ variant: 'quiet' })).toContain('text-neutral-mid')
    expect(buttonVariants({ variant: 'quiet' })).toContain('hover:text-neutral-fg')
    // mount 级：类真实落在钮上
    const w = mount(Button, { props: { variant: 'quiet' } })
    expect(w.find('button').classes()).toContain('text-neutral-mid')
  })

  it('destructive：--danger-soft 底 + --danger-text 字（spec §6.1 破坏动作档）', () => {
    expect(buttonVariants({ variant: 'destructive' })).toContain('bg-danger-soft')
    expect(buttonVariants({ variant: 'destructive' })).toContain('text-[color:var(--danger-text)]')
    const w = mount(Button, { props: { variant: 'destructive' } })
    expect(w.find('button').classes()).toContain('bg-danger-soft')
  })

  it('icon-44：--m-tap 触控档（44px），存量 icon（40px）不变', () => {
    expect(buttonVariants({ size: 'icon-44' })).toContain('h-[var(--m-tap)]')
    expect(buttonVariants({ size: 'icon-44' })).toContain('w-[var(--m-tap)]')
    expect(buttonVariants({ size: 'icon' })).toContain('h-10 w-10')
    const w = mount(Button, { props: { size: 'icon-44' } })
    expect(w.find('button').classes()).toContain('h-[var(--m-tap)]')
  })

  it('存量 variant 表零变化：default/secondary/ghost/danger/danger-solid 五档类串回归锁', () => {
    expect(buttonVariants({ variant: 'default' })).toContain('bg-accent text-accent-fg hover:bg-accent-hover')
    expect(buttonVariants({ variant: 'secondary' })).toContain('bg-transparent border border-border text-neutral-fg hover:bg-surface-hover')
    expect(buttonVariants({ variant: 'ghost' })).not.toContain('bg-accent')
    expect(buttonVariants({ variant: 'danger' })).toContain('text-danger hover:bg-danger-soft')
    expect(buttonVariants({ variant: 'danger-solid' })).toContain('bg-danger text-[color:var(--danger-fg)] hover:brightness-110')
  })
})
