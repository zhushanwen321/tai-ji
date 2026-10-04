/**
 * McpSection 测试（pi-mcp-management U3，三视角）。
 *
 * 覆盖（验收条款全分支）：
 *  - 清单渲染：空清单（文件不存在与「文件存在但无条目」同形态）/ 行渲染（名称/传输类型/描述）
 *    / 坏条目「配置有误」标注含错误摘要；
 *  - 页头：生效说明 / 覆盖说明 / 快照说明三行渲染（设计 §3.1 定死文案语义）；
 *  - 表单校验内联错误三形态（字符集 / 必填 / 互斥——错误消息含修复动作）+ 重名拦截（含 -/_
 *    归并同名，D4）+ 校验不过不调协议；
 *  - 双 tab：表单 → 代码自动序列化为包装形态；代码 → 表单解析成功才切换、失败留代码模式显示
 *    解析错误；添加流裸形态拦截（包装形态指引，D7）；编辑流名称锁定 + 改包装键名拦截（改名 =
 *    删除后重建，D7）；编辑流切换传输类型（§4 断言①用户入口：payload 只含新类型键，D7 键级切换）；
 *  - 启停切换调协议（update 写 enabled，服务端终态校准）；删除确认（取消不调协议，确认后删除）；
 *  - 连接测试按钮调协议 + 「测试中」过程态徽标；
 *  - 状态徽标三类来源（D8）：config「配置有误」/ ui-local「未测试·测试中·测试超时」/ probe
 *    「已连接（N 个工具）·连接失败（详情展开 error 全文）·超时保留上次结果」；
 *  - 损坏错误态整页呈现（路径 + 先修复指引 + 添加禁用，S6）；加载失败可重试；
 *  - runtime 保存校验失败 ok:false error 内联显示（校验权威在 runtime，D4）；
 *  - i18n 双语 key 对齐：zh-CN / en-US 的 mcp 键集一致（pre-commit locale sync 同口径）。
 *
 * mock 策略：core transport mcp 域整模块桩（McpSection 直连 core transport 域——设计 §2.4，
 * 测试打域模块缝，不真实发 WS）+ useToast mock 捕获 + navigator.clipboard 桩（happy-dom 无实现）。
 *
 * 运行：npx vitest run src/__tests__/settings/mcp-section.test.ts（packages/renderer 目录）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

const mcpDomainMock = vi.hoisted(() => ({
  listMcpServers: vi.fn(),
  addMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  setMcpServerEnabled: vi.fn(),
  removeMcpServer: vi.fn(),
  testMcpServer: vi.fn(),
  cancelMcpServerTest: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/mcp', () => mcpDomainMock)
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: toastMock.info, error: toastMock.error, warning: vi.fn() }),
}))

import McpSection from '@/components/settings/mcp/McpSection.vue'
import { pickRekaOption } from '../helpers/reka-select-harness'
import { dispatchGlobal } from '@taiji/core/transport/api'
import zhCN from '@/i18n/locales/zh-CN/settings'
import enUS from '@/i18n/locales/en-US/settings'
import type { McpListResult, McpServerEntry, McpServerStatusBadge, McpServerEntryValue } from '@taiji/shared'

function makeI18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { settings: zhCN } },
  })
}

function stdioEntry(overrides: Partial<McpServerEntryValue> = {}): McpServerEntryValue {
  return { command: 'npx', args: ['-y', 'pkg'], description: '文件系统访问', enabled: true, exposure: 'codemode', ...overrides }
}

function entryFixture(name = 'filesystem', value: McpServerEntryValue = stdioEntry()): McpServerEntry {
  return { name, value }
}

function listFixture(servers: McpServerEntry[], corruption: McpListResult['corruption'] = null): McpListResult {
  return { servers, corruption, agentDir: '/data/.taiji-dev/agent' }
}

let wrapper: VueWrapper | null = null

/** mcp:testResult 广播帧 id 序列（broadcast helper 用；broker push id 形态不参与断言）。 */
let broadcastSeq = 0

function mountSection(): VueWrapper {
  wrapper = mount(McpSection, {
    attachTo: document.body,
    global: { plugins: [makeI18n()] },
  })
  return wrapper
}

/** Dialog 内容 teleport 到 body，经 document 查询拿 DOMWrapper。 */
function q(selector: string): DOMWrapper<Element> {
  const el = document.querySelector(selector)
  expect(el, `element not found: ${selector}`).toBeTruthy()
  return new DOMWrapper(el as Element)
}

async function openAddForm(): Promise<void> {
  await wrapper!.find('[data-testid="mcp-add-btn"]').trigger('click')
  await flushPromises()
}

