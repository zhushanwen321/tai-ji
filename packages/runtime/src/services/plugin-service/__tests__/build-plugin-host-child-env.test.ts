/**
 * buildPluginHostChildEnv 出站接线单测（U4-B6，docs/architecture/env-propagation-boundary.md §5-U4/D6）。
 *
 * 覆盖验收断言点：{...process.env} 全量拷贝拓扑不动——除 deny 两键与既有
 * ELECTRON_RUN_AS_NODE=1 注入外，输出键集合与输入完全一致（含非白名单任意键）；
 * 不 mutate 输入对象（R1）。纯函数 DI 注入污染记录，不读写真实 process.env（R3）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/plugin-service/__tests__/build-plugin-host-child-env.test.ts
 */
import { describe, it, expect } from 'vitest'
import { buildPluginHostChildEnv } from '../plugin-host-process.js'

/** 混合形态父 env：正常键 + 非白名单任意键 + deny 两键 + undefined 值。 */
function createPollutedParentEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/tester',
    // trusted/sandbox 插件兼容性依赖全量拷贝：非白名单键也必须跟随（D6）
    SOME_PLUGIN_CUSTOM_VAR: 'keep-me',
    XYZ_AGENT_PACKAGED: '1',
    XYZ_RUNTIME_TOKEN: 'secret-token',
    EMPTY_VALUED: '',
  }
}

describe('buildPluginHostChildEnv（U4/D6 只做增量叠加）', () => {
  it('拷贝拓扑不变：除 deny 两键外键集合一致；ELECTRON_RUN_AS_NODE=1 注入', () => {
    const parent = createPollutedParentEnv()
    const out = buildPluginHostChildEnv(parent)

    expect(out.XYZ_AGENT_PACKAGED).toBeUndefined()
    expect(out.XYZ_RUNTIME_TOKEN).toBeUndefined()
    // 拷贝拓扑断言：输出 = 输入 − deny 两键 + ELECTRON_RUN_AS_NODE
    const expectedKeys = new Set([
      ...Object.keys(parent).filter((k) => k !== 'XYZ_AGENT_PACKAGED' && k !== 'XYZ_RUNTIME_TOKEN'),
      'ELECTRON_RUN_AS_NODE',
    ])
    expect(new Set(Object.keys(out))).toEqual(expectedKeys)

    expect(out.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(out.SOME_PLUGIN_CUSTOM_VAR).toBe('keep-me')
    expect(out.EMPTY_VALUED).toBe('')
  })

  it('deny 键剔除 + 沙箱变量可后续注入（caller 现行赋值路径不被阻断）', () => {
    const out = buildPluginHostChildEnv(createPollutedParentEnv())
    // caller 在返回值上继续赋值 sandbox 目录（createProcess 现行代码形状），类型上必须可行
    out.XYZ_PLUGIN_SANDBOX_DIR = '/plugins/foo'
    expect(out.XYZ_PLUGIN_SANDBOX_DIR).toBe('/plugins/foo')
  })

  it('不 mutate 父 env 对象（R1：副本上删，绝不改写输入）', () => {
    const parent = createPollutedParentEnv()
    const snapshot = { ...parent }

    buildPluginHostChildEnv(parent)

    expect(parent).toEqual(snapshot)
  })
})
