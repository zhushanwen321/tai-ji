# extension.load · pi 扩展装载（builtin 21 包 + 用户扩展）

- **通道**：A（扩展页列表 / 行为可见）/ B（`extension.list` reply、`session.getCommands` 来源）/ C（`<dataDir>/run/pi-spawn-markers.json`、runtime 日志 `resolved N extensions from M sources`、`<dataDir>/agent/logs/<ext>-<date>.log`、会话 jsonl）
- **前置**：`requires: none`（装载判据本身不需要 LLM）；要验「扩展功能真的可用」再叠 `requires: faux`
- **用于**：所有依赖扩展的 scenario 的**前置门**（`p0-*` 全部 covers 它）；单独验收 `p0-extension-load`

> 本 capability 是「其它所有 capability 的地基」：扩展没装载，ask_user / permission / plan /
> canvas / 后台任务全部静默缺席。但**「N 够大」不等于「某个扩展真的装了」**——本文件
> 的核心就是拆开这两个问题。

---

## 入口（用户 POV / 协议 / 副作用点）

**用户 POV（两条）**：

1. 设置 → `settings-nav-extension` → 扩展页（`extension-group-builtin` / `extension-group-user`
   两组卡片；testid 出处 `packages/renderer/src/components/settings/extension/ExtensionList.vue`）。
   每行 `ExtensionDetail` + `ExtensionActions`（行内**无独立 testid**，只能用文本锚点）。
2. 对话里用该扩展提供的 slash 命令 / 工具（如 `/permission status`、`/plan`、`/todos`、
   `/goal`）——命令面板出现即证明扩展的命令注册成功。

**协议**：

- `extension.list`（无参）→ reply `config.extensions`（`{ extensions: ExtensionInfo[] }`，
  含 `name/displayName/version/enabled/source/layer/tier/mandatory`；
  出处：`packages/shared/src/protocol.ts` 的 `'extension.list'` + `packages/shared/src/extension.ts`
  的 `ExtensionInfo`）。
- `extension.toggle`（`{ name, enabled }`）→ reply `config.extensions`；
  `extension.uninstall` / `extension.upgrade` → reply 同名。
- `session.getCommands`（`{ sessionId }`）→ reply `session.commands`
  （`commands[]` 含 `name/description/source/sourceInfo.path`；
  出处：`packages/shared/src/protocol.ts` 的 `CommandSourceInfo`）。
  **这是「某个扩展真的跑到 pi 里了」最便宜的 B 通道证据**（仅对注册了命令的扩展有效）。

**装载链（谁决定「哪些扩展进 pi 进程」）**：

```
runtime ExtensionResolver.resolve(projectRoot, packaged, userExtPaths, discoveryExtDirs)
  ├─ 六源扫描：npm > user > discovery > settings > third-party > bundled（first-write-wins 去重）
  └─ log.info(`[extension-resolver] resolved ${deduped.size} extensions from ${sources.length} sources`)
       ↑ 这一行就是 doctor 判据的来源
runtime → pi spawn：`--mode rpc --no-extensions --approve --extension <每个目录>`（+ 同名 --skill）
       ↑ `--no-extensions` 意味着 pi **不会**自动发现 `<dataDir>/agent/extensions/`；
         唯一装载通道 = 显式 `--extension` 列表
```

出处：`packages/runtime/src/infra/installers/extension-resolver.ts`（六源 + 日志行）、
`packages/pi-rpc/src/spawn-args.ts`（`--no-extensions` 注释与参数顺序）、
`packages/runtime/src/infra/pi/rpc-client.ts`（`recordSpawnMarkers`）。

**builtin 清单 SSOT**：`packages/shared/src/mandatory-extensions.json` —— 当前
**21 条 = 13 feature + 8 infrastructure**（实测 `python3 -c "…"` 计数；文件本身无版本号，
数量以文件为准，**不要在任何文档里写死「21」当契约**）。分组语义
（出处 `packages/shared/src/extension.ts`）：

| tier | 语义 | 可否禁用 | 可否卸载 |
|------|------|----------|----------|
| `infrastructure`（8 条） | 纯能力提供者：`pending-notifications` / `session-reader` / `structured-output` / `agent-ext` / `system-prompt` / `msg-id-mapper` / `base-tool-enhance` / `provider-live-sync`（`extensions/shared/*` 是共享库、不是 extension 条目，不在此列） | **否**（`extension.toggle(false)` 直接抛 `infrastructure_cannot_disable`） | **否**（`builtin_cannot_uninstall`） |
| `feature`（13 条） | 用户可感知功能：`ask-user` / `goal` / `todo` / `subagent-workflow` / `permission` / `scheduler` / `rename-session` / `system-prompt-trace` / `smart-context` / `session-manager` / `plan` / `canvas` / `network-proxy` | 可禁（`disabled-packages.json` 记 `npm:<name>`） | 否 |