async function submitForm(): Promise<void> {
  await q('[data-testid="mcp-form-save"]').trigger('click')
  await flushPromises()
}

/** navigator.clipboard 桩（happy-dom 无实现；configurable 供 afterEach 清除，同 codemode-section 先例）。 */
const writeText = vi.fn()
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

beforeEach(() => {
  vi.clearAllMocks()
  mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([]))
  mcpDomainMock.addMcpServer.mockResolvedValue({ ok: true, entry: entryFixture() })
  mcpDomainMock.updateMcpServer.mockResolvedValue({ ok: true, entry: entryFixture() })
  mcpDomainMock.removeMcpServer.mockResolvedValue({ ok: true, entry: entryFixture() })
  mcpDomainMock.setMcpServerEnabled.mockResolvedValue({ ok: true, entry: entryFixture() })
  mcpDomainMock.testMcpServer.mockResolvedValue({ testId: 'test-1' })
  mcpDomainMock.cancelMcpServerTest.mockResolvedValue({ cancelled: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  Reflect.deleteProperty(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('McpSection（pi-mcp-management U3）', () => {
  // ── 清单渲染 + 页头 ──

  it('空清单：空态文案渲染（文件不存在与「文件存在但无条目」同形态）', async () => {
    const w = mountSection()
    await flushPromises()

    expect(w.find('[data-testid="mcp-list-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="mcp-list-empty"]').text()).toContain('尚未配置 MCP 服务器')
    wrapper?.unmount()
  })

  it('清单行渲染：名称 + 传输类型 + 描述 + 缺省「未测试」徽标 + 页头三行说明', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(
      listFixture([entryFixture('filesystem'), entryFixture('remote', { url: 'https://example.com/mcp', command: undefined, args: undefined })]),
    )
    const w = mountSection()
    await flushPromises()

    expect(w.find('[data-testid="mcp-row-filesystem"]').exists()).toBe(true)
    expect(w.find('[data-testid="mcp-row-name-filesystem"]').text()).toBe('filesystem')
    expect(w.find('[data-testid="mcp-row-filesystem"]').text()).toContain('本地命令')
    expect(w.find('[data-testid="mcp-row-remote"]').text()).toContain('远程地址')
    expect(w.find('[data-testid="mcp-row-filesystem"]').text()).toContain('文件系统访问')
    // 缺省徽标 = 「未测试」（D8② UI 本地态）
    expect(w.find('[data-testid="mcp-badge-filesystem"]').text()).toBe('未测试')
    // 使用者黑盒：页头生效说明 + 覆盖说明 + 快照说明三行可见（设计 §3.1 定死文案语义）
    expect(w.find('[data-testid="mcp-effect-notice"]').text()).toContain('配置由新启动的会话读取')
    expect(w.find('[data-testid="mcp-effect-notice"]').text()).toContain('已在运行的会话保持当前工具集')
    expect(w.find('[data-testid="mcp-scope-notice"]').text()).toContain('覆盖用户级配置')
    expect(w.find('[data-testid="mcp-snapshot-notice"]').text()).toContain('测试时刻的快照')
    wrapper?.unmount()
  })

  it('坏条目「配置有误」标注：徽标 + 错误摘要渲染（D8③ 读侧校验探明）', async () => {
    const bad = entryFixture('broken', { command: 'npx' })
    bad.configError = 'needs either "command" (stdio) or "url" (streamable HTTP)'
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([bad]))
    const w = mountSection()
    await flushPromises()

    expect(w.find('[data-testid="mcp-badge-config-broken"]').text()).toContain('配置有误')
    expect(w.find('[data-testid="mcp-config-error-broken"]').text()).toContain('needs either')
    // 坏条目不产生测试态徽标（config 徽标优先，D8）
    expect(w.find('[data-testid="mcp-badge-broken"]').exists()).toBe(false)
    wrapper?.unmount()
  })

  // ── 表单校验内联错误三形态（错误消息含修复动作；校验不过不调协议）──

  it('字符集错误：名称含空格 → 内联错误含合法字符集说明，不调协议', async () => {
    const w = mountSection()
    await flushPromises()
    await openAddForm()

    await q<HTMLInputElement>('[data-testid="mcp-form-name"]').setValue('my server')
    await q<HTMLInputElement>('[data-testid="mcp-form-command"]').setValue('npx')
    await submitForm()

    expect(q('[data-testid="mcp-form-name-error"]').text()).toContain('字母、数字、下划线、连字符')
    expect(mcpDomainMock.addMcpServer).not.toHaveBeenCalled()
    wrapper?.unmount()
  })

  it('必填错误：stdio 缺命令 → 内联错误含修复动作（填入可执行文件），不调协议', async () => {
    const w = mountSection()
    await flushPromises()
    await openAddForm()

    await q<HTMLInputElement>('[data-testid="mcp-form-name"]').setValue('fs')
    await submitForm()

    expect(q('[data-testid="mcp-form-command-error"]').text()).toContain('命令')
    expect(mcpDomainMock.addMcpServer).not.toHaveBeenCalled()
    wrapper?.unmount()
  })

  it('互斥错误（代码模式 command+url 同填，D4 有意收紧项）→ 内联互斥提示，不调协议', async () => {
    const w = mountSection()
    await flushPromises()
    await openAddForm()
    await q('[data-testid="mcp-form-tab-code"]').trigger('click')
    await flushPromises()

    await q<HTMLTextAreaElement>('[data-testid="mcp-form-code-text"]').setValue(
      JSON.stringify({ mixed: { command: 'npx', url: 'https://example.com/mcp' } }),
    )
    await submitForm()

    expect(q('[data-testid="mcp-form-code-error"]').text()).toContain('只能填其一')
    expect(mcpDomainMock.addMcpServer).not.toHaveBeenCalled()
    wrapper?.unmount()
  })

  it('重名拦截（含 -/_ 归并同名，D4）：既有 a-b，新名 a_b → 「已存在同名服务器」', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('a-b')]))
    const w = mountSection()
    await flushPromises()
    await openAddForm()

    await q<HTMLInputElement>('[data-testid="mcp-form-name"]').setValue('a_b')
    await q<HTMLInputElement>('[data-testid="mcp-form-command"]').setValue('npx')
    await submitForm()

    expect(q('[data-testid="mcp-form-name-error"]').text()).toContain('已存在同名服务器，请编辑该条目')
    expect(mcpDomainMock.addMcpServer).not.toHaveBeenCalled()
    wrapper?.unmount()
  })

  // ── 双 tab（D7）──

  it('表单 → 代码自动序列化为包装形态（名称随内容可见）', async () => {
    const w = mountSection()
    await flushPromises()
    await openAddForm()

    await q<HTMLInputElement>('[data-testid="mcp-form-name"]').setValue('fs')
    await q<HTMLInputElement>('[data-testid="mcp-form-command"]').setValue('npx')
    await q('[data-testid="mcp-form-tab-code"]').trigger('click')
    await flushPromises()

    const code = q<HTMLTextAreaElement>('[data-testid="mcp-form-code-text"]').element as HTMLTextAreaElement
    const parsed = JSON.parse(code.value)
    expect(parsed).toEqual({ fs: { command: 'npx', exposure: 'codemode' } })
    wrapper?.unmount()
  })

  it('代码 → 表单解析失败：留代码模式并显示解析错误', async () => {
    const w = mountSection()
    await flushPromises()
    await openAddForm()
    await q('[data-testid="mcp-form-tab-code"]').trigger('click')
    await flushPromises()

    await q<HTMLTextAreaElement>('[data-testid="mcp-form-code-text"]').setValue('{ not json')
    await q('[data-testid="mcp-form-tab-form"]').trigger('click')
    await flushPromises()

    expect(q('[data-testid="mcp-form-code-error"]').text()).toContain('JSON 解析失败')
    // 仍在代码模式：表单字段区未渲染
    expect(document.querySelector('[data-testid="mcp-form-fields"]')).toBeNull()
    expect(mcpDomainMock.addMcpServer).not.toHaveBeenCalled()
    wrapper?.unmount()
  })

  it('代码 → 表单解析成功：切换并保留内容（裸形态条目字段填充）', async () => {
    const w = mountSection()
    await flushPromises()
    await openAddForm()
    await q('[data-testid="mcp-form-tab-code"]').trigger('click')
    await flushPromises()

    await q<HTMLTextAreaElement>('[data-testid="mcp-form-code-text"]').setValue(
      JSON.stringify({ srv: { command: 'uvx', args: ['mcp-server'] } }),
    )
    await q('[data-testid="mcp-form-tab-form"]').trigger('click')
    await flushPromises()

    expect(document.querySelector('[data-testid="mcp-form-fields"]')).not.toBeNull()
    expect((q<HTMLInputElement>('[data-testid="mcp-form-command"]').element as HTMLInputElement).value).toBe('uvx')
    expect((q<HTMLTextAreaElement>('[data-testid="mcp-form-args"]').element as HTMLTextAreaElement).value).toBe('mcp-server')
    wrapper?.unmount()
  })

  it('添加流裸形态拦截：无键名可取 → 报错含包装形态指引（D7 添加态名称来源）', async () => {
    const w = mountSection()
    await flushPromises()
    await openAddForm()
    await q('[data-testid="mcp-form-tab-code"]').trigger('click')
    await flushPromises()

    await q<HTMLTextAreaElement>('[data-testid="mcp-form-code-text"]').setValue(JSON.stringify({ command: 'npx' }))
    await submitForm()

    expect(q('[data-testid="mcp-form-code-error"]').text()).toContain('包装形态')
    expect(mcpDomainMock.addMcpServer).not.toHaveBeenCalled()
    wrapper?.unmount()
  })

  // ── 添加/编辑流 ──

  it('添加成功：表单序列化 payload 断言（args 拆行 / env 解析 / 暴露档位默认 codemode），清单新增行', async () => {
    const created = entryFixture('fs', { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: 'x' }, exposure: 'codemode' })
    mcpDomainMock.addMcpServer.mockResolvedValue({ ok: true, entry: created })
    const w = mountSection()
    await flushPromises()
    await openAddForm()

    await q<HTMLInputElement>('[data-testid="mcp-form-name"]').setValue('fs')
    await q<HTMLInputElement>('[data-testid="mcp-form-command"]').setValue('npx')
    await q<HTMLTextAreaElement>('[data-testid="mcp-form-args"]').setValue('-y\npkg')
    await q<HTMLTextAreaElement>('[data-testid="mcp-form-env"]').setValue('API_KEY=x')
    // 暴露档位默认 codemode（D6），档位释义可见
    expect(q('[data-testid="mcp-form-exposure-hint"]').text()).toContain('Code Mode')
    await submitForm()

    expect(mcpDomainMock.addMcpServer).toHaveBeenCalledTimes(1)
    expect(mcpDomainMock.addMcpServer).toHaveBeenCalledWith({
      name: 'fs',
      entry: { command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: 'x' }, exposure: 'codemode' },
    })
    // 清单以服务端终态校准：新行渲染，弹层关闭
    expect(w.find('[data-testid="mcp-row-fs"]').exists()).toBe(true)
    expect(document.querySelector('[data-testid="mcp-form-dialog"]')).toBeNull()
    wrapper?.unmount()
  })

  it('编辑流：名称锁定（disabled）+ 改包装键名保存被拦截（改名 = 删除后重建，D7）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-edit-filesystem"]').trigger('click')
    await flushPromises()

    const nameInput = q<HTMLInputElement>('[data-testid="mcp-form-name"]').element as HTMLInputElement
    expect(nameInput.disabled).toBe(true)
    expect(nameInput.value).toBe('filesystem')

    await q('[data-testid="mcp-form-tab-code"]').trigger('click')
    await flushPromises()
    // 编辑初始即包装形态（外键可见可改，D7）
    const initial = JSON.parse((q<HTMLTextAreaElement>('[data-testid="mcp-form-code-text"]').element as HTMLTextAreaElement).value)
    expect(Object.keys(initial)).toEqual(['filesystem'])

    await q<HTMLTextAreaElement>('[data-testid="mcp-form-code-text"]').setValue(
      JSON.stringify({ renamed: { command: 'npx' } }),
    )
    await submitForm()

    expect(q('[data-testid="mcp-form-code-error"]').text()).toContain('改名 = 删除后重建')
    expect(mcpDomainMock.updateMcpServer).not.toHaveBeenCalled()
    wrapper?.unmount()
  })

  it('编辑流正常保存：update 以被编辑条目名调用 + 服务端终态校准清单', async () => {
    const updated = entryFixture('filesystem', { command: 'npx', description: '新描述' })
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    mcpDomainMock.updateMcpServer.mockResolvedValue({ ok: true, entry: updated })
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-edit-filesystem"]').trigger('click')
    await flushPromises()
    await q<HTMLInputElement>('[data-testid="mcp-form-description"]').setValue('新描述')
    await submitForm()

    expect(mcpDomainMock.updateMcpServer).toHaveBeenCalledWith({
      name: 'filesystem',
      entry: expect.objectContaining({ command: 'npx', description: '新描述' }),
    })
    expect(w.find('[data-testid="mcp-row-filesystem"]').text()).toContain('新描述')
    wrapper?.unmount()
  })

  it('编辑流切换传输类型：携带显式 type 的 http 条目切 stdio 保存 → payload 只含新类型键（§4 断言①用户入口，D7 切换清空另一类型字段）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(
      listFixture([entryFixture('mixed-src', { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer t' }, exposure: 'codemode' })]),
    )
    mcpDomainMock.updateMcpServer.mockResolvedValue({ ok: true, entry: entryFixture('mixed-src') })
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-edit-mixed-src"]').trigger('click')
    await flushPromises()

    // 编辑态仅锁名称（§3.1）：传输类型可切换（D4 例外条款 / D7 键级清理明示的编辑流切换路径）
    await pickRekaOption(q('[data-testid="mcp-form-transport"]').element, '本地命令（stdio）')
    // 切换即清空另一类型表单字段：http 字段消失、stdio 字段出现，无残留可编辑
    expect(document.querySelector('[data-testid="mcp-form-url"]')).toBeNull()
    await q<HTMLInputElement>('[data-testid="mcp-form-command"]').setValue('npx')
    await submitForm()

    // payload 无 url/headers/type（toEqual 全量比对——表单级清理；条目对象键级清理由
    // store buildFormConfig 承担，§4 断言①单测在 pi-mcp-store.test.ts）
    expect(mcpDomainMock.updateMcpServer).toHaveBeenCalledWith({
      name: 'mixed-src',
      entry: { command: 'npx', exposure: 'codemode' },
    })
    wrapper?.unmount()
  })

  it('runtime 保存校验失败（ok:false）→ error 内联显示在表单，不关闭弹层（校验权威在 runtime）', async () => {
    mcpDomainMock.addMcpServer.mockResolvedValue({ ok: false, error: 'type "sse" is not supported' })
    const w = mountSection()
    await flushPromises()
    await openAddForm()

    await q<HTMLInputElement>('[data-testid="mcp-form-name"]').setValue('srv')
    await q<HTMLInputElement>('[data-testid="mcp-form-command"]').setValue('npx')
    await submitForm()

    expect(q('[data-testid="mcp-form-server-error"]').text()).toContain('type "sse"')
    expect(document.querySelector('[data-testid="mcp-form-dialog"]')).not.toBeNull()
    wrapper?.unmount()
  })

  // ── 清单行动作 ──

  it('启停切换调协议：Switch 点击 → setEnabled 启停专用操作（仅 name + enabled，不带条目投影回写），服务端终态校准', async () => {
    const disabled = entryFixture('filesystem', { command: 'npx', enabled: false })
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    mcpDomainMock.setMcpServerEnabled.mockResolvedValue({ ok: true, entry: disabled })
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-toggle-filesystem"]').trigger('click')
    await flushPromises()

    expect(mcpDomainMock.setMcpServerEnabled).toHaveBeenCalledTimes(1)
    // §3.1「写入 enabled 字段」最小语义：payload 只含 name + enabled（整条目回写会让
    // 清单打开至切换之间的外部并发改动被旧投影覆盖，D2 丢失窗口失真——U4 修复锚定）
    expect(mcpDomainMock.setMcpServerEnabled).toHaveBeenCalledWith({
      name: 'filesystem',
      enabled: false,
    })
    expect(mcpDomainMock.updateMcpServer).not.toHaveBeenCalled()
    expect(w.find('[data-testid="mcp-toggle-filesystem"]').attributes('data-state')).toBe('unchecked')
    wrapper?.unmount()
  })

  it('启停失败损坏拒入（ok:false + corruption）→ toast 指引先修复 + 转整页损坏态（S6 同口径）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    mcpDomainMock.setMcpServerEnabled.mockResolvedValue({
      ok: false,
      error: 'mcp.json 无法解析（JSON 语法错误）：请先修复文件后再操作（文件路径：/data/agent/mcp.json）',
      corruption: { filePath: '/data/agent/mcp.json', corruptCopyPath: null },
    })
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-toggle-filesystem"]').trigger('click')
    await flushPromises()

    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('保存被拒绝'))
    expect(w.find('[data-testid="mcp-corruption-error"]').exists()).toBe(true)
    wrapper?.unmount()
  })

  it('启停失败（ok:false 无 corruption，如条目已被外部删除）→ store 错误文案走 toast 可见，不误转损坏态', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    mcpDomainMock.setMcpServerEnabled.mockResolvedValue({
      ok: false,
      error: '服务器 "filesystem" 不存在：可能已被删除，请刷新清单后重试',
    })
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-toggle-filesystem"]').trigger('click')
    await flushPromises()

    // 清单行失败反馈走 toast（formServerError 仅由编辑弹层渲染，写它则用户无任何可见反馈）
    expect(toastMock.error).toHaveBeenCalledWith('服务器 "filesystem" 不存在：可能已被删除，请刷新清单后重试')
    expect(w.find('[data-testid="mcp-corruption-error"]').exists()).toBe(false)
    wrapper?.unmount()
  })

  it('删除失败（ok:false 无 corruption）→ store 错误文案走 toast，确认框关闭', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    mcpDomainMock.removeMcpServer.mockResolvedValue({
      ok: false,
      error: '服务器 "filesystem" 不存在：可能已被删除，请刷新清单后重试',
    })
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-remove-filesystem"]').trigger('click')
    await flushPromises()
    const confirmBtn = q('[role="dialog"]').findAll('button').find((b) => b.text() === '删除')
    await confirmBtn!.trigger('click')
    await flushPromises()

    expect(toastMock.error).toHaveBeenCalledWith('服务器 "filesystem" 不存在：可能已被删除，请刷新清单后重试')
    // 确认框已关闭（失败不挂死确认弹层）
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    wrapper?.unmount()
  })

  it('删除确认：取消不调协议；确认后 remove 调用且行消失', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-remove-filesystem"]').trigger('click')
    await flushPromises()

    // ConfirmDialog 经 reka DialogPortal 渲染（ConfirmDialog 标签上的 testid 落不到 DOM，
    // 以 role=dialog 定位；本用例无其他弹层，唯一 dialog 即删除确认）
    const confirmDialog = q('[role="dialog"]')
    expect(confirmDialog.text()).toContain('删除 filesystem？')

    // 取消路径：不调协议，弹层关闭
    const cancelBtn = confirmDialog.findAll('button').find((b) => b.text() === '取消')
    await cancelBtn!.trigger('click')
    await flushPromises()
    expect(mcpDomainMock.removeMcpServer).not.toHaveBeenCalled()

    // 确认路径：协议调用 + 行消失
    await w.find('[data-testid="mcp-remove-filesystem"]').trigger('click')
    await flushPromises()
    const confirmBtn = q('[role="dialog"]').findAll('button').find((b) => b.text() === '删除')
    await confirmBtn!.trigger('click')
    await flushPromises()

    expect(mcpDomainMock.removeMcpServer).toHaveBeenCalledWith({ name: 'filesystem' })
    expect(w.find('[data-testid="mcp-row-filesystem"]').exists()).toBe(false)
    wrapper?.unmount()
  })

  it('连接测试按钮：调 mcp.test 协议 + 徽标转「测试中」（D8② 过程态）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-test-filesystem"]').trigger('click')
    await flushPromises()

    expect(mcpDomainMock.testMcpServer).toHaveBeenCalledWith({ name: 'filesystem' })
    expect(w.find('[data-testid="mcp-badge-filesystem"]').text()).toBe('测试中')
    wrapper?.unmount()
  })

  // ── 状态徽标三类来源（D8；probe 结果经 applyProbeResult 接缝回填）──

  function applyProbe(w: VueWrapper, name: string, badge: McpServerStatusBadge): void {
    ;(w.vm as unknown as { applyProbeResult: (n: string, b: McpServerStatusBadge) => void }).applyProbeResult(name, badge)
  }

  // ── mcp:testResult 广播帧回填（u5b 打回接线：probe 终态经 runtime 广播到达本组件）──

  function broadcastTestResult(name: string, badge: McpServerStatusBadge, testId = 'test-1'): void {
    dispatchGlobal({ id: `push_broadcast_${broadcastSeq++}`, type: 'mcp:testResult', payload: { name, testId, badge } })
  }

  it('广播帧 connected：徽标从「测试中」转终态「已连接（N 个工具）」（S1 判定面）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('filesystem')]))
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-test-filesystem"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-filesystem"]').text()).toBe('测试中')

    broadcastTestResult('filesystem', { source: 'probe', state: 'connected', toolCount: 14, testedAt: 1730000000000 })
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-filesystem"]').text()).toBe('已连接（14 个工具）')
    wrapper?.unmount()
  })

  it('广播帧 failed：徽标转「连接失败」+ 详情展开 error 全文（S4 判定面）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('broken')]))
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-test-broken"]').trigger('click')
    await flushPromises()

    broadcastTestResult('broken', {
      source: 'probe',
      state: 'failed',
      errorDetail: 'spawn /nonexistent/path/binary ENOENT',
      testedAt: 1730000000002,
    })
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-broken"]').text()).toBe('连接失败')
    await w.find('[data-testid="mcp-error-detail-toggle-broken"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="mcp-error-detail-broken"]').text()).toContain('spawn /nonexistent/path/binary ENOENT')
    wrapper?.unmount()
  })

  it('广播帧 ui-local timeout：徽标转「测试超时」+ 上次成功结果保留（D3）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('slow')]))
    const w = mountSection()
    await flushPromises()

    broadcastTestResult('slow', { source: 'probe', state: 'connected', toolCount: 2, testedAt: 1730000000003 })
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-slow"]').text()).toBe('已连接（2 个工具）')

    broadcastTestResult('slow', { source: 'ui-local', state: 'timeout' }, 'test-2')
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-slow"]').text()).toContain('测试超时')
    wrapper?.unmount()
  })

  it('probe 徽标：connected → 「已连接（N 个工具）」；failed → 「连接失败」+ 详情展开 error 全文', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(
      listFixture([entryFixture('ok'), entryFixture('bad', { command: '/nonexistent-cmd' })]),
    )
    const w = mountSection()
    await flushPromises()

    applyProbe(w, 'ok', { source: 'probe', state: 'connected', toolCount: 3, testedAt: 1730000000000 })
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-ok"]').text()).toBe('已连接（3 个工具）')

    applyProbe(w, 'bad', { source: 'probe', state: 'failed', errorDetail: 'spawn /nonexistent-cmd ENOENT\nstderr tail...', testedAt: 1730000000001 })
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-bad"]').text()).toBe('连接失败')

    // 详情入口展开 error 全文（D8①：连接测试结果自身 error 字段，含 stderr 尾部）
    await w.find('[data-testid="mcp-error-detail-toggle-bad"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="mcp-error-detail-bad"]').text()).toContain('spawn /nonexistent-cmd ENOENT')
    expect(w.find('[data-testid="mcp-error-detail-bad"]').text()).toContain('stderr tail...')
    wrapper?.unmount()
  })

  it('probe 其余实测态：needs-auth / disabled 徽标映射（D8①）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('auth'), entryFixture('off')]))
    const w = mountSection()
    await flushPromises()

    applyProbe(w, 'auth', { source: 'probe', state: 'needs-auth', testedAt: 1 })
    applyProbe(w, 'off', { source: 'probe', state: 'disabled', testedAt: 2 })
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-auth"]').text()).toBe('需要登录')
    expect(w.find('[data-testid="mcp-badge-off"]').text()).toBe('已停用')
    wrapper?.unmount()
  })

  it('测试超时：整体无本次结果，「测试超时」徽标 + 上次成功结果保留展示（D3）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('slow')]))
    const w = mountSection()
    await flushPromises()

    applyProbe(w, 'slow', { source: 'probe', state: 'connected', toolCount: 2, testedAt: 1730000000000 })
    applyProbe(w, 'slow', { source: 'ui-local', state: 'timeout' })
    await flushPromises()

    expect(w.find('[data-testid="mcp-badge-slow"]').text()).toBe('测试超时')
    expect(w.find('[data-testid="mcp-badge-last-slow"]').text()).toContain('已连接（2 个工具）')
    wrapper?.unmount()
  })

  // ── 损坏错误态与加载失败 ──

  it('损坏错误态整页呈现：路径 + 先修复指引 + 添加禁用 + 清单不渲染（S6）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(
      listFixture([], { filePath: '/data/.taiji-dev/agent/mcp.json', corruptCopyPath: null }),
    )
    const w = mountSection()
    await flushPromises()

    expect(w.find('[data-testid="mcp-corruption-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="mcp-corruption-path"]').text()).toBe('/data/.taiji-dev/agent/mcp.json')
    expect(w.find('[data-testid="mcp-corruption-guide"]').text()).toContain('先修复或删除该文件')
    expect(w.find('[data-testid="mcp-corruption-guide"]').text()).toContain('不会覆盖')
    expect(w.find('[data-testid="mcp-add-btn"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="mcp-server-list"]').exists()).toBe(false)

    // 复制路径按钮
    writeText.mockResolvedValueOnce(undefined)
    await w.find('[data-testid="mcp-copy-path-btn"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('/data/.taiji-dev/agent/mcp.json')
    wrapper?.unmount()
  })

  it('隔离副本提示：corruptCopyPath 非空 → 渲染副本路径（codemode 同形态）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(
      listFixture([], { filePath: '/data/mcp.json', corruptCopyPath: '/data/mcp.json.corrupt-1730000000000' }),
    )
    const w = mountSection()
    await flushPromises()

    expect(w.find('[data-testid="mcp-corrupt-copy-path"]').text()).toContain('mcp.json.corrupt-1730000000000')
    wrapper?.unmount()
  })

  it('加载失败：错误提示 + 重试按钮，重试成功恢复清单', async () => {
    mcpDomainMock.listMcpServers.mockRejectedValueOnce(new Error('rpc down'))
    const w = mountSection()
    await flushPromises()

    expect(w.find('[data-testid="mcp-load-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="mcp-server-list"]').exists()).toBe(false)

    await w.find('[data-testid="mcp-load-retry"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="mcp-load-error"]').exists()).toBe(false)
    expect(w.find('[data-testid="mcp-list-empty"]').exists()).toBe(true)
    wrapper?.unmount()
  })

  // ── I3 登录引导（needs-auth 徽标：完整可复制登录命令 + PI_CODING_AGENT_DIR 指引）──

  it('needs-auth 徽标：登录命令渲染（agentDir 运行时填充）+ 复制按钮拷贝完整命令 + toast 反馈（I3）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('auth')]))
    const w = mountSection()
    await flushPromises()

    applyProbe(w, 'auth', { source: 'probe', state: 'needs-auth', testedAt: 1 })
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-auth"]').text()).toBe('需要登录')

    // 完整可复制命令：PI_CODING_AGENT_DIR=<mcp.list reply agentDir> pi mcp login <name>
    //（缺环境变量指引时凭据会写到 ~/.pi/agent 成为孤岛，复刻 F1）
    const cmd = 'PI_CODING_AGENT_DIR=/data/.taiji-dev/agent pi mcp login auth'
    expect(w.find('[data-testid="mcp-login-cmd-auth"]').text()).toBe(cmd)

    writeText.mockResolvedValueOnce(undefined)
    await w.find('[data-testid="mcp-login-copy-auth"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(cmd)
    expect(toastMock.info).toHaveBeenCalledWith('登录命令已复制')
    wrapper?.unmount()
  })

  it('非 needs-auth 条目不渲染登录命令（指引只属于 needs-auth 场景）', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('ok')]))
    const w = mountSection()
    await flushPromises()

    applyProbe(w, 'ok', { source: 'probe', state: 'connected', toolCount: 1, testedAt: 1 })
    await flushPromises()
    expect(w.find('[data-testid="mcp-login-cmd-ok"]').exists()).toBe(false)
    expect(w.find('[data-testid="mcp-login-copy-ok"]').exists()).toBe(false)
    wrapper?.unmount()
  })

  // ── 连接测试取消（D3「取消」按钮——等价于超时到点杀进程的主动形态）──

  it('测试进行中按钮切「取消」：点击 → testCancel 按 testId 杀 probe，cancelled true 徽标恢复原态', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('slow')]))
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-test-slow"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-slow"]').text()).toBe('测试中')
    expect(w.find('[data-testid="mcp-test-slow"]').text()).toContain('取消')

    await w.find('[data-testid="mcp-test-slow"]').trigger('click')
    await flushPromises()

    // testId 来自 mcp.test reply 句柄（beforeEach mock 恒 test-1）
    expect(mcpDomainMock.cancelMcpServerTest).toHaveBeenCalledWith({ testId: 'test-1' })
    // cancelled true：probe 将以 cancelled 终态收敛（不回填徽标），本侧恢复取消前徽标（未测试）
    expect(w.find('[data-testid="mcp-badge-slow"]').text()).toBe('未测试')
    wrapper?.unmount()
  })

  it('取消晚到（cancelled false）：徽标不动，结果由 mcp:testResult 广播照常回填', async () => {
    mcpDomainMock.listMcpServers.mockResolvedValue(listFixture([entryFixture('slow')]))
    mcpDomainMock.cancelMcpServerTest.mockResolvedValue({ cancelled: false })
    const w = mountSection()
    await flushPromises()

    await w.find('[data-testid="mcp-test-slow"]').trigger('click')
    await flushPromises()
    await w.find('[data-testid="mcp-test-slow"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="mcp-badge-slow"]').text()).toBe('测试中')

    // 任务实际已完成的形态：结果广播正常回填
    broadcastTestResult('slow', { source: 'probe', state: 'connected', toolCount: 2, testedAt: 1730000000010 })
    await flushPromises()
    expect(w.find('[data-testid="mcp-badge-slow"]').text()).toBe('已连接（2 个工具）')
    wrapper?.unmount()
  })

  // ── i18n 双语 key 对齐 ──

  it('i18n 双语 key 对齐：zh-CN 与 en-US 的 mcp 键集一致（含嵌套 exposureHint）', () => {
    const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`],
      )
    const zhKeys = flatten((zhCN as Record<string, Record<string, unknown>>).mcp).sort()
    const enKeys = flatten((enUS as Record<string, Record<string, unknown>>).mcp).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(30)
  })
})
