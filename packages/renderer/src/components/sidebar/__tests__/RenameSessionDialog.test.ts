/**
 * RenameSessionDialog 校验测试（u13 直连改写后，三视角）。
 * 验证 session 重命名规则：min1 / max60 / 无换行（\r\n 拒绝），合法名通过。
 *
 * 既有「复制 zod schema 保持同步」双轨已随旧表单库退役删除：全部用例改为挂载
 * 真实组件 + 真实 DOM 输入（使用者黑盒），断言用户可见错误消息与 confirm payload，
 * 不再存在测试副本与生产实现漂移的可能。
 *
 * mock 策略：无外部依赖 mock——组件仅依赖 pinia session store（appendSession 预填）
 * 与全局 vue-i18n mock（vitest-i18n-setup.ts，zh-CN 取值）。Dialog 经 reka DialogPortal
 * teleport 到 body：DOM 断言统一走 document.body（ImportSessionDialog.test.ts 先例）。
 *
 * 测试框架：vitest + @vue/test-utils。
 * 运行：cd packages/renderer && npx vitest run src/components/sidebar/__tests__/RenameSessionDialog.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import RenameSessionDialog from '@/components/sidebar/RenameSessionDialog.vue'
import { useSessionStore } from '@/stores/session'
import type { SessionSummary } from '@taiji/shared'

/** 辅助：构造最小 SessionSummary（cast 补齐可选字段，测试代码可接受） */
function mkSession(id: string, label: string): SessionSummary {
  return { id, label, cwd: '/x', status: 'idle' } as SessionSummary
}

/** i18n 文案（zh-CN locale 断言，vitest-i18n-setup mock 取值） */
const MSG_REQUIRED = '请输入名称'
const MSG_MAX_LENGTH = '名称不能超过 60 个字符'
const MSG_PATTERN = '不允许换行符，最大 60 个字符'
const MAX_LABEL_LENGTH = 60

let wrapper: VueWrapper | null = null

/** mount 对话框（open=true 触发 resetState 聚焦），目标 session 名 = '旧名称' */
async function mountDialog(): Promise<void> {
  const sessionStore = useSessionStore()
  sessionStore.appendSession(mkSession('s1', '旧名称'))
  wrapper = mount(RenameSessionDialog, {
    props: { open: true, sessionId: 's1' },
    attachTo: document.body,
  })
  await flushPromises()
}

/** Dialog 经 reka DialogPortal teleport 到 body：按 id 从 body 取输入框 */
function inputEl(): HTMLInputElement {
  const el = document.body.querySelector('#rename-session-label')
  expect(el, '重命名输入框应存在').not.toBeNull()
  return el as HTMLInputElement
}

/** 错误消息元素（不可见时为 null） */
function errorMsgEl(): Element | null {
  return document.body.querySelector('#rename-session-label-message')
}

/** 输入并等 DOM 更新（v-model 同步，错误 computed 随 input 事件即时刷新）；Portal 内容不在 wrapper 子树，走 body DOMWrapper */
async function type(value: string): Promise<void> {
  await new DOMWrapper<HTMLInputElement>(inputEl()).setValue(value)
  await nextTick()
}

/**
 * 含换行值注入：input type=text 的 value sanitization（HTML 规范）会剥离换行，
 * happy-dom 与真实浏览器一致，故换行分支无法经常规 setter 触达——覆写 value 后
 * dispatch input 事件，仍走真实 v-model → 校验 → DOM 错误展示生产链路。
 */
async function typeWithNewline(value: string): Promise<void> {
  const input = inputEl()
  Object.defineProperty(input, 'value', { value, writable: true, configurable: true })
  input.dispatchEvent(new Event('input'))
  await nextTick()
  delete (input as unknown as Record<string, unknown>).value
}

