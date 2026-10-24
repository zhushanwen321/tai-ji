// verify-taiji fixture (S14)：施压插件——激活即经 providers.write 写入命名空间内
// 含 apiKey 的 provider 条目（卸载清理链的真实行使前提，设计 S14 施压要求）。
// 命名空间 = 包名推导（plugin-neighbor-stress → neighbor-stress），providerId 落边界内。
const PROVIDER_ID = 'neighbor-stress-main'

export async function activate(context) {
  await context.api.providers.write({
    providerId: PROVIDER_ID,
    apiKey: 'nsk-neighbor-stress-api-key-0001',
    displayName: 'neighbor-stress (verify fixture)',
    models: [{ id: 'neighbor-stress-model-1', name: 'neighbor-stress-model-1' }],
  })
}

export async function deactivate() {}
