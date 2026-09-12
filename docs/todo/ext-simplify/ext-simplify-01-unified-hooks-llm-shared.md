# ext-simplify-01：删除 unified-hooks 废弃整包 + llm-shared 死导出清理

> **一句话结论**：删除 `extensions/universal/unified-hooks/` 整包及其全部登记（全仓零 import、能力已由 base-tool-enhance 逐条承接、本机双装危害已实测发生），llm-shared 仅移除 `MigrationResult` 死导出（迁移函数按日落条款保留）——单 commit 原子落地，无行为变更。

## 开篇（SCQA）

- **S（情境）**：本仓 `extensions/` 维护 21 个活跃 `@zhushanwen/pi-*` extension 包（taiji 5 + universal 16）+ 4 个共享库，另有一个自 0.2.7 起标记 deprecated 的废弃包 unified-hooks，源码保留在 `extensions/universal/unified-hooks/`（653 行 ts：src 351 + 测试 302，本次核验于 HEAD 373b96451）。
- **C（冲突）**：废弃包滞留构建面持续缴税——pi 0.84.4 anchor 同步（commit bcfd647b3）与 junit 基建（commit ce0aea2ac）两次全仓动作都被迫携带它；同时本机 `~/.pi/agent/settings.json:24`（unified-hooks）与 `:37`（base-tool-enhance，下称 bte）**同时启用**，README 警告的 bash 双重拦截已实际发生。
- **Q（问题）**：如何让 unified-hooks 从仓库登记面与本机安装面彻底退役、llm-shared 收敛死导出，同时不破坏 npm 已发布物、历史 session entry 不断链承诺、以及 permission 的迁移日落窗口？
- **A（答案）**：整包 `git rm` + 5 处登记单 commit 原子清理（第 5 处 = `.changeset/config.json` ignore 条目，第 1 轮审查补登）+ docs 活文档悬空引用同批清扫 + 本机 `pi uninstall`；llm-shared 只删 index 出口面的 `type MigrationResult` re-export，`migrateLegacyConfig` 函数保留至 permission v2.0.0 日落条款到期。

## 1. 背景：被设计的系统是什么

**本章结论**：本设计作用于 extension 包集合与它的四层登记链路，属于 2026-09-11 过度设计审计（over-engineering audit，25 包全量四问扫描）候选 1 的落实设计；该审计已由用户拍板全部执行，本文是 16 份按包拆分的设计文档之一（索引见 `docs/design/ext-simplify-index.md` #01）。

**pi extension 体系**：pi coding agent 运行时按用户 `settings.json` 的 `packages` 数组加载 npm 包形态的 extension。本仓开发的 extension 包分两组：`extensions/taiji/`（xyz-agent 集成包，随桌面应用打包）与 `extensions/universal/`（独立通用包，独立 pi 用户可单独安装），另有 `extensions/shared/` 共享库。unified-hooks 属 universal 组，曾经提供三个 hook（test-timeout-guard / network-timeout-guard / tool-error-handler），自 0.2.7 起被 bte 整包取代——`package.json:5` 声明 `"deprecated": "Superseded by @zhushanwen/pi-base-tool-enhance — install that instead; test-command guarding, tool-error audit and configurable timeouts are all covered."`，npm latest 0.2.9 带同款 deprecated 标记。

**登记链路**（一个包在仓库内被「登记」的全部位置，本设计的核心改动面）：

| 登记处 | unified-hooks 现状（核验） | 守卫 |
|---|---|---|
| `extension-dependencies.json` :72-81 | 条目含 dependsOn（reason 引用已迁走的文件，见 §3.4-E2） | `scripts/check-extension-dependencies.mjs` 双向校验：正向条目→磁盘 package.json、反向磁盘包→条目，pre-commit 按路径触发（`.githooks/install-hooks.sh:428-441`，正则含 `^extensions/` 与 `^extension-dependencies\.json$`）+ CI（`scripts/preflight-check.sh:312`） |
| `pnpm-lock.yaml` :697 | `extensions/universal/unified-hooks:` workspace 条目（deps：pi-coding-agent 0.84.4 + extension-logger workspace:*） | `pnpm install` 一致性 |
| `.changeset/config.json` ignore 数组末项 | `"@zhushanwen/pi-unified-hooks"`（u4/D6 落地，见 `docs/design/npm-publish-surface-guard.md` D6；本次核验实读确认）——第 1 轮影响面审查补登的第 5 处登记 | changesets 发布管线消费：`scripts/apply-version.sh:156,170` 与 `scripts/check-version-changes.sh:113,133` 读 ignore 构建排除集合（仅集合成员判断，对条目增删不报错）；changesets version/status 自身解析 config |
| `AGENTS.md` :37 | 「已废弃包」整段列举 | 人工维护 |
| 本机 `~/.pi/agent/settings.json` :24 | `npm:@zhushanwen/pi-unified-hooks` 装载项（与 :37 的 bte 双装） | `pi uninstall` |

**能力承接现状**（删除的安全前提，全部实读核验）：bte 已逐条承接 unified-hooks 全部三能力，迁移注释可追溯——

- test-timeout-guard → bte force-test 白名单自动后台（`extensions/universal/base-tool-enhance/src/force-patterns.ts:5,28`：「force-test：逐条迁自 unified-hooks test-timeout-guard.ts」）；
- tool-error-handler → bte tool_error 审计（`src/tool-error-audit.ts:2`：「自 unified-hooks tool-error-handler 等价迁移（设计文档 D11 落点）」）；
- network-timeout-guard → 正则不迁入，挂死保护由显式 timeout + bte 可配置前台默认超时弱承接（`src/bash-tool.ts:178` D13 注释）；
- 关键协议承诺：历史 session entry 不断链——bte `tool-error-audit.ts:76` 的 `pi.appendEntry("unified-hooks:tool-error", entry)` **保持原 customType 字符串**，这是生产代码字符串（非注释），删除 unified-hooks 包不影响它。

**llm-shared**（`extensions/shared/llm-shared/`，@zhushanwen/pi-llm-shared v0.6.0）：被 permission / rename-session / smart-context / bte 四包依赖的共享库（config 读写 / callLLM / resolveModel / migrateLegacyConfig）。审计认定整体健康（config.ts 缓存原子写、callLLM 归一化契约、resolveModel ref 解析均列入「已核实非过度」），本设计只动一个死导出。

### 设计目标（从使用者体验倒推）

1. **本机 pi 用户**：bash 工具不再被废弃包与 bte 双重拦截；session JSONL 不再写入无人消费的 `unified-hooks:loaded` entry。
2. **仓库维护者**：extensions 构建面（typecheck/lint/test、anchor 同步、junit 基建、守卫校验）不再为废弃包缴税；`rg unified-hooks` 在登记与配置面零命中。
3. **npm 生态用户**：已安装 unified-hooks 的独立用户有明确出路（npm deprecated 标记 + 指引不变），历史 session 的 `unified-hooks:tool-error` entry 仍可被 session-reader 泛化渲染读取（不断链）。
4. **llm-shared 消费者**：公共出口面不含零引用导出，permission 的旧配置迁移窗口（v2.0.0 日落条款）不受影响。

**In-scope**：删除 unified-hooks 整包 + 5 处登记清理 + 本机卸载；llm-shared `MigrationResult` 死导出移除；删包引发的悬空引用清扫（代码注释 §3.4-E5 + docs 活文档 §3.4-E8，第 1 轮审查扩面）。
**Out-of-scope**：llm-shared 其余审计发现（见附录 B 各自裁决，均不动作）；migrate.ts + permission 调用点整链删除（等 v2.0.0 日落）；npm registry 侧任何操作（不 unpublish）；bte / subagent-workflow 等包内历史出处注释清理（保留，见附录 A 白名单）。

