# 03 · Runtime 服务与 Extension 测试手册（系统提示词 / extension 运行时体系 / 插件 E2E / 自动升级）

> 合并自 10-settings-system-prompt.md + 12-extension-runtime-testing.md + 13-plugin-e2e.md + update-e2e.md（2026-09 手册并册，原文 git 历史可查）。
>
> 公共前置（双轨制 / Playwright harness / activateSession / E2E 常见坑）见 [00-overview.md](./00-overview.md)。

---


> 覆盖：Settings → 「系统提示词」菜单 → 两卡片（替换 pi 核心提示词 / 追加注入额外提示词）+ 替换卡内「pi 默认提示词」折叠参考区 → 保存/失败 toast / 放弃/恢复默认 / corrupted 兜底。
>
> 先读 [00-overview.md](./00-overview.md) 理解双轨制和公共前置。

## 1. 功能概述

「系统提示词」配置页是 Settings 下的一个菜单页（FR-4/FR-5，ADR-0044），允许用户在不动代码的前提下调整 pi agent 的系统提示词行为。两种互不冲突的能力 + 一个只读参考区：

```
卡 1 替换 pi 核心系统提示词（replace）
  → ConfigService.getReplaceSystemPrompt() 读取 → spawn pi 时透传 --system-prompt
  → 仅对【新建会话】生效（已存在的会话不会改 spawn 参数）
  卡内折叠区：pi 默认提示词参考（DEFAULT_PI_SYSTEM_PROMPT 常量，可一键复制）
    ——是 pi 0.84.1 提取的静态常量，不是运行时实时生效值

卡 2 追加注入额外提示词（append）
  → builtin npm 扩展 @zhushanwen/pi-system-prompt（extensions/taiji/system-prompt/，
     infrastructure 级 mandatory，清单 SSOT = packages/shared/src/mandatory-extensions.json）
     注册 before_agent_start hook
  → 每轮读 <dataDir>/system-prompt.json（不缓存），append 段追加到 event.systemPrompt 末尾
  → 同一 hook 还负责全局指令注入：~/.agents/AGENTS.md（候选 AGENTS.md / AGENTS.MD /
     CLAUDE.md / CLAUDE.MD，精确大小写匹配）带标签头追加；pi 带 --no-context-files /
     -nc 启动时不注入（尊重用户 context files opt-out）
  → 注入顺序：base prompt → 全局指令 → append 配置（显式配置排最后）
  → 保存后【下一轮】即生效（hook 每轮读配置，热生效）
```

**关键设计**：replace（启动期 CLI 注入）与 append（运行期 hook 注入）走两条独立链路；配置存独立文件 `<dataDir>/system-prompt.json`（configDir 与 dataDir 同根，dev=`~/.xyz-agent-dev/`、prod=`~/.xyz-agent/`），插件每轮直读，故追加保存后立即生效。

**[HISTORICAL]** 旧根文件版 `xyz-system-prompt-extension.js`（repo root 文件型 builtin）已于 2026-08 builtin→npm 迁移删除；其「当前生效提示词快照」卡（写 `<dataDir>/system-prompt-snapshot.md` 供 UI 回读）一并移除，现行无实时快照入口，参考区只展示默认提示词常量。

## 2. 组件结构概述

`SettingsModal.vue` 在 activeMenu 为 `system-prompt` 时渲染 `system/SystemPromptPage.vue`（`data-testid="system-prompt-page"`；菜单 nav 按钮 testid `settings-nav-system-prompt`）。页面含 corrupted 警告提示条（条件渲染）与两张编辑卡：卡 1 替换系统提示词（Switch `system-prompt-replace-switch`、Textarea `system-prompt-replace-input`、放弃/恢复默认/保存按钮 `system-prompt-replace-discard` / `-reset` / `-save`，均 dirty 才可用）+ 折叠参考区（展开/收起 `system-prompt-default-toggle`、复制 `system-prompt-default-copy`、内容区 `system-prompt-default-content` 展示 DEFAULT_PI_SYSTEM_PROMPT 常量）；卡 2 注入额外提示词（Switch `system-prompt-append-switch`、Textarea `system-prompt-append-input`、放弃/保存 `system-prompt-append-discard` / `system-prompt-append-save`）。Switch 关闭时 Textarea 与保存按钮 disabled；参考区默认折叠。

## 3. data-testid 清单

testid 以组件 template 内 data-testid 属性为准（均在 `packages/renderer/src/components/settings/system/SystemPromptPage.vue`，已核实有效）。

| testid | 触发/可见条件 |
|--------|--------------|
| `system-prompt-page` | 切到 system-prompt 菜单后恒显（页面根容器） |
| `system-prompt-replace-switch` | 卡 1 恒显（Switch 控件，绑 replaceEnabled） |
| `system-prompt-replace-input` | 卡 1 恒显，`!replaceEnabled` 时 disabled |
| `system-prompt-replace-discard` | 卡 1 恒显，`!replaceDirty` 时 disabled，点击还原已保存快照 |
| `system-prompt-replace-reset` | 卡 1 恒显，`!replaceDirty` 时 disabled，点击清空文本+关开关（编辑态） |
| `system-prompt-replace-save` | 卡 1 恒显，`!replaceDirty` 时 disabled，点击调 `saveReplace` |
| `system-prompt-default-toggle` | 卡 1 恒显，点击切换参考区展开态（默认折叠） |
| `system-prompt-default-copy` | 仅参考区展开时可见，点击复制 DEFAULT_PI_SYSTEM_PROMPT 到剪贴板 |
| `system-prompt-default-content` | 仅参考区展开时可见，pre 展示常量全文 |
| `system-prompt-append-switch` | 卡 2 恒显（绑 appendEnabled） |
| `system-prompt-append-input` | 卡 2 恒显，`!appendEnabled` 时 disabled |
| `system-prompt-append-discard` | 卡 2 恒显，`!appendDirty` 时 disabled |
| `system-prompt-append-save` | 卡 2 恒显，`!appendDirty` 时 disabled，点击调 `saveAppend` |

