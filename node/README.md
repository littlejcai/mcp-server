# skill-hub Node 版（N2 · 地基）

skill-hub 服务端的 Node.js/TypeScript 实现，与根目录的 Python/FastMCP 版本
**协议契约完全一致**（MCP 工具面、envelope、registry.yaml、审计格式）。
方案与里程碑见 [docs/NODE-PLAN.md](../docs/NODE-PLAN.md)。

当前为 N2（地基）：server/api/core 三层定型 + REST API 出口 + SQLite
JobStore + `skillhub` CLI。MCP 面保持 N1 能力：`list_skills` /
`describe_skill` / `run_skill`（`run_mode: "async"`）+ `get_job` /
`list_jobs` + first-class 独立工具 + 脚本型与 Agent 型技能执行 +
Streamable HTTP + Bearer 认证。

## 使用

```bash
npm install
npm test                 # 编译到 dist/ 并跑 node:test 套件（87 用例）
npm start                # 编译并启动，读取仓库根的 config.yaml / registry.yaml
npm run smoke            # 对运行中的服务做端到端冒烟（默认 127.0.0.1:8811）
npm run parity -- <urlA> <tokenA> <urlB> <tokenB>   # 与 Python 版逐工具对比
npm run cli -- list      # 本机 CLI：list / describe / run / jobs / job
```

- 令牌：`HUB_TOKEN` 环境变量，或与 Python 版共用仓库根的 `secrets.token`。
- 测试/冒烟覆盖：`HUB_REGISTRY_PATH`、`HUB_WORKSPACE_ROOT` 环境变量。
- 作业存储：`config.yaml` 的 `job_store.type`（默认 `sqlite`，持久化到
  `./logs/jobs.db`；`memory` 恢复 N0.5 的进程内语义）。

## REST API（N2）

与 MCP 同一执行核，同一 envelope / 作业记录 / 错误语义（Bearer 鉴权同上）：

| 端点 | 语义 |
| --- | --- |
| `GET /api/skills` | 技能目录（同 `list_skills`） |
| `GET /api/skills/:skillId` | 单技能 schema（同 `describe_skill`；未知 404） |
| `POST /api/skills/:skillId/run` | 执行（同 `run_skill`；`run_mode: async` 返回 202 + job handle） |
| `GET /api/jobs?limit=` | 最近作业（同 `list_jobs`） |
| `GET /api/jobs/:jobId` | 单作业（同 `get_job`；未知 404） |

错误映射：未知技能/作业 404，输入违规/路径逃逸 400，无/错 token 401，内部 500。

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

## 分层（N2 定型）

```
src/core/    执行核：hub / runner / agent_runner / registry / security /
             envelope / audit / jobs（接口 + 内存实现）/ sqlite_jobs
src/api/     API 出口：mcp.ts（MCP 工具注册）/ rest.ts（REST 路由）
src/server/  装配：app.ts / config.ts / paths.ts / main.ts
src/cli.ts   skillhub CLI
```

## 运行时说明

统一 `tsc` 编译到 `dist/` 后用纯 `node` 运行（不用 tsx 常驻）——tsx 会给
`spawn` 出的每个 node 子进程注入自身加载器，高负载机器上启动退化严重
（docs/NODE-PLAN.md §6 备注 7）。技能子进程因此始终是干净的 plain node。
SQLite 使用内置 `node:sqlite`（实验性特性，入口已主动抑制警告）。
