# @zhushanwen/pi-permission

Pi permission 扩展 — 四档权限模式（yolo / auto / approve / strict）+ 三层安全管道（AST 结构分析 + 规则匹配 + AI Classifier），为 bash 工具调用提供可配置的安全门。

## 功能

- **四档权限模式**：从「完全放行」到「全部审批」的渐进式安全策略
- **三层管道**（auto 模式）：AST 结构分析 → 规则匹配 → AI 风险分类 + 用户审批竞速
- **内置危险规则**：12 条 builtin-danger 规则（rm -rf、curl|sh、chmod 777 等高危模式）
- **白名单快速放行**：50+9 条安全命令白名单（24 Codex 原始 + 26 扩充 + 9 条件安全）
- **用户自定义规则**：OpenCode wildcard 语法，last-match-wins 语义
- **AI Classifier**：auto 模式下用 LLM 评估未知命令风险（low/medium/high）
- **用户审批 UI**：TUI（自定义 Component）/ RPC（select 对话框）/ headless（fail-closed deny）
- **Reject-with-Reason**：用户拒绝时可输入真实理由（回传 agent 辅助理解）
- **fail-closed**：任何异常路径 → block（绝不静默放行）

## 安装

```bash
# npm 方式（唯一正式方式）
pi install npm:@zhushanwen/pi-permission

# 本地开发（symlink；globalExtDir 平铺布局，目标不带分组层）
ln -s /path/to/taiji/extensions/universal/permission \
      ~/.pi/agent/extensions/permission
```

## 配置

配置文件位置：`<agentDir>/config/permission-ext-config.json`（`<agentDir>` = pi agent 目录，`PI_CODING_AGENT_DIR` 覆盖，默认 `~/.pi/agent`；首次运行自动创建默认配置）。

可通过 `PI_CODING_AGENT_DIR` 环境变量覆盖基础路径。

### 配置结构

