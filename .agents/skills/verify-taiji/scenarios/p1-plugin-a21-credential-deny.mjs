/**
 * p1-plugin-a21-credential-deny —— D3 验收场景 A21（设计 S21，负面，核心）：
 * 凭据回读越权拒绝——跨命名空间请求 NAMESPACE_MISMATCH；未声明 network.http 能力的
 * providers.credential 调用 PERMISSION_DENIED；两者均无凭据外泄。
 *
 * 装配：runner 单实例（scenario 顶层 import 阶段 seed）+ 双探针 fixture 插件（纯 B/C
 * 通道，无 UI 断言）：
 *   - a21-probe-http（pkg '@verify/plugin-cred-http' → ns 'cred-http'，capabilities 声明
 *     network.http）：激活即 providers.write 写本命名空间条目（凭据落点 = 正向对照）；
 *     probe 方法调 api.providers.credential(providerId) 并捕获宿主拒绝；
 *   - a21-probe-nocap（pkg '@verify/plugin-cred-nocap' → ns 'cred-nocap'，capabilities 空）：
 *     同款 probe 方法。
 *
 * 路径（全部 B/C 通道）：
 *   C：models.json 落盘 cred-http-prov（apiKey=A21-SELF-KEY，providers.write 正面）→
 *   ① 跨命名空间：invoke probe-http probe {providerId:'demo-wool'}（另一插件命名空间的
 *   providerId）→ 拒绝，错误消息 NAMESPACE_MISMATCH 前缀 →
 *   ② 能力缺失：invoke probe-nocap probe {providerId:'cred-nocap-prov'}（自己命名空间！）
 *   → 拒绝，错误消息 PERMISSION_DENIED 前缀且含 network.http（能力前提先于命名空间检查，
 *   provider-write-proxy.handleProviderCredential 校验序）→
 *   ③ 正向对照：invoke probe-http probe {providerId:'cred-http-prov'}（自己命名空间 + 已
 *   声明能力 + 凭据在场）→ 成功回读 hasKey=true——证明①的拒绝来自越权判定而非通道故障 →
 *   ④ 无凭据外泄：两个拒绝 reply 均无 key 字段（探针 catch 结构只回错误消息）。
 *
 * 锚点事实（源码已核对）：拒绝通道 = RPC error response（errorWithCode → makeErrorResponse
 * → 插件侧 reject(errorWithCode(msg, code))，错误消息带 'NAMESPACE_MISMATCH:' /
 * 'PERMISSION_DENIED:' 前缀）；handleProviderCredential 校验序 = 身份 → 清单可读 →
 * capabilities 含 network.http → 命名空间前缀 → resolver 唯一读通道；ns 推导 =
 * deriveNamespace（去 npm scope + 去 plugin- 前缀）；权限门（plugin-permission）要求
 * manifest permissions 声明完整方法名 'providers.credential' 才能到达业务校验层。
 */
import fs from 'node:fs'
import path from 'node:path'

import { pluginFixture, resolveDataDirFromArgv } from './lib-plugin-fixtures.mjs'
import { seedMultiPluginFixture, waitPluginActive, pollUntil } from './lib/plugin-provider-fixture.mjs'

const PROBE_HTTP_ID = 'a21-probe-http'
const PROBE_NOCAP_ID = 'a21-probe-nocap'
const HTTP_NS_PROVIDER = 'cred-http-prov'
const NOCAP_NS_PROVIDER = 'cred-nocap-prov'
const SELF_KEY = 'A21-SELF-KEY'
const PROBE_PERMISSIONS = ['plugin.commands.register', 'plugin.commands.invoke.result', 'providers.credential', 'providers.write']

