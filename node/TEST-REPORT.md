# skill-hub Node 版（N0 MVP）测试报告

- 日期：2026-09-16（N1 修订：AgentRunner + first-class 落地后更新）
- 被测对象：`node/` 目录 —— skill-hub 服务端的 Node.js/TypeScript 实现（N0–N1）
- 结论：**70/70 自动化测试通过（全真进程：真实子进程、真实超时杀树、真实 HTTP）；
  实弹冒烟 12/12（含 first-class 直调）；真实 Agent 技能（note-worthiness，
  内层真 Claude Code）端到端通过（42s，四维评分完整返回）；
  strict TS 零错误**

## 1. 测试环境

| 项 | 值 |
| --- | --- |
| 操作系统 | macOS 12.7.6 x64（负载常驻 60+ 的重度使用机器） |
| Node | v24.16.0（ESM，`tsc` 编译后纯 `node` 运行） |
| TypeScript | 5.9.3（strict，`--noEmit` 类型检查零错误） |
| @modelcontextprotocol/sdk | 1.30.0（服务端 Streamable HTTP + 客户端冒烟均为该 SDK） |
| express / ajv / zod / js-yaml | 4.22.3 / 8.20.0 / 3.25.76 / 4.3.2 |
| 被调技能运行时 | python3（真实 md-stats 技能脚本）；Node fixture 技能 |
| 运行器 | node:test（vitest 因本机环境病理性停滞被替换，见 §5） |

## 2. 自动化测试（70/70 通过，16 个套件）

| 测试文件 | 覆盖模块 | 用例 | 结果 |
| --- | --- | --- | --- |
| agent.test.ts（N1 新增） | agent_runner.ts（真 fake-claude 进程） | 9 | 全过 |
| app.test.ts | app.ts（HTTP 层 + MCP 工具面 + first-class） | 9 | 全过 |
| envelope.test.ts | envelope.ts（含 v 版本戳） | 10 | 全过 |
| first_class.test.ts（N1 新增） | first_class.ts（JSON Schema→zod） | 3 | 全过 |
| hub.test.ts | hub.ts（执行核） | 3 | 全过 |
| job.test.ts（N0.5 新增） | jobs.ts + hub.submit（异步作业） | 6 | 全过 |
| registry.test.ts | registry.ts | 9 | 全过 |
| runner.test.ts | runner.ts（真实子进程） | 10 | 全过 |
| security.test.ts | security.ts | 11 | 全过 |

### 关键用例与 Python 版的对应（契约保真验证）

| 用例 | 场景 | 对应 Python 用例 | 结果 |
| --- | --- | --- | --- |
| runs the fixture skill end to end | spawn 真实子进程，envelope `data.words=12` | test_script_skill_success | ✅ |
| rejects path escapes before any process | `inbox/../..` 进程启动前拒绝 | test_script_skill_escape_path_rejected | ✅ |
| rejects missing read-scope sources | 读路径必须存在 | test_script_skill_missing_source_rejected | ✅ |
| dry_run writes nothing but reports artifact | 预览不落盘 | test_script_skill_dry_run_no_write | ✅ |
| times out and reports the kill | 2s 超时，**进程树 SIGKILL** | test_timeout_raises | ✅ |
| surfaces nonzero exits with scrubbed stderr | 退出码 2 + `token=supersecret123` → `[REDACTED]` | （Python 同行为） | ✅ |
| serializes executions under the limit | 并发 2 路，最大重叠数 = 1 | test_global_semaphore_serializes_executions | ✅ |
| runs async jobs through the same global semaphore | 异步 2 路提交，最大重叠数 = 1（作业与同步共用限流） | （N0.5 新语义） | ✅ |
| submits an async job and resolves it via get_job | MCP 层异步往返：submit → 轮询 → succeeded + envelope | （N0.5 新语义） | ✅ |
| **AgentRunner 九连**：结果文件回读 / CLI 文本回退 / fenced 容错 / 退出码+脱敏 / 超时杀树 / 缺 CLI / 坏 provider / 缺 SKILL.md / 路径围栏 | 全部经 fake-claude 夹具走真实进程，与 Python test_agent_runner.py 逐条对应 | test_agent_runner.py 11 例 | ✅ |
| maps hub errors to tool errors | 未知技能 / Schema 违规 / 路径逃逸关键词一致 | test_server.py 4 例 | ✅ |
| rejects /mcp without or with wrong token | 无/错 token 均 401，timingSafeEqual 比较 | test_mcp_without_token_is_401 等 | ✅ |
| answers 405 for GET /mcp | 无状态模式协议允许行为 | （Python 为有状态 SSE，N2 对齐） | ✅ |
| symlink escape rejected | 链接在内、目标在外 → 拒绝 | test_security.py 同类 | ✅ |
| meta-schema rejects unknown runtime keys | `timeout_second` 拼写错误 → registry 拒载 | （防 typo 静默失效） | ✅ |

## 3. 实弹验证（真实服务器，非 mock，12/12 + Agent 全链路）