## 2. 现状：使用者眼里是什么样的

**本章结论**：废弃包在三个层面同时收税——本机用户层（双装双拦截已实测）、维护者层（构建面与守卫持续校验、登记已漂移）、代码层（为不存在的失败模式建的上报机制 + barrel 死导出）。

### 2.1 本机用户的真实样子（双装已发生）

`~/.pi/agent/settings.json` 的 packages 数组（实测行号）：

```
24:    "npm:@zhushanwen/pi-unified-hooks",      ← 废弃包仍装载
...
37:    "npm:@zhushanwen/pi-base-tool-enhance",   ← 承接包同装
```

此时每次 bash 工具调用同时经过 bte 的同名 override 与 unified-hooks 的 test/network 两个 timeout-guard 拦截；每次 session_start 额外写入一条 `unified-hooks:loaded` customEntry。unified-hooks README（`extensions/universal/unified-hooks/README.md` 第 3-13 行）明确警告：「两者同时安装会对 bash 产生双重拦截，务必先卸载本包」——警告描述的危害在本机已是事实，而非假设。

`unified-hooks:loaded` entry 全仓**无读取方**：唯一潜在消费者 session-reader 的 `src/core/render.ts:528` 只对 `[custom:...]` 做泛化渲染，不解析该类型。写入侧见 §2.4。

### 2.2 维护者的真实样子（构建面缴税 + 登记漂移）

- **全仓动作被迫携带**：git 历史实证两次——bcfd647b3（pi 0.84.4 anchor 同步，x21 包 peerDep）与 ce0aea2ac（34 包 junit reporter 基建）均触碰 unified-hooks 的 package.json / vitest.config.ts / CHANGELOG。
- **守卫持续校验**：`check-extension-dependencies.mjs` 的双向校验每次都覆盖该条目；`extensions:typecheck` / `lint` / `test` 三连持续编译执行 653 行废弃代码。
- **登记已漂移**：`extension-dependencies.json:79` 的 dependsOn reason 写「hooks/subagent-list-injector.ts top-level import」，但该文件早已迁往 subagent-workflow（`extensions/universal/subagent-workflow/src/injectors/subagent-list-injector.ts:2` 自述「迁移自 unified-hooks」），磁盘上 `src/hooks/` 只剩三个 hook 文件。守卫只校验 name/directory/依赖可解析性，不校验 reason 内路径——漂移静默存活。
- **「留源码便于热修」的赌注已输**：0.2.7（deprecated 起点）→ 0.2.9（npm latest）之间无任何功能修复，全部三能力由 bte 逐条承接并继续演进（force-patterns 锚定语义翻转、D13 timeout 忽略等）。废弃包源码已无热修场景。

### 2.3 代码层的两处残留

- **session_start 上报机制**（`unified-hooks/src/index.ts:29-70`）：为「hook setup 可能 throw」建的完备性机器——try/catch 注册 + enabled/disabled 统计 + `appendEntry("unified-hooks:loaded")` + disabled 才 notify，约 40 行占包内 src 的 11%。审计四问：三个 setup 各只是一次 `pi.on` 注册，throw 概率趋零，全生命周期无一次 disabled 发生；防护对象不存在（审计发现 3，随整包删除消解，无需单独处理）。
- **MigrationResult 死导出**（`extensions/shared/llm-shared/src/index.ts:8`）：`export { migrateLegacyConfig, type MigrationResult }` 中的类型 re-export。全仓 `rg MigrationResult` 仅 3 处命中——migrate.ts:22（定义）、:34（返回类型）、index.ts:8（re-export 本身），**零外部消费**。唯一生产调用方 permission（`src/index.ts:104`，`oncePerProcess` 包裹）整体忽略返回值。该调用点带日落注释（:102 `[MIGRATION] Added in v1.0.0. Remove after v2.0.0`），permission 现版本 1.4.2、v2 未发布——**迁移窗口合法开放中**，故只删出口面的死导出、函数链保留（决策依据见 §3.3-D1 注）。

### 2.4 根因 + 数据流

**根因**：unified-hooks 的滞留不是技术依赖（全仓 `rg "pi-unified-hooks|unified-hooks"` 命中全部为注释/文档/登记，**零 import**——审计与本次起草双重复核），而是一个未兑现的运营赌注（「废弃包留源码便于热修」）叠加「删除需要动 5 处登记 + docs 悬空引用清扫 + 本机卸载」的仪式成本拖延。MigrationResult 则是 barrel 出口面「导出即公共 API」习惯在零消费方核查缺位下的自然沉积。

**pi 加载面数据流（删除前 → 删除后）**：

```
删除前（现状）：
  ~/.pi/agent/settings.json:24 → pi 加载 unified-hooks
    ├─ session_start → appendEntry("unified-hooks:loaded")   【无读取方，纯噪音】
    ├─ tool_call 拦截 ×2（test/network timeout-guard）        【与 bte override 双重拦截】
    └─ tool_execution_end → appendEntry("unified-hooks:tool-error")
         └─ session-reader src/core/render.ts:528 泛化渲染 [custom:...]  【历史 entry 可读】

删除后（终态）：
  settings.json（经 pi uninstall）→ unified-hooks 不再加载
    ├─ unified-hooks:loaded 写入消失                            【噪音消除】
    ├─ bash 拦截只剩 bte 单通道                                  【双拦截消除】
    └─ "unified-hooks:tool-error" 写入由 bte tool-error-audit.ts:76 继续
         （同字符串协议，新 entry 不断链；历史 entry 仍可泛化渲染）【不变】
```

## 3. 解决方案

**本章结论**：整包删除 + 登记链单 commit 原子清理（D1/D2 两个决策），加 7 项无取舍执行项；llm-shared 只删一个 re-export。

### 3.1 终态（使用者与维护者视角）

**本机 pi 用户**：`pi uninstall npm:@zhushanwen/pi-unified-hooks` 后，bash 工具仅经 bte 单通道（前台委托 pi 官方工厂 + 后台模式 + tool_error 审计），行为与 bte 设计文档（`docs/design/base-tool-enhance.md`）一致；session JSONL 不再新增 `unified-hooks:loaded` entry，历史 entry 仍可被 session-reader 打开查看。

**失败路径与恢复**：若卸载后 agent 报 `Cannot find module @zhushanwen/pi-unified-hooks`（理论上不应发生——全仓零 import；仅当用户自定义脚本残留引用时）——👉 `pi install npm:@zhushanwen/pi-base-tool-enhance` 并检查 `~/.pi/agent/settings.json` 的 packages 数组；若需找回旧包源码，`git log --follow -- extensions/universal/unified-hooks/` 定位删除 commit，`git show <commit>^` 可完整取回（git 历史即归档）。

**维护者**：`extensions/universal/` 剩 16 个活跃包；`rg "unified-hooks"` 在登记与配置面（extension-dependencies.json / pnpm-lock.yaml / `.changeset/config.json`）零命中，代码注释面仅剩附录 A 白名单（历史出处 + 协议字符串），docs 活文档无指向已删目录的悬空路径/链接/行号（E8）；`pnpm install` 与守卫全绿。

### 3.2 决策 D1：删包时机与方式（选定：现在、整包 git rm）

