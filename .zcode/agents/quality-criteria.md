---
description: "通用代码质量审查（维度 B）。跨语言通用范式：类型安全 / 错误处理 / 边界条件 / 测试有效性。是兜底维度（C > A > B）。"
name: quality-criteria
---

# 通用代码质量审查标准（Subagent B 用）

## 目的

本文档是 CW（coding-workflow）的**通用范式质量审查标准**，供 review 阶段的 Subagent B 使用。

定义跨语言/跨项目通用的代码质量判定基线——任何语言都适用的质量维度（类型安全、错误处理、边界条件、测试有效性），
与具体项目的 lint 规则、架构规范无关。

## 适用场景

- 审查任何语言（TypeScript / Python / Java / Go / ...）的代码变更
- 只审"语言/范式通用质量"，不审项目特定约定（lint 规则、架构约定、命名规范属于 Subagent A 的职责）
- 判定结果分三档：**pass / warn / fail**

## 判定档位语义

| 档位 | 含义 | 处理 |
|------|------|------|
| pass | 该维度无明显问题（或仅 nit 级别） | 无需改动 |
| warn | 有 should_fix 级别问题（有改进空间但不阻塞） | 记入编排器指定的维度报告路径（如 .review/run-<runId>/quality-criteria.md），warn 不阻塞流程 |
| fail | 有 must_fix 级别问题（核心缺陷必须修） | 记入编排器指定的维度报告路径，fail 禁止流程通过 |

档位由"最严重的问题"决定：只要出现一个 must_fix → fail；只有 should_fix 无 must_fix → warn；全无问题 → pass。

### 与统一严重度档位的映射

本维度判定用 pass/warn/fail 三档（面向审查者），但产出的报告条目必须标注统一严重度（面向 aggregator 去重统计）：

| 本维度判定 | 统一严重度 | 说明 |
|-----------|-----------|------|
| fail | MUST_FIX | 核心缺陷，对应 aggregator 的 must_fix 计数 |
| warn | SUGGESTION | 改进空间，对应 aggregator 的 suggestion 计数 |
| pass | （不产出条目） | 无问题不报告，不产出 INFO；INFO 条目由其他维度按需产出 |

审查者在报告每个问题时，必须同时标注本维度判定（fail/warn）和统一严重度（MUST_FIX/SUGGESTION）。pass 的维度不产出条目。

---

## 维度 1：类型安全

### 定义

代码是否准确表达了类型意图，避免运行时类型错误。强类型语言看类型签名准确性，弱类型/动态语言看防御性约束（类型注释、运行时校验、契约检查）。

### pass 标准

- 无 `any`（TS）或等效的"放弃类型"写法
- 无 `as` 断言链（TS）或硬转换绕过类型系统
- 类型签名准确：函数参数、返回值、变量都有明确类型，类型与实现一致
- 联合类型 / 可空字段处理完整（不是靠断言强行收窄）

### warn 标准

- 有少量 `as` 断言，但每处都有注释说明为什么需要断言（如：第三方库类型不完整、边界处必要的类型收窄）
- 有少量类型推断而非显式标注，但不影响可读性和正确性

### fail 标准

- 有 `any`（TS）或等效的"放弃类型"写法，且无注释说明
- 有断言链（`as unknown as`）绕过类型检查
- 类型签名与实现不一致（如声明返回 `string`，实际可能返回 `undefined`）
- 在不该 nullable 的地方返回 nullable，且调用方未处理

### 示例

```typescript
// pass：类型准确，可空字段有显式处理
function getUser(id: string): User | null {
  return users.find((u) => u.id === id) ?? null;
}

// warn：有 as 但有注释说明意图
const raw = JSON.parse(text);
const config = raw as Config; // 第三方输入，schema 在 parseConfig 时已校验

// fail：any + 断言链，无防御
function handle(data: any) {
  const cfg = data as unknown as Config; // 为什么断言？无说明
  return cfg.timeout;
}
```

---

## 维度 2：错误处理

### 定义

异步操作、外部依赖、可能失败的调用是否都有错误处理。不吞异常，不让错误静默丢失。

### pass 标准

- 所有异步操作（fetch / fs / db / 子进程）有 try/catch 或等价的错误处理
- 错误被捕获后要么向上传播（throw / reject），要么被显式处理（记日志 + 降级 + 用户可见错误）
- catch 块不为空——至少有日志、错误转换或注释说明为什么这里忽略

### warn 标准

- 有空 catch 但**有注释说明意图**（如：清理资源的 finally 中已知异常可忽略，注释写明"此处 EBUSY 在某些 OS 上偶发，忽略不影响逻辑"）
- 部分错误路径未给用户可见反馈，但不影响核心数据正确性

### fail 标准

- 静默吞异常（`catch {}` 或 `catch (e) {}` 空体，无注释）
- 异步操作无错误处理（裸 `await` 无 try/catch，Promise 无 .catch）
- 错误被捕获后既不传播也不处理（既不 throw，也不记日志，也不降级）——错误信息彻底丢失
- 把系统错误降级成"成功"返回（吞掉失败让调用方以为成功）

### 示例

