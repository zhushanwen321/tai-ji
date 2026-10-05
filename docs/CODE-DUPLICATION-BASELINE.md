# 代码重复度基线（CODE-DUPLICATION-BASELINE）

代码重复度机器度量的口径 SSOT 与健康基线。谁读：重复度审计（code-simplify / 架构审计）执行前，保证度量可比；什么触发更新：jscpd 版本变更、口径参数调整、范围调整——任何一项变更须同批重测并更新本文件基线数字。

## 口径（现行 SSOT）

| 项 | 值 |
|----|----|
| 工具 | jscpd `5.4.0`（根 package.json devDependencies exact 锁定，版本随 lockfile 固定） |
| 参数 | `--min-tokens 50 --mode strict --format typescript` |
| 范围 | `packages apps extensions scripts e2e`（全仓源码五域） |
| 排除 | `__tests__/`、`*.test.ts`、`*.spec.ts`、`generated/`、`fixtures/`（测试与生成物）+ `node_modules/`、`dist/`、`dist.*` 变体、`resources/`（依赖与打包 staged 产物） |

**typescript 单通道的理由**：jscpd 的多语言通道（`.vue` 拆分出的 typescript/html/css 子通道、`.md`/`.json`/`.css`/`.sh`）各自产生难以归因的噪声克隆（文档措辞重复、token 表重复），且 `.vue` 内嵌 TS 与 `.ts` 的同源重复会被双计；重复度审计的对象是 TS 逻辑重复，故只认 typescript 通道。

## 一键重跑

```bash
node scripts/measure-code-duplication.mjs
```

脚本按上表口径执行并输出 `clones / duplicatedLines / percentage` 三数；报告写临时目录即用即删，不落仓库。改口径先改脚本与本文（两处一致），再重测数字。

## 基线数字与判读（2026-10-04 实测）

| 指标 | 值 |
|------|----|
| clones | 164 |
| duplicatedLines | 2543 |
| percentage | **0.73%** |

**判读基准**：<1% 为健康区（架构偏好「重复保险式过度工程是可疑信号」的反面——低重复 = 抽象归位）；1%-3% 关注区（新克隆出现时优先判断「真差异（业务含义/变化原因不同）还是假差异（形式语义同构可合并）」，假差异走收敛）；>3% 需要专项审计（用 `jscpd --reporters html` 出明细定位克隆族）。

## 全量口径与生产口径的差异原因

不加排除项跑全量（含测试与生成物）时数字虚高一个量级（实测 5410 克隆 / 67562 行 / 5.97%），构成：

- **约 82% 的克隆来自测试文件**（`__tests__`/`*.test.ts`/`*.spec.ts`——测试代码重复是常态：断言样板、fixture 构造，不属于生产代码重复度信号）；
- **约 11% 来自生成物**（`packages/runtime/src/generated/builtin-providers.json` 单文件族——构建期生成物，禁止手改，其内部重复无审计意义）；
- 两者合计约 93%，生产手写代码的真实重复即本登记的生产口径数字。

## 历史记录值（不作为判据）

早期一轮审计曾记录「生产代码 64 克隆 / 702 行 / 0.36%」与「全量克隆 55% 来自生成物」两个数值；该轮报告未随临时目录保存，扫描范围细节不可考，两个数值均无法复现，不作为回归判据。本文件登记的口径与基线是唯一现行 SSOT。