// ── 顶层预置（import 阶段执行，先于 instance.launch）────────────────
const dataDir0 = resolveDataDirFromArgv()
const seedSummary = seedMultiPluginFixture(dataDir0, {
  plugins: [
    pluginFixture({
      dirName: PROBE_HTTP_ID,
      pkgName: '@verify/plugin-cred-http',
      displayName: 'CredHttpProbe',
      description: 'A21 fixture: declares network.http; probes providers.credential for cross-namespace deny matrix',
      namespace: 'cred-http',
      capabilities: ['network.http'],
      permissions: PROBE_PERMISSIONS,
      activateBody: `
  await api.commands.register({ id: 'probe' }, async (args) => {
    try {
      const r = await api.providers.credential(String(args?.providerId ?? ''))
      return { ok: true, providerId: r?.providerId, hasKey: typeof r?.key === 'string', kind: r?.kind ?? null }
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) }
    }
  })
  await api.providers.write({ providerId: '${HTTP_NS_PROVIDER}', apiKey: '${SELF_KEY}', displayName: 'CredHttpProbe (verify)', models: [{ id: 'a21-model' }] })
`,
    }),
    pluginFixture({
      dirName: PROBE_NOCAP_ID,
      pkgName: '@verify/plugin-cred-nocap',
      displayName: 'CredNocapProbe',
      description: 'A21 fixture: no capabilities declared; probes providers.credential permission-deny face',
      namespace: 'cred-nocap',
      permissions: PROBE_PERMISSIONS,
      activateBody: `
  await api.commands.register({ id: 'probe' }, async (args) => {
    try {
      const r = await api.providers.credential(String(args?.providerId ?? ''))
      return { ok: true, providerId: r?.providerId, hasKey: typeof r?.key === 'string', kind: r?.kind ?? null }
    } catch (e) {
      return { ok: false, message: String(e?.message ?? e) }
    }
  })
`,
    }),
  ],
  permissionSpecs: {
    [PROBE_HTTP_ID]: PROBE_PERMISSIONS,
    [PROBE_NOCAP_ID]: PROBE_PERMISSIONS,
  },
  catalogPlugins: [],
})

export const meta = {
  id: 'p1-plugin-a21-credential-deny',
  priority: 'P1',
  title: 'D3/A21（设计 S21，负面）：跨命名空间凭据请求 NAMESPACE_MISMATCH + 未声明 network.http 的 credential 调用 PERMISSION_DENIED，无凭据外泄',
  covers: ['plugin.invoke'],
  requires: [],
  estimateSec: 180,
  provable: [
    'C: models.json 落盘 cred-http-prov（probe-http providers.write 正面，凭据对照落点）',
    'B: 越权请求（cred-http ns 插件 → providerId demo-wool）被拒，错误消息 NAMESPACE_MISMATCH 前缀',
    'B: 能力缺失（未声明 network.http 的插件 → 自己命名空间 providerId）仍被拒，错误消息 PERMISSION_DENIED 前缀且含 network.http 提示（能力前提先于命名空间检查）',
    'B: 正向对照（声明能力 + 自己命名空间 + 凭据在场）成功回读 hasKey=true——拒绝来自越权判定而非通道故障',
    'B: 两个拒绝 reply 均无 key 字段（无凭据外泄；探针 catch 结构只回错误消息）',
  ],
  notProvable: [
    '未声明 network.http 时 sandbox 内 import http/https 模块被拒（能力词 → 放行模块集的执行面，归 u-capability 的 L1 fixture 矩阵 A9）',
    '「帧审计」级定向 reply 断言（S20 正向场景的审计面）——本场景以「拒绝 reply 无 key 字段」等价断言无外泄',
    'trusted 通道 fail-closed 分支（identity.pluginId 缺失拒绝）——羊毛系 external 插件恒 sandbox，正常路径无此形态',
  ],
}

