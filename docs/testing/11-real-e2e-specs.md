# 11 · real 轨 E2E 自动化 spec

> real 轨手工测试清单见 [08-real-track-manual.md](./08-real-track-manual.md)（给 ai-agent 照着执行）。
> 本文档是 real 轨的 **Playwright 自动化 spec**：真起 Electron app + 真实 runtime 子进程 + 真实 pi + 真实 LLM provider，断言真实表面（WS 广播、pi 自己写的 session JSONL、真实 DOM）。**零 mock**。

## 1. 定位（与 mock 轨的区别）

| 维度 | MOCK 轨（见 [00 总览](./00-test-strategy-overview.md)） | real 轨自动化（本文） |
|---|---|---|
| renderer bundle | `VITE_MOCK=true` 构建 | `VITE_MOCK` 不传（real bundle） |
| runtime / pi | 不起（`XYZ_MOCK=1`） | 真起（main spawn runtime → runtime spawn pi） |
| LLM | mock 流式数据 | 真实 provider 调用（慢、flaky） |
| 断言表面 | mock fixture / 组件 DOM | 真实 WS 广播 / pi 产物文件 / 真实 DOM |
| 失败处理 | 确定性 | flaky skip + diag 落盘 |

**适用场景**：验证 mock 轨覆盖不到的盲区——真实协议透传（如 ask-user 的 `extension.ui_request`）、pi 子进程对 CLI 参数的真实消费（如 `--model x:thinkingLevel` 落盘 `thinking_level_change` entry）、真实 UI 交互闭环。

## 2. 现有 spec 清单

| spec | 用例 | 验证目标 | 状态 |
|---|---|---|---|
| `e2e/ask-user-real.spec.ts` | A1/A2/A3 | ask-user 协议透传（问题对象无 allowComment）+ overlay 真实渲染（Other 保留）+ UI 交互闭环（overlay 关闭 + pi 恢复 turn） | ✅ 3/3（需 LLM） |
| `e2e/workflow-thinkinglevel-real.spec.ts` | TC1/TC2/TC3 | workflow agent() thinkingLevel 端到端：state 请求值 / pi 子进程 thinking_level_change / 完整跑通 | ✅ 3/3（需 LLM） |
| `e2e/workspace-real.spec.ts` | 1 | 跨进程持久化 | ❌ 需真实 runtime 端口 |

## 3. 运行

```bash
# 前置：real renderer bundle（与 mock bundle 输出冲突，分批 build + 跑）
# 用 global-setup 检测到 real bundle 缺失时会 build mock bundle——real spec 前必须手动确认

# 单个用例（real case 慢，建议单独跑）
npx playwright test e2e/ask-user-real.spec.ts --grep A1
npx playwright test e2e/workflow-thinkinglevel-real.spec.ts --grep TC2

# 全量（每个用例独立 launch，约 1.5-3 分钟/用例）
npx playwright test e2e/ask-user-real.spec.ts
```

**flaky 处理**：LLM 未按引导调用 tool（ask_user / workflow）→ `test.skip` + `/tmp/<tc>-diag.json` 落盘（事件流、日志尾部）。跑失败的用例重跑一次即可，属预期行为。

## 4. 通用范式（两个 spec 共用）

```
① makePresetDataDir()：临时 dataDir + pi 配置（models/settings）+ npm extension 目录 + 分支源码 symlink
② launchRealApp({dataDir}) + waitForRuntime(dataDir)  ← e2e/fixtures/launch-app-real.ts
③ WS session.create（绕过 OS dialog，cwd=sample-project）
④ 开第二 WS 监听广播（先 listen 再发 prompt，避免 broadcast 时序竞争）
⑤ WS message.send 强引导 prompt（"必须调用 xxx tool"）
⑥ 轮询目标事件（120s deadline）→ 不出现则 skip + diag
⑦ 断言真实表面（协议字段 / pi 产物文件 / DOM）
```

## 5. bring-up 关键发现（写新 spec 前必读）

以下 5 条是本仓库实测踩坑结论（2026-08-03），直接决定新 real spec 能否跑通：

### 5.1 registry 的 extension 包可能滞后于分支源码

`npm:@zhushanwen/pi-ask-user` 3.0.0 是删 comment **之前**发布的旧版（仍带 `allowComment`/`__comment`）——与分支源码同版本号但内容不同（分支未 bump）。**断言"新功能已生效"的 spec 必须让预设目录优先 symlink 分支源码**，否则验证的是旧包。

```typescript
// makePresetDataDir 内：分支源码优先（已存在跳过）
fs.symlinkSync(BRANCH_ASKUSER, path.join(zsDest, 'pi-ask-user'), 'dir')
```

> 含义：功能分支合入并发布 npm 前，real spec 测的是分支代码；发布后 registry 版更新，symlink 优先级逻辑不变（分支仍优先，行为一致）。