启动 `node dist/src/main.js`（读仓库共享 config.yaml；因本机 `python` 不在
PATH，用 `HUB_REGISTRY_PATH` 覆盖将 md-stats 的可执行改为 `python3`，
**registry.yaml 本体未改动**），以独立 MCP client（官方 TS SDK）经
HTTP + Bearer 全链路验证：

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | `GET /health` 免鉴权 | ✅ 200 `{ok:true, skills:2}` |
| 2 | 无 token / 错 token 访问 `/mcp` | ✅ 401 |
| 3 | `tools/list` 发现 7 个工具（3 调度 + 2 作业 + 2 first-class） | ✅ |
| 4 | `list_skills` 返回真实 registry 目录 | ✅ |
| 5 | `describe_skill(md-stats)` 暴露 input schema 与超时 | ✅ |
| 6 | `run_skill(md-stats)` 真实执行 Python 技能脚本（含 `v: 1` 版本戳） | ✅ |
| 7 | **first-class `md_stats` 直调**（不走 run_skill 的独立工具路径） | ✅ |
| 8 | `run_skill(async)` → `get_job` 轮询至 succeeded，envelope 完整 | ✅ |
| 9 | `list_jobs` 返回最近提交 | ✅ |
| 10 | 未知技能 → `isError=true` + "Unknown skill" | ✅ |
| 11 | 路径逃逸 `../../etc` → `isError=true` + "outside the allowed workspace" | ✅ |
| 12 | 审计日志落盘（与 Python 版共用 `logs/audit.jsonl`，格式一致） | ✅ |

**Agent 全链路（真 Claude Code 内层）**：`run_skill(note-worthiness, async)`
提交 → 内层真实 `claude -p --output-format json --max-turns 15
--allowedTools Read,Glob,Grep,Write --model haiku` 执行 → 42s 返回完整
envelope（四维评分、总分 13、两个切入角度、dry_run 警示）→ `get_job`
succeeded。与 Python 版当年的同链路验证（verdict=strong, 26–47s）互为印证。

## 4. 移植中发现并修复的问题

**第一轮（移植缺陷，全部由测试捕获）：**

| # | 级别 | 问题 | 根因与修复 |
| --- | --- | --- | --- |
| 1 | 高 | `parseEnvelope` 对以 `{` 开头的文本**无限循环**，最终 `RangeError: Invalid array length`（单用例空转 94s） | Python `rfind("{", 0, start)` 在 start=0 时返回 -1；JS `lastIndexOf` 把负 fromIndex 当作"从尾部搜索"，重新找到 0。加 `start > 0` 守卫并在代码处留移植注释 |
| 2 | 中 | ajv 严格模式报 `unknown keyword: "x-path-scope"`，带路径标注的技能全部无法校验 | Python jsonschema 按规范忽略未知关键字，ajv 默认 strict 会报错。三处实例化统一 `strict: false`，恢复标准行为 |
| 3 | 低 | expect 垫片 `.not` 无限递归；`expect.any(String)` 用 `instanceof` 匹配原始字符串恒为 false | 垫片修复：`not` 只挂一层；AnyMarker 按 typeof 匹配原始类型（与 vitest 语义一致） |

**第二轮（工具链，根因经进程栈 sample 确认）：**

| # | 级别 | 问题 | 根因与修复 |
| --- | --- | --- | --- |
| 4 | 高 | vitest runner 子进程在同一位置病理性空转（栈：`uv__wait_children → OnExit → JS 回调`），单文件 5 分钟无结果 | 本机高负载（8 核 / load 60+）下 vitest worker 的已知形态。换 **node:test** 单进程顺序执行；vitest 断言面由 `test/expect.ts` 约 200 行垫片承接 |
| 5 | 高 | 测试/服务经 tsx 运行时，`spawn` 出的每个 node 子进程（含技能子进程、node:test 文件级子进程）被注入 `--experimental-import-meta-resolve --require tsx` 加载器，高负载下子进程启动退化到分钟级 | **tsx 彻底移出运行路径**：统一 `tsc` 编译到 `dist/` 后用纯 `node` 运行（`npm start/test/smoke`）。技能子进程始终是干净的 plain node，也更接近生产形态 |
| 6 | 低 | repo 根定位用 import.meta 相对层数，编译后（dist/ 深一层）会错位 | 改为 `findRepoRoot`：从当前目录向上查找 `registry.yaml` 标记，src 与 dist 双形态均正确 |
| 7 | 低 | 作业状态快照断言竞态：submit 返回的是活引用，信号量空闲时后台执行在返回前已把状态推进到 running | 测试改为区间断言（queued ∨ running）；语义记录在案：`submit` 返回的 status 是快照，终态以 `get_job` 为准 |

## 5. 与 Python 版的有意行为差异（均已记录于 docs/NODE-PLAN.md §6）

1. `validate_inputs` 失败归类为 `SkillInputError`（审计记 `rejected` 而非 `failed`），
   客户端可见消息不变；
