# skill-hub 路线图（公开）

> 设计依据见 [ARCHITECTURE.md](ARCHITECTURE.md)（第一性原理与目标架构）。
> 原则：单机体验永不牺牲；契约向后兼容；安全边界每版如实公示。

## v0.2 — 地基（core/server 分离 + 作业模型）

**主题：把"能用的工具"变成"可演进的平台"。**

- [ ] 包重组：`skillhub/core|exec|jobs|authn|server|cli` monorepo 结构
- [ ] `docs/CONTRACT.md`：envelope 契约 v1 成文（含机器可读 schema、版本号、弃用政策）
- [ ] `skillhub validate` / `skillhub test <skill-dir>`：技能契约符合性测试套件
- [ ] 作业模型：`run_skill_async`（返回 job_id）+ `get_job`，内存 JobStore；
      MCP 侧进度通知流式输出
- [ ] 每技能并发度字段（`concurrency`），替代全局硬编码信号量
- [ ] `dry_run` 平台强制（主体 scope 决定可否覆盖；read_only 技能只读执行）
- [ ] 技能 manifest 化第一步：每技能目录 `skill.yaml`（id/version/权限/入口），
      registry.yaml 变为索引，`skillhub migrate` 迁移工具
- [ ] 官方 Node 技能示例（证明契约语言无关）
- [ ] REST API 骨架（/api/skills, /api/jobs），与 MCP 同源同权

**验收**：两个示例技能在重组后行为不变（53 用例全绿）；一个 60s Agent 技能
不再阻塞其他客户端调用；契约文档发布。

## v0.3 — 安全（隔离与多主体）

**主题：A1/A2 从声明变为强制。**

- [ ] docker 执行驱动：默认无网络、只读根 fs、非 root、cap-drop、cgroup
      资源上限；compose 一键起（hub + 可选 redis）
- [ ] wsl 驱动（Windows 开发折中）；三平台 CI 矩阵（win/linux/mac × py3.10-3.12）
- [ ] 多主体认证：users.yaml 多 token → JWT → OIDC；UI 会话登录
- [ ] 授权策略引擎：`(主体, 技能, action, 风险) → 允许/拒绝`，默认拒绝，
      主体带风险上限（如该用户最高 workspace_write）
- [ ] 每主体配额（并发/频率）；响应过滤器（路径抹除、脱敏规则化）
- [ ] 发布工程：`skillhub new` 脚手架、Docker 镜像、pip/uv 安装文档

**验收**：`external_write` 技能在 docker 驱动下可安全注册（网络物理隔离）；
两个不同权限的主体互相不可见对方专属技能；CI 三平台全绿。

## v0.4 — 产品化（界面与上传）

**主题：让非命令行用户和外部贡献者能用起来。**

- [ ] Web UI：技能目录（含风险/版本/作者）、调用记录与审计可视化、
      作业状态面板（FastAPI + 前端，同为普通客户端）
- [ ] 用户管理界面（主体、scope、风险上限）
- [ ] 技能上传第一阶段：**仅 Agent 型（SKILL.md 纯文本）**，上传 → 校验 →
      人工审核 → 启用（上传 ≠ 生效）
- [ ] JobStore SQLite 持久化（重启恢复作业历史）；worker 与 API 进程分离
- [ ] Prometheus /metrics、/version；结构化日志可选 OTel 导出

**验收**：新用户 10 分钟内完成：登录 → 浏览技能 → 上传一个 SKILL.md →
审核启用 → 从手机 agent 调用成功。

## v1.0 — 开源发布

**主题：面向社区的稳定平台。**

- [ ] 契约 v1 冻结 + SemVer 承诺 + RFC 式契约变更流程
- [ ] 技能签名（ed25519）与发布者信任级（community / verified）；
      上传放开到脚本型（docker 驱动强制 + 审批流）
- [ ] 官方示例技能画廊（≥6 个，覆盖脚本/Agent/多 Action/多语言）
- [ ] 文档双语；CONTRIBUTING / SECURITY（披露流程）/ CHANGELOG；Apache-2.0
- [ ] Redis JobStore（横向扩展，可选部署）
- [ ] 云端连接器指南：Tailscale / Cloudflare Tunnel / 反向代理最佳实践

**验收**：外部贡献者按文档从 fork 到技能被合并的全流程走通，无需维护者
口口相传；安全边界表随版本发布。

## 已完成的里程碑

- **v0.1（当前，已推送）**：局域网 HTTP + Bearer 鉴权；脚本型/Agent 型
  两种技能链路；路径围栏、环境变量白名单、超时杀进程树、全局并发 1、
  JSONL 审计；53 用例 / 覆盖率 92%；Node 官方 SDK 第三方客户端实测通过。