```typescript
// pass：异步操作有错误处理，错误向上传播
try {
  await fs.writeFile(path, data);
} catch (e) {
  throw new CwError("WRITE_FAILED", `写 ${path} 失败`, { cause: e });
}

// warn：空 catch 但有注释说明意图
try {
  await fs.unlink(tmpPath);
} catch {
  // EBUSY 在某些 OS 上偶发，tmp 文件清理失败不影响主流程
}

// fail：静默吞异常
try {
  await fs.writeFile(path, data);
} catch {
  // 空——错误彻底丢失，调用方以为成功
}
```

---

## 维度 3：边界条件

### 定义

代码是否处理了输入/状态的边界情况：空值、零值、最大值、并发竞争、异常分支。

### pass 标准

- 空值处理：空数组 / 空字符串 / null / undefined 都有对应分支
- 零值/极值：0、负数、最大长度、空集合等边界值不导致崩溃或错误结果
- 并发竞争：共享状态（文件 / 内存变量 / 数据库）的并发读写有锁或等价机制
- 异常分支：外部依赖失败的 fallback / 降级路径已实现，不是只有 happy path

### warn 标准

- 有部分边界遗漏，但不影响核心路径（如：极端大文件未限流，但日常场景正常）
- 并发场景未加锁但单进程串行调用下不会出错（注释说明"当前仅单进程"）

### fail 标准

- 核心路径有未处理的边界（如：除法没除零检查、数组取下标没越界检查、JSON.parse 没校验输入）
- 并发竞争未处理且会导致数据损坏（如：flock 未覆盖某条写路径）
- 异常分支缺失：外部依赖失败时整个功能崩溃（无 fallback / 无错误提示）

### 示例

```typescript
// pass：空值 + 边界都处理
function sum(nums: number[]): number {
  if (nums.length === 0) return 0;       // 空集合
  return nums.reduce((a, b) => a + b, 0); // 零值由初始值 0 覆盖
}

// warn：部分边界遗漏但非核心
function formatList(items: string[]): string {
  // 未处理 items.length > 1000 的情况，但日常场景正常
  return items.join(", ");
}

// fail：核心边界未处理
function divide(a: number, b: number): number {
  return a / b; // b=0 时返回 Infinity，调用方未预期
}
```

---

## 维度 4：测试有效性

### 定义

测试是否有效验证了行为，而不是"凑覆盖率"。断言是否具体，是否覆盖正常 + 异常路径。

> **CW 项目特定补充**：本维度是通用范式层（"克制 mock"）。但 CW（coding-workflow）项目另有**零 mock 硬规则**——测试零 mock、禁止引入 mock 框架（见 AGENTS.md / TEST-STRATEGY.md）。审查 CW 自身源码时，若发现引入 mock 框架，归 Subagent A（项目约定，project-conventions.md），优先级高于本维度的通用"克制 mock"判断。

### pass 标准

- 测试断言具体（`toBe(具体值)` / `toEqual(具体结构)`），不是 `toBeTruthy()` 滥用
- 覆盖正常路径 + 异常路径（异常输入、错误分支、边界条件各有测试）
- 测试有明确的 arrange-act-assert 结构，可读性好
- mock 使用克制——只 mock 外部依赖，被测逻辑不 mock

### warn 标准

- 测试覆盖正常路径但异常路径不足（只测了 happy path 的一个变体）
- 个别断言偏宽泛（如 `expect(result).toBeDefined()`），但有其他具体断言补充

### fail 标准

- 只测 happy path（所有测试都是正常输入，无异常分支测试）
- 断言过于宽泛（大量 `toBeTruthy` / `toBeDefined` / `toBeGreaterThan(0)`，不验证具体值）
- 测试无实际断言（只跑不验）或断言恒真
- mock 过度（把被测逻辑本身也 mock 了，测试没验证真实行为）

### 示例

```typescript
// pass：断言具体 + 覆盖异常路径
describe("sum", () => {
  it("正常求和", () => {
    expect(sum([1, 2, 3])).toBe(6);
  });
  it("空数组返回 0", () => {
    expect(sum([])).toBe(0);
  });
  it("负数", () => {
    expect(sum([-1, -2])).toBe(-3);
  });
});

// warn：只覆盖正常路径
describe("sum", () => {
  it("求和", () => {
    expect(sum([1, 2, 3])).toBe(6);
  }); // 缺空数组、负数、异常输入
});

// fail：断言过于宽泛
it("求和", () => {
  const result = sum([1, 2, 3]);
  expect(result).toBeTruthy(); // 不验证具体值，sum 返回 100 也会 pass
});
```

---

## 分工边界（重要）

本文档**只审语言/范式通用质量**。以下不在本文档范围：

| 不审的内容 | 谁来审 |
|-----------|--------|
| 项目特定 lint 规则（如禁止某 API） | Subagent A（读 project-conventions.md） |
| 架构规范（如分层约定、模块边界） | Subagent A |
| 命名规范（如 camelCase / 文件命名） | Subagent A |
| plan 是否完成（changes 落地率） | Subagent C |

**重叠裁决**：同一缺陷最多被一个维度报告。全局优先级为 **C > A > B**，B（通用质量）是兜底层。当问题同时符合 B 和 A（项目约定）时归 A；当问题同时符合 B 和 C（plan 落地）时归 C。B 只报告既不属于项目特定约定也不属于 plan 落地的通用质量问题。详见 review-aggregator.md 的去重规则。
