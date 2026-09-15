/**
 * 原语渲染协议 key —— rendering-protocol 层与消费方（renderer）的注入契约。
 *
 * PRIMITIVE_RENDER_KEY：渲染器组件注入点。原语组件内部递归渲染子组件时
 * inject 此 key 获取渲染器；未注入时回退内置 PrimitiveRouter（7 原语路由）。
 * renderer 的 GuiComponentRenderer provide 自身（含 custom 注册表 + ansi-text
 * 降级逻辑，降级 SSOT 在 core resolveComponent），保证 re-home 后递归行为与
 * 迁移前完全一致。
 *
 * 注意：vue 为 runtime-only（无模板编译器），递归渲染器组件必须用 render 函数，
 * 不能用 template 字符串。
 */
import type { Component, InjectionKey } from 'vue'

export const PRIMITIVE_RENDER_KEY: InjectionKey<Component> = Symbol('primitive-render')
