/**
 * paths.ts 纯函数测试（W3）。
 *
 * 覆盖 getAttachmentsDir（IF4）：
 * - W3TC1: 传 dataDir → path.join(dataDir,'attachments',sessionId)
 * - W3TC2: 不传 dataDir → path.join(getDataDir(),'attachments',sessionId)
 * - W5+B2（路径穿越防护）：sessionId 含分隔符/非法字符 → throw
 *   （原 W3TC3 用「不负责 sanitize sessionId」固化缺陷，已删除；改用纵深防御校验）
 *
 * 覆盖 getPiAgentDir（方案 B 布局对齐 pi：`<dataDir>/agent`）：
 * - env 注入 TAIJI_AGENT_DATA_DIR → `<dataDir>/agent`（旧两级布局已退役；正向断言即回归守卫）
 * - 不传 env → 与 getDataDir() 推导一致
 * - env 无 TAIJI_AGENT_DATA_DIR → `~/.taiji-dev/agent`（缺省反转后的字面路径断言——
 *   缺省 = dev 目录（fail-safe default），prod 形态由打包 main 显式钉死 ~/.taiji，
 *   不得回归旧缺省 ~/.taiji）
 *
 * 覆盖 getDataDir prod 值准入守卫（C-proc-26 第二支柱，词法判定不触磁盘）：
 * - prod 树值 + 无 PACKAGED → throw；+ PACKAGED=1 → 放行
 * - dev/tmp/未设/空串 → 不触发；词法出入树 resolve 消解后判定；前缀混淆 sep 边界放行
 * - 大小写变体 ~/.TAIJI → 判定双侧 casefold（大小写不敏感卷上词法树外 = 磁盘命中 prod）
 *
 * 运行：cd packages/shared && npx vitest run __tests__/paths.test.ts
 */
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getAttachmentsDir, getDataDir, getPiAgentDir } from '../src/paths'

describe('getAttachmentsDir（W3 IF4 纯函数）', () => {
  it('W3TC1: 传 dataDir → path.join(dataDir, "attachments", sessionId)', () => {
    const result = getAttachmentsDir('sess-1', '/custom/data')
    expect(result).toBe(join('/custom/data', 'attachments', 'sess-1'))
    // 纯函数不创建目录——无副作用可断言（仅校验返回值，目录是否真实存在由 IPC handler 负责）
  })

  it('W3TC2: 不传 dataDir → path.join(getDataDir(), "attachments", sessionId)', () => {
    const result = getAttachmentsDir('sess-2')
    expect(result).toBe(join(getDataDir(), 'attachments', 'sess-2'))
  })

  it('sessionId 含路径分隔符 → throw（防路径穿越）', () => {
    // W5+B2: getAttachmentsDir 校验 sessionId 字符集，拒绝 / \ .. ; 等会逃逸 attachments/ 的载荷。
    expect(() => getAttachmentsDir('../etc', '/d')).toThrow(/path traversal/)
    expect(() => getAttachmentsDir('foo/bar', '/d')).toThrow(/path traversal/)
    expect(() => getAttachmentsDir('..\\etc', '/d')).toThrow(/path traversal/)
    expect(() => getAttachmentsDir('a;b', '/d')).toThrow(/path traversal/) // 分号等也不允许
  })

  it('合法 sessionId（uuidv7 / u-<uuid> 格式）正常拼接', () => {
    // pi 的 uuidv7 格式
    expect(getAttachmentsDir('019f9bd8-ee50-779d-a912-4a661683cf69', '/d'))
      .toBe(join('/d', 'attachments', '019f9bd8-ee50-779d-a912-4a661683cf69'))
    // taiji store 的 u-<uuid> 格式
    expect(getAttachmentsDir('u-a1b2c3d4-e5f6-7890-abcd-ef1234567890', '/d'))
      .toBe(join('/d', 'attachments', 'u-a1b2c3d4-e5f6-7890-abcd-ef1234567890'))
  })
})