| 方案 | 长期架构合理性 | 短期实现成本 | 风险 | 裁决 |
|---|---|---|---|---|
| A 现在整包 git rm | 概念数 -3（三 hook 机制的旧实现），构建/检索/登记面零残留；git 历史即归档 | 一次 commit + 本机 uninstall（约半小时含验证） | 残留安装用户失去热修通道（见下方代价量化，可接受） | ✅ |
| B 归档目录保留（移 attic/archive） | 同一份知识第二份物化：rg 命中翻倍、归档 package.json 可能被工具误扫、AGENTS.md 仍需维护解释段 | 与 A 相当（git mv + 登记调整） | 缴税面不消失只是换目录；违反「git 历史即归档」的仓库惯例 | ❌ |
| C 只退登记、源码留置 | 与守卫语义直接冲突（反向校验要求磁盘包必须在登记中），须为一个废弃包改守卫 | 表面最小，实际要弱化守卫规则 | pre-commit/CI 永久红，或守卫被弱化（机制性倒退） | ❌ |
| D 延后删除（等版本边界） | 终态与 A 相同，但缴税窗口延长 | 与 A 相同，只是晚付 | 每轮全仓动作继续携带（bcfd647b3 / ce0aea2ac 实证）；本系列后续 15 份设计都会触碰 extensions/ 面，脏基线干扰审计 | ❌ |

- **采用**：本设计实施时立即 `git rm -r extensions/universal/unified-hooks/`（含 src/测试/package.json/README/CHANGELOG/vitest.config.ts/包根 index.ts 共 653+ 行 ts 与配置），不留归档目录、不留「仅源码」形态。
- **被否**：B 归档目录保留——git 历史本身就是完美归档（`git log --follow` 可追溯、`git show` 可取回）；若用它，§2.2 的检索噪音与文档维护税不消失。C 只退登记留源码——守卫反向校验（`check-extension-dependencies.mjs` 检查项 2）要求 `extensions/{taiji,universal}/` 下每个包必须在登记文件中，退登记则守卫红。D 延后——两次缴税 commit 实证热度，越晚删税越多。
- **证据**：全仓零 import（`rg "pi-unified-hooks|unified-hooks" --glob '!extensions/universal/unified-hooks/**' --glob '!node_modules'` 命中全为注释/文档/登记，双重复核）；能力承接注释 `force-patterns.ts:5,28` / `tool-error-audit.ts:2` / `bash-tool.ts:178`；协议不断链承诺 `tool-error-audit.ts:7,76`；npm 侧 0.2.9 deprecated 标记（审计 `npm view` 确认，实施期按 §5 检查点复核）。
- **效果**：§1 目标 1/2/3 全部成立——双拦截消除（目标 1）、构建面零税 + 登记面零命中（目标 2）、npm 生态用户出路不受影响（目标 3，已发布物与 deprecated 指引在 registry 侧独立存在）。

**已接受代价的量化（残留安装用户失去旧包）**：①量级——本机实测 1 台（settings.json:24）；独立 npm 用户数未知但 npm 下载面小（私有 scope 个人包），deprecated 标记在 registry 侧对所有 `npm install` 尝试者可见；②恢复路径——README/npm deprecated 消息均给出指引（uninstall 旧包 + install bte），本机操作见 E7；③重审触发条件——若有用户报告 bte 未承接的场景（目前三能力逐条有承接注释佐证，无已知缺口），经 git 历史找回旧实现评估补齐；④显式判定——可接受：承接是等价迁移（tool-error-audit「逐字段一致」注释）或明确声明放弃（network 正则不迁入，弱承接），无静默丢失。

### 3.3 决策 D2：登记链路清理顺序与原子性（选定：单 commit 原子）

- **采用**：目录删除 + extension-dependencies.json 条目删除 + `.changeset/config.json` ignore 条目删除（连带 `npm-publish-surface-guard.md` 三处现行口径句注记 + 变更历史表回写，见 E2③④）+ AGENTS.md 废弃段删除 + pnpm-lock 重算（`CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install`）+ 悬空注释改写（代码注释 E5 + docs 活文档 E8）+ llm-shared 死导出移除（附 minor changeset 声明，见 E6），**同一 commit** 交付；本机 `pi uninstall` 是仓库外操作，不进 commit，作为验收步骤执行。
- **被否**：
  - **B 分步多 commit**（先删目录后删登记，或反之）——守卫双向校验决定任何中间态必红：先删目录则正向校验失败（条目指向不存在的 package.json），先删登记则反向校验失败（磁盘包不在文件中）。pre-commit 按路径触发（`^extensions/` 即触发），分步的第一个 commit 就会被拦下，只能 `--no-verify` 违规跳过（项目 MANDATORY 禁止）。
  - **C 拆 llm-shared 改动到独立 commit**——技术上可行（llm-shared 与删包无依赖），但 7 行内的 re-export 删除与删包同属本设计的执行面，拆开只增加 commit 噪音与部分应用状态；同 commit 携带不构成耦合。
- **证据**：守卫触发链 `.githooks/install-hooks.sh:428-441`（STAGED_FILES 匹配 `^extensions/|^extension-dependencies\.json$|...` 即跑 `node scripts/check-extension-dependencies.mjs`，失败 exit 1）+ CI 侧 `scripts/preflight-check.sh:312` 同脚本；lock workspace 条目 `pnpm-lock.yaml:697`。
- **效果**：§1 目标 2 成立且可验证——commit 落地后守卫与 `pnpm install` 同时绿，不存在登记与磁盘不一致的窗口。

### 3.4 执行项（无取舍，位置/改动/验证）