## 4. MOCK 模式测试

### 4.1 mock 策略

`vi.mock('@/api')` 提供 `config` 门面（两个系统提示词方法 + SettingsModal/store 依赖的 `listProviders` / `setSkillDirs` / `setAgentDirs` / ProviderPage 与 OAuth 事件订阅）：

```typescript
// 典型 mock（system-prompt-page.test.ts）
const configMock = vi.hoisted(() => ({
  getSystemPrompt: vi.fn(() => Promise.resolve({ config: defaultConfig(), corrupted: false })),
  setSystemPrompt: vi.fn((cfg) => Promise.resolve({ config: cfg, corrupted: false })),
  listProviders: vi.fn(() => Promise.resolve([])),
  setSkillDirs: vi.fn(() => Promise.resolve()),
  setAgentDirs: vi.fn(() => Promise.resolve()),
  // SettingsModal → ProviderPage → useProviderOAuth onMounted 订阅 4 个 auth.* 事件（缺则崩 mount）
  onAuthDeviceCode: vi.fn(() => () => {}),
  onAuthAuthUrl: vi.fn(() => () => {}),
  onAuthSuccess: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  // ProviderPage 默认 pill + 默认修复 toast
  onDefaultsWithSource: vi.fn(() => () => {}),
}))
```

> **坑 1**：`SettingsModal` 挂载时 `useSettings` 会调 `settings.getSystem`，必须一并 mock（返回 `{ locale, theme, themePreset }`）。
> **坑 2**：切菜单定位 nav 按钮用 `settings-nav-system-prompt` testid（label 已走 i18n 翻译，勿按 textContent 找）。

### 4.2 集成测试（vitest，已有）

| 测试文件 | 覆盖用例 |
|---------|---------|
| [`__tests__/settings/system-prompt-page.test.ts`](../../packages/renderer/src/__tests__/settings/system-prompt-page.test.ts) | 渲染 gate（核心 testid 全在）/ 替换卡警告文案 / 保存成功 toast / 保存失败 error toast / 放弃还原快照 + 保存按钮禁用 / 恢复默认清空关开关 / corrupted 提示 |
| [`__tests__/settings/default-prompt-reference.test.ts`](../../packages/renderer/src/__tests__/settings/default-prompt-reference.test.ts) | 参考区默认折叠 / 展开后显示 DEFAULT_PI_SYSTEM_PROMPT 内容 + 说明文案 / 常量导出且非空 |

**运行**：
```bash
cd packages/renderer && npx vitest run src/__tests__/settings/system-prompt-page.test.ts src/__tests__/settings/default-prompt-reference.test.ts
```

**典型用例**：
- 渲染 gate：`openSystemPromptPage()` 后遍历 requiredIds 断言 `hasTestId(id) === true`
- 保存流：`trigger('click')` 替换 Switch → `setValue('自定义系统提示词')` → 点保存 → 断言 `setSystemPrompt` 被调且 payload.replace.enabled===true，且出现 info toast
- 失败反馈：`setSystemPrompt.mockRejectedValueOnce(new Error('保存失败'))` → 点保存 → 断言出现 error toast 含「保存失败」
- 放弃：改文本 → 点 discard → 编辑态还原 + discard/save/reset 按钮 disabled
- corrupted：`getSystemPrompt.mockResolvedValueOnce({ ..., corrupted: true })` → 断言页内文本含「损坏」

### 4.3 调用链概述（前端 → runtime → 磁盘）

- **保存**：`SystemPromptPage.saveReplace()` / `saveAppend()` → config 门面 `setSystemPrompt` → WS `config.setSystemPrompt` → `SettingsMessageHandler` → `ConfigService.setSystemPromptConfig`（委托 system-prompt-config-helper）：长度校验（replace.prompt 超 `SYSTEM_PROMPT_MAX_LENGTH` 16000 拒绝）→ atomicWrite `<dataDir>/system-prompt.json` → reply + broadcast `config.systemPrompt`（多 panel 同步）。
- **加载**：`config.getSystemPrompt` → `ConfigService.getSystemPromptConfig`：文件不存在 → 默认配置 corrupted:false；JSON.parse 失败 → 默认配置 corrupted:true；字段缺失/类型错 → `mergeSystemPromptConfig` 容错 corrupted:false。

**长度上限 SSOT**：`SYSTEM_PROMPT_MAX_LENGTH = 16000`（`packages/shared/src/constants.ts`），ConfigService 与前端 textarea 计数器同源引用；**仅约束 replace**（append 走 hook 不经 argv，无硬上限，只显示字符数）。

**默认提示词常量 SSOT**：`DEFAULT_PI_SYSTEM_PROMPT`（`packages/shared/src/pi-default-prompt.ts`，提取自 pi 0.84.1——pi 升级后需 diff 检查）。

## 5. 非 MOCK 测试步骤（真实 runtime）

```bash
pnpm dev
```

### 5.1 ConfigService / WS 路由 / spawn 注入单测（`packages/runtime/test/`）

| 测试文件 | 覆盖用例 |
|---------|---------|
| [`system-prompt-config.test.ts`](../../packages/runtime/test/system-prompt-config.test.ts) | getSystemPromptConfig / setSystemPromptConfig / getReplaceSystemPrompt 的常规与异常路径（读写、损坏兜底、超长拒绝、字段级容错） |
| [`settings-message-handler-system-prompt.test.ts`](../../packages/runtime/test/settings-message-handler-system-prompt.test.ts) | 2 个 WS case 路由：`config.getSystemPrompt` / `config.setSystemPrompt`（成功 reply+broadcast、失败按 D10 错误信封不广播） |
| [`rpc-client-system-prompt.test.ts`](../../packages/runtime/test/rpc-client-system-prompt.test.ts) | spawn pi 时 `--system-prompt` CLI arg 注入：有值/仅空白/未传 三态 |

