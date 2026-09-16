# skill-hub Node 版使用说明（N0.5）

> 与根目录 Python 版**契约完全一致**的 Node.js/TypeScript 服务端：
> 同一份 `registry.yaml`、同一份 `config.yaml`、同一批技能、同一份审计日志。
> 为的是后续 Web UI 与服务端统一技术栈。路线见
> [docs/NODE-PLAN.md](../docs/NODE-PLAN.md)，本篇只讲怎么用。

---

## 一、当前能力边界（N0 + N0.5）

| 能力 | 状态 |
| --- | --- |
| `list_skills` / `describe_skill` / `run_skill` 调度工具 | ✅ 可用 |
| 脚本型技能（任意语言的子进程，stdin/stdout envelope） | ✅ 可用 |
| 异步作业：`run_mode: "async"` + `get_job` / `list_jobs` | ✅ 可用（N0.5） |
| Streamable HTTP + Bearer 认证 + `/health` | ✅ 可用 |
| 全局并发限制、超时杀进程树、路径围栏、环境白名单、审计 | ✅ 可用 |
| envelope 带内契约版本号 `v: 1` | ✅ 可用（两端同步） |
| Agent 型技能（`claude -p` 驱动） | ⏳ N1（当前调用返回明确提示错误） |
| first-class 独立工具（`md_stats` 等） | ⏳ N1 |
| JobStore SQLite 持久化 / REST / UI | ⏳ N2–N4 |

## 二、架构（Node 版）

```
 外部客户端（MCP over HTTP + Bearer）
        │
        ▼
┌──────────────────────────────────────────────────┐
│ node/dist/src/main.js — 接入层（Express）          │
│  Bearer 中间件 · /health · /mcp (Streamable HTTP) │
│  无状态模式：每请求独立 McpServer + transport      │
└───────────────┬──────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────┐
│ node/src/ — 核心层（与 Python 版逐模块对应）        │
│  registry.ts → registry.yaml（共用，唯一事实源）    │
│  security.ts  路径围栏 · 环境白名单 · 脱敏          │
│  runner.ts    脚本型执行器（spawn/超时杀树/上限）    │
│  envelope.ts  请求/响应契约（与 Python 逐字段一致）  │
│  audit.ts     JSONL 审计（共用 logs/audit.jsonl）  │
└───────────────┬──────────────────────────────────┘
                ▼
   skills/（共用） · workspace/（共用）
```

| 模块 | 职责 | 对应 Python |
| --- | --- | --- |
| `src/main.ts` | 入口：装配 + 监听 | `server.py __main__` |
| `src/app.ts` | HTTP 层：Bearer、/health、/mcp、工具注册 | `server.py` |
| `src/hub.ts` | 执行核：校验→信号量→执行→审计 | `server._execute` |
| `src/runner.ts` | 脚本型执行器 | `hub/runner.py` |
| `src/registry.ts` | registry 加载 + meta-schema + 输入校验 | `hub/registry.py` |
| `src/security.ts` | PathGuard / buildEnv / scrub | `hub/security.py` |
| `src/envelope.ts` | 请求/响应 envelope | `hub/envelope.py` |
| `src/audit.ts` | JSONL 审计 | `hub/audit.py` |
| `src/config.ts` | config.yaml 加载 + env 覆盖 | （内联于 server.py） |

## 三、快速上手

```bash
cd node
npm install
npm test                          # 编译到 dist/ + 50 用例（node:test）
npm start                         # 编译并启动，默认读仓库根 config.yaml
```

启动输出：

```
[skill-hub] http://0.0.0.0:8800/mcp  (skills: 2)
[skill-hub] LAN exposure ON — clients need: Authorization: Bearer <token>
```

客户端接入方式与 Python 版完全相同：

```json
{
  "mcpServers": {
    "skill-hub": {
      "url": "http://<局域网IP>:8800/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### 异步执行长任务

`run_skill` 默认 `run_mode: "sync"`（阻塞直到完成）。慢技能（如未来的 agent
型）建议异步：

```
run_skill { skill_id, inputs, run_mode: "async" }
  → { "job_id": "job_ab12cd34ef56", "status": "queued", ... }

get_job { job_id }                     # 轮询
  → { "status": "running" | "succeeded" | "failed" | "queued",
      "envelope": { ... },             # 终态后携带响应 envelope
      "error": "..." }                 # failed 时的原因