| # | 位置 | 改动 | 验证 |
|---|---|---|---|
| E1 | `extensions/universal/unified-hooks/` 整目录 | `git rm -r`（653 行 ts：src 351 + 测试 302；含 package.json / README / CHANGELOG / vitest.config.ts / 包根 index.ts）。git rm 只删 tracked 文件，随后 `rm -rf extensions/universal/unified-hooks` 清 untracked 残留（实测该包 node_modules/ 为 ignored 目录，不清则目录空壳残留、E1 验证失败；守卫 scanPackageDirs 按 package.json 判包，空壳无 package.json 不触发反向校验，但污染 `ls` 与检索面） | `ls extensions/universal/ \| grep unified-hooks` 零输出；`git show --stat` 确认删除清单 |
| E2 | `extension-dependencies.json:72-81` + `.changeset/config.json` ignore 数组 | ① 删除 unified-hooks 条目（含 dependsOn；reason 引用已迁文件 `hooks/subagent-list-injector.ts` 的漂移随之消解——该文件在 subagent-workflow）；② ignore 数组删除 `"@zhushanwen/pi-unified-hooks"` 末项（第 1 轮影响面审查补登的第 5 处登记：残留指向不存在的包，违反目标 2 配置面零命中；发布管线两脚本仅做集合排除，对条目删除零敏感——核实记录见 §3.5 P-changeset）；③ `docs/design/npm-publish-surface-guard.md` §1.1 S / §1.2 全景句 / §1.2 分类表共三处「已 ignore」现行口径句补注记「（2026-09 ext-simplify-01 删包后 ignore 条目已移除；该包删前被 ignore 排除、删后不在磁盘，31 包计数不变）」；④ 同文档变更历史表（§6）补一行本次变更记录——「ext-simplify-01 删包移除 ignore 条目，发布面计数不变」（该 ignore 条目由本文档 u4/D6 登记落地、变更历史表 v7 承载过同量级 ignore 状态演进记录，删除须同批回写保持时间线连续，C-proc-10；设计期不改该文档，实施期随本项执行，第 2 轮影响面审查补）。该文档 D6/S6b/G3 等已落地历史记录不动（变更历史表按 ④ 仅追加新行，既有行不改写） | `rg unified-hooks extension-dependencies.json` 与 `rg "pi-unified-hooks" .changeset/config.json` 各零命中；`node scripts/check-extension-dependencies.mjs` exit 0；`pnpm exec changeset status` exit 0（config 解析合法、无幽灵 ignore） |
| E3 | `AGENTS.md:37` | 删除「已废弃包：unified-hooks …」整段（活跃列举 21 个包的计数不含废弃包，无需改：30 行「21 个」保持）。:33 bte 条目内「承接已废弃 unified-hooks 的能力」为历史出处表述，保留 | 人工 diff：该段消失；`grep -n "已废弃包" AGENTS.md` 零命中 |
| E4 | `pnpm-lock.yaml:697` | 随 E1 后跑 `CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` 重算（workspace 条目消亡，node_modules 软链同步清理） | install exit 0；`grep -n unified pnpm-lock.yaml` 零命中 |
| E5 | `extensions/universal/structured-output/src/text-primitives.ts:43` | 注释改写：**直接删除**「见 extensions/universal/unified-hooks 的 extractErrorText 及其文档」从句（删包后悬空，违反设计文档同步纪律 C-proc-10）。第 1 轮审查 S-2 口径收敛：不采用「指向 git 历史」式改写——任何保留 "unified-hooks" 字样的写法都会命中 §4 场景 1 且不在附录 A 白名单，场景 1 自判失败；两种口径重演见修订记录。从句删除后保留 agent-loop.js createErrorToolResult 事实锚点与「SDK 事件结构无独立 errorMessage 字段」论证（本函数存在依据，不依赖被删从句） | `rg "extensions/universal/unified-hooks" extensions/` 零命中（无指向已删目录的路径引用）；`rg unified-hooks extensions/universal/structured-output/` 零命中（该文件退出场景 1 命中集合） |
| E6 | `extensions/shared/llm-shared/src/index.ts:8` + 新增 `.changeset/<llm-shared>.md` | ① 移除 `type MigrationResult`（保留 `migrateLegacyConfig` 导出；migrate.ts:22 内部定义与 :34 返回类型不动——permission 1.4.2 的 v2.0.0 日落窗口开放中，见 §2.3）；② **发布面显式判定**（第 1 轮影响面审查补）：本改动是 npm 公共出口面收缩，对独立 TS 消费者是编译期 breaking，随下次 llm-shared 发版才对 npm 用户生效。处置 = 实施时同 commit 附 **minor changeset**（0.6.0 → 0.7.0），仓库 0.x 阶段惯例 minor 即 breaking、同型先例 llm-shared 0.5.0（`CHANGELOG.md` Minor Changes：「remove dead package-root barrels and llm-shared dead API surface」——`recoverable` 字段移除 + `extractText` 停止 re-export，与本改动同型）；changeset body 载明移除内容与「全仓零消费」依据；不单独触发发版（发版时机归 merge 管线）。workspace 四消费方（permission / rename-session / smart-context / bte，package.json 均声明 `workspace:*`）零使用 `MigrationResult`，changesets `updateInternalDependencies: patch` 自动传播 patch 即兼容 | `rg MigrationResult extensions/shared/llm-shared/src/index.ts` 零命中；`pnpm extensions:typecheck` + llm-shared 包测试绿；`.changeset/` 存在含 llm-shared 的 minor changeset 文件 |
| E7 | 本机 `~/.pi/agent/settings.json:24` | `pi uninstall npm:@zhushanwen/pi-unified-hooks`（仓库外操作，验收期执行；README 迁移指引同款命令） | settings.json packages 数组无 unified-hooks、:37 bte 仍在；新 session 起 bash 调用仅 bte 单通道拦截 |
| E8 | `docs/` 活文档悬空引用（第 1 轮影响面审查补登，5 处路径/链接/行号形态） | ① `docs/extensions/logging-conventions.md:158`（日志现行 SSOT）：「unified-hooks 在 `index.ts:43-45` 和 `tool-error-handler.ts:81-83` 的注释中明确记录」改为「原 unified-hooks 包（2026-09 已删除，`git log --follow` 可查）的调试教训」——教训原文已内联为blockquote，仅去掉删后永不可对照的行号引用；:14 历史出处表述与 :162 教训句保留。② `docs/design/base-tool-enhance.md:8`：相对链接 `[unified-hooks](../../../extensions/universal/unified-hooks/)` 改纯文字「unified-hooks（已删除，git 历史即归档）」；pending-notifications 链接保留。③ 同文件 :388「关键事实源」清单：unified-hooks 路径条目（`unified-hooks：extensions/universal/unified-hooks/src/hooks/{network,test}-timeout-guard.ts`）整条改写为纯文字 git 锚点「unified-hooks：已删除（2026-09，ext-simplify-01），原 timeout-guard 源码 `git log --follow` 可查」（第 2 轮主审修正原「补注记」口径：追加注记保留路径全串，机器验证必残留命中，见修订记录 MF-E8）。④ `docs/todo/extension-log-cleanup-design.md:142`（P4 tool-error 双写）：P4 节首加状态行「对象包 unified-hooks 已于 2026-09 删除（ext-simplify-01）；专属 entry 写入由 bte 延续（同 customType），本条剩余有效性执行时按 bte 现状重核」，且 :142 原路径行 `extensions/universal/unified-hooks/src/hooks/tool-error-handler.ts`（tool_execution_end isError 分支）同批改写为不含路径全串的 git 锚点引用「原 unified-hooks 包 tool-error-handler.ts（已删除，`git log --follow` 可查）（tool_execution_end isError 分支）」——同 ③，仅加状态行不动路径行会残留机器验证命中。⑤ `docs/architecture/builtin-extension-dev-build-split.md:70`：表格下既有历史注记（已列 evolve-daily 等已删三包）补「unified-hooks 已于 2026-09 删除（ext-simplify-01）」。docs 面其余 unified-hooks 字样命中均为历史出处/协议/验收记录（import-session / pi-assumption-remediation / ext-simplify-13 同系列协同登记 / archive 归档等），按附录 A 同一逻辑豁免不改 | 路径形态机器验证：`rg "extensions/universal/unified-hooks" docs/ --glob '!docs/design/ext-simplify-*.md'` 零命中（ext-simplify 系列对自身执行对象的登记引用豁免；现状该命令命中恰 3 处——bte.md:8 链接 / bte.md:388 路径条目 / todo:142 路径行——经 ②③④ 改写全部消解，第 2 轮修订实跑核对，处置动作与断言自洽）；:158 行号锚点与 :70 表格注记机器正则不覆盖，两处逐一人工 diff 核对，②③④ 改写后的路径形态残留全部归机器验证兜底 |

### 3.5 探针清单