```json
{
  "mode": "yolo",
  "enabled": true,
  "classifier": {
    "enabled": true,
    "model": "auto",
    "timeout": 90,
    "autoApproveLowRisk": true,
    "autoDenyHighRisk": true,
    "thinkingLevel": "off"
  },
  "userRules": []
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `mode` | `"yolo"` | 当前权限模式（yolo/auto/approve/strict） |
| `enabled` | `true` | 扩展是否启用（false=完全放行，等同 yolo 但保留配置） |
| `classifier.enabled` | `true` | 是否启用 AI 层（false 时 auto 模式跳过 AI，ask 直接转人工审批） |
| `classifier.model` | `"auto"` | AI 模型（`auto` = 取 modelRegistry.getAvailable() 首个可用，或精确 `provider/model-id`） |
| `classifier.timeout` | `90` | AI 分类超时秒数 |
| `classifier.autoApproveLowRisk` | `true` | 低风险是否自动放行（false=转人工） |
| `classifier.autoDenyHighRisk` | `true` | 高风险是否自动拦截（true=强制 deny） |
| `classifier.thinkingLevel` | `"off"` | classifier LLM 的 thinking 级别（pi `ModelThinkingLevel`；`"off"`=不传 reasoning，`"minimal"`~`"max"` 透传） |
| `userRules` | `[]` | 用户自定义规则数组 |

## 四档模式

按严格等级从低到高：

### YOLO（默认）

完全无防护，所有工具调用放行。不跑任何层。适合受信任的隔离环境（如 dev container）。

### Auto

安全命令规则直接放行 + 非安全命令过 AI 审查 + AI 认为安全放行 / AI 认为非安全人工审批。

三层管道：
1. **AST 结构分析**（层 1）：tree-sitter-bash 解析命令，检测危险结构（subshell、command_substitution、file_redirect 等）
2. **规则匹配**（层 2）：白名单 + builtin-danger + user rules，last-match-wins
3. **AI Classifier + 用户审批竞速**（层 3）：AI 评估风险等级，同时弹出用户审批；AI 先返回时按 outcome 分支（allow/deny/ask）

### Approve

自动模式去除 AI，规则匹配后安全放行、非安全直接人工审批。无 AI 调用，适合无网络/无 API key 环境。

### Strict

全部审批。不跑 AST/规则/AI，所有工具调用都弹出用户审批。

## 切换模式

```
/permission              显示当前模式和可用模式列表
/permission yolo         切换到 yolo 模式
/permission auto         切换到 auto 模式
/permission approve      切换到 approve 模式
/permission strict       切换到 strict 模式
/permission status       显示详细配置
/permission rule         overlay 编辑用户规则（增/删）
/permission model        overlay 选择 AI classifier 模型（W7）
```

## 内置规则（摘要）

内置规则分两类，均代码硬编码，用户不可改：

- **白名单（builtin-safe）**：50 条无条件安全命令（24 Codex 移植 + 26 本扩展扩充：`cat`/`cd`/`echo`/`ls`/`grep`/`pwd`/`diff`/`jq`/`du`/`file`/`ps` 等）+ 9 条带 flag 子检查的条件安全命令（`base64`/`find`/`rg`/`git`/`sed`/`sort`/`iconv`/`shuf`/`date`）。规则遍历无 deny/allow 命中时（ask），白名单兜底 allow（不跑 AI）。
- **危险规则（builtin-danger）**：12 条正则规则（`rm -rf`、`sudo`、`chmod 777`、`curl ... | sh`、`git push --force`、`git reset --hard` 等）。pattern 是 RegExp 源字符串（含 `\b`/`\s`），用 `new RegExp(pattern, 'i')` 编译，`action` 固定 `deny`。

完整清单与每条规则的 pattern/示例见下方「规则系统」第 2、3 节。

## 规则系统

本节是用户编辑规则的完整指南，覆盖三层规则来源、内置白名单/危险规则全量清单、自定义规则语法、匹配优先级与常见场景示例。

### 1. 规则系统总览

规则（Rule）是层 2「规则匹配」的核心数据单元。每条规则描述「某条命令匹配某模式时执行某动作」。规则来源分三层：

| 来源 | source 字段 | 数量 | 形态 | 可改 |
|------|-------------|------|------|------|
| 内置安全白名单 | `builtin-safe` | 50 无条件 + 9 条件 | 函数实现（`isKnownSafeCommand`），不进 `Rule[]` 数组 | 不可改 |
| 内置危险规则 | `builtin-danger` | 12 条正则 | `BUILTIN_DANGER_RULES` 常量，代码硬编码 | 不可改 |
| 用户自定义规则 | `user` | 任意 | `config/permission-ext-config.json` 的 `userRules` 数组 | 可改 |

规则层在整个权限管道中的位置（auto / approve 模式）：

```
W2 AST 结构分析 → W3 规则匹配 → W4 AI Classifier（仅 auto）
```

W3 内部评估顺序：

1. **`[...BUILTIN_DANGER_RULES, ...userRules]`**：按数组顺序遍历，last-match-wins。deny → 直接 deny；allow → 直接 allow
2. **无规则匹配（ask）→ 白名单兜底**：`isKnownSafeCommand(argv)` 命中 → `allow`（虚拟 `builtin-safe` rule）
3. **仍无命中**：返回 `ask`（交下游 W4 AI 或人工审批，不静默 deny）

注意：只有 bash 工具的命令字符串会走规则匹配；非 bash 工具（Read/Write/Edit 等）在 `pipeline.ts` 的 `matchNonBashTool` 中单独评估用户规则（详见第 5 节「tool 字段」）。

### 2. 内置安全白名单（builtin-safe，不可改）

由 `BUILTIN_UNCONDITIONAL_SAFE` + `CONDITIONAL_SAFE_COMMANDS` 实现（函数判定，不是 `Rule[]`），白名单仅在规则遍历无 deny/allow 命中时（ask）作为 allow 兜底，不短路规则遍历。用户 deny 规则可覆盖白名单。

**50 条无条件安全命令**（`BUILTIN_UNCONDITIONAL_SAFE`，仅看 argv[0] basename）：

```
arch / basename / cat / cd / cksum / cmp / column / comm / cut /
diff / dirname / du / df / echo / expand / expr / false / file /
fold / grep / groups / head / id / jq / ls / md5sum / nl / paste /
printenv / ps / pwd / readlink / realpath / rev / seq / sha256sum /
shasum / stat / tail / tr / true / tsort / uniq / uname / uptime /
wc / whereis / who / whoami / which
```

注：前 24 条（cat/cd/cut/echo/expr/false/grep/head/id/ls/nl/paste/pwd/rev/seq/stat/tail/tr/true/uname/uniq/wc/which/whoami）移植自 Codex safelist。后 26 条（arch/basename/cksum/cmp/column/comm/diff/dirname/du/df/expand/file/fold/groups/jq/md5sum/printenv/ps/readlink/realpath/sha256sum/shasum/tsort/uptime/whereis/who）是本扩展在验证无写入 flag 后扩充。Codex 源码里的 `numfmt`/`tac` 仅在 linux 安全，本扩展面向跨平台 agent，统一不加入。

**9 条带 flag 子检查的条件安全命令**（`CONDITIONAL_SAFE_COMMANDS`，argv 级判定）：

| 命令 | 安全条件 | 命中危险即不放行 |
|------|----------|------------------|
| `base64` | 不含写文件 flag | 禁 `-o` / `--output` / `--output=*` / `-o*`（合并 flag 如 `-ob64.txt`） |
| `find` | 不含执行/删除/写文件 flag | 禁 `-exec` / `-execdir` / `-ok` / `-okdir` / `-delete` / `-fls` / `-fprint` / `-fprint0` / `-fprintf` |
| `rg` | 不含执行外部工具 flag | 禁 `--pre` / `--pre=*` / `--hostname-bin` / `--hostname-bin=*` / `--search-zip` / `-z` |
| `git` | 子命令属于 `status`/`log`/`diff`/`show`/`branch` 且只读 | 见下文 git 子表 |
| `sed` | 仅 `sed -n {N\|M,N}p [file]`（argv 长度 ≤ 4） | 其余形式不放行 |
| `sort` | 不含写文件 flag | 禁 `-o` / `--output` / `--output=*` / `-o*`（合并 flag） |
| `iconv` | 不含写文件 flag | 禁 `-o` / `--output` / `--output=*` / `-o*`（合并 flag 如 `-fo`） |
| `shuf` | 不含写文件 flag | 禁 `-o` / `--output` / `--output=*` / `-o*`（合并 flag 如 `-fo`） |
| `date` | 不含设置时间 flag | 禁 `-s` / `--set` / `--set=*`（`-s` 设置系统时间需 root） |

**git 子命令安全判定细则**：

- 子命令白名单：`status` / `log` / `diff` / `show` / `branch`
- 全局选项禁用：`-C` / `-c` / `-p` / `--config-env` / `--config-env=*` / `--exec-path` / `--exec-path=*` / `--git-dir` / `--git-dir=*` / `--namespace` / `--namespace=*` / `--paginate` / `--super-prefix` / `--super-prefix=*` / `--work-tree` / `--work-tree=*`（短选项内联值如 `-C.` 也禁）
- 子命令选项禁用：`--output` / `--output=*` / `--ext-diff` / `--textconv` / `--exec` / `--exec=*`
- `git branch` 仅当全部参数是只读 flag（`--list`/`-l`/`--show-current`/`-a`/`--all`/`-r`/`--remotes`/`-v`/`-vv`/`--verbose`/`--format=*`）时安全，否则视为创建/重命名/删除分支

**sed 安全判定细则**：

仅形如 `sed -n {N\|M,N}p [file]` 的命令安全，argv 长度上限 4。其中第三参数必须匹配 `/^(\d+,)?\d+p$/`（如 `5p`、`2,8p`）。其余 `sed` 用法（如 `s/.../.../`、`-i`）一律不放行。

### 3. 内置危险规则（builtin-danger，不可改）

12 条正则规则（`BUILTIN_DANGER_RULES`），`action` 固定 `deny`，`source` 固定 `builtin-danger`。pattern 是 RegExp 源字符串（含 `\b`/`\s`），由 `resolvePattern` 用 `new RegExp(pattern, 'i')` 编译（大小写不敏感）。

| id | pattern（正则字面量）| description | 匹配示例 |
|----|----------------------|-------------|----------|
| bd-001 | `\brm\b.*(\s-(?:[a-zA-Z]*r)\|--recursive)` | recursive delete | `rm -rf /`、`rm -f -r /`（分离 flag）、`rm --recursive y` |
| bd-002 | `\bsudo\b` | sudo | `sudo`、`sudo -E apt update` |
| bd-003 | `\bchmod\b.*(777\|a\+rwx\|ugo\+rwx\|ugo=rwx)` | world-writable permissions | `chmod 777 /tmp`、`chmod a+rwx file`、`chmod ugo=rwx file` |
| bd-004 | `(>\s*/dev/(sd\|hd\|nvme\|mmcblk\|vd\|xvd)[a-z0-9]+\|of=/dev/(sd\|hd\|nvme\|mmcblk\|vd\|xvd)[a-z0-9]+)` | raw device write | `dd ... > /dev/sda`、`dd of=/dev/nvme0n1`、`> /dev/mmcblk0` |
| bd-005 | `\bgit\s+push\s+.*(-f\b\|--force\b)` | force push | `git push --force`、`git push -f` |
| bd-006 | `\bgit\s+reset\s+--hard\b` | hard reset | `git reset --hard HEAD~1` |
| bd-007 | `\bgit\s+clean\b.*(\s-(?:[a-zA-Z]*f)\|--force)` | git clean --force | `git clean -fd`、`git clean -d -f`（分离 flag）、`git clean -fx` |
| bd-008 | `\bgit\s+checkout\s+(--\s+)?\.\s*($\|[;&\|])` | git checkout . (discard all) | `git checkout .`、`git checkout -- .` |
| bd-009 | `\bgit\s+restore\b` | git restore | `git restore file.txt` |
| bd-010 | `\b(curl\|wget)\b.*\|\s*(ba)?sh\b` | pipe to shell | `curl http://x \| sh`、`wget x \| bash` |
| bd-011 | `\bgh\s+repo\s+(create\|delete\|rename\|archive)\b` | modify GitHub repo | `gh repo delete foo` |
| bd-012 | `\bgh\s+release\s+(create\|delete\|edit)\b` | modify GitHub release | `gh release create v1` |

