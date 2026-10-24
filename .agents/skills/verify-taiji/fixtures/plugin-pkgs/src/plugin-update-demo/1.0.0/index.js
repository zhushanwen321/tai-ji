// verify-taiji fixture (S26) v1.0.0：激活写入命名空间内 provider 条目（含 apiKey），
// 供「更新后条目与凭据保留」断言。
export async function activate(context) {
  await context.api.providers.write({
    providerId: 'update-demo-main',
    apiKey: 'udk-update-demo-api-key-0001',
    displayName: 'update-demo (verify fixture v1.0.0)',
    models: [{ id: 'update-demo-model-1', name: 'update-demo-model-1' }],
  })
}

export async function deactivate() {}
