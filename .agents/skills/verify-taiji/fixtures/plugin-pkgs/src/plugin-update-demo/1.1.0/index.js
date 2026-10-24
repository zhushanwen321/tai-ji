// verify-taiji fixture (S26) v1.1.0：更新目标版本。激活重写同 providerId 条目
//（凭据字段保持同值——「provider 条目与凭据保留」断言的对照面）。
export async function activate(context) {
  await context.api.providers.write({
    providerId: 'update-demo-main',
    apiKey: 'udk-update-demo-api-key-0001',
    displayName: 'update-demo (verify fixture v1.1.0)',
    models: [{ id: 'update-demo-model-1', name: 'update-demo-model-1' }],
  })
}

export async function deactivate() {}
