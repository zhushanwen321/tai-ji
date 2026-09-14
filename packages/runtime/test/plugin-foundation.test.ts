/**
 * PluginRegistry built-in scan 测试（BG1 Task 1 残留正文）。
 *
 * [2026-09 测试舰队审查 r2-14 裁剪] 原「类型系统验证」约 12 个用例已删——
 * `const x: PluginSource = 'built-in'; expect(x).toBe('built-in')` 形态的断言在
 * vitest（esbuild 剥类型）下运行时恒真，类型契约由 tsc（pnpm typecheck）承担；
 * PermissionConstants truthiness 守卫与 plugin-permission-map.test.ts 的
 * SSOT 全量归一守卫重叠（那边更强）。仅保留 PluginRegistry scan 2 个真行为用例。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PluginRegistry } from '../src/services/plugin-service/plugin-registry.js'

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'plugin-foundation-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

describe('PluginRegistry built-in scan', () => {
  it('scan() includes built-in path resources/plugins/', async () => {
    const registry = new PluginRegistry(tmpDir, tmpDir)
    // 获取 scan 的目录列表——通过创建 built-in 插件验证
    const builtInDir = join(tmpDir, 'resources', 'plugins', 'core-tool')
    await mkdir(builtInDir, { recursive: true })
    await writeFile(
      join(builtInDir, 'package.json'),
      JSON.stringify({
        name: 'core-tool',
        version: '1.0.0',
        xyzAgent: {
          manifestVersion: 1,
          main: 'index.js',
          activationEvents: ['onStartupFinished'],
        },
      }),
      'utf-8',
    )

    const descriptors = await registry.scan()
    const coreTool = descriptors.find(d => d.pluginId === 'core-tool')!
    expect(coreTool).toBeTruthy()
    expect(coreTool.source).toBe('built-in')
    expect(coreTool.extensionDependencies).toEqual([])
  })

  it('external plugins are marked as external', async () => {
    const pluginDir = join(tmpDir, '.xyz-agent', 'plugins', 'ext-plugin')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'ext-plugin',
        version: '1.0.0',
        xyzAgent: {
          manifestVersion: 1,
          main: 'index.js',
          activationEvents: [],
          extensionDependencies: ['core-tool'],
        },
      }),
      'utf-8',
    )

    const registry = new PluginRegistry(tmpDir, tmpDir)
    const descriptors = await registry.scan()
    const ext = descriptors.find(d => d.pluginId === 'ext-plugin')!
    expect(ext).toBeTruthy()
    expect(ext.source).toBe('external')
    expect(ext.extensionDependencies).toEqual(['core-tool'])
  })
})
