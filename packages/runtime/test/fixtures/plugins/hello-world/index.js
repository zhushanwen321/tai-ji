let context = null

export async function activate(ctx) {
  context = ctx
  await context.globalState.set('activated', true)
  await context.globalState.set('activateTime', Date.now())
  context.subscriptions.push({
    dispose() {
      context = null
    }
  })
}

export async function deactivate() {
  if (context) {
    await context.globalState.set('deactivated', true)
  }
}