**运行**：
```bash
cd packages/runtime && npx vitest run test/system-prompt-config.test.ts test/settings-message-handler-system-prompt.test.ts test/rpc-client-system-prompt.test.ts
```

### 5.2 扩展单测（before_agent_start hook 行为）

| 测试文件 | 覆盖用例 |
|---------|---------|
| [`system-prompt-extension.test.ts`](../../packages/runtime/test/system-prompt-extension.test.ts) | append 开启且非空 → BASE+全局段+\n\n+EXTRA / append 关闭 → undefined / 配置缺失 → undefined / JSON 损坏 → undefined / append.prompt 纯空白 → undefined / 全局指令注入（存在→带头部、空白→跳过、候选顺延） / --no-context-files 在 argv → 全局不注入（append 仍生效） / XYZ_AGENT_DATA_DIR 与 PI_CODING_AGENT_DIR 回退定位 |
| [`extension-service-system-prompt.test.ts`](../../packages/runtime/test/extension-service-system-prompt.test.ts) | builtin npm 包经 mandatory-extensions.json 机制加载（@zhushanwen/pi-system-prompt 等）；旧文件型扩展机制已移除 |
| [`extensions/taiji/system-prompt/src/__tests__/system-prompt.test.ts`](../../extensions/taiji/system-prompt/src/__tests__/system-prompt.test.ts) | 包内占位测试（真实 hook 断言在 runtime 侧文件） |

**扩展源码**：[`extensions/taiji/system-prompt/src/index.ts`](../../extensions/taiji/system-prompt/src/index.ts)（npm 包 `@zhushanwen/pi-system-prompt`，root `index.ts` 再导出。打包：`scripts/bundle-extensions.mjs` esbuild bundle 后 staging 到 `apps/electron/resources/extensions/@zhushanwen/pi-system-prompt/`，数量与清单以 `packages/shared/src/mandatory-extensions.json` SSOT 为准）

**关键 hook 行为**（`extensions/taiji/system-prompt/src/index.ts`）：
- 每轮 `before_agent_start` 读 `<dataDir>/system-prompt.json`（不缓存）
- 注入顺序：base → 全局指令（`~/.agents/AGENTS.md` 候选精确匹配真实目录条目，防 APFS 大小写不敏感误报）→ append.prompt
- append.enabled && append.prompt 非空白 → 追加后返回 `{ systemPrompt: newPrompt }`；与原值相同 → `undefined`（放行）
- `--no-context-files` / `-nc` 在 argv → 全局指令不注入（append 仍生效）
- 任何异常吞掉返回 `undefined` + stderr 落诊断日志（经 pi stdout tee 进 `logs/pi-*.jsonl`），绝不阻塞 agent loop

**运行**：
```bash
cd packages/runtime && npx vitest run test/system-prompt-extension.test.ts test/extension-service-system-prompt.test.ts
```

### 5.3 手工冒烟清单（每项必做，MOCK 测不出真实 spawn/hook）

| 步骤 | 操作 | 期望 |
|------|------|------|
| 1 | Settings → 系统提示词 → 开替换卡开关 + 填文本 → 保存 | toast 提示成功；`~/.xyz-agent-dev/system-prompt.json` 写入 |
| 2 | 新建会话发一条消息 | runtime 日志 spawn pi 时 args 含 `--system-prompt "..."` |
| 3 | 切 append 卡开关 + 填追加指令（如「每轮回复以 MARKER 开头」）→ 保存 → 在已有会话发下一轮 | 回复遵守追加指令（hook 每轮读配置，下一轮即生效——现行无快照文件，只能按行为验证） |
| 4 | `~/.agents/AGENTS.md` 写入标记内容 → 下一轮提问确认模型知晓 | 模型复述全局指令内容；用 preset `noContextFiles`（或 `--no-context-files`）启动的新会话 → 全局不注入 |
| 5 | 手动把 system-prompt.json 改成非法 JSON 后刷新页 | corrupted 提示条出现，控件回退默认值（不崩） |
| 6 | replace.prompt 填超 16000 字符 → 保存 | runtime 返回 error 信封，前端 error toast（append 无此上限） |

## 6. 已知坑 / 注意事项

| 坑 | 说明 |
|----|------|
| ⚠️ 替换模式仅对新建会话生效 | replace 走 spawn 期 `--system-prompt` CLI 注入，已存在的会话不会重新 spawn。改完 replace 后必须新建会话才看到效果 |
| ✅ 追加模式下一轮即生效 | append 走 before_agent_start hook，hook 每轮读配置（不缓存）。保存后同一会话下一轮即可生效 |
| ⚠️ 长度上限 16000 仅约束 replace | `SYSTEM_PROMPT_MAX_LENGTH`（shared/constants.ts），ConfigService 拒绝超长（ok:false）；append 走 hook 不经 argv 无硬上限，UI 只显示字符数（R3） |
| ⚠️ 参考区是静态常量不是实时快照 | `DEFAULT_PI_SYSTEM_PROMPT` 是 pi 0.84.1 提取的常量（pi-default-prompt.ts 内含版本标记）；旧「当前生效提示词快照」机制（system-prompt-snapshot.md）已随 builtin→npm 迁移删除，[HISTORICAL] 勿按旧文档找 snapshot testid / `config.getSystemPromptSnapshot` 命令（均已不存在） |
| ⚠️ corrupted 仅 JSON.parse 失败才置 true | 字段缺失/类型错走 `mergeSystemPromptConfig` 字段级容错（corrupted=false）。只有文件整个不是合法 JSON 才回退默认 + corrupted=true 提示用户 |
| ⚠️ 全局指令注入受 argv 守卫 | pi 带 `--no-context-files` / `-nc` 启动时 hook 跳过全局 AGENTS.md 注入；subagent 路径靠 argv-mirror 镜像该 flag 保证 opt-out 不被绕过（extensions/subagent-workflow/src/execution/argv-mirror.ts） |
| ⚠️ hook 绝不阻塞 agent | hook 顶层 try/catch 兜底，任何异常返回 `undefined`（放行）+ stderr 诊断。测试注入坏 dataDir 不会让 pi 卡住 |
| ⚠️ 数据目录双名同根 | 文档/代码中 configDir 与 dataDir 均指 `XYZ_AGENT_DATA_DIR` 根（dev=`~/.xyz-agent-dev/`，prod=`~/.xyz-agent/`），`system-prompt.json` 两端读到同一文件（extension 经 XYZ_AGENT_DATA_DIR / PI_CODING_AGENT_DIR 上溯两级解析） |

