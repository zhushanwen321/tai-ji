/**
 * plugin-capability-map 映射完整性单测（provider-plugin-access D3 / u-foundation 验收②）
 *
 * 守护：4 个能力词 → 放行模块集与设计 D3 表逐项一致（期望值硬编码自设计表，不引
 * 被测常量对比自身——同义反复抓不住映射写错）。放行集写错 = sandbox 放行边界漂移
 * （多放 = 逃逸面扩大，少放 = 已声明能力插件被拒），映射改动必须本测试同步红绿。
 */
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_CAPABILITIES,
  PluginCapabilityConstants,
  getCapabilityModules,
  resolveAllowedModules,
} from '../plugin-capability-map.js'

describe('能力词 → 放行模块集（D3 表逐项一致）', () => {
  it('network.http → http / https / net / dns / tls', () => {
    expect(getCapabilityModules(PluginCapabilityConstants.NETWORK_HTTP)).toEqual([
      'http',
      'https',
      'net',
      'dns',
      'tls',
    ])
  })

  it('fs.read-user-data → fs / fs/promises（只读子集 + 路径受限由 loader/fork 侧承载）', () => {
    expect(getCapabilityModules(PluginCapabilityConstants.FS_READ_USER_DATA)).toEqual([
      'fs',
      'fs/promises',
    ])
  })

  it('crypto → crypto', () => {
    expect(getCapabilityModules(PluginCapabilityConstants.CRYPTO)).toEqual(['crypto'])
  })

  it('process.spawn → child_process', () => {
    expect(getCapabilityModules(PluginCapabilityConstants.PROCESS_SPAWN)).toEqual(['child_process'])
  })

  it('词表恰好 4 个能力词（映射完整性——新增词必须配映射，漏配即红）', () => {
    expect(PLUGIN_CAPABILITIES).toHaveLength(4)
    expect([...PLUGIN_CAPABILITIES].sort()).toEqual(
      ['crypto', 'fs.read-user-data', 'network.http', 'process.spawn'].sort(),
    )
  })

  it('4 个能力词全部有映射（无悬空常量）', () => {
    for (const capability of PLUGIN_CAPABILITIES) {
      expect(getCapabilityModules(capability), `能力词 ${capability} 缺映射`).toBeDefined()
      expect(getCapabilityModules(capability)!.length).toBeGreaterThan(0)
    }
  })
})

describe('resolveAllowedModules（fork 放行清单数据源）', () => {
  it('多能力词并集去重（crypto 与 process.spawn 无交集，各自入集）', () => {
    const { allowed, unknown } = resolveAllowedModules([
      PluginCapabilityConstants.CRYPTO,
      PluginCapabilityConstants.PROCESS_SPAWN,
    ])
    expect(unknown).toEqual([])
    expect([...allowed].sort()).toEqual(['child_process', 'crypto'].sort())
  })

  it('重复模块去重保序（fs 与 fs/promises 同属 fs.read-user-data 单词不重复；跨词重复场景去重）', () => {
    const { allowed } = resolveAllowedModules([
      PluginCapabilityConstants.NETWORK_HTTP,
      PluginCapabilityConstants.NETWORK_HTTP,
    ])
    expect(allowed).toEqual(['http', 'https', 'net', 'dns', 'tls'])
  })

  it('未知词单独返回、不参与放行（安装期校验的判定输入）', () => {
    const { allowed, unknown } = resolveAllowedModules([
      PluginCapabilityConstants.CRYPTO,
      'not-a-capability',
    ])
    expect(allowed).toEqual(['crypto'])
    expect(unknown).toEqual(['not-a-capability'])
  })

  it('空声明 → 空放行集（未声明能力的插件不因缺省获得任何模块）', () => {
    const { allowed, unknown } = resolveAllowedModules([])
    expect(allowed).toEqual([])
    expect(unknown).toEqual([])
  })

  it('未知词重复出现只报一次', () => {
    const { unknown } = resolveAllowedModules(['ghost', 'ghost'])
    expect(unknown).toEqual(['ghost'])
  })
})
