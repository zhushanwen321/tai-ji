# pi Extension 本地开发调试指南

> **面向**：pi extension 开发者
> **目标**：在 xyz-agent + pi 均为本地 dev 模式下，搭建开发调试环境，实现「改源码 → 新建 session → 即时生效」的快速迭代
> **姊妹文档**：[GUI 协议接入指南](./gui-protocol-guide.md)（TUI extension 改造为 TUI/GUI 双模）

---

## 1. 核心概念

### Extension 是什么

pi extension 是一个导出 **default factory function** 的 TypeScript 模块。pi 通过 [jiti](https://github.com/unjs/jiti) 动态加载，**TS 源码无需编译**即可运行。

```typescript
// index.ts — 最小 extension
export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('Extension loaded!', 'info')
  })
}
```

Factory 接收 `ExtensionAPI`，可注册：工具（`registerTool`）、命令（`registerCommand`）、事件钩子（`on`）、快捷键、provider 等。完整 API 参考 pi 官方文档：`pi-mono/packages/coding-agent/docs/extensions.md`。

### xyz-agent 如何加载 extension

```
xyz-agent 启动 session
  → ExtensionService.getExtensionPaths()
  → ExtensionResolver 五源扫描 + 去重（npm > user > settings > third-party > bundled）
  → 路径列表通过 pi CLI 参数 --extension <path> 注入
  → pi 原生 loader（jiti）加载
```

关键点：
- pi 以 `--no-extensions` 启动，抑制 pi 自身的全局自动发现，**只认 xyz-agent 显式注入的 `--extension` 路径**。
- extension 路径在 **session 启动时** 解析（`session-lifecycle.ts` 的 create/restore/fork 均调 `getExtensionPaths()`），运行中的 session 不会重扫。

### dev 模式数据目录隔离

dev 模式（`pnpm dev`）下，xyz-agent 的数据目录自动设为 `~/.xyz-agent-dev/`（由 `apps/electron/main/main.ts` 在 `!app.isPackaged` 时设置），与生产环境 `~/.xyz-agent/` 和系统 pi 的 `~/.pi/agent/` **完全隔离**。

| 内容 | dev 路径 | 生产路径 |
|------|----------|----------|
| extension 配置 | `~/.xyz-agent-dev/pi/agent/` | `~/.xyz-agent/pi/agent/` |
| runtime 日志 | `~/.xyz-agent-dev/logs/runtime-YYYY-MM-DD.log` | `~/.xyz-agent/logs/...` |
| pi 事件流 | `~/.xyz-agent-dev/logs/pi-YYYY-MM-DD-<sessionId>.jsonl` | 同上 |

---

## 2. 本地开发方案：XYZ_EXTENSION_PATHS（推荐）

### 原理

`XYZ_EXTENSION_PATHS` 环境变量让 xyz-agent 直接指向你的 extension **源码目录**，是 live link——改源码后无需 cp 副本、无需 npm install。该变量经 `ENV_WHITELIST_PREFIXES`（`XYZ_` 前缀）自动通过两层白名单（main → runtime → pi），无需额外配置。

`ExtensionResolver` 的 **user 源**（优先级仅次于 npm）会扫描这些路径，校验有效性后注入 pi。

### 步骤

#### 2.1 创建 extension 目录

```bash
mkdir -p ~/Code/my-extension
cd ~/Code/my-extension
```

**`package.json`**（必须满足 `isValidPiExtension` 三条件之一）：

```json
{
  "name": "my-extension",
  "version": "0.0.1",
  "description": "My local dev extension",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

> `isValidPiExtension` 判定（满足任一即可）：`package.json` 有 `pi` 字段 / `keywords` 含 `pi-package` / `peerDependencies` 的 key 匹配 `pi-coding-agent|pi-agent-core`。写上全部三条最保险。

**`index.ts`**（最小可运行 extension）：

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from '@sinclair/typebox'

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('my-extension loaded!', 'info')
  })

  pi.registerTool({
    name: 'greet',
    label: 'Greet',
    description: 'Greet someone by name',
    parameters: Type.Object({
      name: Type.String({ description: 'Name to greet' }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: 'text', text: `Hello, ${params.name}!` }],
        details: {},
      }
    },
  })
}
```

> `peerDependencies` 里写 `@earendil-works/pi-coding-agent`（正式名）或 `@mariozechner/pi-coding-agent`（旧名，pi loader 同时支持）。`typebox` 用于定义工具参数 schema，pi 会 bundle 它，不需要本地安装。

#### 2.2 类型与依赖 resolve（npm 发布前怎么拿到类型）

上面的 `package.json` 把 pi 核心包声明为 `peerDependencies`，但**不 install 它们**——运行时由 pi 的 jiti loader 注入。问题：开发时 IDE 和 `tsc` 怎么找到 `ExtensionAPI` 等类型？

**方案 A：全局安装 pi + tsconfig `paths`（推荐）**

先全局安装 pi（提供类型声明文件）：

```bash
npm install -g @earendil-works/pi-coding-agent
```

然后在 extension 目录创建 `tsconfig.json`，用 `paths` 把 peer 包指向全局 pi 的 `.d.ts` 文件：

```jsonc
// tsconfig.json
// 将 <NPM_GLOBAL> 替换为 `npm root -g` 的返回值
// 例如 ~/.nvm/versions/node/v24.11.1/lib/node_modules
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "lib": ["ES2022"],
    "types": ["node"],
    "paths": {
      "@earendil-works/pi-coding-agent": [
        "<NPM_GLOBAL>/@earendil-works/pi-coding-agent/dist/index.d.ts"
      ],
      "@mariozechner/pi-coding-agent": [
        "<NPM_GLOBAL>/@earendil-works/pi-coding-agent/dist/index.d.ts"
      ],
      "typebox": [
        "<NPM_GLOBAL>/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.d.mts"
      ],
      "@sinclair/typebox": [
        "<NPM_GLOBAL>/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.d.mts"
      ]
    }
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules"]
}
```

> `<NPM_GLOBAL>` 是 `npm root -g` 的返回值（如 `~/.nvm/versions/node/v24.11.1/lib/node_modules`）。全局安装 pi 后，类型声明文件就在 `<NPM_GLOBAL>/@earendil-works/pi-coding-agent/dist/index.d.ts`。
>
> `@mariozechner/pi-coding-agent` 是旧包名，pi loader 内置 alias 同时支持两个前缀（`loader.ts` 的 `VIRTUAL_MODULES` / `getAliases()` 把两者映射到同一组内部模块）。import 时写任一个都能在运行时 resolve。

**方案 B：`pnpm install` 把 peer 装为 devDependencies**

如果不想用 tsconfig paths，直接把 pi 核心包同时加入 `devDependencies`（仅开发时需要类型，不打包进产物）：

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

这样 `pnpm install` 会把 pi 核心包装到本地 `node_modules`，TS 和 IDE 都能 resolve。代价：本地多装一份 pi（发布时 `files` 字段不含 `node_modules`，不影响产物）。

**`@xyz-agent/extension-protocol`（GUI 协议包）**

如果你的 extension 需要 GUI 渲染（在 xyz-agent 桌面端展示结构化组件），会用到 `@xyz-agent/extension-protocol`（提供 `guiComponent`、`guiResult` 等 helper）。**该包尚未发布到 npm**，npm 发布前通过本地路径安装：

```bash
# 假设 xyz-agent 仓库在 ~/Code/xyz-agent-workspace/<branch>/
cd ~/Code/my-extension
pnpm add ~/Code/xyz-agent-workspace/feat-ask-user-gui/packages/extension-protocol
```

> `pnpm add <本地路径>` 会创建 symlink，源码改动即时生效。`extension-protocol` 是纯类型 + helper 函数包，零运行时依赖。

**运行时 resolve 总结**

| 包 | typecheck/IDE 怎么 resolve | 运行时谁注入 |
|----|---------------------------|-------------|
| `@earendil-works/pi-coding-agent` | 方案 A 或 B | pi jiti loader（alias 映射） |
| `@mariozechner/pi-coding-agent` | 同上（旧名 alias） | pi jiti loader（alias 映射） |
| `typebox` / `@sinclair/typebox` | 同上 | pi bundle 内置 |
| `@xyz-agent/extension-protocol` | `pnpm add <本地路径>` symlink | extension 自己 bundle（发布后走 npm） |

**运行时这些 peer 包不需要 install**——pi 启动时通过 jiti 的 alias 机制把 `@earendil-works/*` 和 `@mariozechner/*` 映射到 pi 内部模块，`typebox` 直接从 pi 的 bundle 解析。extension 的 `peerDependencies` 只是声明依赖关系（供 `isValidPiExtension` 校验 + 未来 npm resolve），不参与运行时加载。

#### 2.3 设环境变量启动

```bash
XYZ_EXTENSION_PATHS=~/Code/my-extension pnpm dev
```

多个 extension 用平台路径分隔符（macOS/Linux `:`，Windows `;`）分隔：

```bash
# macOS / Linux
XYZ_EXTENSION_PATHS=~/Code/ext-a:~/Code/ext-b pnpm dev
```

> 也可以写到 `.envrc`（direnv）或 shell profile 里，避免每次手敲。

#### 2.4 验证加载

1. xyz-agent 启动后，打开 **Settings → Extensions** 页面，应能看到 `my-extension` 列在已安装列表中。
2. **新建一个 session**（不是 restore 已有的），向 agent 发消息触发工具调用。如果 extension 注册了 `session_start` 事件，pi 启动时会执行。
3. 在对话中让 agent 调用 `greet` 工具验证。

### 改代码后生效

**extension 没有 HMR（热模块替换）**。改源码后，**新建一个 session** 即可加载最新代码——不需要重启 xyz-agent。

原因：`--extension` 路径在 pi 进程启动时注入 CLI 参数，运行中的 pi 进程无法追加。但 `session-lifecycle.ts` 在 create/restore/fork 时都会重新调 `getExtensionPaths()`，所以新 session 会重新解析路径（`XYZ_EXTENSION_PATHS` 是 live link，读到的是最新源码）。

---

## 3. 调试技巧

### 3.1 查看日志

```bash
# runtime 日志（含 extension 扫描结果、session 生命周期）
tail -f ~/.xyz-agent-dev/logs/runtime-$(date +%Y-%m-%d).log

# pi 原始事件流（pi 卡死时的决定性证据）
tail -f ~/.xyz-agent-dev/logs/pi-$(date +%Y-%m-%d)-<sessionId>.jsonl
```

extension 扫描日志示例：
```
[extension-resolver] resolved 3 extensions from 5 sources
```

`sources` 数取决于是否设了 `XYZ_EXTENSION_PATHS`（设了才有 user 源，共 5 个源；否则 4 个）。如果 resolved 数不含你的 extension，检查 `isValidPiExtension`（package.json 三条件）。

### 3.2 console 输出

extension 内的 `console.log` / `console.error` 会进 pi 的 stdout/stderr，经 runtime 落盘到上述日志。dev 模式下 runtime 日志级别为 debug，pi 原始事件流也会被记录（`XYZ_DEBUG_PI_EVENTS=1` 可开启更详细的 pi 事件日志）。

### 3.3 五源优先级与去重

如果同名 extension 出现在多个源，按优先级 first-write-wins：

| 优先级 | 源 | 扫描位置 | 典型来源 |
|--------|------|----------|----------|
| 1（高） | `npm` | `apps/electron/package.json` dependencies（dev） | 项目内置依赖 |
| 2 | `user` | `XYZ_EXTENSION_PATHS` 环境变量 | **本地开发（本方案）** |
| 3 | `settings` | `~/.xyz-agent-dev/pi/agent/npm/node_modules/` | Settings UI 安装的 npm 包 |
| 4 | `third-party` | `~/.xyz-agent-dev/pi/agent/extensions/` | 本地目录/Git 安装（cp 副本） |
| 5（低） | `bundled` | `resources/pi/agent/extensions/` | 仓库内置 |

如果你的 extension 被 settings 源的同名包覆盖，改一下 `package.json` 的 `name` 字段区分。

### 3.4 ctx.mode 分支

xyz-agent 以 `--mode rpc` 运行 pi，extension 的 `ctx.mode` 为 `"rpc"`。TUI 相关 API（`ctx.ui.setWidget`、`ctx.ui.custom`、`renderResult`）在 RPC 模式下失效。需要 GUI 渲染的 extension 参阅 [GUI 协议接入指南](./gui-protocol-guide.md)。

---

## 4. 方案对比

| 方案 | 操作 | 特点 | 适用场景 |
|------|------|------|----------|
| **`XYZ_EXTENSION_PATHS`** | 设环境变量 | Live link，改源码 → 新建 session 即生效 | **本地开发（推荐）** |
| Settings UI 安装 | 输入本地路径 → 选候选 | cp 副本，每次改代码需重新安装 | 一次性安装他人的 extension |
| npm 安装 | Settings → 推荐扩展 / 输入包名 | 从 npm registry 下载 | 安装已发布的 extension |
| 手动 symlink | `ln -s` 到 third-party 目录 | Live link（`scanDirectory` 用 `statSync` 跟随 symlink） | 备选，但非官方支持路径 |

---

## 5. 打包发布

开发完成后发布到 npm，其他用户可通过 Settings → Extensions 安装。

### package.json 必需字段

```json
{
  "name": "@your-scope/your-extension",
  "version": "1.0.0",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["./index.ts"]
  },
  "keywords": ["pi-package"],
  "files": ["src/", "index.ts"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

关键点：
- **`pi.extensions`**：声明入口文件路径数组，pi loader 优先读此字段定位入口。
- **`keywords: ["pi-package"]`**：用于 pi package gallery 发现。
- **`peerDependencies`**：pi 框架核心包（`pi-coding-agent` / `pi-agent-core` / `pi-ai` / `pi-tui` / `typebox`）声明为 `"*"`，pi 会 bundle 这些包，不要打包进你的 extension。
- **`files`**：npm 发布时包含的文件，确保 `index.ts` 和 `src/` 都在内。
- **TS 无需编译**：pi 用 jiti 加载 TS 源码，直接发布 `.ts` 文件即可。

> **`@xyz-agent/extension-protocol` 的特殊处理**：如果你的 extension 依赖 GUI 协议包，目前它**尚未发布到 npm**。发布前不要把它放进 `dependencies`（会导致安装失败），而是放到 `devDependencies` 并用 `pnpm add <本地路径>` 安装。该包是纯类型 + helper 函数，会被 jiti 直接 inline 到 extension 代码中，运行时不需要单独 resolve。等 `@xyz-agent/extension-protocol` 正式发布到 npm 后，再迁移到 `dependencies`。

### 发布

```bash
npm publish
```

发布后用户在 xyz-agent 的 Settings → Extensions 页面，通过 npm 包名（`@your-scope/your-extension`）安装。

---

## 6. 相关文档

- [GUI 协议接入指南](./gui-protocol-guide.md) — TUI extension 改造为 TUI/GUI 双模
- [问题排查指南](../TROUBLESHOOTING.md) — dev 模式差异、extension 安装失败排查
- [pi extensions 官方文档](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) — 完整 API 参考