| ID | 验证的行为 | 探针 | 状态 | 失败时的降级路径 |
|---|---|---|---|---|
| P-dual | 本机双装（双拦截前提成立） | `grep -n "pi-unified-hooks\|pi-base-tool-enhance" ~/.pi/agent/settings.json` → :24 与 :37 双命中 | ✅ 已测（本次起草实跑） | — |
| P-zeroimport | 全仓零生产 import | `rg "pi-unified-hooks" --glob '!**/*.md' --glob '!node_modules'` → 全部命中为注释/登记/字符串，无 import 语句 | ✅ 已测（审计 + 本次起草双重复核） | 若出现 import → 该引用方先迁移到 bte 等价能力再删包 |
| P-protocol | `unified-hooks:tool-error` customType 由 bte 持续写入（不断链） | 实读 `bte/src/tool-error-audit.ts:7,76`（注释承诺 + 生产 appendEntry 字符串） | ✅ 已测（实读） | 若字符串漂移 → 删包前先对齐 bte 侧字符串 |
| P-npm | npm 已发布物不受删包影响、deprecated 指引在 | `npm view @zhushanwen/pi-unified-hooks deprecated version` → 0.2.9 + deprecated 消息 | ⛔ 实施期复核（审计 20260911 已验，registry 侧独立于本仓） | 失败（标记丢失）→ 与删包无关，另案处理，不阻塞 |
| P-single | 卸载后 bash 仅 bte 单通道 | 本机 `pi uninstall` 后起 `pi --mode rpc` 发一次 bash prompt，观察拦截行为单通道 | ⛔ 实施期验收（§4 场景 4） | 若仍双拦截 → 检查 settings.json 残留与 `~/.pi/agent/npm/` 安装目录 |
| P-changeset | changeset ignore 条目存在性与删除后 config 合法（第 1 轮审查补） | 删除前：实读 `.changeset/config.json` ignore 数组含 `"@zhushanwen/pi-unified-hooks"`；删除后：`pnpm exec changeset status` exit 0（config 解析合法、无幽灵 ignore） | 存在性 ✅ 已测（本次修订实读）；删除后合法性 ⛔ 实施期（E2 同 commit 验证） | 失败 → 按报错修 config 形态（不预期：ignore 是可选数组，删项合法；`apply-version.sh:170` / `check-version-changes.sh:133` 对 ignore 仅做集合排除、对条目删除零敏感，本次修订已实读两脚本核实）。审查原建议「探针核实 changesets 对 ignore 指向不存在包的行为」经重演错位：本设计删除该条目而非保留，「ignore 指向不存在包」状态在删除后不存在，探针对象改为删除后 config 合法性 |

## 4. 验收（真实场景，非单测非 mock）

**本章结论**：改动规模 = 中等（结构性删除 653 行 + 登记链 5 处 + 代码注释与 docs 活文档悬空引用清扫共 6 处 + 1 处死导出，但零行为变更——删除的是零 import 的废弃代码）；用 5 个真实场景验证，每个回溯 §1 目标。

| 场景 | 回溯 §1 目标 | 真实流程/数据/路径 | 通过标准 |
|---|---|---|---|
| 1. 登记面退役 | 目标 2（维护者） | 实施后在仓库根跑：`rg -l "unified-hooks" --glob '!**/*.md' --glob '!docs/**'`；再跑 `rg "unified-hooks" extension-dependencies.json pnpm-lock.yaml`；补跑 `rg "pi-unified-hooks" .changeset/config.json` | 第一条命令命中集合 ⊆ 附录 A 白名单（11 个非 md 文件：10 个代码/测试/脚本文件 + mandatory-extensions.json 历史描述，全部为出处注释或协议字符串；实施后基数精确为 11：现状 19 命中 − E1 包自身 5 − E2/E4/E5 各消 1，第 2 轮修订模拟核验；后续批次 95a40bc81——14 号 stage-6 sync——将 extension-logger createLogger JSDoc 举例由 "unified-hooks" 改为 "smart-context"，该文件退出命中集，现基数 10，2026-09-12 实跑复核）。**注意：该命令默认跳过 hidden 目录（`.changeset/` 以点开头），config.json 从不在其命中面——config.json 的零命中守门由第三条显式路径命令承担**（显式路径下 rg 的 hidden 跳过规则失效，实测有效；不加 `--hidden`，实测引入 `.xyz-harness/` 探针产物与 `.agents/skills/dev-link/` 等 5 个新命中、白名单需无谓扩张，否决理由见修订记录）；第二、三条零命中（第三条即 config.json 守门，勿因第一条命令看似已覆盖而省略） |
| 2. 构建面健康 | 目标 2 | `CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` → `node scripts/check-extension-dependencies.mjs` → `pnpm extensions:typecheck && pnpm extensions:lint && pnpm extensions:test` → `pnpm exec changeset status` | 四者 exit 0；`grep unified pnpm-lock.yaml` 零命中；test 三连收「测试面退役」证据（junit reporter 包集合计数 −1：v2 修订时点实测 38→37，以实施时点实数为准；unified-hooks 的 302 行测试退出执行面——第 1 轮审查 S-3 补，§2.2 已把三连列为缴税面，验收须对称收证） |
| 3. llm-shared 收敛且迁移窗口不动 | 目标 4 | `rg "MigrationResult" extensions/` → 仅 migrate.ts:22/:34 两处；跑 llm-shared 包测试（`cd extensions/shared/llm-shared && pnpm vitest run`）；实读 permission/src/index.ts:102-104 日落注释未被触碰；确认 `.changeset/` 存在 llm-shared minor changeset 文件（E6②） | MigrationResult 不再出现在 index.ts 出口面；测试绿；permission 迁移调用点原样；出口面收缩已按 0.x 惯例附 minor changeset，下次发版不致以 patch 静默带出 breaking |
| 4. 本机单通道 | 目标 1（用户） | 本机执行 `pi uninstall npm:@zhushanwen/pi-unified-hooks`；`grep -n "unified" ~/.pi/agent/settings.json` 零命中且 bte 行仍在；按项目惯例起本地 pi CLI（`pi --mode rpc --session-dir <tmp> --model xiaomi-token-plan-cn/mimo-v2.5-pro --approve --extension <bte 本地路径>` + stdin JSONL 发含 bash 调用的 prompt） | bash 调用正常执行、仅 bte 行为可见（如 force-test 自动后台）；session JSONL 无新增 `unified-hooks:loaded` entry |
| 5. 历史不断链 | 目标 3（npm 生态/历史数据） | `npm view @zhushanwen/pi-unified-hooks deprecated` 仍有标记；用 pi 打开一个含历史 `unified-hooks:tool-error` entry 的旧 session（session-reader 或 TUI）。**验收数据可得性（第 1 轮审查 S-1 补，本次修订实测）**：该 entry 仅在 bash 工具报错时写入、删包后无法用原包再造，存在性是偶然事实——已实测确认存在：`rg -l '"unified-hooks:tool-error"' ~/.pi/agent/sessions/` 命中 672 个 session JSONL（同法 `unified-hooks:loaded` 1523 个），实施期按此命令先检索再选取；兜底再造路径（仅当检索为零时）：`pi install` bte 后触发一次 bash 报错，bte `tool-error-audit.ts:76` 以同 customType 写入新 entry，可验证同一渲染链路（但「历史 entry」口径降级为「新 entry」，须在验收记录注明） | deprecated 指引在（已发布物未受影响）；旧 entry 仍被泛化渲染为 `[custom:unified-hooks:tool-error]` 可读 |

**关键负面行为反向验证**（已并入场景 1/4）：不该发生的不再发生——`unified-hooks:loaded` 新写入为零（场景 4）、登记面命中为零（场景 1）。

## 5. 下一层拆分

**本章结论**：单个下一层实施单元（一次原子 commit + 一次本机操作），按有序序列执行；无并行拆分面。

### 5.1 实施序列（单 commit 内的顺序）