### 4. 自定义规则（用户编辑指南）

在 `<agentDir>/config/permission-ext-config.json` 的 `userRules` 数组中添加。完整示例：

```json
{
  "userRules": [
    { "id": "user-001", "tool": "bash", "pattern": "npm *", "action": "allow", "source": "user", "description": "允许所有 npm 命令" },
    { "id": "user-002", "tool": "bash", "pattern": "git push *", "action": "deny", "source": "user", "description": "禁止 git push" },
    { "id": "user-003", "tool": "bash", "pattern": "docker *", "action": "ask", "source": "user", "description": "docker 转人工" },
    { "id": "user-004", "tool": "*", "pattern": "*", "action": "ask", "source": "user", "description": "兜底：所有未匹配工具转人工" }
  ]
}
```

加载时配置层（`normalizeRule`）会对每条规则归一化，缺失字段有兜底：

- `id` 缺失 → 自动分配 `user-<n>`（按数组下标 +1）
- `tool` 缺失 → `*`（匹配所有工具）
- `pattern` 缺失 → `*`（匹配所有命令）
- `action` 非 `allow`/`deny`/`ask` → 该规则被丢弃（不影响其他规则）
- `source` 非 `user` → 归一化为 `user`

### 5. 规则字段详解

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 唯一 id，用户规则建议 `user-<n>`（缺失会自动分配） |
| `tool` | string | 是 | 工具名匹配，wildcard 语法。`bash` 精确匹配 bash 工具；`*` 匹配所有工具（含 Read/Write/Edit）；也可写具体工具名如 `read`、`write` |
| `pattern` | string | 是 | 命令/目标匹配，wildcard 语法。bash 工具对 `argv.join(' ')` 匹配；非 bash 工具对文件路径匹配（path 缺省时对工具名） |
| `action` | `"allow"` \| `"deny"` \| `"ask"` | 是 | 决策动作，详见第 8 节 |
| `source` | `"user"` | 是 | 规则来源，用户规则固定 `user`（写成其他值也会被归一化回 `user`） |
| `description` | string | 否 | 人类可读描述，在 matchedRule 与拒绝理由中展示 |