**副作用点**：装载发生在 **pi 子进程 spawn 时**。所以：
- 扩展开关变更对**已存在 session 不生效**（pi 进程已起），必须新建 session / 重连；
- `resolved N` 的 N 是**解析阶段**的目录数，**不代表每个都成功 load**（jiti 求值失败、
  `registerTool` 抛错都会让某个包静默缺失而 N 不变）。这是 doctor「N ≥ 8」判据的边界。

---

## 驱动

### 判据一：解析阶段（doctor 的 N ≥ 8）

```bash
node .agents/skills/verify-taiji/scripts/doctor.mjs <repo> --data-dir <dataDir> --json
```

- 读 `<dataDir>/logs/runtime-<date>.log` 末次 `[extension-resolver] resolved N extensions from M sources`。
- 语义（**必须这样理解**）：
  - `N` = 去重后**目录数**（六源合并，first-write-wins）；
  - dev 实例典型值 = 21 builtin（源码布局 `extensions/<group>/<pkg>`） + 可选用户源
    （`TAIJI_EXTENSION_PATHS`，faux 装配时会多一个 `e2e/fixtures/faux-provider-ext`）；
  - `--no-extensions` 下 `M` 的来源数量取决于装配（dev 常见 2~3：bundled + user[+ settings]）；
  - **N ≥ 8 只是「有东西被解析」的下限 smoke**，不是「21 个都在」的断言。
- 反向证据（C）：`cat <dataDir>/run/pi-spawn-markers.json` —— 该实例最近一次 pi spawn
  实际收到的 staged 专属 `--extension` 路径清单（原子覆盖写，JSON 字符串数组）。
  这是**比日志更硬的事实**：日志说「解析了 N 个」，清单说「真正传给了 pi 哪些」。

### 判据二：某个扩展真的装了（不能只看 N）

按强度递增，任选组合（**至少两条不同通道**）：

| # | 通道 | 做法 | 能证明什么 |
|---|------|------|-----------|
| 1 | C | `python3 -c 'import json,sys;print(len(json.load(open("<repo>/packages/shared/src/mandatory-extensions.json"))))'` + `grep -c` 分组 | 契约层「应该有哪些」（期望值基线，不是运行时证据） |
| 2 | C | `grep -o '"[^"]*pi-[a-z-]*"' <dataDir>/run/pi-spawn-markers.json` | 该包的**目录被传给 pi**（dev 源码根 `<repo>/extensions/<group>/<pkg>`） |
| 3 | C | `ls <dataDir>/agent/logs/ \| grep <extName>` 或 `tail <dataDir>/agent/logs/<extName>-<date>.log` | 该扩展**代码被执行过**（logger 初始化 / session_start 日志）。taiji 恒注入 `TAIJI_AGENT_EXT_LOG=1`（`rpc-client.ts`），INFO 级本应落盘 |
| 4 | B | `session.getCommands` → 找该扩展注册的命令（`/permission`、`/plan`、`/goal`、`/todos`、`/compact`…），核对 `sourceInfo.path` 指向该包目录 | **pi 进程内注册成功**（仅对注册命令的扩展有效） |
| 5 | A/B | 行为验证：该扩展的核心工具能跑通（如 `ask_user` → FormOverlay；`/permission status` → 状态文本） | **端到端可用**（最强，但成本最高） |
| 6 | C | 会话 jsonl 的 `<dataDir>/agent/sessions/<encodeCwd>/*.jsonl` 出现该扩展写入的 custom entry（如 `taiji:system-prompt`） | 扩展 hook 在该 session 真的跑了 |

**不能当作证据的**：
- `extension.list` 的 `enabled: true` —— 它只表示「不在 disabled-packages.json 里」，
  是**配置意图**，不是装载事实；
- 扩展页出现卡片 —— 同上（页面数据源就是 `extension.list`）；
- `ExtensionInfo.tools` —— 该字段来自 package.json 的 `pi.tools` 声明；仓内 21 个 builtin
  **全部未声明**（实测 `python3` 遍历 `extensions/*/*/package.json` 的 `pi.tools` 恒空），
  所以恒 `undefined`，**不能**用来证明工具注册。

### 判据三：禁用 / 卸载边界

```bash
# feature 可禁：写 disabled-packages.json 的 npm:<name>（经 extension.toggle）
# infrastructure 禁：应得 ExtensionInstallError code=infrastructure_cannot_disable
node scripts/vp.mjs ... # 或直接 protocol.call('extension.toggle', { name: '@zhushanwen/pi-pending-notifications', enabled: false })
```

- 断言：reply 为 error envelope 且 `code=infrastructure_cannot_disable`
  （出处 `packages/runtime/src/services/extension-service.ts` 的 `toggleExtension`）；
- `extension.uninstall` 对任一 builtin → `builtin_cannot_uninstall`（同文件）。
- 文件侧证据：`<dataDir>/agent/disabled-packages.json`（taiji 自有文件，
  出处 `packages/runtime/src/infra/pi/pi-extension-settings.ts`，与 pi 的 `settings.json`
  分离）。

