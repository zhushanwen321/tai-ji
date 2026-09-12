import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { readFileSync } from 'fs'

// __APP_VERSION__ 展示应用版本（与 electron 包一致），读 apps/electron/package.json（单一版本源）。
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../apps/electron/package.json'), 'utf-8')) as { version: string }

// P0 coexistence spike：构建期共存 flag。NEW_ARCH=1 时整个构建切换到新壳骨架入口
// （vite define 注入 globalThis.__NEW_ARCH__ + input/outDir 切到 dist-new），未设 flag 时
// 构建行为与现状完全一致（ES1 安全默认）。消费方：main 进程 window-factory.ts 的
// resolveRendererEntry(process.env.NEW_ARCH)（同源同值，避免 main loadFile 与 renderer 自认架构不一致）。
const newArch = process.env.NEW_ARCH === '1'

// 裸跑（不经 dev-instance.mjs 装配器）时的 Vite 端口；与 runtime dev 端口 3310 / CDP 9222
// 同属「裸跑端口组」，改值须同步 dev-instance.mjs 旧用法兼容注释与 troubleshooting 文档。
const DEFAULT_VITE_PORT = 1420

export default defineConfig(({ mode }) => {
  // loadEnv 读取 renderer 目录下的 .env + 按前缀过滤；同时并入 process.env 中已存在的 VITE_ 变量
  // （E2E 构建时由 e2e/fixtures 注入 VITE_MOCK / VITE_E2E）。
  const env = { ...loadEnv(mode, __dirname, ''), ...process.env }
  // E2E 构建期注入 sample-project 绝对路径（renderer 是浏览器环境读不到 process.env / __dirname）
  const e2eSampleCwd = resolve(__dirname, '../../e2e/fixtures/sample-project')
  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      // 仅在 E2E 构建时注入真实路径，否则注入空串（mock/data.ts 检测 VITE_E2E 后才使用）。
      // 用 globalThis.__X__ 形式：vite define 会替换 globalThis 属性访问（vitest 不继承 build 的 define，
      // 但 data.ts 用可选链兜底，vitest 下为 undefined → 空串，不影响测试）。
      'globalThis.__E2E_SAMPLE_PROJECT_CWD__': JSON.stringify(env.VITE_E2E === 'true' ? e2eSampleCwd : ''),
      // P0 coexistence spike：构建期 flag，读 process.env.NEW_ARCH，默认 false，复用现有 define 模式。
      // 烘焙为字面 boolean；P0 无业务消费者（consumerCount=0），P3 域级灰度时各域模块按此分支。
      'globalThis.__NEW_ARCH__': JSON.stringify(newArch),
    },
    // 打包后通过 file:// 协议加载，必须用相对路径，否则 /assets/ 解析到文件系统根目录
    base: './',
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    server: {
      // per-worktree dev 实例端口（dev-instance.mjs 按 worktree 名 hash 派生，C-dev-01）；
      // 未注入时保持默认 1420（裸 vite / dev-smoke 等旧用法兼容）。strictPort 保留：被占即
      // fail-fast，杜绝「Electron 加载到别的实例的 1420 跑旧代码」的静默错配。
      port: Number(process.env.XYZ_VITE_PORT) || DEFAULT_VITE_PORT,
      strictPort: true,
      // HMR file watcher：本机环境（Node 24 + macOS 15）下 Vite 8 默认的 fsevents 后端不派发变更事件
      //（独立 chokidar 同路径/同 fsevents 绑定可正常收到，问题仅在 Vite 运行时触发），导致改 .vue/.ts 不热更新。
      // 强制轮询模式绕过 fsevents，保证 HMR 可靠触发。轮询 209 个源目录 ~每 100ms，CPU 开销可忽略。
      watch: {
        usePolling: true,
        interval: 100,
      },
    },
    build: {
      target: 'esnext',
      // 产物输出到 apps/electron/renderer/dist（与 main 进程 loadFile 路径一致，
      // electron-builder files 直接包含 renderer/dist/**/*）。dev 模式不读 outDir。
      // P0 coexistence spike：NEW_ARCH=1 时切换入口/输出目录到新壳骨架（dist-new），
      // 证明「构建期可按 flag 选入口」接缝机制；未设 flag 时以下两行与现状完全一致（ES1）。
      outDir: resolve(__dirname, newArch ? '../../apps/electron/renderer/dist-new' : '../../apps/electron/renderer/dist'),
      emptyOutDir: true,
      // [W31 D-8] codeSplitting.groups = rolldown 1.1.4 的 manual chunking（rolldown 文档 §manual-code-splitting）。
      // rollupOptions.output.manualChunks / advancedChunks 均已被 rolldown 标记 deprecated（manualChunks 仅支持
      // 函数形式、对象形式不支持），vite 8 的 build.rollupOptions 只是 rolldownOptions 的 deprecated alias
      // （vite dist node.js: `rolldownOptions ??= rollupOptions` —— 两者同时设置时 rollupOptions 被整体丢弃，
      // 故 input 与 output 必须统一写在 rolldownOptions 下，不能拆开）。
      // 分组（10 §3.4 四组 + 探针修正）：
      //   - xterm：TerminalView 静态 import @xterm/xterm + 4 addon，随 defineAsyncComponent 真正移出首屏
      //   - shiki：排除 @shikijs/langs（langs-bundle-full 内 235 个动态 import 的语言定义 chunk 必须保持
      //     按需分离，不被本组吞并——shiki 4.3.1 源码实证）；首屏仍静态 import（markdown.ts），分组收益
      //     = 与业务 chunk 的 parse 隔离（10 §3.4 审查修正）
      //     [HISTORICAL] 上文「235 个动态语言 chunk 按需分离」机制已随 2026-09 shiki fine-grained
      //     改造（commit ac01fab47）终结：langs-bundle-full 已移出模块图，grammar 改为 markdown.ts
      //     静态 import 的具名 grammar 对象、随静态 import 链归并 vendor 组。shiki 组 regex 的
      //     (?!langs) 排除保留仅为不扰动既有分组，不再承担「保持按需分离」职责。
      //   - katex：katex + markdown-it-katex（静态 import，同 shiki 仅 parse 隔离）
      //   - vendor：其余 node_modules 稳定依赖。tags:['$initial'] 只捕获静态 import 链上的模块，
      //     mermaid（动态 import ~3MB）不被吞进 vendor、保持独立懒加载 chunk
      // 未命中任何组的模块（含 @shikijs/langs/*、mermaid、业务共享模块）回退 automatic chunking。
      rolldownOptions: {
        input: {
          main: resolve(__dirname, newArch ? 'new-arch/index.html' : 'index.html'),
        },
        output: {
          codeSplitting: {
            groups: [
              { name: 'xterm', test: /node_modules[\\/]@xterm[\\/]/, priority: 10 },
              { name: 'shiki', test: /node_modules[\\/](shiki[\\/]|@shikijs[\\/](?!langs[\\/]))/, priority: 10 },
              { name: 'katex', test: /node_modules[\\/](katex|markdown-it-katex)[\\/]/, priority: 10 },
              { name: 'vendor', test: /node_modules[\\/]/, tags: ['$initial'], priority: 1 },
            ],
          },
        },
      },
    },
    // mermaid ~3MB，显式预构建避免 dev 首次冷启动 esbuild 重新打包时慢 + warning。
    // (shiki 同为大体积库已验证该路径无需额外 build 配置)
    optimizeDeps: {
      include: ['mermaid'],
    },
  }
})