**tool 字段语义补充**：

- bash 工具的命令匹配由 `matcher.ts` 的 `matchRulesForArgv` 负责，它**只遍历规则数组、不对 rule.tool 做过滤**（因为 bash 工具上下文已确定）。所以 bash 规则的 `tool` 字段写什么不影响匹配结果，惯例写 `"bash"`。
- 非 bash 工具（Read/Write/Edit 等）由 `pipeline.ts` 的 `matchNonBashTool` 负责，它会先用 `wildcardToRegExp(rule.tool).test(toolName)` 过滤，再判定 `pattern`。要让规则对非 bash 工具生效，`tool` 必须能匹配工具名（如 `read`、`write`，或 `*`）。

### 6. wildcard 语法

`pattern` 与非 bash 的 `tool` 字段都用 OpenCode 风格 wildcard（`wildcardToRegExp` 编译）：

- `*` 匹配任意字符（含空格），等价于 `.*`
- `?` 匹配单个字符，等价于 `.`
- 末尾 ` *` 改写为可选的 `( .*)?`，使 `ls *` 也能匹配无参的裸 `ls`
- 特殊字符 `. + ^ $ { } ( ) | [ ] \` 按字面量匹配（自动转义）
- 路径分隔符 `\` 统一归一化为 `/`
- 全锚定 `^...$`
- 非 Windows：大小写敏感，用 `s`（dotAll）flag；Windows：大小写不敏感，用 `si` flag

常见 pattern 示例：

| pattern | 匹配 | 不匹配 |
|---------|------|--------|
| `npm *` | `npm install`、`npm`、`npm run build` | `pnpm install` |
| `git commit -m *` | `git commit -m "msg"` | `git commit` |
| `rm -rf *` | `rm -rf /tmp/x` | `rm -r /tmp` |
| `docker *` | `docker ps`、`docker` | `docker-compose up`（中间有 `-` 仍命中 `docker *`） |

### 7. 匹配优先级（last-match-wins）

规则遍历遵循 **last-match-wins**（最后一条匹配的规则胜出）。拼接顺序由 pipeline 固定：

```
[...BUILTIN_DANGER_RULES, ...userRules]
```

即内置危险规则在前，用户规则在后。配合 last-match-wins：

- 多条规则都匹配时，**数组末尾的那条**胜出
- 用户规则在 builtin-danger 之后，因此**用户规则可以覆盖内置危险规则**
- 在 `userRules` 数组内部，**靠后的规则覆盖靠前的**
- 无任何匹配 → `ask`（交下游，不静默 deny）

**覆盖示例**：命令 `git push --force origin main`

1. 遍历到 bd-005（`git push ... --force`）→ 命中 deny，记为 winner
2. 遍历到 `userRules` 末尾的 `{ pattern: "git push *", action: "allow" }` → 命中 allow，覆盖 winner
3. 最终 action = `allow`（用户已显式放行，风险自负）

**叠加示例**：想让 `npm install` 放行但 `npm publish` 拦截，按顺序写两条（deny 在后才能胜出）：

```json
{ "id": "user-allow-npm",  "tool": "bash", "pattern": "npm *",       "action": "allow", "source": "user" },
{ "id": "user-deny-publish", "tool": "bash", "pattern": "npm publish *", "action": "deny",  "source": "user" }
```

### 8. action 三态语义

| action | 行为 | 适用场景 |
|--------|------|----------|
| `allow` | 直接放行，跳过 AI 与人工审批 | 信任的命令（白名单/常驻开发命令） |
| `deny` | 直接拦截，返回 `{ block: true, reason }` | 禁止的命令（覆盖 builtin allow 或封禁危险操作） |
| `ask` | 转下游：auto 模式 → W4 AI Classifier；approve/strict 模式 → 人工审批 | 不确定是否安全的命令，交给 AI 或人判断 |

注意 `deny` 与「无匹配」不同：无匹配返回 `ask`（让命令进入下游评估），`deny` 是显式拦截。要拦截必须显式写 `action: "deny"`。

### 9. 常见场景示例

**场景 1：允许所有 npm 命令**

```json
{ "id": "user-npm", "tool": "bash", "pattern": "npm *", "action": "allow", "source": "user" }
```

**场景 2：禁止 git push（含 --force）**

```json
{ "id": "user-no-push", "tool": "bash", "pattern": "git push *", "action": "deny", "source": "user" }
```

**场景 3：docker 转人工审批**

```json
{ "id": "user-docker", "tool": "bash", "pattern": "docker *", "action": "ask", "source": "user" }
```

**场景 4：允许 npm install 但禁止 npm publish**

```json
{ "id": "user-npm-allow",   "tool": "bash", "pattern": "npm *",        "action": "allow", "source": "user" },
{ "id": "user-publish-deny", "tool": "bash", "pattern": "npm publish *", "action": "deny",  "source": "user" }
```

publish 规则在后，last-match-wins 时 deny 胜出。

**场景 5：全工具兜底审批（如所有 Write/Edit 都问一下）**

```json
{ "id": "user-all-ask", "tool": "*", "pattern": "*", "action": "ask", "source": "user" }
```

对非 bash 工具生效（`matchNonBashTool` 会用 `tool='*'` 匹配任意 toolName）。建议放在 `userRules` 末尾作为兜底。

**场景 6：覆盖内置危险规则（谨慎）**

例如内置 bd-001 禁止 `rm -rf`，但容器内想放行清理 `/tmp`：

```json
{ "id": "user-rm-tmp", "tool": "bash", "pattern": "rm -rf /tmp/*", "action": "allow", "source": "user" }
```

放在 `userRules` 末尾即覆盖 bd-001。务必缩窄 pattern 范围，避免误放行。

### 10. 配置文件管理

- **路径**：`<agentDir>/config/permission-ext-config.json`（`<agentDir>` 可用 `PI_CODING_AGENT_DIR` 环境变量覆盖，默认 `~/.pi/agent`）
- **首次创建**：扩展启动时若文件不存在，自动写入默认配置（`mode: "yolo"`、空 `userRules`）
- **权限**：`0o600`（原子写：先写 `.tmp` 再 rename，避免半写状态）
- **编辑方式**：`/permission rule` 打开 overlay 编辑器（TUI 支持列表查看/模板新增/自定义表单；RPC 模式仅支持删除已有规则）；也可直接手动编辑 JSON 文件
- **热重载**：每次 tool_call 都重读配置，用 `mtimeMs + size` 双 key 缓存检测变化（防 APFS 等 mtime 精度截断）。编辑保存后下一次命令即生效，无需重启

### 11. 调试技巧

- `/permission status`：查看当前配置摘要（含 `userRules` 数量）
- 查看决策来源：`PermissionDecision.source`（`mode` / `rule` / `ai` / `user`），区分是模式直接放行、规则命中、AI 分类还是人工审批（AST 分析不直接产生决策，只改变后续评估路径）
- 查看命中规则：`PermissionDecision.matchedRule`（命中时携带 Rule 对象），从 `id` 可判断是 `builtin-safe`（白名单虚拟规则）、`bd-<n>`（内置危险）还是 `user-<n>`（用户规则）
- 故意写一条 `deny` + 带 `description` 的用户规则触发拦截，从 tool_result 的 block reason 文案反查命中的是哪条规则
- 规则 pattern 编译失败不会静默跳过：`resolvePattern` 无容错，非法 pattern 抛出的异常由 tool_call handler 兜底 fail-closed block（该次调用被拦）。实际触发面极窄——用户规则加载时 source 归一化为 `user`，走 wildcard 编译（特殊字符自动转义，几乎不会失败）；只有手写配置写出非法正则且恰好命中 `builtin-danger` 分支才会抛异常。怀疑某条规则没生效时先检查 JSON 语法与 wildcard 写法

## AI Classifier

auto 模式下层 3 用 LLM 评估未知命令风险：

- **模型**：`classifier.model`（`auto` = 取 `modelRegistry.getAvailable()` 首个可用，或指定精确 `provider/model-id`）
- **输出**：`risk_level`（low/medium/high）+ `outcome`（allow/deny/ask）+ `reasoning` + `confidence`
- **override**（WT7 偏差补丁）：
  - `low + allow + autoApproveLowRisk=false` → 强制 `ask`（转人工）
  - `high + allow + autoDenyHighRisk=true` → 强制 `deny`（即使 AI 说放行）
- **Racing**：AI 分类与用户审批并行；AI 先返回时按 outcome 分支（allow/deny 关闭对话框，ask 等用户）

### 切换 classifier 模型（/permission model）

`/permission model` 弹出 overlay 选择 AI classifier 使用的模型，写回 `classifier.model`：

- **数据源**：`ctx.modelRegistry.getAll()` + `hasConfiguredAuth()` 过滤（`pi auth login` 配置的内置/OAuth provider 同样可见，不读 `models.json`），整体按 provider + id 字典序排序。
- **第一级 provider 选择**：列出 `Auto`（自动：取 `modelRegistry.getAvailable()` 首个可用）+ 所有可用 provider。当前 `classifier.model` 预选高亮。
- **第二级 model 选择**：选中具体 provider 后，列出该 provider 下所有可用 model（provider + id 字典序）。`Esc` 回退到 provider 列表。
- **键位**：`↑/↓` 导航、`Enter` 确认、`Esc` 取消（provider stage）或回退（model stage）。
- **三模式分发**：
  - **TUI**：`ctx.ui.custom` 渲染 overlay（`ProviderModelSelectorComponent`，两级 `SelectList` 状态机）。
  - **RPC**：两次 `ctx.ui.select`（先 provider 含 `Auto`，再 model）。
  - **headless**（json/print）：无交互 UI，返回降级提示。
- **无可用模型**：`modelRegistry` 无模型或全部未配置 auth 时，`listAvailableModels` 返回空 Map，命令降级为提示 `No available models. Run `pi auth login` or configure provider API keys, then retry.`（不阻塞，不修改配置）。
- **结果写回**：选中后 `classifier.model` 更新为 `auto` 或 `provider/model-id`，其余字段（mode/enabled/timeout/userRules）保留。

## 已知限制

- **TUI Reject-with-Reason**：当前 RPC 分支已完整接入 `ctx.ui.input` 采集拒绝理由；TUI 分支因 pi-tui Input 组件集成成本较高，暂保留简化 deny（固定文案），后续迭代补齐内联文本输入。
- **headless 模式**：json/print 模式无交互 UI，所有审批请求 fail-closed deny（不阻塞自动化流程，但 strict/approve 模式下无法放行）。
- **wasm 加载**：AST 分析依赖 tree-sitter-bash wasm，加载失败时 fail-closed（clean=false, parseError=true）。
- **并发**：tool_call handler 用 approvalChain 串行化（Pi 不保证 handler 串行，但权限检查涉及共享 UI 对话框）。

## 架构

```
tool_call event
     │
     ▼
