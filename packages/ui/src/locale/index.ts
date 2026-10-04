/**
 * ui locale 模块双侧聚合入口。消费方（移动壳 vue-i18n 装配）组装 vue-i18n messages
 * 时按 locale 键装配：
 *
 *   messages: { 'zh-CN': zhCN, 'en-US': enUS }
 *
 * renderer 因 tray 合并按域直连 ./locale/zh-CN、./locale/en-US（panel 命名空间的 tray
 * 子树展开合并留守 renderer 壳）；本入口仅移动壳（mobile i18n.ts）消费。
 *
 * 单侧聚合对象形态镜像 renderer 壳聚合（default export 顶层域键 → 嵌套文案树）。
 */
import zhCN from './zh-CN'
import enUS from './en-US'

export { zhCN, enUS }
