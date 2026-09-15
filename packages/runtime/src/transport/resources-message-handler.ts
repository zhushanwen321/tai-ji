/**
 * 资源发现域 config.* message handler（skill / agent / extension 三族的扫描、目录管道、
 * 清单 CRUD，12 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件逐一原样迁移，行为保持）。三族同构：ADR-0021 §1 目录级管道（set*Dirs 覆盖
 * discovery.json.*Dirs 有序数组）+ scan（sources 候选加入 discovery + 广播列表）+
 * @deprecated 逐条 upsert/delete 兼容期路径；skill 族额外接 skillRegistry（全局/项目
 * 缓存 + watcher）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class ResourcesMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理资源发现域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.scanSkills': {
        const existingIds = new Set(this.ctx.configService.loadSkills(this.ctx.projectRoot).map(s => s.id))
        this.ctx.reply(ws, msg.id, 'config.scannedSkills', { skills: this.ctx.configService.scanSkills(msg.payload.sources, existingIds), success: true })
        // 修裂缝①：扫描后广播最新 skill 列表（与 set/delete 对称），让前端 onSkills 订阅推回
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.scanSessionSkills': {
        // W2（cw-2026-07-21-scan-project-agents-skills）：按 session cwd 拉 project skill。
        // 与 config.scanSkills 区分：scanSkills 扫 sources 数组候选加入 discovery + 广播全局；
        // scanSessionSkills 扫某 cwd 的 .agents/skills + .xyz-agent/skills 已生效目录，不广播
        // （按需 RPC，避免污染全局 config.skills，前端 useProjectSkills 按 cwd key 独立缓存）。
        const skills = this.ctx.configService.loadSkills(msg.payload.cwd)
        this.ctx.reply(ws, msg.id, 'config.sessionSkills', { skills })
        return true
      }
      case 'config.getGlobalSkills': {
        // W4：返回 skillRegistry globalCache（启动期扫描 + watcher 自动刷新，同步读缓存零开销）。
        // landing 全局 skill 走此 RPC（FR-5：不再走 settingsStore.skills 配置态扫描）。
        const skills = this.ctx.skillRegistry.getGlobalSkills()
        this.ctx.reply(ws, msg.id, 'config.globalSkills', { skills })
        return true
      }
      case 'config.getProjectSkills': {
        // W4：按 cwd 拉项目 skill（skillRegistry projectCache，首次扫描 + 挂 watcher，命中缓存零开销）。
        // 与 config.scanSessionSkills 区分：getProjectSkills 走 skillRegistry（带缓存 + 文件监听 W1 单例），
        // scanSessionSkills 直接调 configService.loadSkills(cwd)（无缓存）。前端 useProjectSkills 已切到本 RPC。
        const skills = await this.ctx.skillRegistry.getProjectSkills(msg.payload.cwd)
        this.ctx.reply(ws, msg.id, 'config.projectSkills', { skills })
        return true
      }
      case 'config.setSkillDirs': {
        // ADR-0021 §1 目录级管道：覆盖 discovery.json.skillDirs（有序数组 = 优先级）
        this.ctx.configService.setSkillDirs(msg.payload.dirs)
        this.ctx.reply(ws, msg.id, 'config.skillDirs', { dirs: msg.payload.dirs })
        // 触发 SkillRegistry 重建（close 旧 watcher → 重扫 globalCache → 重挂 watcher 含新路径）+ 清 projectCache。
        // rebuildGlobal 内部 notifyGlobalChange → onChange → 广播 config.skillCacheInvalidated('global') + reloadOrchestrator。
        // 显式广播 ('project')——让前端 useProjectSkills 也失效重拉。
        //
        // Promise 链语义（W1 修正：原 `.then` 内 invalidate+broadcast 在 rebuild reject 时被整段跳过，
        // 与下方「失败不阻塞后续 invalidate/broadcast」注释不符——原写法 broadcast 在 `.then` 里，
        // reject 时前端收不到 project 失效信号、useProjectSkills 仍展示陈旧缓存）：
        //   - 成功：invalidateAllProjects（清 projectCache，globalCache 已由 rebuild 重扫）+ broadcast('project')
        //   - 失败：仅 broadcast('project')（让前端至少重拉一次；projectCache 暂不清——rebuild 失败时
        //     globalCache 可能损坏，invalidateAllProjects 此时意义不大且 reloadOrchestrator 可能已在处理错误，
        //     等下次成功 rebuild 再清；用户重试 settings 操作可恢复）。
        // broadcast 总是执行（无论 rebuild 成败都通知前端 project 失效），invalidate 只在成功时。
        // best-effort：失败只记日志，不阻塞 WS 消息处理（reply/broadcastSkillDirs 已立即返回）。
        void this.ctx.skillRegistry.rebuildGlobal()
          .then(() => {
            this.ctx.skillRegistry.invalidateAllProjects()
            this.ctx.broadcastSkillCacheInvalidated('project')
          })
          .catch((e: unknown) => {
            console.error('[settings-handler] skillRegistry.rebuildGlobal failed after setSkillDirs:', e)
            // rebuild 失败也广播失效，让前端至少重拉一次（projectCache 未清，前端拉到旧值——
            // 但比完全不通知好，用户重试 settings 操作可恢复）。
            this.ctx.broadcastSkillCacheInvalidated('project')
          })
        this.ctx.broadcastSkillDirs()
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.setSkill': {
        // @deprecated ADR-0021 §5：保留兼容期，走 deprecated config-service 路径
        this.ctx.configService.upsertSkill(msg.payload.skill)
        this.ctx.reply(ws, msg.id, 'config.skillUpdated', { skill: msg.payload.skill, success: true })
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.deleteSkill': {
        // @deprecated ADR-0021 §5：保留兼容期
        this.ctx.configService.deleteSkill(msg.payload.skillId)
        this.ctx.reply(ws, msg.id, 'config.skillDeleted', { skillId: msg.payload.skillId, success: true })
        this.ctx.broadcastSkillList()
        return true
      }
      case 'config.scanAgents': {
        const existingIds = new Set(this.ctx.configService.loadAgents(this.ctx.projectRoot).map(a => a.id))
        this.ctx.reply(ws, msg.id, 'config.scannedAgents', { agents: this.ctx.configService.scanAgents(msg.payload.sources, existingIds), success: true })
        // 修裂缝①：扫描后广播最新 agent 列表
        this.ctx.broadcastAgentList()
        return true
      }
      case 'config.setAgentDirs': {
        // ADR-0021 §1 目录级管道：覆盖 discovery.json.agentDirs（有序数组 = 优先级）
        this.ctx.configService.setAgentDirs(msg.payload.dirs)
        this.ctx.reply(ws, msg.id, 'config.agentDirs', { dirs: msg.payload.dirs })
        this.ctx.broadcastAgentList()
        this.ctx.broadcastAgentDirs()
        return true
      }
      case 'config.setAgent': {
        // @deprecated ADR-0021 §5：保留兼容期
        this.ctx.configService.upsertAgent(msg.payload.agent)
        this.ctx.reply(ws, msg.id, 'config.agentUpdated', { agent: msg.payload.agent, success: true })
        this.ctx.broadcastAgentList()
        return true
      }
      case 'config.setExtensionDirs': {
        // ADR-0021 §1 目录级管道：覆盖 discovery.json.extensionDirs（有序数组 = 优先级）
        this.ctx.configService.setExtensionDirs(msg.payload.dirs)
        this.ctx.reply(ws, msg.id, 'config.extensionDirs', { dirs: msg.payload.dirs })
        this.ctx.broadcastExtensionDirs()
        return true
      }
      case 'config.deleteAgent': {
        // @deprecated ADR-0021 §5：保留兼容期
        this.ctx.configService.deleteAgent(msg.payload.agentId)
        this.ctx.reply(ws, msg.id, 'config.agentDeleted', { agentId: msg.payload.agentId, success: true })
        this.ctx.broadcastAgentList()
        return true
      }
      default:
        return false
    }
  }
}