| 步 | 动作 | 说明 |
|---|---|---|
| 1 | `git rm -r extensions/universal/unified-hooks/` + `rm -rf` 清 untracked node_modules 残留 | E1；目录删除触发 pre-commit 守卫路径正则 |
| 2 | 删 `extension-dependencies.json` unified-hooks 条目 + 删 `.changeset/config.json` ignore 末项 + `npm-publish-surface-guard.md` 三处现行口径句注记 + 变更历史表回写 | E2；与步骤 1 同 commit 才能过守卫双向校验（D2）；changeset ignore 与包删除同 commit，不存在「ignore 指向已删包」的中间态被发布管线消费 |
| 3 | 删 `AGENTS.md` 废弃段落 | E3 |
| 4 | 改写 `structured-output/src/text-primitives.ts:43` 注释（直接删除从句） | E5；悬空路径引用清扫（C-proc-10 同批纪律） |
| 5 | docs 活文档悬空引用清扫（logging-conventions:158 / bte.md:8+:388 / todo:142 / builtin-split:70） | E8；与 E5 同批（C-proc-10：docs 与测试注释中的悬空引用同批清扫） |
| 6 | `extensions/shared/llm-shared/src/index.ts:8` 移除 `type MigrationResult` + 写 `.changeset/<llm-shared>.md` minor changeset | E6；changeset 文件与代码改动同 commit，防下次发版以 patch 静默带出 breaking |
| 7 | `CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` | E4；重算 lock + 清 node_modules 软链，产物随 commit |
| 8 | 本地验证（守卫 + extensions 三连 + changeset status）→ commit → 本机 `pi uninstall` | 验收场景 1-3 于 commit 前，场景 4-5 于 commit 后 |

**拆分 justification**：不拆多个单元的理由——守卫双向校验把「目录 × 登记」锁成不可分的原子（D2 被否 B 的证据）；llm-shared 1 行改动与注释改写同 commit 携带不构成耦合（D2 被否 C）；本机卸载是仓库外操作天然独立成验收步骤。

### 5.2 待验证检查点（设计阶段无法确定，诚实标注）

- `pi uninstall` 的确切子命令形态以本机 pi 0.84.4 实装为准（README 写 `pi uninstall npm:@zhushanwen/pi-unified-hooks`；子命令存在性有本仓两处实读佐证：dev-link 脚本 `dev-link-lib.sh` 头注释声明依赖 `pi install` / `pi uninstall` 完成全部卸载操作、`docs/design/file-lock-unification-and-reaper-sink.md:154` 否决的是 `pi extension uninstall` 子命令形态而非顶层 `pi uninstall`——第 2 轮修订补，README 形态大概率直接可用）；若该子命令不存在（概率低），等价手工操作 = 编辑 settings.json 删 :24 行 + 清 `~/.pi/agent/npm/node_modules/@zhushanwen/pi-unified-hooks`。
- pnpm 重算后 node_modules 内 workspace 软链的残留形态（是否留死链）——install 自清理即可，无需手工干预；若 `pnpm install` 报 store 布局翻转，按 AGENTS.md 规则 20 的恢复命令处理（与本设计无因果）。

## 附录 A：历史命中白名单（删包后允许保留的 unified-hooks 引用）

| 文件:行 | 形态 | 保留理由 |
|---|---|---|
| `base-tool-enhance/src/tool-error-audit.ts:76` | **生产代码**：`pi.appendEntry("unified-hooks:tool-error", ...)` | 协议字符串 SSOT——历史 entry 不断链承诺（README 承接表 + :7 注释） |
| 同文件 :2,:7,:20；`force-patterns.ts:5,28`；`bash-tool.ts:178`；`index.ts:51` | 注释 | bte 能力出处与迁移语义说明（解释代码为什么长这样） |
| `base-tool-enhance/src/__tests__/{force-patterns,tool-error-audit}.test.ts` | 测试注释/断言 | 断言 customType 协议字符串，与生产承诺绑定 |
| `subagent-workflow/src/index.ts:166`、`src/injectors/subagent-list-injector.ts:2` | 注释 | 文件归位出处（「迁移自 unified-hooks」） |
| `extensions/shared/extension-logger/src/index.ts:226` | JSDoc 举例 | 参数用法示例（名字举例，非路径引用，不悬空；2026-09-12 时点行号，14 号流水线文件头部 +4 行注释致原 :222 漂移）。**已于 95a40bc81（14 号 stage-6 sync）将举例改为 "smart-context"，本行退出场景 1 命中集，条目保留备溯** |
| `packages/runtime/scripts/record-get-entries-fixtures.mjs:30` | 注释 | 历史事故说明（录制混入 `unified-hooks:loaded` 的教训） |
| `AGENTS.md:33`（bte 条目内）、`packages/shared/src/mandatory-extensions.json:18`（bte 描述 "(migrated from unified-hooks)"） | 文档/登记描述 | 历史出处表述，非包登记本体 |
| 各包 CHANGELOG.md、docs/ 已归档与纯历史记录（archive/、impl-plan、验收/探针历史记录、同系列 ext-simplify-\* 设计对自身执行对象的登记） | 历史记录 | 变更史不改写。**docs/ 不整体豁免**（第 1 轮审查修正原失实归类）：现行 SSOT / 现行设计文档 / todo 待执行设计 / 架构文档中的路径、链接、行号引用是活引用，删包后悬空，由 E8 逐处清扫；纯字样形态（历史出处、协议、教训叙述）豁免 |
| 仓库根 `README.md:138` / `README_EN.md:138` | 用户面活文档 | 「pi-unified-hooks 已废弃（npm 标记 deprecated），其能力由 pi-base-tool-enhance 取代」是对独立 npm 用户的迁移指引，删源码后该事实仍成立，保留 |

白名单是「允许保留的引用」；`.changeset/config.json` 的 ignore 条目**不在豁免之列**——它是指向包本体的登记残留（配置面），处置方式是删除（E2）而非豁免，区别于上表全部条目（出处注释/协议字符串/历史记录）。

## 附录 B：llm-shared 其余审计发现的处置（out-of-scope 登记）

审计（20260911，unified-hooks + llm-shared 单元四问记录）对 llm-shared 另有 5 项发现，均已各自裁决、不在本设计 scope：`ModelSelector` 单变体判别联合——**保留**（已是用户盘上落盘 config 格式，改格式是 breaking 换零收益）；migrate.ts 多消费者赌注实际 n=1——**保留至 permission v2.0.0**（与本文 E6 同一日落锚点，到期三件套齐删）；call.ts optional peer 声明与顶层静态 import 矛盾——**保留 + 已有注释**（4 个 consumer 全在 pi 进程内，pi 恒提供 pi-ai，契约矛盾不触发）；`clearConfigCache` 测试专用出口——**保留**（收敛收益趋零）；`getCurrentModelId` 单消费者——**保留**（churn > 收益）。smart-context 绕开 callLLM 自建调用封装（界外发现）——**保留**（n=1 不值得合并，出现第 2 个需要 tools 的调用方时再参数化收敛）。

## 附录 C：变更历史

- v1（2026-09-12）：初稿。依据 over-engineering 审计 20260911（候选 1 + llm-shared low 项）起草，全部 file:line 于 HEAD 373b96451 复核。
- v2（2026-09-12）：第 1 轮审查修复（主审 0 must-fix + 3 suggestion / 影响面审 2 must-fix + 1 suggestion，全修）。逐条处置见文末「修订记录」。
- v3（2026-09-12）：第 2 轮聚焦复审修复（主审 1 must-fix + 1 suggestion / 影响面审 1 must-fix + 1 suggestion，全修；含对 v2 一处反例重演段失实的更正）。逐条处置见文末「修订记录」第 2 轮。