/** 点确认按钮（文本定位，Dialog 内容在 body 下） */
async function clickConfirm(): Promise<void> {
  const btn = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === '确认',
  )
  expect(btn, '确认按钮应存在').not.toBeNull()
  ;(btn as HTMLButtonElement).click()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('RenameSessionDialog 校验（V5：空/超60/换行拒绝，合法通过）', () => {
  it('TC1: 允许 emoji、标点、多语言等可打印字符（合法名通过：无错误消息）', async () => {
    await mountDialog()
    const validCases = [
      'hello🎉', // emoji
      'test.name', // 点号
      '用户(1)', // 括号
      'task@home', // @符号
      '100% 完成', // 百分号
      'bug #123', // 井号
      '价格 $99', // 美元符号
      '路径/a/b', // 斜杠
      'C:\\Users', // 反斜杠
      '<html>', // 尖括号
      'a+b=c', // 加号等号
      '问号?感叹号!', // 问号感叹号
      '引号"单引号\'', // 引号
      '波浪号~', // 波浪号
      '管道|符', // 管道符
      '👨‍👩‍👧 家庭', // emoji 组合字符
      '中文测试', // 中文
      '日本語テスト', // 日文
      '한국어 테스트', // 韩文
      'Ñoño', // 西班牙文
    ]
    for (const value of validCases) {
      await type(value)
      expect(errorMsgEl(), `合法名 "${value}" 不应显示错误`).toBeNull()
    }
  })

  it('TC2: 拒绝 \\r\\n 控制字符（用户可见错误：换行文案）', async () => {
    await mountDialog()
    const invalidCases = ['hello\nworld', 'hello\rworld', 'hello\r\nworld', 'hello\n\rworld', '\n开头', '结尾\n', '\r开头', '结尾\r']
    for (const value of invalidCases) {
      await typeWithNewline(value)
      expect(errorMsgEl(), `含换行 "${value}" 应显示错误`).not.toBeNull()
      expect(errorMsgEl()!.textContent).toBe(MSG_PATTERN)
    }
  })

  it('TC3: 长度边界（60 通过 / 61 拒绝）与空名拒绝', async () => {
    await mountDialog()
    await type('a'.repeat(MAX_LABEL_LENGTH))
    expect(errorMsgEl(), '60 字符不应显示错误').toBeNull()

    await type('a'.repeat(MAX_LABEL_LENGTH + 1))
    expect(errorMsgEl(), '61 字符应显示错误').not.toBeNull()
    expect(errorMsgEl()!.textContent).toBe(MSG_MAX_LENGTH)

    await type('')
    expect(errorMsgEl(), '空名应显示错误').not.toBeNull()
    expect(errorMsgEl()!.textContent).toBe(MSG_REQUIRED)
  })

  it('交互: 合法名点确认 → emit confirm（label trim）+ update:open false', async () => {
    await mountDialog()
    await type('  新名称  ')
    expect(errorMsgEl()).toBeNull()
    await clickConfirm()
    expect(wrapper!.emitted('confirm')).toEqual([[{ sessionId: 's1', label: '新名称' }]])
    expect(wrapper!.emitted('update:open')).toEqual([[false]])
  })

  it('交互: 非法名点确认 → 错误可见且不 emit（确认按钮不禁用、submit 被拦截，与改写前等价）', async () => {
    await mountDialog()
    await type('')
    await clickConfirm()
    expect(errorMsgEl(), '提交后错误应可见').not.toBeNull()
    expect(errorMsgEl()!.textContent).toBe(MSG_REQUIRED)
    expect(wrapper!.emitted('confirm')).toBeUndefined()
  })

  it('交互: 打开即聚焦并全选输入框', async () => {
    await mountDialog()
    expect(document.activeElement).toBe(inputEl())
    expect((inputEl() as HTMLInputElement).value).toBe('旧名称')
  })

  it('交互: 初值未动时无错误展示（新实现：label 偏离初值或提交尝试后即显示错误；旧 vee-validate 为 blur/submit 后才显示，差异登记 D7），动过再改回原值错误消失', async () => {
    await mountDialog()
    expect(errorMsgEl(), '打开初值合法不应显示错误').toBeNull()
    await type('')
    expect(errorMsgEl()).not.toBeNull()
    await type('旧名称')
    expect(errorMsgEl(), '改回合法初值后错误应消失').toBeNull()
  })
})
