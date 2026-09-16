# skill-hub Node 版（N0 · MVP）

skill-hub 服务端的 Node.js/TypeScript 实现，与根目录的 Python/FastMCP 版本
**协议契约完全一致**（MCP 工具面、envelope、registry.yaml、审计格式）。
方案与里程碑见 [docs/NODE-PLAN.md](../docs/NODE-PLAN.md)。

当前为 N0/N0.5：`list_skills` / `describe_skill` / `run_skill`（支持
`run_mode: "async"`）+ `get_job` / `list_jobs` 五个工具 + 脚本型技能执行 +
Streamable HTTP + Bearer 认证。Agent 型技能与 first-class 动态工具在 N1
落地（调用会得到明确的 "planned milestone N1" 错误）。

## 使用

```bash
npm install
npm test                 # 编译到 dist/ 并跑 node:test 套件（50 用例）
npm start                # 编译并启动，读取仓库根的 config.yaml / registry.yaml
npm run smoke            # 对运行中的服务做端到端冒烟（默认 127.0.0.1:8811）
npm run parity -- <urlA> <tokenA> <urlB> <tokenB>   # 与 Python 版逐工具对比
```

- 令牌：`HUB_TOKEN` 环境变量，或与 Python 版共用仓库根的 `secrets.token`。
- 测试/冒烟覆盖：`HUB_REGISTRY_PATH`、`HUB_WORKSPACE_ROOT` 环境变量。

## 与 Python 版并存

两边读取同一份 `config.yaml` / `registry.yaml` / `skills/`，写同一份
`logs/audit.jsonl`。N1 验收（parity 五原则）通过后即可切流，Python 版保留
一个版本期。

## 运行时说明

统一 `tsc` 编译到 `dist/` 后用纯 `node` 运行（不用 tsx 常驻）——tsx 会给
`spawn` 出的每个 node 子进程注入自身加载器，高负载机器上启动退化严重
（docs/NODE-PLAN.md §6 备注 7）。技能子进程因此始终是干净的 plain node。
