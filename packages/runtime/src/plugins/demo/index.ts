/**
 * Demo Plugin — showcases the taiji PluginModule API.
 *
 * Demonstrates:
 *   1. Tool registration (demo_search)
 *   2. Hook registration (onBeforeSendMessage interceptor)
 *   3. UI notification
 *   4. Workspace file search
 *   5. Storage persistence
 */
import type { PluginModule, PluginContext } from '../../services/plugin-service/plugin-types.js'

const plugin: PluginModule = {
  async activate(context: PluginContext) {
    // ── 1. Register tool ───────────────────────────────────────
    await context.api.tools.register({
      name: 'demo_search',
      description: 'Search for files matching a pattern',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to search' },
        },
        required: ['pattern'],
      },
      execute: async ({ arguments: args }) => {
        const pattern = args.pattern as string
        const results = await context.api.workspace.findFiles(pattern)

        // Persist search metadata
        await context.api.storage.global.set('lastSearch', {
          pattern,
          count: results.length,
          timestamp: Date.now(),
        })

        const MAX_DISPLAY_FILES = 10
        const fileList = results.slice(0, MAX_DISPLAY_FILES).join('\n')
        return {
          content: `Found ${results.length} files matching '${pattern}':\n${fileList}`,
        }
      },
    })

    // ── 2. Register hook ───────────────────────────────────────
    await context.api.hooks.onBeforeSendMessage(async (hookContext) => {
      const data = hookContext.data as { content?: string }
      if (data.content?.includes('!important')) {
        return {
          proceed: true,
          modifiedData: { ...data, content: data.content.replace(/!important/g, 'IMPORTANT') },
        }
      }
      return { proceed: true }
    })

    // ── 3. Notify activation ───────────────────────────────────
    await context.api.ui.notify('info', 'Demo plugin activated!')
  },

  deactivate() {
    console.log('[demo-plugin] deactivated')
  },
}

export default plugin
