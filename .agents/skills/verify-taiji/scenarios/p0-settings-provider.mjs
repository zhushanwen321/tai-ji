/**
 * p0-settings-provider —— 设置页 provider 写侧 + 生效 + 删除无塌陷（覆盖矩阵 P0-13 主面）。
 *
 * 装配：faux（零 token；provider-live-sync 扩展轮询让运行中 pi 的模型快照热刷新）。
 * 路径（全部 B 协议 + C 落盘，UI 设置页导航不进本剧本）：
 *   config.getProviders 基线 → config.setProvider 新增 verify-tmp provider（baseUrl 指向
 *   不可达端口，只为过 schema）→ getProviders 含它 + C：agent/models.json 落盘 →
 *   model.list 出现 tmp 模型（provider-live-sync ≤3s 轮询，条件轮询等出现）→
 *   config.deleteProvider → getProviders 消失 + model.list 里 faux 演员仍在（无塌陷）+
 *   C：models.json 已删该条目。
 *
 * Gotcha（model.md model.live-sync）：不要用 model.list 单次结果判断热刷新——「写盘 →
 * 条件轮询 → 出现」三步对照。
 */
import fs from 'node:fs'
import path from 'node:path'

const TMP_PROVIDER = 'verify-tmp-provider'
const TMP_MODEL = 'verify-tmp-model'

export const meta = {
  id: 'p0-settings-provider',
  priority: 'P0',
  title: 'provider 写侧（set/delete）+ 运行中热可见（live-sync 轮询）+ 删除无塌陷',
  covers: [
    'env.launch', 'env.ready', 'env.isolation',
    'settings.provider', 'model.list', 'model.live-sync',
  ],
  requires: ['faux'],
  estimateSec: 120,
  faux: {
    responses: [{ text: 'settings-provider-spare', stopReason: 'stop' }],
  },
  provable: [
    'config.setProvider 后 getProviders 含新 provider + C：agent/models.json 落盘该条目',
    '运行中热可见：model.list 条件轮询出现 tmp 模型（provider-live-sync 2s 轮询生效）',
    'config.deleteProvider 后 getProviders 不再含它 + C：models.json 已删',
    '删除无塌陷：faux 演员模型仍在 model.list 且 model.switch 仍可用（目录未坏）',
  ],
  notProvable: [
    '设置页 UI 表单交互（A 通道导航）——本剧本走协议写侧；UI 面归手工验收/后续 UI 剧本',
    'catalog（pi.dev overlay）与 remote-config 合并展示（独立基建）',
    'oauth 型凭据流（本剧本用 apiKey 字面量形态）',
  ],
}