export async function run(ctx) {
  const { ev, log, protocol, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    'providers.credential 是插件 Worker → 宿主 RPC（api.providers.credential），拒绝以 error response 回到插件侧 catch——剧本经探针方法把拒绝形态带回 B 通道断言',
    '能力检查（network.http）先于命名空间检查（handleProviderCredential 校验序）——所以「越权 + 未声明能力」的插件得到 PERMISSION_DENIED 而不是 NAMESPACE_MISMATCH，两探针分工各自命中一码',
    '权限门与业务校验分层：manifest permissions 声明 providers.credential 只解锁「可达业务校验层」，越权/能力判定在 provider-write-proxy',
    'ns 前缀边界 = providerId === ns || startsWith(ns + "-")；demo-wool 不在 cred-http ns 内即构成越权，不依赖目标凭据是否存在',
  ]
  const proto = protocol

  ev.step({ step: 'fixture.seed', channel: 'C', exitCode: 0, stats: { dataDir, plugins: seedSummary.pluginDirs.length, selfKeyProvider: HTTP_NS_PROVIDER } })

  await waitPluginActive(proto, PROBE_HTTP_ID)
  await waitPluginActive(proto, PROBE_NOCAP_ID)

  // C：providers.write 落盘（正向对照的凭据落点）
  const written = await pollUntil(() => {
    try {
      const models = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', 'models.json'), 'utf8'))
      return models.providers?.[HTTP_NS_PROVIDER]?.apiKey === SELF_KEY
    } catch {
      return false
    }
  }, { timeoutMs: 20_000, label: 'models.json 落盘 cred-http-prov' })
  ev.assert('C: models.json 落盘 cred-http-prov（providers.write 正面）', written !== null, {
    channel: 'C',
    expected: `${HTTP_NS_PROVIDER}.apiKey=${SELF_KEY}`,
    actual: written !== null ? '命中' : '20s 内未落盘',
  })

  // ① 跨命名空间请求 → NAMESPACE_MISMATCH
  const cross = await proto.call('plugin.invoke', {
    pluginId: PROBE_HTTP_ID, method: 'probe', params: { providerId: 'demo-wool' },
  }, { timeoutMs: 30_000 })
  const crossResult = cross?.result ?? {}
  ev.assert('B: 越权请求（demo-wool ∉ cred-http ns）被拒 NAMESPACE_MISMATCH', crossResult?.ok === false && String(crossResult?.message ?? '').startsWith('NAMESPACE_MISMATCH'), {
    channel: 'B',
    expected: 'ok:false + 消息 NAMESPACE_MISMATCH 前缀',
    actual: JSON.stringify(crossResult).slice(0, 300),
  })
  ev.assert('B: 越权拒绝无凭据外泄（reply 无 key 字段）', !('key' in crossResult) && crossResult?.hasKey === undefined, {
    channel: 'B',
    expected: '拒绝结构只含 ok/message，无 key',
    actual: JSON.stringify(crossResult).slice(0, 200),
  })

  // ② 未声明 network.http（请求自己命名空间）→ PERMISSION_DENIED
  const nocap = await proto.call('plugin.invoke', {
    pluginId: PROBE_NOCAP_ID, method: 'probe', params: { providerId: NOCAP_NS_PROVIDER },
  }, { timeoutMs: 30_000 })
  const nocapResult = nocap?.result ?? {}
  const nocapMessage = String(nocapResult?.message ?? '')
  ev.assert('B: 能力缺失（自己命名空间 + 未声明 network.http）被拒 PERMISSION_DENIED', nocapResult?.ok === false && nocapMessage.startsWith('PERMISSION_DENIED'), {
    channel: 'B',
    expected: 'ok:false + 消息 PERMISSION_DENIED 前缀',
    actual: JSON.stringify(nocapResult).slice(0, 300),
  })
  ev.assert('B: 拒绝消息含 network.http 能力提示（错误可操作：指明恢复动作）', nocapMessage.includes('network.http'), {
    channel: 'B',
    expected: '消息含 network.http（声明能力 + 重装的恢复指引）',
    actual: nocapMessage.slice(0, 200),
  })
  ev.assert('B: 能力拒绝无凭据外泄（reply 无 key 字段）', !('key' in nocapResult) && nocapResult?.hasKey === undefined, {
    channel: 'B',
    expected: '拒绝结构只含 ok/message，无 key',
    actual: JSON.stringify(nocapResult).slice(0, 200),
  })

  // ③ 正向对照（声明能力 + 自己命名空间 + 凭据在场）→ 成功回读
  const self = await proto.call('plugin.invoke', {
    pluginId: PROBE_HTTP_ID, method: 'probe', params: { providerId: HTTP_NS_PROVIDER },
  }, { timeoutMs: 30_000 })
  const selfResult = self?.result ?? {}
  ev.assert('B: 正向对照成功回读（hasKey=true，证明拒绝来自越权/能力判定而非通道故障）', selfResult?.ok === true && selfResult?.hasKey === true, {
    channel: 'B',
    expected: `ok:true + hasKey:true（${HTTP_NS_PROVIDER} 命中 ${SELF_KEY} 落点）`,
    actual: JSON.stringify(selfResult).slice(0, 200),
  })
  ev.attach('a21-deny-matrix', JSON.stringify({
    crossNamespace: crossResult,
    noCapability: nocapResult,
    selfPositive: selfResult,
  }, null, 2))

  log('a21 done')
  return { uncovered, gotchas }
}
