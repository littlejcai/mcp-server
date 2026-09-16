# skill-hub Node 版实现方案（NT 路线）

> 目标：把 skill-hub 的服务端从 Python/FastMCP 迁移到 Node.js/TypeScript，
> 与后续 Web UI 统一技术栈。**协议契约不变**——MCP 工具面、envelope、
> registry.yaml、审计格式全部保持与 Python 版一致，客户端无感切换。
>
> 本文档与 [ROADMAP.md](./ROADMAP.md) 的关系：M0–M6 的**递进逻辑不变**，
> 只是代码基换成 Node。NT 里程碑是对应 M 里程碑在 Node 侧的落地阶段。

---

## 1. 决策记录

| 决策点 | 选择 | 理由 |
|---|---|---|
| 语言/运行时 | TypeScript + Node ≥ 20（ESM） | 与未来 UI 同栈；类型即契约 |
| MCP 框架 | 官方 `@modelcontextprotocol/sdk` | 一方维护、协议参考实现；npm 版 fastmcp 只是它上面的封装，移植工作量 90% 在 hub 业务层，封装帮不上忙 |
| HTTP 框架 | Express 4 | SDK 官方示例默认；Bearer/路由是通用知识 |
| Schema 校验 | ajv（draft 2020-12） | 原生说 JSON Schema，`x-path-scope` 自定义键默认透传，比 Python 侧更顺 |
| 工具 schema | zod | SDK 的 `registerTool` 惯例 |
| 测试/运行 | tsc 编译 + 纯 `node`（node:test） | tsx 会向 spawn 出的每个 node 子进程注入自身加载器，在高负载机器上病理性缓慢（见 §6 备注 6/7）；编译后运行最接近生产形态 |
| 代码位置 | 本仓库 `node/` 目录 | 与 Python 版同仓并存，parity 对比脚本能同时打两端 |
| 配置/技能 | **复用**根目录 `config.yaml`、`registry.yaml`、`skills/`、`workspace/` | 单一事实源，两边零漂移 |
| 传输模式 | Streamable HTTP，**无状态**（每请求独立 server+transport） | 工具调用不需要会话；横向扩展友好；GET SSE 长流延后到需要服务端推送时（协议允许返回 405） |

## 2. Parity 原则（切换的验收标准）

Node 版替换 Python 版的硬性门槛（N1 完成）：

1. `tools/list` 返回的工具名、描述、input schema 与 Python 版一致；
2. 同一请求（相同 inputs）两端返回的 envelope 除 `duration_ms` 外逐字段相等；
3. 错误路径行为一致：未知技能 / schema 违规 / 路径逃逸 / 超时，消息关键词一致；
4. 审计 JSONL 字段兼容（`ts/status/skill_id/duration_ms/inputs_summary/client`）；
5. 认证一致：同一 `HUB_TOKEN`/`secrets.token` 对两端都有效。

配套 `node/scripts/parity-check.ts`：同一 MCP client 分别连两端，自动执行上述对比。

## 2.5 并行期治理（N0.5 起）

Python 版与 Node 版并存期间（至 N1 切换完成）：

1. **Python 侧冻结**：安全相关代码（security/runner/agent_runner）与新功能冻结，
   只接受 critical fix；唯一例外是两端同步的契约对齐改动（如 envelope `v` 字段，
   一行级、向后兼容、必须同一次改动里两端落地并各自更新测试）。
2. **Node 先行契约**：`run_skill` 的 `run_mode: sync|async`、`get_job`、
   `list_jobs` 已在 Node 侧落地（异步作业语义从 N2 提前，见 §6 备注 8）。
   Python 冻结期不实现；parity 工具面对比取**交集**，并断言 Node 侧多出的
   工具恰好是这一清单。
3. **新功能只进 Node**：AgentRunner、first-class 工具（N1）、REST、UI 全部只在
   Node 侧开发，Python 不再跟进，避免双份内核各自演化。

---

## 3. N0 · 本次交付（MVP，v0.1.0）

**范围**：核心执行回路跑通——脚本型技能端到端可用。

交付物：

- [x] 项目骨架：`node/`（package.json / tsconfig / vitest，ESM，strict TS）
- [x] 核心模块移植：`errors` / `envelope` / `security`（PathGuard + 环境白名单 + scrub）/ `registry`（meta-schema 严格校验）/ `audit`（JSONL）
- [x] `ScriptRunner`：argv 数组 spawn、stdin 请求 envelope、超时杀**进程树**、stdout 上限、最小环境
- [x] MCP 服务层：`list_skills` / `describe_skill` / `run_skill` 三个调度工具 + Bearer 中间件 + `/health` + 全局并发信号量
- [x] 测试：对齐 `tests/` 的 pytest 用例（envelope/security/registry/runner/server/并发）
- [x] parity 对比脚本（骨架版：工具面 + envelope diff）

**明确不做**（归后续里程碑）：AgentRunner、first-class 动态工具、REST 出口、UI、上传、多用户。

**验收门（Gate-NT0）**：
① `npm test`（编译后 node:test）全绿；
② 真实启动服务，MCP client 经 HTTP+Bearer 调 `run_skill` 成功执行一个脚本型技能，
envelope 与 Python 版一致；
③ 路径逃逸 / 未知技能 / schema 违规在工具层返回与 Python 版同关键词的错误。

## 4. 里程碑路线