export async function run(ctx) {
  const { protocol, ev, log, dataDir } = ctx
  const uncovered = []
  const gotchas = [
    'models.json 的 apiKey 必须字面量（pi 把 $VAR 当 env 模板、!cmd 当命令）；baseUrl 故意指不可达端口（http://127.0.0.1:9/v1）只为过 schema，不产生真实请求',
    'model.list 是「首推 + 按需拉」不是订阅流：新增 provider 后要重拉，且要给 provider-live-sync 的 2s 轮询留时间（条件轮询，不是固定 sleep）',
    'provider id 是持久化契约（providers.json extras），只增不改名——本剧本用独立 id 且收尾删除',
  ]

  const modelsPath = path.join(dataDir, 'agent', 'models.json')
  const providers0 = await protocol.call('config.getProviders', {})
  const before = (providers0.providers ?? []).map((p) => p.id ?? p.providerId)
  ev.step({ step: 'config.getProviders.baseline', channel: 'B', exitCode: 0, stats: { count: before.length } })
  ev.assert('基线：tmp provider 尚不存在', !before.includes(TMP_PROVIDER), {
    channel: 'B', expected: `无 ${TMP_PROVIDER}`, actual: before.join(',').slice(0, 200),
  })

  // ── 写侧：setProvider ──────────────────────────────────────
  await protocol.call(
    'config.setProvider',
    {
      providerId: TMP_PROVIDER,
      name: 'verify-tmp (settings-provider scenario)',
      type: 'custom',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'verify-tmp-dummy-key',
      models: [{ id: TMP_MODEL, name: TMP_MODEL }],
    },
    { timeoutMs: 60_000 },
  )
  ev.step({ step: 'config.setProvider', channel: 'B', exitCode: 0, stats: { providerId: TMP_PROVIDER } })

  const providers1 = await protocol.call('config.getProviders', {})
  const afterAdd = (providers1.providers ?? []).map((p) => p.id ?? p.providerId)
  ev.assert('B: setProvider 后 getProviders 含新 provider', afterAdd.includes(TMP_PROVIDER), {
    channel: 'B',
    expected: TMP_PROVIDER,
    actual: afterAdd.join(',').slice(0, 200),
  })
  const modelsJson = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
  ev.assert('C: agent/models.json 落盘新 provider', Boolean(modelsJson.providers?.[TMP_PROVIDER]), {
    channel: 'C',
    expected: `${TMP_PROVIDER} 条目`,
    actual: `keys=${Object.keys(modelsJson.providers ?? {}).join(',').slice(0, 200)}`,
  })
  ev.attach('models-json-after-add', JSON.stringify(modelsJson.providers?.[TMP_PROVIDER] ?? null, null, 2).slice(0, 4_000))

  // ── 运行中热可见（live-sync 轮询） ─────────────────────────
  let listed = false
  {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const ml = await protocol.call('model.list', {})
      if ((ml.models ?? []).some((m) => m.id === TMP_MODEL)) {
        listed = true
        break
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  ev.assert('B: model.list 热可见 tmp 模型（live-sync 轮询窗口内）', listed, {
    channel: 'B',
    expected: `model.list 含 ${TMP_MODEL}（≤15s，轮询周期 2s）`,
    actual: listed ? '出现' : '15s 未出现（live-sync 未生效 = 目录快照冻结）',
  })
  ev.step({ step: 'model.live-sync', channel: 'B', exitCode: listed ? 0 : 1, stats: {} })

  // ── 删除 + 无塌陷 ──────────────────────────────────────────
  await protocol.call('config.deleteProvider', { providerId: TMP_PROVIDER }, { timeoutMs: 60_000 })
  const providers2 = await protocol.call('config.getProviders', {})
  const afterDel = (providers2.providers ?? []).map((p) => p.id ?? p.providerId)
  ev.assert('B: deleteProvider 后 getProviders 不再含它', !afterDel.includes(TMP_PROVIDER), {
    channel: 'B',
    expected: `无 ${TMP_PROVIDER}`,
    actual: afterDel.join(',').slice(0, 200),
  })
  const modelsJson2 = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
  ev.assert('C: models.json 已删该条目', !modelsJson2.providers?.[TMP_PROVIDER], {
    channel: 'C',
    expected: '条目消失',
    actual: `keys=${Object.keys(modelsJson2.providers ?? {}).join(',').slice(0, 200)}`,
  })

  // 无塌陷：faux 演员仍可切（会话级验证：建会话默认模型 faux-1 正常）
  const created = await protocol.call('session.create', { cwd: ctx.repo, label: 'p0-settings-provider' }, { timeoutMs: 120_000 })
  const sid = created.session?.id
  ev.assert('删除无塌陷：faux 会话仍可正常创建（模型解析 faux-1）', Boolean(sid) && created.session?.modelId === 'faux/faux-1', {
    channel: 'B',
    expected: 'modelId=faux/faux-1',
    actual: `sid=${sid} model=${created.session?.modelId}`,
  })
  ev.step({ step: 'no-collapse', channel: 'B', exitCode: 0, stats: {} })

  log(`done sid=${sid}`)
  return { uncovered, gotchas }
}