2. POSIX 超时用进程组 `kill(-pid, SIGKILL)` **真正杀树**（Python 版在 POSIX 上
   `taskkill` 不存在、实际只杀直接子进程）；
3. `HUB_REGISTRY_PATH` / `HUB_WORKSPACE_ROOT` 环境变量覆盖（测试/冒烟便利，
   默认值仍来自共享 config.yaml）；
4. `GET /mcp`（SSE 长流）返回 405——无状态模式的协议允许行为，N2 启用有状态会话；
5. 工具结果以 JSON 文本承载（信息与 Python 版 structured content 等价）；
6. 运行器与运行路径差异（见 §4 第 4/5 条）；
7. Agent `runtime.args` 附加在 CLI 旗标之前（Python 忽略该字段）——真实技能
   不受影响，测试夹具得以走生产代码路径；工作区 `temp/` 由 AgentRunner 自动创建；
8. first-class 注册按技能粒度容错（Python 版整个循环一个 try/catch，
   一条坏记录会吞掉后续所有工具）。

## 6. 剩余未测试项（如实清单）

- **双端 parity 跑批（Gate-NT1 最后一关）**：**已完成**（2026-09-17 本机实测：
  Python 3.12 venv 起 Python 版 :8800、Node 版 :8811，`npm run parity` 全项
  一致，PARITY OK；交集 = 5 个共同工具，Node 先行 = get_job/list_jobs）——
  已从待办移除，见 §8
- **Windows 平台**：已按 Python 版移植 PATHEXT/taskkill/大小写不敏感 containment，
  但本机为 macOS，未实机验证
- **真实 note-worthiness 已实测通过**（见 §3 Agent 全链路），但仅 macOS 单环境
- 覆盖率计量未接入（Python 版为 92%；计划接入 c8 后对齐口径）
- **Python 侧 envelope `v` 字段改动需在原 Windows 环境复跑 pytest**
  （本机无 Python 测试环境；改动为两行 + 测试同步，test_envelope.py 已更新）
- 真实第三方设备（手机/Notion 连接器）、Tailscale、浸泡测试——与 Python 版遗留项相同

## 7. 安全扫描记录（Mimosa）

- 扫描：`scan-2026-09-16T12-43-44.393Z-60bccdfbaa9f`（deep，静态分析）
- Seal：`sha256:942fda9181b0641755f40a1fbccc906bca7b6e734e19d8d29f139aed77c1257d`
- 依赖：237 包，0 命中已知漏洞
- 业务逻辑假设「敏感操作未观察到权限检查」（DELETE /mcp）：**已驳回**
  （refuted）——/mcp 全部方法处于 Bearer 中间件之后，DELETE 当前仅返回 405

**静态污点标记的人工确认（5 条 HIGH，均为"按设计即命中"）：**

| 标记 | 人工复核结论 |
| --- | --- |
| `smoke.ts` expectStatus ×3 "SSRF 入口" | 开发者本机 CLI，按参数探测**自己的** hub 是其存在目的。已加固：目标默认限 loopback/私网段，公网需显式 `HUB_SMOKE_ALLOW_PUBLIC=1`；不接受攻击者输入，非服务面 |
| `security.ts` resolve/resolveLoose "path-traversal 入口" | 这两个函数**就是防目录穿越的控件本身**（`x-path-scope` 围栏的执行点），源标记来自 env 派生的 workspace 根而非每次请求的不可信路径；逃逸/符号链接/空字节/绝对路径越界共 11 个测试用例全部通过 |

扫描器自身标注该类结果"需要人工确认真实数据流和可利用性"（static advisory）。
按其建议重构（删除 smoke 网络探测、或改写围栏控件以规避模式匹配）反而会
删除功能或削弱安全控件，故记录确认而非修改。

## 8. 结论

Gate-NT0 三条全部通过（见上版记录）；**N1 范围全部落地**：AgentRunner 与
first-class 动态工具实现并验证——自动化 70/70，实弹 12/12，真实 note-worthiness
agent 全链路通过（42s，内层真 Claude Code，四维评分完整返回）。
移植过程中测试套件累计捕获 7 个问题，其中 envelope 无限循环、tsx 子进程
加载器注入两个属于必然在真实使用中暴露的深层缺陷——契约测试先行再移植的
策略得到验证。

**切流条件（已满足）**：2026-09-17 本机同时起 Python 版（venv，:8800）与
Node 版（:8811），`npm run parity` 五条原则全部通过——tools/list 交集一致且
Node 先行工具（get_job/list_jobs）符合预期、list_skills 一致、
describe_skill(md-stats) 一致、run_skill(md-stats) envelope 逐字段一致。
Node 版即可成为唯一实现，Python 版保留一个版本期退役。

复测命令：

```bash
cd node
npm install
npm test          # 编译 + 50 用例（node:test）
npm start         # 启动服务（读仓库根 config.yaml / registry.yaml）
npm run smoke -- http://127.0.0.1:8800 <token>   # 端到端实弹（需服务已启动）
npm run typecheck # strict TS 检查
```