describe('getPiAgentDir（方案 B 布局对齐 pi）', () => {
  it('env 注入 TAIJI_AGENT_DATA_DIR → path.join(dataDir, "agent")（单层，无中间层）', () => {
    const env = { TAIJI_AGENT_DATA_DIR: '/custom/data' }
    // 回归守卫：旧两级布局会返回带一层中间目录的路径（<dataDir>/<层>/agent），
    // 与上面的期望值不同 → 退化必红，无需再写第二条反向断言。
    expect(getPiAgentDir(env)).toBe(join('/custom/data', 'agent'))
  })

  it('不传 env → path.join(getDataDir(), "agent")', () => {
    expect(getPiAgentDir()).toBe(join(getDataDir(), 'agent'))
  })

  it('env 无 TAIJI_AGENT_DATA_DIR → 缺省 ~/.taiji-dev/agent（fail-safe default，非 prod ~/.taiji、非系统 pi 的 ~/.pi/agent）', () => {
    // 纯路径推导，不触碰磁盘。缺省反转回归守卫：旧缺省 ~/.taiji 必红。
    expect(getPiAgentDir({})).toBe(join(homedir(), '.taiji-dev', 'agent'))
    expect(getPiAgentDir({})).not.toBe(join(homedir(), '.taiji', 'agent'))
    expect(getPiAgentDir({})).not.toBe(join(homedir(), '.pi', 'agent'))
  })
})

describe('getDataDir prod 值准入守卫（C-proc-26 第二支柱）', () => {
  /** 守卫判定纯词法（resolve + 真实 homedir 树内判），构造值不触磁盘 */
  const PROD_ROOT = join(homedir(), '.taiji')
  const DEV_ROOT = join(homedir(), '.taiji-dev')

  it('prod 树值 + 无 PACKAGED → throw（泄漏形态：消息含恢复动作）', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: PROD_ROOT })).toThrow(/C-proc-26 prod-admission guard/)
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: join(PROD_ROOT, 'agent') })).toThrow(
      /unset TAIJI_AGENT_DATA_DIR/,
    )
  })

  it('prod 树值 + PACKAGED=1 → 放行返回原值（合法 prod 消费链）', () => {
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: PROD_ROOT, TAIJI_AGENT_PACKAGED: '1' })).toBe(PROD_ROOT)
  })

  it('dev 树值 / tmp 值 / 未设 / 空串 → 不触发守卫（缺省或原值）', () => {
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: DEV_ROOT })).toBe(DEV_ROOT)
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: '/tmp/anything' })).toBe('/tmp/anything')
    expect(getDataDir({})).toBe(DEV_ROOT)
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: '' })).toBe(DEV_ROOT)
  })

  it('词法入树形态 ~/.taiji-dev/../.taiji → resolve 消解后在 prod 树内，throw', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: `${DEV_ROOT}/../.taiji` })).toThrow(
      /prod-admission guard/,
    )
  })

  it('词法出树形态 ~/.taiji/../.taiji-dev → resolve 消解后在 dev 树，放行', () => {
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: `${PROD_ROOT}/../.taiji-dev` })).toBe(
      `${PROD_ROOT}/../.taiji-dev`,
    )
  })

  it('前缀混淆形态 ~/.taijiish → sep 边界判不在树内，放行', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: `${PROD_ROOT}ish` })).not.toThrow()
  })

  it('大小写变体 ~/.TAIJI（无 PACKAGED）→ casefold 判在 prod 树内，throw（大小写不敏感卷漏判 = 写真实 prod）', () => {
    const variant = join(homedir(), '.TAIJI')
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: variant })).toThrow(/prod-admission guard/)
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: join(variant, 'agent') })).toThrow(
      /prod-admission guard/,
    )
  })

  it('大小写变体 ~/.TAIJI + PACKAGED=1 → 放行返回原值（错误消息保留原大小写）', () => {
    const variant = join(homedir(), '.TAIJI')
    expect(getDataDir({ TAIJI_AGENT_DATA_DIR: variant, TAIJI_AGENT_PACKAGED: '1' })).toBe(variant)
  })

  it('大小写变体前缀混淆 ~/.TAIJIish → casefold 后 sep 边界仍生效，放行', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: `${join(homedir(), '.TAIJI')}ish` })).not.toThrow()
  })

  it('PACKAGED 非 "1" 值（0/true）不构成 prod 形态声明，prod 树值仍 throw', () => {
    expect(() => getDataDir({ TAIJI_AGENT_DATA_DIR: PROD_ROOT, TAIJI_AGENT_PACKAGED: '0' })).toThrow()
    expect(() =>
      getDataDir({ TAIJI_AGENT_DATA_DIR: PROD_ROOT, TAIJI_AGENT_PACKAGED: 'true' }),
    ).toThrow()
  })
})
