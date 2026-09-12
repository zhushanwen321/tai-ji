# 10 · 系统提示词配置（Settings · SystemPrompt）测试流程

> 覆盖：Settings → 「系统提示词」菜单 → 两卡片（替换 pi 核心提示词 / 追加注入额外提示词）+ 替换卡内「pi 默认提示词」折叠参考区 → 保存/失败 toast / 放弃/恢复默认 / corrupted 兜底。
>
> 先读 [00-test-strategy-overview.md](./00-test-strategy-overview.md) 理解双轨制和公共前置。

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