## 7. 相关文档

- 组件源码：[`components/settings/system/SystemPromptPage.vue`](../../packages/renderer/src/components/settings/system/SystemPromptPage.vue)
- 菜单注册：[`components/settings/SettingsModal.vue`](../../packages/renderer/src/components/settings/SettingsModal.vue)（`menus[4] = { id: 'system-prompt', ... }`，nav testid `settings-nav-system-prompt`）
- 数据层：[`core/transport/api/domains/config.ts`](../../packages/core/src/transport/api/domains/config.ts) §System prompt config
- runtime 配置：[`services/config-service.ts`](../../packages/runtime/src/services/config-service.ts) + [`services/system-prompt-config-helper.ts`](../../packages/runtime/src/services/system-prompt-config-helper.ts)
- WS 路由：[`transport/settings-message-handler.ts`](../../packages/runtime/src/transport/settings-message-handler.ts)（`config.getSystemPrompt` / `config.setSystemPrompt` case）
- 扩展源码：[`extensions/taiji/system-prompt/src/index.ts`](../../extensions/taiji/system-prompt/src/index.ts)（npm 包 `@zhushanwen/pi-system-prompt`）
- builtin 清单 SSOT：[`packages/shared/src/mandatory-extensions.json`](../../packages/shared/src/mandatory-extensions.json)（打包经 `scripts/bundle-extensions.mjs` staging 到 `apps/electron/resources/extensions/`）
- 集成测试：[`__tests__/settings/system-prompt-page.test.ts`](../../packages/renderer/src/__tests__/settings/system-prompt-page.test.ts) · [`__tests__/settings/default-prompt-reference.test.ts`](../../packages/renderer/src/__tests__/settings/default-prompt-reference.test.ts)
- 架构约束：[AGENTS.md §Builtin pi-extensions 打包内置](../../AGENTS.md)

---


> [STALE 2026-09-13] 本文撰写于 subagent-workflow 重构前：档位 A 的 L1 harness（`worker-script-builder.ts` + `worker-script-builder-runtime.test.ts`）已随重构并入 host/injectors 而删除，同名等价物不存在（现行源码见 `extensions/universal/subagent-workflow/src/{host,injectors}/`）。仅保留仍然有效的章节：§2 断言价值层级方法论、§3 档位 C real E2E 结论、§4 pi-mono 参考模式、§5 决策树；现存测试覆盖 = `extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts`（L1.5）+ `e2e/workflow-thinkinglevel-real.spec.ts`（L2/L3）。
>
> **定位**：[TEST-STRATEGY.md](../../TEST-STRATEGY.md) 的分层 SSOT 覆盖「单元/集成/E2E mock 轨/dev 冒烟」，[00-overview.md](./00-overview.md) 覆盖「app 级 real-mode Playwright E2E」。本文补两者之间的空白——**extension（尤其 `extensions/universal/subagent-workflow`）层如何做运行时断言**：从源码字符串断言（L0）一路到真实 LLM（L3）。
>
> **读者**：给 subagent-workflow（或同类 extension）写测试、想把「降级断言」升级为运行时断言、或要做 real LLM 验证的开发者。

---

## 1. 为什么需要这套体系

`extensions/subagent-workflow` 的 workflow 执行走 worker_threads 子进程：主线程 `actionRun` → `RunSpec` → `workerHost.start`（spawn worker）→ worker 内 `buildWorkerScript` 产物执行 → `agent()` 经 `postMessage(agent-call)` 请求主线程 → 主线程 `resolveIdentity`/`resolveModel` → spawn pi 子进程 → 真实 LLM。

这条链路跨 3 个执行域（主线程 / worker 线程 / pi 子进程），每一域都有自己的失败模式。**只在一个域做断言，会漏掉跨域的注入/序列化/作用域 bug**。典型教训：

- `_safePost` 作用域 bug（定义在 async IIFE 内、IIFE 外的 `.then()/.catch()` 里使用）→ 源码字符串断言全绿，但真实 Worker 每次 return 都 `ReferenceError` → exit code 1 → 所有 workflow 100% 失败。由 `worker-script-builder-runtime.test.ts` 抓住。
- `$MODEL` 注入写成源码字符串断言（`expect(script).toContain('const $MODEL = ...')`）→ 只证明「生成的源码含这行」，不证明「真实 Worker 拿到 `workerData.model=X` 后产出的 `agent-call.opts.model=X`」。由本次 P3/P4 runtime 升级解决。

**核心原则**：断言越靠近「真实产物」，价值越高；越靠近「源码字符串」，越只能防拼写错误。下文的「价值层级」量化这个梯度。

---

## 2. 断言价值层级（L0–L3）