## 修订记录

### 第 1 轮（2026-09-12，对照主审 3 suggestion + 影响面审 2 must-fix + 1 suggestion）

**MF-impact-1（changeset ignore 第 5 处登记遗漏，连带击穿场景 1 断言）**
- 修法：登记链路表补第 5 处登记（含守卫列：发布管线两脚本的集合排除消费点）；E2 扩为双登记面（dependencies.json + `.changeset/config.json` ignore 末项删除）+ `npm-publish-surface-guard.md` §1.1/§1.2 三处「已 ignore」现行口径句同批注记（D6/S6b/G3/变更历史为已落地历史记录不动）；场景 1 补 `.changeset/config.json` 零命中断言；探针表加 P-changeset；§5.1 步骤 2 同步。
- 反例重演：（2026-09-12 第 2 轮修订更正，原段论证失实，更正过程见修订记录第 2 轮 MF-scenario1 条目）第 5 处登记违反 §1 目标 2「配置面零命中」→ E2 与包同 commit 删除，由场景 1 第三条显式路径命令 `rg "pi-unified-hooks" .changeset/config.json` 验证零命中（显式路径下 rg 不跳过 hidden 目录，守门有效）；同 commit 删除保证不存在「ignore 指向已删包」中间态被发布管线消费（changesets 仅在 commit 后 release 管线解析 config）。
- 审查修复方向重演（不照单全收项）：原建议「实施前探针核实 changesets 对 ignore 指向不存在包的行为（version/status/publish 是否报错）」——重演后发现探针对象错位：本设计删除该条目而非保留，该状态在删除后不存在；真实消费面已改为实读核实——`apply-version.sh:156,170` 与 `check-version-changes.sh:113,133` 读 ignore 仅构建排除集合（`!ignoreSet.has(name)`），对条目增删零敏感、不报错。以 `pnpm exec changeset status` exit 0 顶替原探针位置，验证删除后 config 合法性（P-changeset ⛔ 实施期）。
- 同模式扫描（纪律 7.2-3）：`npm-publish-surface-guard.md` 的「已 ignore」现行口吻是本遗漏在 docs 面的第二实例，已并入 E2③；其余命中均为历史记录豁免。

**MF-impact-2（附录 A 把 docs/ 整体豁免归类失实，活文档悬空引用清扫缺失）**
- 修法：附录 A 豁免收窄为「已归档与纯历史记录」，docs/ 活引用（路径/链接/行号）摘出由新执行项 E8 逐处清扫；E5 验证面保持 extensions/，docs 面验证归 E8（路径形态机器扫描 + 行号/链接/表格三形态人工 diff，机器正则不覆盖后三形态，诚实声明）。
- 逐处处置与重演（5 处——审查列 4 处 + 自扫补登 1 处）：
  1. `logging-conventions.md:158`（现行 SSOT）：行号引用改 git 历史锚点。重演：教训原文已内联为 blockquote，行号删后读者不再被指向「打开即 404 的源码」，规范论证完整；:14 历史出处与 :162 教训句保留。
  2. `base-tool-enhance.md:8`：相对链接改纯文字。重演：删目录后链接不再 404；「废弃 unified-hooks」事实表述保留。
  3. `base-tool-enhance.md:388`（**审查未列，本次全扫 `rg "extensions/universal/unified-hooks" docs/` 补登**）：「关键事实源」路径条目补已删除注记。重演：事实源清单降为历史指引，不再误导读者去磁盘找文件。
  4. `todo/extension-log-cleanup-design.md:142`（P4）：节首加状态行。重演：执行该 todo 的实施者不会按图索骥找不到 `tool-error-handler.ts`；专属 entry 由 bte 同 customType 延续的事实写明，剩余有效性指向 bte 现状重核。
  5. `builtin-extension-dev-build-split.md:70`：表格下既有历史注记（已列 evolve-daily 等已删三包）补 unified-hooks。重演：沿用该文档自己的「已删包进注记」先例，表格不再被误读为现行列举。
- 豁免面核验：docs/ 其余字样命中（import-session / pi-assumption-remediation / ext-simplify-13 / sidebar-sync / archive / impl-plan / cache-probe 等）逐一核对均为历史出处、协议字符串、已执行验收记录或同系列协同登记，按附录 A 同一逻辑豁免——与 E8 验证命令的 `!docs/design/ext-simplify-*.md` 排除口径互洽。

**S-impact（E6 npm 公共出口面收缩未做发布面显式判定）**
- 修法：E6② 补显式判定——实施时同 commit 附 minor changeset（0.6.0 → 0.7.0），依据仓库 0.x 阶段惯例（minor 即 breaking）与同型先例 llm-shared 0.5.0（`recoverable` 字段移除 + `extractText` 停止 re-export 以 Minor Changes 发版，CHANGELOG 实读确认）；changeset body 载明移除内容与零消费依据；不单独触发发版；四消费方 package.json 均声明 `workspace:*` 且零使用该类型，`updateInternalDependencies: patch` 自动传播即兼容。§5.1 步骤 6、场景 3 通过标准同步。
- 重演（不声明的后果）：E6 合入后若下次发版漏 changeset 或按 patch 走，独立 TS 消费者 import `MigrationResult` 编译期炸且 changelog 零痕迹——判定落文档后该路径被实施序列强制项堵死。

**S-1（场景 5 验收数据可得性未确认）**
- 修法：本次修订实测本机 session 库——`rg -l '"unified-hooks:tool-error"' ~/.pi/agent/sessions/` 命中 672 个 session JSONL（`unified-hooks:loaded` 1523 个），数据大量存在；场景 5 补检索命令、实测结果与兜底再造路径（bte 同 customType 写新 entry，验收记录须注明口径降级）。
- 重演：实施者执行场景 5 前先检索（命令已给出）→ 必得非空集合 → 不再卡在「找不到数据」；再造路径仅作零命中兜底，且其口径限制被显式声明，不会被误当「历史 entry」证据。

**S-2（E5「指向 git 历史」改写 × 场景 1 白名单断言口径不一致）**
- 修法：E5 收敛为「直接删除从句」，不采用 git 历史式改写；E5 验证加 `rg unified-hooks extensions/universal/structured-output/` 零命中。
- 两种口径重演：①选「git 历史式改写」→ text-primitives.ts 改写后仍含 "unified-hooks" 字样 → 场景 1 命中 12 项、该文件 ∉ 白名单 → 断言失败；补救只能扩白名单，代价 = 检索噪音 +1 + 一条需 git 考古才有信息量的引用，否。②选「直接删除从句」→ 该文件 rg 零命中 → 场景 1 命中恰为白名单 11 项，断言通过；从句删除后注释保留 agent-loop.js createErrorToolResult 事实锚点与「SDK 无独立 errorMessage 字段」论证（本函数存在依据，不依赖被删从句），信息无损。选定②；①连同其击穿反例记为被否（git 历史式改写在「需与场景 1 命中集合白名单机制共存」的约束下不成立）。

**S-3（场景 2 缺 `pnpm extensions:test`，测试面退役未收证）**
- 修法：场景 2 命令链补 test 三连与「junit 包集合 34→33」收证说明；§5.1 步骤 8 验证清单同步。
- 重演：删包使 vitest 执行集合少一包（E1 同删 302 行测试），test 三连绿即证明测试面收敛无残留配置（extensions 三脚本均无硬编码包清单，影响面审已核实）——与 §2.2「三连缴税」证据对称闭合。