### 5.2 routeWebSocket 无法拦截 Electron renderer 的 WS（Playwright 限制）

实测：`page.routeWebSocket('**/*')` 全匹配 + 连接稳定后 `routedConnections === 0`——Electron renderer 的 WS 走其 net 层，不经过 Playwright 的 route。**无法捕获 renderer → runtime 的出站帧**（如 `extension.ui_response`）。

对策：需要断言"前端发出帧"时，降级为断言**可观测的副作用**：
- overlay 关闭（前端 onSubmit 成功的 UI 信号）
- pi 恢复 turn（`message.message_start` / `message.complete` 广播）
- 帧内容本身由组件层测试（`AskUserOverlay.test.ts`）覆盖

### 5.3 mandatory npm install 与 pi spawn 存在启动竞态

runtime boot 时 `ensureMandatoryExtensions()` 对 9 个 mandatory 包执行 npm install（实测约 16s），而 `session.create` 触发的 pi spawn 可能更早。**若 session 过早创建，pi spawn 注入的 `--extension` 列表为空/不完整 → 模型说"没有 xxx tool"**。

对策：`session.create` 前必须等 extension 就绪：

```typescript
// 信号：runtime 日志最后一次 "resolved N extensions from M sources" 的 N ≥ 8
async function waitForExtensionsReady(dataDir: string, timeoutMs = 90_000, minCount = 8): Promise<number>
```

### 5.4 workflow script 的可靠发现路径是 user 级

`resource-discovery.ts` 的 project 级扫描路径是 `<workspaceRoot>/.pi/workflows/`，而 `findWorkspaceRoot(sample-project)` 因祖先目录有 `.bare`（bare+worktree workspace）会**跳转到 workspace 根**——project 级 `sample-project/.pi/workflows/` 不会被发现。

**唯一可靠路径**：user-pi 源 `<agentDir>/workflows/` = `<dataDir>/pi/agent/workflows/`（`PI_CODING_AGENT_DIR` 指向）。makePresetDataDir 把 fixture script 复制到此。

### 5.5 `state.calls[0].sessionId`（sa- 前缀）不是 pi session id

`sa-<uuid>` 是 subagent-workflow 扩展的 ExecutionRecord id（`subagent-service.ts`），**不是** pi 的 session id（uuidv7，JSONL 首行 `session.id`）。用 sessionId 定位子进程 session 文件必然失败。

对策：定位走 `state.calls[0].sessionFile`（execution-record serialize 持久化的**绝对路径**）；缺失时 fallback 全量扫描 `dataDir` 下 `sessions/*.jsonl`（排除主 session 文件 + cwd 匹配 sample-project + mtime 最新）。

## 6. 断言真实表面的价值层级（thinkingLevel 案例）

以"验证 thinkingLevel 生效"为例，从弱到强的真实表面：

| 层级 | 断言 | 表面 | 价值 |
|---|---|---|---|
| L0 | `buildSpawnArgs` 纯函数输出 `:level` 后缀 | 单元测试 | 只证明"拼对了字符串" |
| L1 | 真实 spawn 的 args | 需日志钩子（生产改动） | 证明"args 到了 pi 进程启动点" |
| **L2** | 子进程 session JSONL 的 `thinking_level_change` entry | **pi 自己写的产物文件（零 xyz-agent 介入）** | **证明"pi 真实收到并落盘"** |
| L3 | 真实 provider 跑完的产出 | WS done + assistant 消息 | 证明"完整链路可跑通" |

**要点**：L2 是最佳性价比——断言对象是 pi 的产物（`setThinkingLevel` → `appendThinkingLevelChange` 落盘链路），不需要任何 xyz-agent 日志钩子。且 `:high` 后缀**只在 spawn args 存在**（session-runner 拼 args 处），pi 解析后拆成独立字段落盘——**断言必须查独立字段 `thinkingLevel:"high"`，禁止 grep `:high` 后缀**。

## 7. 编写新 real spec 的 checklist

- [ ] 前置：确认被测功能在分支源码（非 registry 旧版），makePresetDataDir symlink 分支源码
- [ ] 触发：WS 强引导 prompt + 第二 WS 监听（先 listen 再 send）+ 120s deadline + flaky skip + diag
- [ ] `session.create` 前调用 `waitForExtensionsReady`（防 mandatory install 竞态）
- [ ] UI 操作前等"连接中"横幅消失（renderer 首次连接 fallback 端口失败 + 指数退避重连，最长 ~30s）
- [ ] 需要捕获前端出站帧时：先确认 routeWebSocket 可行（Electron 下不可行，见 5.2），否则降级为可观测副作用
- [ ] 断言 pi 产物文件时：查独立字段（5.5/§6），文件定位优先绝对路径字段
- [ ] 独立 launch（每用例独立 dataDir），`finally` 里 cleanup + 清理临时目录
- [ ] 跑通后更新本文件 §2 清单
