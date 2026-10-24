/**
 * _smoke-plugin-fixtures —— S3 组 fixture 基建冒烟（临时剧本，交付前删除）。
 *
 * 验证四条链路，全部 B/C 通道：
 *   ① 预置 fixture 插件被 registry 扫到且激活（plugin.list status=active）；
 *   ② plugin.invoke → 插件注册的业务方法往返（commands-executor 链）；
 *   ③ 插件 providers.write → C：models.json 落盘本命名空间条目；
 *   ④ 清单缓存种子 → plugin.listAvailable 返回 fixture 条目（4h 节流窗内不发网络）。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  resolveDataDirFromArgv,
  pluginFixture,
  seedPluginFixtures,
  seedCatalogCache,
  catalogEntry,
  approveAndAwaitActive,
  pollUntil,
} from './lib-plugin-fixtures.mjs'

const ALPHA_KEY = 'SMOKE-ALPHA-SECRET-9137'

// ── 顶层预置（import 阶段执行，先于 instance.launch）────────────────
const dataDir0 = resolveDataDirFromArgv()
seedPluginFixtures(dataDir0, [
  pluginFixture({
    dirName: 'smoke__plugin-echo',
    pkgName: '@smoke/plugin-echo',
    displayName: 'Smoke Echo',
    description: 'smoke fixture for S3 infra',
    namespace: 'smoke-echo',
    permissions: ['plugin.commands.register', 'providers.write', 'plugin.event'],
    activateBody: `
  await api.commands.register({ id: 'ping', title: 'ping' }, (args) => ({ pong: true, echo: args ?? null }))
  await api.providers.write({ providerId: 'echo-prov', apiKey: '${ALPHA_KEY}', displayName: 'Smoke Echo Provider', models: [{ id: 'smoke-model' }] })
`,
  }),
])
seedCatalogCache(dataDir0, [
  catalogEntry({
    pluginId: 'smoke__plugin-echo',
    packageName: '@smoke/plugin-echo',
    displayName: 'Smoke Echo (catalog)',
    version: '0.1.0',
    family: { id: 'echo', displayName: 'SmokeEcho', vendor: 'verify', credentialSource: 'oauth', modelCount: 1 },
  }),
])

export const meta = {
  id: '_smoke-plugin-fixtures',
  priority: 'P0',
  title: 'S3 fixture 基建冒烟（临时）',
  covers: [],
  requires: [],
  estimateSec: 120,
  notProvable: ['全部 UI 通道（本剧本只验基建链路）'],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir } = ctx
  const gotchas = []

  // ① 权限批准 + 插件被发现且激活
  const states = await approveAndAwaitActive(protocol, ev, {
    'smoke__plugin-echo': ['plugin.commands.register', 'providers.write', 'plugin.event'],
  })
  ev.assert('① fixture 插件激活（sandbox fork，status=active）', states['smoke__plugin-echo']?.status === 'active', {
    channel: 'B', expected: 'active', actual: JSON.stringify(states),
  })
  ev.step({ step: 'fixture.active', channel: 'B', exitCode: 0, stats: { pluginId: 'smoke__plugin-echo' } })

  // ② invoke 往返
  const pong = await protocol.call('plugin.invoke', { pluginId: 'smoke__plugin-echo', method: 'ping', params: { hello: 'world' } })
  ev.assert('② plugin.invoke → 业务方法往返', pong?.result?.pong === true && pong?.result?.echo?.hello === 'world', {
    channel: 'B', expected: '{pong:true, echo:{hello:world}}', actual: JSON.stringify(pong?.result ?? pong).slice(0, 200),
  })

  // ③ providers.write → models.json
  await pollUntil(() => {
    try {
      const models = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8'))
      return Boolean(models.providers?.['echo-prov'])
    } catch {
      return false
    }
  }, { timeoutMs: 20_000, label: 'models.json 落盘 echo-prov' })
  const models = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8'))
  ev.assert('③ C: providers.write 落盘 models.json（本命名空间条目 + apiKey）', models.providers?.['echo-prov']?.apiKey === ALPHA_KEY, {
    channel: 'C', expected: `apiKey=${ALPHA_KEY}`, actual: JSON.stringify(models.providers?.['echo-prov'] ?? null).slice(0, 200),
  })

  // ④ 清单缓存种子 → listAvailable
  const avail = await protocol.call('plugin.listAvailable', {})
  const entry = (avail.plugins ?? []).find((x) => x.pluginId === 'smoke__plugin-echo')
  ev.assert('④ B: listAvailable 返回种子清单条目（installed 比对命中）', Boolean(entry) && entry.installed === true && entry.family?.id === 'smoke-echo', {
    channel: 'B', expected: 'installed:true + family.id=smoke-echo', actual: JSON.stringify(entry ?? avail).slice(0, 300),
  })

  log('smoke done')
  return { uncovered: gotchas, gotchas }
}