**顺手修正（主审/影响面审 INFO，机械性，不进 findings 计数）**：session-reader 路径补全 `src/core/` 层级（§2.1 两处 + §2.4 数据流图）；permission 日落注释 :103→:102（§2.3）；场景 3 实读区间同步为 :102-104。

**未修项**：无。

### 第 2 轮（2026-09-12，对照主审 1 must-fix + 1 suggestion + 影响面审 1 must-fix + 1 suggestion）

**MF-E8（主审：E8 ③④ 处置动作 × 自身机器验证「零命中」断言矛盾，按字面实施后验证必红）**
- 修法：修复方向二选一，取 (a)——③④ 与 ①② 同口径，路径全串改写为 git 历史锚点纯文字消解：:388 路径条目整条改写（不再「补注记」）；todo:142 在保留节首状态行的同时，原路径行同批改写为不含全串的 git 锚点引用。E8 验证列同步：补现状 3 处命中清单与「经 ②③④ 改写全部消解」的自洽说明；人工 diff 对象由「四处」更正为两处（:158 行号锚点 + :70 表格注记，机器正则不覆盖；②③④ 改写后路径形态残留全部归机器验证兜底——影响面 INFO-3 的计数笔误随方案 (a) 一并消解）。
- 反例重演：修复前（原③④ 字面动作）→ :388 追加注记后路径全串残留、todo:142 状态行外原路径行原样保留 → 实跑 `rg "extensions/universal/unified-hooks" docs/ --glob '!docs/design/ext-simplify-*.md'` 现状恰 3 处命中（bte.md:8 / bte.md:388 / todo:142），② 消解 :8 后 ③④ 处仍残留 2 处 → 「零命中」断言自判失败，与 MF-impact-1（执行项动作与验证断言不自洽）同构的击穿成立；且 pre-commit 的 `check-doc-symbol-drift.mjs` 为符号级检查、DOC_MODULE_MAP 未登记这三个文档，矛盾不会被守卫暴露、只会在 E8 收尾卡住实施者。修复后（方案 a）→ 3 处全消 → 机器验证零命中成立，且未来 docs/ 新增路径全串命中仍由同一命令兜底。
- 被否谱系：① E8 ③「路径条目补注记」/ ④「节首加状态行（不动路径行）」——击穿反例 = 机器验证残留 2 处全串、零命中断言自判失败（同构于 MF-impact-1 模式）；② 审查替代方案 (b)「保留 ③④ 字面动作（有意保留 todo 证据路径），断言放宽为『命中 ≤2 处且均为带已删除注记的登记残留，逐一人工确认』」——亦否：放宽断言引入需人维护的残留清单与人工瓶颈，放弃机器可验证的零命中兜底；todo 的证据价值经改写后由 git 锚点（`git log --follow`）承载，不依赖磁盘路径残留。选 (a) 与 E8「活引用清扫」自我口径一致。

**S-junit（主审：场景 2 junit 包集合「34→33」数字漂移，收证口径失真）**
- 修法：场景 2 收证改为计数差断言——「junit reporter 包集合计数 −1：v2 修订时点实测 38→37，以实施时点实数为准」，删除固定绝对数「34→33」。
- 重演：实跑 `rg -l "junit" --glob '**/vitest.config.ts'` = 38（apps 1 / extensions 21 / extensions/shared 4 / packages 12），unified-hooks 在内，删包后 37。「34」是 ce0aea2ac（junit 基建落地）时点口径，此后按 AGENTS.md「存量包改动其测试时顺手补」惯例陆续补齐推高——固定绝对数随仓库自然漂移，实施者按 34→33 对数必错乱（怀疑漏删或误判）；计数差断言锚定实施时点实测，差值 −1 才是「测试面退役」的稳定语义。

**MF-scenario1（影响面：场景 1 第一条命令对 config.json 零命中断言永真 + v2 修订记录重演段失实）**
- 修法：① 场景 1 通过标准把 config.json 守门职责显式归**第三条显式路径命令**（显式路径下 rg 的 hidden 跳过规则失效，实测有效），第一条命令补 hidden 盲区说明与「勿省略第三条」提示；② 不加 `--hidden`（实测引入 `.xyz-harness/` 探针产物 ×4 + `.agents/skills/dev-link/dev-link-lib.sh` 等 5 个新命中，白名单需无谓扩张，得不偿失，否决并记录）；③ v2 修订记录 MF-impact-1 反例重演段更正为真实论证链（第 5 处登记违反目标 2 → E2 删除 → 第三条显式路径命令验证零命中）。
- 失实更正（对 v2 重演段）：原段声称「修复前第一条命令命中 12 项（含 config.json）→ 场景 1 自判失败（击穿成立）」——实跑证伪：rg 默认跳过 hidden 目录，`.changeset/config.json` 从不在第一条命令命中面（现状 19 命中实测不含 config.json；v2 修复前若实施同样命不中），「击穿点」从未存在于第一条命令，「修复前必然命中 / 击穿点已消除」的论证随同作废，原文已从修订记录第 1 轮移除、替换为真实论证链。上轮影响面报告 F1 的「场景 1 会命中 config.json」判断与之同源（当时未实测 rg hidden 行为），审查方已在 r2 INFO-1 自行更正，两处一并闭环。教训归档：运行时行为断言（此处 = rg 的 hidden 目录语义）必须实测后才可写入反例重演论证，推断链上的「必然」未经探针不得落文档。
- 重演（新叙述下）：实施后第一条命令命中恰为白名单 11 项（现状 19 − E1 包自身 5 − E2 extension-dependencies.json − E4 pnpm-lock.yaml − E5 text-primitives.ts = 11，本轮模拟核验，逐项对上附录 A）；守门职责显式锚定第三条命令后，若未来有人据「第一条命令看似已覆盖」误删第三条，ignore 残留仍有独立信号——原失实叙述诱导的精简误操作路径被堵死。

**S-history（影响面：npm-publish-surface-guard.md 变更历史表未回写，C-proc-10 联动缺口）**
- 修法：E2 新增子项 ④——实施时同 commit 在该文档变更历史表（§6）追加一行本次变更记录（v7 之后：ext-simplify-01 删包移除 ignore 条目、发布面计数不变），与三处现行口径句注记同批；设计期不改该文档（本设计只登记执行项，实施期执行）。E2③ 尾注与 §3.2 D2、§5.1 步骤 2 同步（原 E2③「变更历史等已落地历史记录不动」与本项直接冲突，已改为「变更历史表按 ④ 仅追加新行，既有行不改写」）。
- 重演：该 ignore 条目由该文档 u4/D6 登记落地、变更历史表 v7（:281）承载过同量级 ignore 状态演进（「u4 将 pi-unified-hooks 加入 changeset ignore 后未被 ignore 的 workspace 包为 28……三处 30→29」）——若只改三处正文句不回写历史表，该文档时间线断在「v7 ignore 落地后口径」，读者沿变更历史链看不到条目已移除（C-proc-10「登记即债务修复即清账」的时间线要求）；回写后 v1→v8 演进连续，三处正文注记（现行口径不误读）与历史表追加（演进可追溯）各司其职。

**顺手修正（影响面 r2 INFO 项，机械性，不进 findings 计数）**：E2③ 注记「包不在 workspace，31 包计数不变」消歧为「该包删前被 ignore 排除、删后不在磁盘，31 包计数不变」（INFO-5 指出的措辞歧义，31 计数不变的结论经审查实读核实成立）；§5.2 补 `pi uninstall` 子命令存在性两处本仓实读佐证（INFO-4，降级路径保留为兜底）。

**未修项**：无。