源自 [00-overview.md Part R-2 §6（断言真实表面的价值层级）](./00-overview.md#6-断言真实表面的价值层级thinkinglevel-案例)，本文按 extension 层重新表述并给出每层在本仓库的可执行方式：

| 层级 | 断言对象 | 能证明什么 | 抓不住什么 | 本仓库实现 |
|---|---|---|---|---|
| **L0** | 生成的源码字符串（`toContain`）| 「拼对字符串」「注入行存在」| 运行时语法错（转义坏）、作用域错、workerData 没传到、序列化失败 | 原 `worker-script-builder.test.ts`（已随重构移除）|
| **L1** | 真实 Worker 线程的**消息产物**（`agent-call.opts`）| 「`workerData.model` 真的流到 `agent()` 的 `opts.model`」「三分支 fallback 真生效」| pi 是否真用这个 model 调 LLM、RunSpec 构造是否对 | 原 `worker-script-builder-runtime.test.ts`（本文档原主角，已随重构移除，模式见 §3 档位 A）|
| **L1.5** | 真实 lifecycle + workerHost + RunSpec 全链路（mock 最终 runner）| 「`actionRun(params.model)` → `RunSpec.model` → `workerData.model` → `$MODEL`」完整生产链路 | pi 子进程 + LLM | `workflows-e2e.test.ts`（mock runner）|
| **L2** | pi 自己写的**产物文件**（session JSONL 的 `model_change`/`thinking_level_change` entry）| 「pi 收到 `--model p/m:level` 后真实拆字段落盘」「零 xyz-agent 代码介入」| LLM 是否跑完产出 | `e2e/workflow-thinkinglevel-real.spec.ts` TC2 |
| **L3** | 真实 provider 跑完产出（assistant 消息）| 「完整链路可跑通」「provider 真的接受这个 model」| —（最真实，但慢/flaky/花钱）| `e2e/workflow-thinkinglevel-real.spec.ts` TC3 |

**选择原则**：**能确定性地证到 L1，就不停在 L0**（L0 只作防御性补充，不替代 L1）。L1.5 覆盖 RunSpec 构造段（L1 不覆盖）。L2/L3 是 real-mode，留给「跨进程协议透传」「pi 对 CLI 参数的真实消费」这类 L1 无法触及的盲区——但触发依赖 LLM 决策，flaky-skip 容忍。

---

## 3. 三档测试模式

### 档位 A · worker-runtime（L1）[已随重构移除]

原模式：真实起 `node:worker_threads.Worker` 执行生成的 worker 脚本产物，主线程模拟 workflow runtime 回发 `agent-result`，断言 `agent-call` 消息的 `opts`——Worker 边界以内全真（`$MODEL`/`$THINKING_LEVEL` global 注入、`agent()` 三分支 fallback、`postMessage` 序列化），唯一 mock 是主线程回发，完全确定（毫秒级）。harness 为 `runWorker()` 扩展点（给 workerData 加 `model`/`thinkingLevel` 透传）。

**该 harness 及其测试文件已随 2026-09 重构删除**（orchestration 层并入 host/injectors），此处保留模式描述供未来重建参照：核心思想是「断言越靠近真实产物越好」——源码字符串断言（L0）只防拼写错误，真实 Worker 消息产物断言（L1）才能抓作用域/序列化/透传 bug（历史教训：`_safePost` 作用域 bug 源码断言全绿但真实 Worker 100% 失败）。若需要重建等价 harness，按现行 `host/` + `injectors/` 结构重新落地。

### 档位 B · workflow-E2E（L1.5）

**走真实 `actionRun` → `lifecycle.runWorkflow` → `workerHost` → Worker 全链路，唯一 mock 是 `deps.runner`（`AgentRunner` 接口）。**

- **真实程度**：覆盖「`actionRun` 把 `params.model` 塞进 `RunSpec.model`」+「`worker-host` 把 `spec.model` 透传到 workerData」这两段生产代码。
- **确定性**：✅ 完全确定（真 lifecycle + 真 JsonlRunStore temp dir，mock runner）。
- **现存实现**：[`extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts`](../../extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts) 的 `makeMockRunner()`——`runner.run` 是 `vi.fn`，`mock.calls[N][0]` 即 AgentCall 的 `opts`（含 `opts.model`）。
- **何时用**：改动涉及 model/thinkingLevel 字段在 actionRun → RunSpec → workerData 的流转时，本档位是回归防线。

---

### 档位 C · real LLM E2E（L2/L3）

**真 Electron + 真 runtime + 真 pi 子进程 + 真实 LLM provider。零 mock。** 详见 [00-overview.md](./00-overview.md)。

- **真实程度**：最真实。断言 pi 自己写的 session JSONL（L2）+ 真实 provider 产出（L3）。
- **确定性**：❌ flaky（触发依赖 LLM 决策调 tool，不调则 skip + diag 落盘）。
- **模板**：`e2e/workflow-thinkinglevel-real.spec.ts`（TC1 验 state 请求值 / TC2 验 pi JSONL `thinking_level_change` + `model_change` / TC3 验完整跑通）。

#### run-level override 的 real E2E 限制

现有 `workflow-thinkinglevel-real.spec.ts` 验证的是 **per-call** override（脚本内 `agent({model, thinkingLevel:"high"})` 显式传）。**run-level override（workflow tool 顶层 `model` 参数）的 real E2E 有固有困难**：

- run-level `model` 是**主 agent 的自主决策**（它在调 `workflow` tool 时决定是否带 `model` 字段）。强引导 prompt 只能保证「调 workflow」，不能保证「带特定 model 字段」——LLM 可能省略。
- 因此 run-level override 的 real E2E 触发**不可控**，flaky-skip 概率高。

**可行路径**：
1. **探针脚本读 `$MODEL`/`$THINKING_LEVEL` global 并 echo**（验证 global 被注入），但这是 worker 内行为，档位 A 已确定性覆盖，real E2E 价值低。
2. **预设 fixture 让主 agent 必须传 model**（如 workflow 脚本的 usage 文案强引导），但仍依赖 LLM 遵从。
3. **直接断言档位 A/B 已覆盖的链路**——run-level override 的核心代码（worker-script-builder 注入 + agent() fallback + RunSpec 透传）已被 L1/L1.5 确定性验证；real E2E 只能补「pi 真调 LLM」这最后一段，而那段是 pi 核心职责（非 extension 代码），由 pi 自己的测试 + 现有 thinkingLevel real spec 覆盖。

**结论**：**run-level override 不新增 real E2E spec**（ROI 低）。real E2E 留给 per-call override（已有 spec）和跨进程协议透传类盲区。如需用真实模型（如 `zhipu-coding-plan-router/glm-5.2`）做 smoke，直接复用现有 thinkingLevel spec 改 `PROBE_MODEL` 即可。

#### 用 glm-5.2 做 real smoke（可选）

`zhipu-coding-plan-router/glm-5.2`（reasoning=true，thinkingLevelMap: high→high, xhigh→max）可用于 real smoke。最小步骤：

```bash
# 1. real renderer bundle（与 mock bundle 输出冲突，分批 build）
# 2. 跑现有 thinkingLevel spec（它用 deepseek-router/ds-pro，可改 PROBE_MODEL）
PROBE_MODEL=zhipu-coding-plan-router/glm-5.2 npx playwright test e2e/workflow-thinkinglevel-real.spec.ts --grep TC2
# TC2 断言子进程 JSONL 含 model_change（provider=zhipu-coding-plan-router, modelId=glm-5.2）
```

> 注意：glm-5.2 的 thinkingLevelMap 无独立 `max` 键，传 `thinkingLevel:"max"` 会被 clamp 到 xhigh（映射 `"max"`）。测 thinkingLevel 用 `"high"` 或 `"xhigh"` 更直接。

---

## 4. pi-mono 参考模式（供未来借鉴）

调研 pi 源码（`~/GitApp/pi-ecosystem/pi-mono`）发现三套 real-mode 模式，xyz-agent 目前**未直接采用**，但未来若要做「真 pi 子进程 + 可控 LLM」的测试，这是最干净的参照：

### 4.1 faux provider（mock LLM 边界，agent loop 全真）

`packages/ai/src/providers/faux.ts` 的 `fauxProvider()` / `registerFauxProvider()`。声明式编排响应序列，**最关键的断言钩子**：响应工厂 `(context, options, state, model) => AssistantMessage` 拿到真实传给 provider 的 `model` + `options.reasoning`，可 capture 事后断言。

**对应 xyz-agent 场景**：若未来要在 extension 层验证「resolveModel 选对 model」而不仅「agent-call 带对 model」，可引 faux provider 模式（但 xyz-agent 经子进程调 pi，faux 需注入 pi 侧，跨进程复杂度高）。

### 4.2 AgentHarness（生产 agent 驱动器，可订阅事件 + 运行时切 model）

`packages/agent/src/harness/agent-harness.ts`。跑真实 `runAgentLoop`，只把 `Models` 换成含 faux provider 的实例。`setModel/setThinkingLevel` 在 save point（turn_end）刷新到下一个 turn——**「运行时模型切换生效」的断言范式**。

**黄金参照**：`packages/agent/test/harness/agent-harness.test.ts` 的 "refreshes model/thinkingLevel at save points"——faux 响应回调 capture model + reasoning，`subscribe(tool_execution_start)` 里切 model，断言第二个 provider 调用用了新 model。这正是「run-level override 运行时生效」在 pi 侧的等价测试。

### 4.3 RpcClient（真 spawn pi 子进程 + JSONL 通信）

`packages/coding-agent/src/modes/rpc/rpc-client.ts`。`spawn("node", [cliPath, "--mode","rpc", ...])` 起真实 pi CLI 子进程，typed API：`setModel/setThinkingLevel/promptAndWait/collectEvents/waitForIdle`。xyz-agent 自己就是 spawn pi + RPC 通信，`RpcClient` 模式可直接复用。

**real-LLM gated 模式**：`describe.skipIf(!process.env.ANTHROPIC_API_KEY)` 门控，无 key 自动 skip。xyz-agent 的 `packages/coding-agent/src/modes/rpc/rpc-mode.ts` 可复用此模式写 real-LLM 测试，断言 `model_change`/`thinking_level_change` JSONL entry（L2）。

---

## 5. 决策树：何时用哪档

```
要验证的代码在 worker 内（globals 注入 / agent() fallback / parallel/pipeline）?
├─ 是 → 档位 A（worker-runtime，L1）——原 harness 已移除，需按现行 host/injectors 结构重建。
│       L0 源码断言可作补充防线。
│
要验证 RunSpec 构造 / worker-host 透传 / actionRun 字段流转?
├─ 是 → 档位 B（workflow-E2E，L1.5）。makeMockRunner() 已就绪（workflows-e2e.test.ts）。
│
要验证跨进程协议透传 / pi 对 CLI 参数的真实消费 / pi 产物文件?
├─ 是 → 档位 C（real E2E，L2/L3）。参考 workflow-thinkinglevel-real.spec.ts。
│       注意：run-level override 触发不可控（§3 档位 C），per-call override 才适合。
│
要验证 pi 核心 RPC / spawn 链路（非 extension 代码）?
└─ 参考 pi-mono RpcClient 模式（§4.3），real-LLM gated。
```

**默认起点**：档位 A。绝大多数 extension 层逻辑（globals 注入、agent() 行为、parallel/pipeline）的最佳性价比都在 L1。只有跨进程/真实 LLM 的盲区才上 L2/L3。

---

## 6. 现存实证索引

| 验证目标 | 档位 | 文件 | 价值层级 |
|---|---|---|---|
| run-level 字段流转（actionRun → RunSpec → workerData → agent-call opts）| B | [`extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts`](../../extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts) | L1.5 |
| runSpawn（spawn pi 子进程的业务逻辑）| mock spawn | `run-spawn-integration.test.ts` 等（FakeChild）| L0.5（mock 边界 = spawn）|
| workflow agent() thinkingLevel 端到端（per-call）| C real | `e2e/workflow-thinkinglevel-real.spec.ts` | L2/L3 |

> 原 L1 档位（`worker-script-builder-runtime.test.ts`）已随重构删除，见文头 STALE 注。

---

## 附录：关键文件速查

| 文件 | 作用 |
|---|---|
| `extensions/universal/subagent-workflow/src/__tests__/workflows-e2e.test.ts` | L1.5 真 lifecycle + mock runner（现行 SSOT）|
| `e2e/workflow-thinkinglevel-real.spec.ts` | L2/L3 real LLM E2E 模板 |
| `e2e/fixtures/launch-app-real.ts` | real-mode Electron launch fixture |
| `~/GitApp/pi-ecosystem/pi-mono/packages/ai/src/providers/faux.ts` | pi faux provider（mock LLM 边界）|
| `~/GitApp/pi-ecosystem/pi-mono/packages/agent/src/harness/agent-harness.ts` | pi AgentHarness（生产 agent 驱动器）|
| `~/GitApp/pi-ecosystem/pi-mono/packages/coding-agent/src/modes/rpc/rpc-client.ts` | pi RpcClient（真 spawn pi 子进程）|

---


> 定位：插件系统（plugin-service）的**真实加载路径**验收——隔离 runtime + 真实插件文件 + 真实 WS 协议，零 mock。
> 背景：测试金字塔底部全是 mock、真实加载路径零覆盖是 F1-F4 四个 bug 的共同根因（built-in pluginPath 存目录从未激活、dev sandbox fork 崩溃、uninstall 缺清理、shutdown 不 flush 全部在 mock 层不可见）。本基线是结构性防护。

## 1. 运行方式

```bash
bash scripts/verify-plugin-e2e.sh          # 独立运行，~8s
bash scripts/validate-runtime-bundle.sh    # 作为第 7 步自动运行（pre-commit 于 runtime src 变更时触发）
```

前置：node >= 22（全局 WebSocket 客户端）、curl、lsof、`pnpm install` 过的仓库（esbuild / tsx 可解析）。

不依赖 `pnpm dev`（不占用正在跑的 dev app）：随机端口 + `mktemp -d` 隔离数据目录，tsx 源码直跑 `packages/runtime/src/index.ts`（dev 形态）。

## 2. 覆盖场景与断言

脚本内 heredoc 生成三个最小 sandbox 测试插件（放 `<隔离数据目录>/plugins/`）：

| 插件 | 形态 | 用途 |
|------|------|------|
| `e2e-minimal` | sandbox、无权限声明、activate/deactivate 各打一行日志 | A 激活 + B toggle |
| `e2e-hook` | sandbox、permissions `["plugin.hooks.register"]`（permissions.json 预批准）、onBeforeSendMessage 拦截器（`v6magic` → `[V6-HOOK-APPLIED]` transform） | D hook 执行 |
| `e2e-perm` | sandbox、permissions `["plugin.hooks.register"]`、**不预批准**、activate 打一行日志 | E 运行时批准唤醒 |

| 步骤 | 断言 | 对应修复 |
|------|------|---------|
| A1 | boot 后 `plugin.list` 中 e2e-minimal `status=active`（onStartupFinished 自动激活，sandbox fork 真实加载） | F1（9068e2692 dev tsx loader） |
| A2 | e2e-hook `status=active`（权限预批准持久化路径） | 权限链路 |
| A3 | built-in `statusline` 出现且 `status=active`（registry 多形态扫描 + prepare-builtin-plugins 预编译链） | F3 + F4 dev 扫描修复 |
| B1 | `plugin.toggle {enabled:false}` 后 status ≠ active 且 `enabled=false` + 日志含 `[e2e-minimal] deactivate called` | toggle 停用链路 |
| B2 | `plugin.toggle {enabled:true}` 后 status 恢复 `active` + 日志再次含 `activate called` | toggle 重激活链路 |
| D1 | `message.send`（fake session，hook 先于 ensureActive 执行，SESSION_NOT_FOUND error envelope 属预期） | message-dispatcher hook 时序 |
| E1 | e2e-perm boot 挂起等审批 → WS `plugin.approvePermissions` → reply 中 `status=active` | 权限审批唤醒链路 |
| E2 | 批准 RPC 总耗时 < 10s（实测 ~100ms；修复前干等 30s 超时，boot plugins=30007.5ms） | 同上 |
| 日志断言 | `[e2e-hook] onBeforeSendMessage fired: hello v6magic marker` + `transform computed` + `[e2e-perm] activate called`（worker stdout 经 host 转发落 runtime 日志） | hook 真实执行 + 批准后 activate 真实执行 |
| 负向断言 | 日志 0 次 `failed/timed out`（hook 管道失败）/ `ERR_MODULE_NOT_FOUND`（F1 事故特征）/ `PERMISSION_DENIED` | 回归防护 |

失败行为：任一步 exit 非 0，打印 `[FAIL]` 行 + `[定位]` runtime stdout / 日志目录路径 + stdout 尾部 30 行；**失败现场保留**（`/tmp/xyz-plugin-e2e.*/`，进程照常清理），成功路径全量清理。

## 3. V6 场景关联

本基线 D 步是 [dev-acceptance.md V6 场景](../../.xyz-harness/2026-08-15-perf/dev-acceptance.md)的自动化版本（fake-session 触发）。V6 补测（2026-08-16）在此之上做了真实 session 全链路手工实测：transform 后内容送达 pi 并持久化（session JSONL user 消息为 `hello [V6-HOOK-APPLIED] end-to-end`，原始 `v6magic` 0 次出现）——该全链路（需模型配置）未自动化。

## 4. 缺口跟踪

1. **权限审批等待无人唤醒 —— 已修复**（2026-08-16，`fix(runtime): wake pending plugin permission approvals on approve`）。
   - **修复前实证**（保留作历史）：sandbox 插件声明 permissions 时，boot 激活的 30s 等待（`PluginActivator.waitForPermissionApproval`）只能超时——`resolvePermissionApproval` 全仓无调用方，`PluginService.approvePermissions` 只 grant 不 resolve 该 pending；且等待期间 approvePermissions 触发的 re-activate 因 ACTIVATING 幂等守卫 no-op。实测 boot 后台初始化被阻塞 30s（`plugins=30007.5ms`）。
   - **修复内容**：① `approvePermissions` grant 后调 `activator.resolvePermissionApproval(pluginId, true)` 唤醒挂起中的激活；② `revokePermissions` 对挂起 pending resolve(false)（拒绝走既有失败路径 UNLOADED）；③ `activatePlugin` 幂等守卫重构为 in-flight 真幂等（重入返回同一 promise，approvePermissions 可 await 到被唤醒激活的完成，不再被 no-op 吞）；④ `deactivatePlugin` 清 pending + 权限等待醒来后校验状态仍为 ACTIVATING（防「批准后快速 disable 复活」「卸载后幽灵 setState」）。单测 `packages/runtime/test/plugin-permission-approval-wake.test.ts`；真实验收：批准后激活完成 93ms、boot plugins 步骤 582.6ms（均对比修复前 30007.5ms）。
2. **plugin.toggle 停用后的协议状态**：UNLOADED 映射为 `discovered`（`mapStateForProtocol`），非 `inactive`。脚本断言按 `status ≠ active && enabled=false` 表述，不锁具体值。

## 5. 排查指南

| 症状 | 定位 |
|------|------|
| A1/A2 失败（不激活） | 看 `[FAIL]` 指向的 runtime stdout 中 `plugin-process` / `plugin-host-process` 行；`ERR_MODULE_NOT_FOUND` = F1 类回归（fork loader），`PERMISSION_DENIED` = 权限预批准失效 |
| A3 失败（statusline 缺失） | 先手工跑 `bash scripts/prepare-builtin-plugins.sh`；仍缺失查 `plugin-registry.ts` 的 `resolveBuiltinPluginsDir` 候选探测（两形态单测在 `packages/runtime/test/plugin-registry.test.ts` TC-1-09/10/11） |
| D 步无 hook 日志行 | 查 `message-dispatcher` 的 hook 时序（hook 必须先于 ensureActive）；fake session 的 error envelope 属预期，不算失败 |
| E 步失败（批准后不激活/超 10s） | 查 `PluginService.approvePermissions` 是否调 `activator.resolvePermissionApproval(pluginId, true)`、`PluginActivator.activatePlugin` 的 in-flight 幂等是否被删（回归特征：E2 耗时逼近 30000ms = 干等超时路径复活） |
| 脚本起不来 | `tsx 不可解析` → `pnpm install`；`node < 22` → 升级 node；端口占用 → 脚本自动重试 10 个随机端口，仍失败查 `lsof -nP -i :41000-43999` |

---

# Part U · 自动升级验证流程（原 update-e2e）


## 分层验证

| 层 | 验证目标 | 方式 | 状态 |
|---|---|---|---|
| L1 单元 | release-checker 三重过滤 / orchestrator 状态机 / download-asset 真实文件流 | vitest | ✅ |
| L1.5 集成 | bash 脚本真实执行 + sha256 决策树 + 回滚 | updater-script-integration.test.ts | ✅ |
| L2 半 E2E | dev + mock releaseChecker → UI 状态转换 + release note 渲染 | dev-mock-update-e2e.mjs | ✅ |
| L3 全链路 | 真实 release → 下载 → 替换 → 重启 | 手动，依赖多版本 | ⏸ 待 v0.8.15 发布后做 |

## L2 半 E2E 操作步骤

1. 启动 dev app（带 mock）：
   ```bash
   XYZ_DEV_MOCK_UPDATE=1 pnpm dev
   ```
2. 等 Electron 窗口起来（约 10s）
3. 另开终端跑：
   ```bash
   node scripts/dev-mock-update-e2e.mjs
   ```
4. 看脚本输出，应看到：
   - `[PASS] update-button visible (state=available)`
   - `[PASS] release notes 含 <h2>（markdown 标题已渲染）`
   - `[PASS] release notes 含 <code>（markdown 代码块已渲染）`
   - 截图保存到 `/tmp/dev-update-e2e-full.png` 与 `/tmp/dev-update-e2e-popover.png`
5. 手动验证：hover UpdateButton，肉眼看 release note 浮层（markdown 渲染）

## 触发机制说明

`useAppUpdate` 是 module-level 单例，外部脚本无法直接访问其 `checkForUpdate`，
脚本 `scripts/dev-mock-update-e2e.mjs` 因此不尝试手动触发，而是直接等
**35s** 让 `Sidebar` 的 `initAutoCheck`（`AUTO_CHECK_DELAY_MS = 30_000`）
自动跑一次 + 5s 渲染 buffer。

> 历史说明（已废弃）：早期文档建议在 `Sidebar.vue` 挂 `window.__testTriggerUpdate`
> 钩子做「手动触发」，但该钩子从未在源码挂载，脚本永远走不到该路径，故已移除脚本里的
> 钩子探测逻辑与本文档的挂载建议。验证耐心点等 35s 即可。

## 限制

- L2 **不验证真实替换**：dev 模式 `app.isPackaged=false`，`MacUpdater` 显式拒绝
  （即使点了 UpdateButton 也会落入 error 态——这是有意为之，P2 只验证「检测 → UI 显示」）。
- L3 需等下次正式 release（v0.8.15+），在旧版本上手动跑全链路（下载 → 替换 → 重启）。
- mock 的 `version: 999.999.999` 是「恒大于任何真实版本」的哨兵值，避免 compare-versions 误判。

## data-testid 清单（UpdatePage.vue）

| testid | 组件 | 所在文件 |
|---|---|---|
| switch-auto-update | 自动更新开关 | packages/renderer/src/components/settings/update/UpdatePage.vue |
| select-update-source | 更新来源三选 Select（自动（推荐）/GitHub/AtomGit，切换即持久化） | packages/renderer/src/components/settings/update/UpdatePage.vue |
| current-version-pill | 当前版本 pill | packages/renderer/src/components/settings/update/UpdatePage.vue |
| switch-pre-download | 预下载开关 | packages/renderer/src/components/settings/update/UpdatePage.vue |
| input-http-proxy / input-https-proxy | 代理输入（手动模式） | packages/renderer/src/components/settings/update/UpdatePage.vue |
| btn-test-proxy / test-proxy-result / btn-save-proxy | 代理测试与保存操作栏 | packages/renderer/src/components/settings/update/UpdatePage.vue |

> 内嵌的 UpdateCheckCard.vue（settings-update-check 等 13 个 testid）不在本表范围，登记属其他任务。
