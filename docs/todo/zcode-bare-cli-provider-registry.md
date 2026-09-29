# TODO：zcode 引擎显式模型的 reasoningLevel 接线（account 体系迁移收尾项）

状态：根因已查明并修复主体（2026-09-29，account 体系迁移同步批次）——模型源/缺省语义/常量清理已落地；本条只剩显式模型的 reasoningLevel 传递收尾

## 背景（根因全景，2026-09-29 深查定案）

a1a4 真机复验 run3 三成员调用全部被 app-server 的 session/create 拒绝（「Provider Registry 中不存在 Model: builtin:bigmodel-coding-plan/GLM-5.3-Flash」）。深查（bundle 解剖 + 活体探针对拍）定案：

- **app 3.14.x 起 provider 注册表架构**：内建目录（`~/.zcode/v2/runtime/provider/<plat>/<ver>/endpoint-*/zcode-builtin.json`）的 providerRules 以 `account:` 前缀定义 plan 家族（builtin:bigmodel-coding-plan → account:bigmodel-individual-coding-plan 等迁移映射在 bundle 内）；这些 provider 全部 `access=zhipu-account`（账号 entitlement 门控），CLI 自举缺省 fail-closed（entitled:false → 整族不进注册表）。
- **外部 spawn（我们引擎的形态）的注册表实况**：只有 `~/.zcode/v2/provider_config.json` 的个人 provider（自带 apiKey）装载可用；plan 家族任何 id（builtin:/account: 前缀）一律 provider-not-found（CLI 的报错文案误导性地写「不存在 Model」——provider-not-found 分支静默返回 undefined 后落进同一文案）。
- **GUI 侧为何正常**：GUI 宿主（zcode-host-local-*）由桌面主进程完整装配（env 配方含 ZCODE_BASE_URL=https://zcode.z.ai + LV/tte 双目录 env + ZAI OAuth 三件套）并有账号态供数链；`provider/updateAccountConfig` host 推送在 3.14.3 上被 refresh 检查挡（账号快照 basedOn 为 string、目录 revision 为 number，严格不等 → resolver 静默跳过）——外部进程即使模拟 GUI 推送也补不进 plan 家族。
- **裸起崩溃**：不经 launcher 注入 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 时 CLI 自身推导 bundled 目录失败（相对路径推导在该 app 布局下算到根目录 `/config/...`）→ 启动即退；launcher 的目录定位注入是外部 spawn 能启动的前提。

## 已修复（account 体系迁移同步批次，2026-09-29）

- `zcode-subagent-cli/preparer.ts`：模型解析/清单源切换 `~/.zcode/v2/provider_config.json`（个人 provider 单源，凭据判据 config.access.apiKey，短名默认 provider = providerOrder 首个带凭据者）；缺席模型返回空串（create 帧省略 model 键 → CLI 缺省解析，实测落 providerOrder 首位快档模型并自动补齐 reasoning 档位）。
- `constants.ts`：`ZCODE_FALLBACK_DEFAULT_MODEL` 删除；core 侧镜像 `zcode-model-ref.ts` 的 `DEFAULT_PROVIDER_ID`/`ZCODE_FALLBACK_DEFAULT_MODEL`/`hasApiKey` 同步删除（宿主侧零消费）。
- `appserver-launcher.ts`：model.main 兜底伪造删除（v2.model.main 透传保留）；新增 ZCODE_BASE_URL 注入（从已定位目录邻位 `zcode-builtin-refresh.json` 的 endpointKey 读出——对齐 CLI 的 active 目录路径推导，避免向错误 endpoint 联网重装）。

## 剩余收尾（本条现承载）

- **显式模型 + reasoningLevel**：部分注册表模型（实测个人 provider 全部）要求 create 帧 `model.options.reasoningLevel`（值域 per-model，源 = 内建目录 modelConfigRules 的 optionSpecs——mimo 家族为 disabled/enabled，GLM 家族为 low/high/max 档）；引擎 create 参数当前不携带 options → 显式指定这些模型在 create 即报「Reasoning level is required」。接线点：AgentCallOpts 侧新增可选 reasoningLevel（或引擎侧读内建目录 modelRules 匹配值域自动补默认档）→ `buildAppServerCreateParams` 的 model 对象带 options。验证形态已探针确认（`options.reasoningLevel: "enabled"` 的 create 建会话成功）。
- 关联条目：`engine-default-provider-setting.md`（引擎默认 provider/model 页面化——长期形态）。

## 出处

- run2 终判：`.tmp/dev-flow/workflow-run-store-convergence.acceptance/a1a4/verdict.json` A4_completion 阻塞项②（handoff 缺陷 3）
- run3 复发与深查证据：同目录 evidence.json + verdict-run3.json + 根因探针 `.tmp/dev-flow/zcode-registry-probe.mts`（接受矩阵/推送实验/缺省解析落点）