| NT | 版本 | 内容 | 对应 | 验收门 |
|---|---|---|---|---|
| **N0** | v0.1 | **MVP**：核心回路（见上） | ≈ M0 证明 | Gate-NT0 |
| **N0.5** | v0.2 | **契约升级（已完成）**：异步作业语义（`run_mode` + `get_job`/`list_jobs` + 内存 JobStore，从 N2 提前）；envelope 带内版本号 `v: 1`（两端同步）；§2.5 并行期治理生效 | 契约地基 | 全套件 58/58 + 实弹 11/11 |
| **N1** | v0.3 | **完整契约对齐**：AgentRunner（`claude -p`，stdin prompt、结果文件回读、树击杀）+ first-class 动态工具（JSON Schema→zod）+ parity 全量金样测试 | ≈ Python v1 全量 | Gate-NT1：五条 parity 原则全过；此后可切流，Python 版保留一个版本期 |
| **N2** | v0.4 | **地基**：server/api/core 分层定型；REST API 出口（UI 消费用，与 MCP 同一执行核）；JobStore 内存→SQLite 持久化；`skillhub` CLI 入口 | M1 | REST 与 MCP 同契约；JobStore 可换实现 |
| **N3** | v0.5 | **信任与隔离**：主体/scope/风险上限授权；上传第一阶段（仅 SKILL.md 校验）；审计查询 API；驱动接口（容器隔离） | M2 | 陌生代码不可越权；授权关掉后核心功能不回归 |
| **N4** | v0.6 | **产品可用（本项目初衷）**：Web UI（技能目录/调用记录/审计可视化/作业面板）+ BFF 或直连 N2 REST；用户管理界面；SKILL.md 上传流 | M3 | 沿用 Gate-3：**关掉 UI，hub 全功能不受影响；UI 只是普通客户端** |
| **N5+** | v1.0→ | 开源发布、签名、驱动接口 v1 冻结、技能分发协议、企业特性、多节点 | M4–M6 | 跟随 ROADMAP.md 节奏，不另立路线 |

依赖关系：N1 依赖 N0；N2 的 REST 依赖 N1 的完整执行核；N3 依赖 N2 的分层；
N4 依赖 N2（REST）+ N3（授权）；N5 依赖 N3 的签名与驱动接口。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 契约漂移（重写最大风险） | parity 原则五条 + 金样测试进 CI；Python 版作为参照实现保留到 N1 验收后 |
| 子进程管理细节（树击杀/超时/EPIPE） | 逐条移植 pytest 用例；POSIX 用进程组 `kill(-pid)`，Windows 用 `taskkill /T /F` |
| Windows spawn 语义差异（.cmd shim 等） | 移植 `resolve_executable` 的 PATH/PATHEXT 解析，行为与 Python 版对齐 |
| SDK API 迭代快 | package.json 锁定大版本；协议层只用到 `McpServer`/`StreamableHTTPServerTransport` 两个稳定面 |

## 6. 移植中的有意修正（与 Python 版的差异，均已记录）

1. **`validate_inputs` 失败改抛 `SkillInputError`**（Python 版抛裸 `ValueError`，
   被兜底成 "internal error" 且审计记为 failed）：消息文本不变，但审计正确记为
   `rejected`——错误分类修正，客户端可见消息不变。
2. **POSIX 杀进程树补齐**：Python 版 `_kill_tree` 在 POSIX 上 `taskkill` 不存在、
   实际只杀直接子进程；Node 版用 `detached` 进程组 + `kill(-pid, SIGKILL)` 真正杀树。
3. **`HUB_REGISTRY_PATH` / `HUB_WORKSPACE_ROOT` 环境变量覆盖**：便于测试与冒烟
   （如本机 `python`→`python3`），默认值仍来自 `config.yaml`，不影响与 Python 版共用配置。
4. **GET /mcp 的 SSE 长流暂返回 405**：无状态模式的协议允许行为；需要服务端推送时
   （N2 的 SSE）再启用有状态会话。
5. **工具结果暂以 JSON 文本承载**（`content[].text`）：信息与 Python 版的
   structured content 等价；N1 对齐时按客户端实测决定是否启用 `structuredContent`。
6. **测试运行器 vitest → node:test**：本机（8 核、负载常驻 60+）上 vitest
   的 runner 子进程病理性地在子进程事件回调中空转（sample 栈确认），无法出结果。
   vitest 风格断言由 `test/expect.ts` 兼容垫片提供
   （toBe/toEqual/toMatchObject/toThrow/rejects/expect.any）。
7. **tsx 移出运行路径**：tsx 会给 `spawn` 出的每个 node 子进程（包括技能子进程
   与 node:test 的文件级子进程）注入 `--require tsx` 加载器，在高负载机器上
   每个子进程启动退化为数十秒级。因此所有脚本统一 `tsc` 编译到 `dist/` 后用
   纯 `node` 运行（`npm start/test/smoke`），技能子进程保持干净的 plain node。
8. **异步作业语义 Node 先行**（原 N2 的 JobStore 语义提前到 N0.5 落地）：
   `run_skill` 新增 `run_mode: sync|async`（默认 sync，向后兼容），async 校验
   快失败后立即返回 `{job_id}`，`get_job`/`list_jobs` 查询；作业经同一个全局
   信号量与同一套审计策略（审计动作与同步路径逐字段一致：SkillHubError→
   rejected，其他→failed，成功→success）。JobStore 为内存实现（重启即失），
   N2 换 SQLite 时保持同一记录形状。`v` 字段为 envelope 带内契约版本号，
   由 hub 强制盖戳（永不取自技能输出），两端实现已同步。
