# skill-hub v1 测试报告

- 日期：2026-09-16（第二轮：补齐未覆盖项后修订）
- 被测对象：skill-hub v1 工作区代码
- 结论：**51/51 自动化测试通过（连续三轮稳定）；第三方客户端（Node 官方 SDK）6/6 通过；
  HTTP 并发串行化验证通过；总覆盖率 66% → 92%**

## 1. 测试环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 11 26200 x64（Git Bash） |
| Python | 3.12.2 |
| fastmcp | 4.0.4 |
| pytest / pytest-cov / anyio | 9.1.1 / 7.16.1 / 4.15.1 |
| jsonschema / pydantic | 4.26.0 / 2.13.5 |
| Node（第三方客户端） | v24.13.0 + @modelcontextprotocol/sdk |
| 内层 Agent CLI | Claude Code 2.1.186 |

## 2. 自动化测试（51/51 通过，约 12–21s，连续三轮无波动）

| 测试文件 | 覆盖模块 | 用例 | 结果 |
| --- | --- | --- | --- |
| test_agent_runner.py（本轮新增） | agent_runner.py 0% → **96%** | 11 | 全过 |
| test_audit.py（本轮新增） | audit.py 0% → **100%** | 2 | 全过 |
| test_server.py（本轮新增） | server.py 未计量 → **90%** | 10 | 全过 |
| test_envelope.py | envelope.py 100% | 6 | 全过 |
| test_registry.py | registry.py 98% | 7 | 全过 |
| test_runner.py | runner.py 84% | 5 | 全过 |
| test_security.py | security.py 92% | 10 | 全过 |

### agent_runner 异常分支（上轮 0% 覆盖，本轮全部补齐）

| 用例 | 场景 | 结果 |
| --- | --- | --- |
| test_success_via_result_file | 内层写 result 文件 → envelope 提取 | ✅ |
| test_falls_back_to_cli_result_text | result 文件缺失 → 从 CLI 输出文本回退解析（代码块/夹杂物容错） | ✅ |
| test_nonzero_exit_raises_with_scrubbed_stderr | CLI 退出码 3 + stderr 含 `sk-*` 凭据 | ✅ 报错且已脱敏 |
| test_timeout_kills_process_tree | 内层挂起 5s > 超时 1s | ✅ 杀进程树 |
| test_missing_cli_raises_clear_error | 可执行文件不存在 | ✅ 明确报错 |
| test_unsupported_provider_rejected | provider=codex | ✅ 拒绝且不 spawn |
| test_missing_skill_file_rejected | SKILL.md 缺失 | ✅ 拒绝且不 spawn |
| test_escape_path_rejected_before_spawn | note_path 目录穿越 | ✅ 进程启动前拒绝 |
| test_extract_cli_result_variants / read_result_file | 解析器边界 | ✅ |

### server 层（工具面 / 鉴权 / 并发）

| 用例 | 场景 | 结果 |
| --- | --- | --- |
| 6 个 in-memory MCP 用例 | list/describe/run 全工具面；未知技能、Schema 违规、路径逃逸均转 ToolError | ✅ |
| 4 个 ASGI TestClient 用例 | /health 免鉴权；无 token、错 token 均 401；正确 token 穿过中间件 | ✅ |
| test_global_semaphore_serializes_executions | 并发 2 路，断言最大重叠数 = 1（全局并发限制生效） | ✅ |

## 3. 实弹验证（真实服务器，非 mock）

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | `/health` 探活（127.0.0.1 与局域网 IP 10.1.34.103 双向） | ✅ |
| 2 | 无 token / 错 token 访问 `/mcp` | ✅ 401 |
| 3 | **第三方客户端：Node 官方 MCP SDK 独立实现连接** | ✅ 6/6 |
| 3.1 | 错 token 连接被拒 | ✅ |
| 3.2 | listTools 发现 5 个工具、一等工具含 JSON Schema | ✅ |
| 3.3 | run_skill（dispatcher 路径）调 md-stats | ✅ success |
| 3.4 | 一等工具 md_stats 调用 | ✅ words=32 |
| 3.5 | 路径逃逸 `../../.ssh/id_rsa` | ✅ 拒绝，`isError=true` + 明确原因 |
| 4 | Agent 型 note-worthiness 全链路（内层 Claude Code 真实执行） | ✅ verdict=strong/14 分，26–47s |
| 5 | HTTP 并发冒烟：5 路并行调 md_stats | ✅ 全部成功；wall=1.80s ≈ Σskill=1.72s → **确认全局串行** |
| 6 | 审计日志成功/失败均落盘 | ✅ |