---

## 断言（期望终态 / 失败信号）

| # | 通道 | 断言 | 失败信号 |
|---|------|------|----------|
| 1 | C | `resolved N extensions from M sources` 出现，N ≥ 8 | 无该行 = resolver 未跑 / runtime 未起 |
| 2 | C | `run/pi-spawn-markers.json` 非空且含目标包目录 | 空数组 = 本次 spawn 没有 staged 扩展（装配错） |
| 3 | B | `session.getCommands` 含目标扩展命令，`sourceInfo.path` 指向该包 | 命令缺失 = 该扩展 load 失败（看 4） |
| 4 | C | `<dataDir>/agent/logs/<extName>-<date>.log` 存在且非空 | 存在但为空 = 该扩展没跑到任何 INFO 日志（可能是 feature 未触发，不是故障） |
| 5 | C | 禁用 feature 后重启实例，`pi-spawn-markers.json` 里该包消失、`session.getCommands` 命令消失 | 仍出现 = disabled key 命名空间不匹配（`npm:` vs `discovery:`） |
| 6 | B | 禁 infrastructure 的 reply 带 `infrastructure_cannot_disable` | 静默成功 = 强制加载护栏失效（严重） |

> 1/2/4/5 是 C，3/6 是 B。**禁止只跑 1 就宣布「扩展装载正常」**——这是本 capability
> 最重要的一条纪律。

---

## 证据（A/B/C 各抓什么）

- **A**：扩展页截图（`extension-group-builtin` 卡头计数徽标）+ **一条行为证据**截图
  （命令面板里的 `/permission`、或 FormOverlay 出现）。A 单独不作为装载证明。
- **B**：`extension.list` reply（只留 `name/enabled/layer/tier/version`）；
  `session.getCommands` reply（只留 `name/source/sourceInfo.path`）。
- **C**：
  - `logs/runtime-<date>.log` 的 `resolved N extensions from M sources` 原文行；
  - `run/pi-spawn-markers.json` 全文；
  - `agent/logs/` 目录清单（`ls -la`）+ 目标扩展日志头 20 行；
  - `agent/disabled-packages.json` 前后对照（禁用场景）。

---

## 证不了

- **N 与「实际 load 成功数」的差值**：pi 的 loader 对单个扩展求值失败只产生诊断/警告，
  没有「成功装载计数」暴露到 runtime 协议（`grep -rn "loaded extension" node_modules/@earendil-works/pi-coding-agent/dist`
  零命中）。→ **需补**：pi 侧是否有 `resourceLoader.getExtensions().extensions.length`
  可经 RPC 暴露（当前无）。
- **没有注册命令、也不写日志的扩展是否真的 load 成功**（如 `pi-msg-id-mapper`、
  `pi-provider-live-sync`）：只能靠行为反证（改写 msg id / 模型列表实时同步），
  当前无一键探针 → 记 `weak-anchor`。
- **`pi.tools` 声明的工具清单**：builtin 全部未声明，`ExtensionInfo.tools` 恒空（见上）。
- **pi 版本漂移导致的静默不兼容**：归 `node scripts/check-pi-semantics.mjs`（C-proc-08 门禁），
  不属本层。

---

## Gotchas

- **`--no-extensions` 是硬事实**：`<dataDir>/agent/extensions/` 下的文件（`seed-faux.mjs`
  会把 `faux-llm-ext.ts` 拷到这里）**不会**被 pi 自动发现；faux 能工作是因为
  `TAIJI_EXTENSION_PATHS=<repo>/e2e/fixtures/faux-provider-ext` 走进了 `user` 源，
  再由 runtime 拼成 `--extension`。`seed-faux.mjs` 里「pi 孙进程自动发现装载用」的注释
  是**过时/错误**的（孙进程另有窄白名单，见 `capabilities/env.md` 与报告）。
- 扩展开关**不影响已存在的 session**（pi 进程已起）；验禁用必须新建 session 或重启实例。
- dev 下 builtin 扩展的路径是**源码目录** `extensions/<group>/<pkg>`（resolver 的 dev 分支），
  打包后是 `Resources/extensions/@zhushanwen/<pkg>`。断言路径时两种形态都要认
  （`pi-spawn-markers.json` 的登记规则见 `spawn-markers.ts` 的「三根」注释）。
- `resolved N` 的 N 会随装配变化（多一个 user 源就 +1）。**不要把它写成等值断言**，
  只做下限（≥8）。
- doctor 的「N ≥ 8」历史上是从高频必装包的经验值来的；现在 21 个 builtin 里
  8 个 infrastructure + 13 个 feature（见 `mandatory-extensions.json` 的 tier 字段）
  ——**以文件为准**。
- `TAIJI_AGENT_DEBUG=1` 才是 DEBUG 全量；默认只有 `TAIJI_AGENT_EXT_LOG=1` 的 INFO 档。
  找不到某扩展的 debug 行是正常的。
