# skill-hub Node 版（N3 · 信任与隔离）

skill-hub 服务端的 Node.js/TypeScript 实现，与根目录的 Python/FastMCP 版本
**协议契约完全一致**（MCP 工具面、envelope、registry.yaml、审计格式）。
方案与里程碑见 [docs/NODE-PLAN.md](../docs/NODE-PLAN.md)。

当前为 N3（信任与隔离）：主体/scope/风险上限授权 + SKILL.md 上传校验 +
审计查询 API + 驱动接口。N2 地基已就位：server/api/core 三层定型 + REST
出口 + SQLite JobStore + `skillhub` CLI。MCP 面保持 N1 能力：`list_skills` /
`describe_skill` / `run_skill`（`run_mode: "async"`）+ `get_job` /
`list_jobs` + first-class 独立工具 + 脚本型与 Agent 型技能执行 +
Streamable HTTP + Bearer 认证。

## 使用

```bash
npm install
npm test                 # 编译到 dist/ 并跑 node:test 套件（126 用例）
npm start                # 编译并启动，读取仓库根的 config.yaml / registry.yaml
npm run smoke            # 对运行中的服务做端到端冒烟（默认 127.0.0.1:8811）
npm run parity -- <urlA> <tokenA> <urlB> <tokenB>   # 与 Python 版逐工具对比
npm run cli -- list      # 本机 CLI：list / describe / run / jobs / job
```

- 令牌：`HUB_TOKEN` 环境变量，或与 Python 版共用仓库根的 `secrets.token`。
- 测试/冒烟覆盖：`HUB_REGISTRY_PATH`、`HUB_WORKSPACE_ROOT` 环境变量。
- 作业存储：`config.yaml` 的 `job_store.type`（默认 `sqlite`，持久化到
  `./logs/jobs.db`；`memory` 恢复 N0.5 的进程内语义）。
- 授权：`config.yaml` 的 `authorization` 段（见下）。

## REST API（N2 + N3）

与 MCP 同一执行核，同一 envelope / 作业记录 / 错误语义（Bearer 鉴权同上）：

| 端点 | 语义 |
| --- | --- |
| `GET /api/skills` | 技能目录（同 `list_skills`） |
| `GET /api/skills/:skillId` | 单技能 schema（同 `describe_skill`；未知 404） |
| `POST /api/skills/:skillId/run` | 执行（同 `run_skill`；`run_mode: async` 返回 202 + job handle） |
| `POST /api/skills/validate` | **SKILL.md 上传第一阶段（N3）**：校验 frontmatter（name/description），只校验不落盘；合法 200，不合法 422 + 错误明细 |
| `GET /api/jobs?limit=` | 最近作业（同 `list_jobs`） |
| `GET /api/jobs/:jobId` | 单作业（同 `get_job`；未知 404） |
| `GET /api/audit?limit=&skill_id=&status=&client=` | **审计日志（N3）**：新→旧分页，支持按技能/状态/客户端过滤（上限 200 条） |

错误映射：未知技能/作业 404，授权拒绝 403，输入违规/路径逃逸 400，
校验失败 422，无/错 token 401，内部 500。

## skillhub CLI（N2）

```bash
skillhub list                        # 技能目录
skillhub describe <skill_id>         # 单技能 schema
skillhub run <skill_id> [--input k=v ...] [--no-dry-run] [--client name]
skillhub jobs [--limit N]            # 最近作业（同一 SQLite 存储，服务端提交的也可见）
skillhub job <job_id>                # 单作业
```

CLI 直连执行核（不走 HTTP、无需 token），本地开发与排障用。

## 与 Python 版并存

两边读取同一份 `config.yaml` / `registry.yaml` / `skills/`，写同一份
`logs/audit.jsonl`。N1 验收（parity 五原则）通过后即可切流，Python 版保留
一个版本期。

## 信任与隔离（N3）

**授权（主体/scope/风险上限）**：`core/authorization.ts` 的 `Authorizer` 在
Hub 执行入口检查——`config.yaml` **不配置 `authorization` 段 = 授权关闭，
一切照旧**（核心功能零回归）；一旦配置即生效：每个调用带 client 标识
（REST=「rest」、MCP run_skill=「」（未带）、first-class=「first-class:<name>」、
CLI=「cli」或 `--client` 指定），grant 控制允许的技能白名单 + 风险上限
（`read_only` < `workspace_write` < `external_write`），未列出的 client 走
`default`（缺省 = 拒绝一切）。拒绝记入审计（status: rejected）。

```yaml
authorization:
  default: { risk_limit: read_only }        # 未列出的 client 默认只读
  clients:
    "rest": { skills: [md-stats, note-worthiness], risk_limit: workspace_write }
    "":      { risk_limit: workspace_write }  # MCP run_skill（未带 client）
```

**上传校验（第一阶段）**：`POST /api/skills/validate` 只校验 SKILL.md 的
YAML frontmatter（name 必须是合法 skill id、description 非空），不落盘、
不注册——完整上传流在 N4。

**审计查询**：`GET /api/audit` 直接读既有 `logs/audit.jsonl`，新→旧返回，
支持 `skill_id` / `status` / `client` 过滤与 `limit` 分页（默认 50，上限 200）。

**驱动接口**：`core/driver.ts` 定义 `ExecutionDriver`（run → stdout/stderr/
退出码/超时/启动错误），`ProcessDriver` 为默认实现（搬自 runner 的
spawn/进程组杀树/流式上限）；`ScriptRunner` 与 `Hub` 通过接口注入——为
N5 的容器隔离驱动预留替换位，行为与 N2 完全一致。

## 分层（N2 定型 + N3 增补）

```
src/core/    执行核：hub / runner / agent_runner / registry / security /
             envelope / audit（record + query）/ jobs / sqlite_jobs /
             authorization（N3）/ driver（N3）/ skill_validate（N3）
src/api/     API 出口：mcp.ts（MCP 工具注册）/ rest.ts（REST 路由）
src/server/  装配：app.ts / config.ts / paths.ts / main.ts
src/cli.ts   skillhub CLI
```

## 运行时说明

统一 `tsc` 编译到 `dist/` 后用纯 `node` 运行（不用 tsx 常驻）——tsx 会给
`spawn` 出的每个 node 子进程注入自身加载器，高负载机器上启动退化严重
（docs/NODE-PLAN.md §6 备注 7）。技能子进程因此始终是干净的 plain node。
SQLite 使用内置 `node:sqlite`（实验性特性，入口已主动抑制警告）。