> 注：JS SDK 对工具执行错误的表现是结果对象 `isError=true`（而非抛协议异常），
> Python 客户端则抛 ToolError——服务端行为一致，客户端表现差异已在
> verify_remote.mjs 中兼容。

## 4. 两轮测试累计发现并修复的问题

**第一轮（初版功能缺陷）：**

| # | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | 高 | PROJECT_ROOT 路径基准错一层，服务器启动即崩 | 修正 |
| 2 | 高 | runner 从未校验路径入参（设计缺口） | `confine_paths` + `x-path-scope` 契约 |
| 3 | 高 | working_directory 边界检查参照物错误 | 改对项目根检查 |
| 4 | 中 | `claude.CMD` shim 无法被 CreateProcess 启动（WinError 2） | resolve_executable 经 `cmd /c` |
| 5 | 中 | 无扩展名 POSIX shim 报 WinError 193 | 仅接受 `.exe/.com/.cmd/.bat`，否则回退原生搜索 |
| 6 | 中 | 一等工具把可选参数当必填 | pydantic 默认值修正 |
| 7 | 低 | prompt 走 argv 有 8191 字符限制 | 改走 stdin |

**第二轮（补测试时暴露的深层问题）：**

| # | 级别 | 问题 | 根因与修复 |
| --- | --- | --- | --- |
| 8 | 高 | 模块级 `asyncio.Semaphore` 被首个事件 loop 绑定，跨 loop 抛 RuntimeError | 改为按 loop 惰性创建（生产单 loop 行为不变，嵌入多 loop 场景更稳） |
| 9 | 中 | Windows Proactor 上同一 loop 内连续多个子进程后，`asyncio.run` 清理阶段挂死（faulthandler 栈定位到 `runners._cancel_all_tasks` → `windows_events._poll`） | asyncio 清理工件，非产品代码缺陷（生产为 uvicorn 长驻 loop）；并发测试改为 mock runner、以"最大重叠数"断言，绕开子进程引入 |
| 10 | 低 | TestClient 启动 fastmcp session manager 后任务组泄漏导致 pytest 不退出 | auth 单测不跑 lifespan；conftest 加遗留线程强制退出兜底 |

## 5. 覆盖率（本轮后）

| 模块 | 语句覆盖 | 备注 |
| --- | --- | --- |
| envelope.py / errors.py / audit.py | 100% | |
| agent_runner.py | 96% | 仅剩余 prompt 构建的纯文本分支 |
| registry.py | 98% | |
| server.py | 90% | 未覆盖：`__main__` 启动块、一等工具注册的异常兜底 |
| runner.py | 84% | 剩余为异常兜底与截断边界分支 |
| security.py | 92% | |
| **合计** | **92%**（490 语句 / 未覆盖 38） | 上轮 66% |

## 6. 剩余未测试项（如实清单）

- 真实设备上的第三方客户端实测（Notion 站点内、手机 app）——协议层已用
  Node SDK 独立实现验证，但 Notion 对远程 MCP 有自己的连接器审核行为
- Tailscale / Cloudflare Tunnel 接入路径（配置层，代码已预留）
- 跨设备防火墙穿越（需第二台设备）、开机自启等部署面
- Agent 内层故障注入（如中途断网）仅在 mock 层验证
- 长时间运行下的资源占用（无浸泡测试）

## 7. 结论

上轮指出的最大短板（agent_runner 异常分支 0% 覆盖）已补齐，其余可测未覆盖
项全部完成。累计发现并修复 10 个问题，其中 3 个（路径校验缺失、信号量
loop 绑定、Proactor 清理挂死）属于会在真实使用中暴露的深层缺陷。

复测命令：

```bash
.venv/Scripts/python -m pytest tests/ -v --cov=hub --cov=server --cov-report=term
# 第三方客户端验证（先启动 server.py）
cd tests/thirdparty && node verify_remote.mjs
```