yolo / disabled? ──yes──→ allow（快速路径）
     │ no
     ▼
strict? ──yes──→ 用户审批
     │ no
     ▼
bash? ──yes──→ AST 结构分析
     │              │
     │              ├─ clean=false →（auto: 层3 / approve: 审批）
     │              └─ clean=true  → argv 提取
     │
     ▼
规则匹配（层 2）
     │
     ├─ allow → 放行
     ├─ deny  → 拒绝
     └─ ask   →（auto: 层3 Racing / approve: 审批）

层 3 Racing（auto 模式）：
  AI Classifier  ──┐
                   ├─ race → AI 赢按 outcome / 用户赢按 decision
  用户审批 UI   ──┘
```

## 设计原则

- **fail-closed**：任何异常 → block（绝不静默放行）
- **checkPermission 永不 throw**：caller（tool_call handler）依赖此契约
- **deps 注入**：所有外部依赖（AST/规则/AI/UI）通过 CheckPermissionDeps 注入，便于测试 mock
- **配置读时刷新**：config 不持有跨调用缓存，每次需要时直接 `loadAndWatchConfig()` 读最新（llm-shared `mtimeMs + size` 去重，文件未变只 statSync），改文件即生效
- **纯函数核心**：checkPermission / runLayer2 / applyAutoApproveOverrides 都是纯函数

## 开发

```bash
# 类型检查
pnpm --filter @zhushanwen/pi-permission typecheck

# 测试
pnpm --filter @zhushanwen/pi-permission test

# 测试监听模式
pnpm --filter @zhushanwen/pi-permission test:watch
```

## License

MIT