list_jobs { limit }                    # 最近提交，新→旧
```

作业经与同步完全相同的全局并发信号量和审计策略；JobStore 目前在内存
（重启即失，N2 换 SQLite 后保持同一记录形状）。

## 四、配置与令牌

| 项 | 来源 | 说明 |
| --- | --- | --- |
| 端口 / host | 仓库根 `config.yaml` | 与 Python 版共用，改一处两端生效 |
| registry 路径 | `config.yaml` 的 `registry` | 可用环境变量 `HUB_REGISTRY_PATH` 覆盖 |
| workspace 路径 | `config.yaml` 的 `workspace_root` | 可用 `HUB_WORKSPACE_ROOT` 覆盖 |
| 并发上限 | `config.yaml` 的 `limits.global_concurrency` | 默认 1 |
| Bearer token | `HUB_TOKEN` 环境变量 → 仓库根 `secrets.token` | 与 Python 版共用同一凭据文件 |

## 五、注册技能

**完全沿用根目录 [USAGE.md](../USAGE.md) 第四～六章的规范**——脚本型/Agent 型
的选择、envelope 契约、`x-path-scope` 路径围栏、多 Action 两种模式、风险等级，
在 Node 版上逐字节一致，不在此重复。唯一区别：

- N0 阶段 Agent 型技能会返回"planned milestone N1"错误（注册不会报错，
  调用时才拒绝）；
- 脚本型技能的 `executable` 同样支持任意解释器（`python`/`python3`/`node`/
  任意 CLI），Node 版额外移植了 Windows 的 `.cmd/.bat` shim 处理。

改完 `registry.yaml` 需重启 `npm start`（与 Python 版相同，v1 不做热加载）。

## 六、验证与对比

```bash
npm run smoke -- http://127.0.0.1:8800 <token>   # 9 项端到端实弹
npm run parity -- <urlA> <tokenA> <urlB> <tokenB> # 双端逐工具对比（N1 验收门）
```

`parity` 同时连两个运行中的 hub（如 Python :8800 与 Node :8811），自动对比
`list_skills`、`describe_skill`、`run_skill` 的 envelope（剔除 `duration_ms`），
输出 PASS/FAIL——这是 N1「完全契约对齐」的验收工具。

## 七、常见问题（Node 版特有）

| 问题 | 答案 |
| --- | --- |
| 为什么不用 tsx 常驻运行？ | tsx 会给 `spawn` 出的每个 node 子进程注入自身加载器，高负载机器上子进程启动退化严重。统一 `tsc` 编译到 `dist/` 后纯 `node` 运行，技能子进程始终干净（详见 docs/NODE-PLAN.md §6 备注 7） |
| 为什么测试用 node:test 而不是 vitest？ | 本机高负载下 vitest runner 病理性空转；node:test 零 worker 更稳。断言面由 `test/expect.ts` 垫片承接，用例写法不变 |
| `run_skill` 提示 "Executable not found: python"？ | 本机 PATH 无 `python` 时，测试/冒烟用 `HUB_REGISTRY_PATH` 指向 `python3` 版 registry；正式部署确保 registry 里的 executable 在 PATH 上 |
| 和 Python 版能同时跑吗？ | 能。端口错开即可（改 config.yaml 或后续支持 env 覆盖端口）；审计写入同一份 `logs/audit.jsonl`，格式互通 |
| 两个版本怎么切换？ | N1 parity 验收（五原则）通过后直接换启动命令；对客户端零改动——URL 和 token 都不变 |

## 八、路线

| 里程碑 | 内容 |
| --- | --- |
| **N0（本篇）** | 核心回路 MVP |
| **N0.5（已完成）** | 异步作业语义 + envelope 版本号进契约；并行期治理生效 |
| N1 | AgentRunner + first-class 工具 + parity 金样 → 可切换，Python 版保留一个版本期 |
| N2 | REST 出口 + JobStore SQLite + 分层定型 |
| N3 | 授权 / scope / 上传校验 / 驱动接口 |
| N4 | **Web UI + BFF** |
| N5+ | 签名 / 分发协议 / 企业特性 / 多节点 |

详见 [docs/NODE-PLAN.md](../docs/NODE-PLAN.md)。质量数据见
[node/TEST-REPORT.md](TEST-REPORT.md)。
