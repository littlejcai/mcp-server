# skill-hub 使用说明

> 把你本地散落的脚本、CLI、SKILL.md 技能，统一包装成 MCP 工具，
> 供 Notion / 手机端 / 网页 agent 这类**加载不了本地 Skill 的客户端**调用。

---

## 一、整体架构

```
 外部客户端                       你的局域网（手机 / 平板 / 其他电脑）
┌─────────────────────────────┐
│ Notion · 手机 Agent · 网页   │
│ Agent · Claude/Cherry Studio│
└──────────────┬──────────────┘
               │  ① MCP over HTTP (Streamable HTTP)
               │  ② Authorization: Bearer <token>
               ▼
┌─────────────────────────────────────────────────────┐
│                server.py  —  接入层                   │
│  ┌───────────────┐ ┌──────────────┐ ┌─────────────┐ │
│  │ Bearer 鉴权    │ │  工具面       │ │ 限流/并发=1  │ │
│  │ (中间件/401)   │ │  5 个 MCP 工具│ │  信号量      │ │
│  └───────────────┘ └──────┬───────┘ └─────────────┘ │
└──────────────────────────┼──────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────┐
│             hub/  —  核心层（纯 Python 库）            │
│                                                     │
│  registry.py ──► registry.yaml（技能目录,唯一事实源）  │
│      │            · input_schema 校验                │
│      │            · x-path-scope 路径围栏             │
│      ▼                                              │
│  security.py   路径围栏 · 环境变量白名单 · 脱敏         │
│      │                                              │
│      ▼                                              │
│  ┌──────────────────┐    ┌─────────────────────┐    │
│  │ runner.py        │    │ agent_runner.py     │    │
│  │ 脚本型执行器      │    │ Agent 型执行器       │    │
│  │ argv数组+stdin    │    │ claude -p 无头模式   │    │
│  │ 超时杀进程树      │    │ allowedTools 白名单  │    │
│  └────────┬─────────┘    └──────────┬──────────┘    │
│           └──────────┬──────────────┘               │
│                      ▼                              │
│           audit.py  JSONL 审计日志                   │
└──────────────────────┼──────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────┐
│  skills/            技能本体（run.py 或 SKILL.md）     │
│  workspace/         inbox / output / temp（围栏根）   │
└─────────────────────────────────────────────────────┘
```

### 模块清单

| 模块 | 职责 | 你会改它吗 |
| --- | --- | --- |
| `server.py` | 接入层：MCP 工具面、鉴权、HTTP | 一般不改 |
| `hub/registry.py` | 加载并校验 registry.yaml、输入校验 | 不改 |
| `hub/runner.py` | 脚本型技能执行器 | 不改 |
| `hub/agent_runner.py` | Agent 型技能执行器（驱动 Claude Code CLI） | 不改 |
| `hub/security.py` | 路径围栏、环境变量白名单、脱敏 | 不改 |
| `hub/envelope.py` | 请求/响应契约 | 不改 |
| `hub/audit.py` | JSONL 审计日志 | 不改 |
| **`registry.yaml`** | **技能目录——注册技能只改这里** | ✅ 经常改 |
| **`skills/<id>/`** | **技能本体** | ✅ 经常改 |
| `config.yaml` | 端口、workspace、并发数 | 偶尔改 |

---

## 二、调用全链路（时序）

```
客户端            server.py           hub/              技能进程
  │  run_skill      │                  │                   │
  ├────────────────►│ ①token 校验       │                   │
  │                 │ ②input_schema 校验 │                   │
  │                 │ ③路径围栏 resolve  │                   │
  │                 │ ④获取信号量(并发1) │                   │
  │                 ├─────────────────►│ 组装 envelope      │
  │                 │                  ├──────────────────►│ stdin: 请求 JSON
  │                 │                  │                   │ 执行…
  │                 │                  │◄──────────────────┤ stdout: 响应 envelope
  │                 │ ⑤解析 envelope    │                   │
  │                 │ ⑥写审计日志       │                   │
  │◄────────────────┤                  │                   │
  │ envelope JSON   │                  │                   │
```

任何一步失败（token 错、参数缺、路径逃逸、超时）都会在对应环节被拒绝，
技能进程根本不会被启动。

---

## 三、快速上手

```bash
# 启动（首次运行自动生成 secrets.token）
.venv/Scripts/python server.py

# 手机端需要的两样东西
cat secrets.token          # Bearer token
ipconfig                   # 局域网 IPv4，例如 10.1.34.103
```

客户端添加远程 MCP：

```json
{
  "mcpServers": {
    "skill-hub": {
      "url": "http://10.1.34.103:8800/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

工具面（5 个）：

| 工具 | 用途 |
| --- | --- |
| `list_skills` | 技能目录 |
| `describe_skill(skill_id)` | 参数 JSON Schema、超时、可用 action |
| `run_skill(skill_id, inputs, dry_run)` | 统一执行入口 |
| `md_stats` / `note_worthiness` | 一等技能的独立工具（`first_class: true` 自动生成） |

---

## 四、注册自己的技能

### 4.0 先选类型：脚本型还是 Agent 型？

```
你的技能要做什么？
│
├─ 确定性的数据处理/文件操作/调已有 CLI？
│  （清洗、统计、转换、备份…步骤固定，不需要模型判断）
│       └──► 脚本型（type: script）    快、稳、便宜、可预测
│
└─ 需要模型理解、判断、组织语言？
   （评估、总结、写作、设计…规则写在 SKILL.md 里）
        └──► Agent 型（type: agent）   灵活，但慢（10-60s）、耗 token
```

### 4.1 注册脚本型技能（四步）

**第 1 步：写入口脚本**（任何语言，示例为 Python）。
约定：**stdin 读请求 envelope，stdout 打响应 envelope**。

```python
# skills/my-cleaner/run.py
import json, sys

def main():
    request = json.loads(sys.stdin.read())   # ① 读请求
    inputs   = request["inputs"]             #    {"source_path": ..., "action": ...}
    dry_run  = request.get("dry_run", True)  #    写文件前必须检查

    # ...你的业务逻辑，路径用 hub 传来的绝对路径...

    print(json.dumps({                       # ② 打响应
        "status": "success",                 #    success | error
        "summary": "清洗了 12 条素材",         #    一句话，给模型看
        "data": {"cleaned": 12},             #    结构化结果
        "artifacts": [{"type": "markdown",
                       "path": "output/cleaned.md"}],  # 产物（如有）
        "warnings": []
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
```

**第 2 步：在 registry.yaml 注册**

```yaml
skills:
  my-cleaner:
    name: 素材清洗
    description: 对 Markdown 素材做清洗、去重、结构化
    type: script
    risk_level: workspace_write      # read_only | workspace_write | external_write
    first_class: true                # 生成同名独立工具（可选）

    runtime:
      executable: python             # 固定，调用方无法指定
      args: [skills/my-cleaner/run.py]
      working_directory: .
      timeout_seconds: 120

    input_schema:
      type: object
      properties:
        source_path:
          type: string
          x-path-scope: read         # ← 声明这是"读"路径，hub 强制围栏
        output_path:
          type: string
          x-path-scope: write        # ← "写"路径，只允许写 output/ 等声明根
      required: [source_path]

    permissions:
      filesystem:
        read:  [inbox]
        write: [output]
      network: false
      environment:
        allow: []                    # 额外环境变量白名单
```

**第 3 步：重启服务器**（registry.yaml 改动需重启生效）

**第 4 步：验证**

```bash
.venv/Scripts/python -m pytest tests/ -q     # 回归
# 然后用任意 MCP 客户端调 run_skill / my_cleaner
```

### 4.2 注册 Agent 型技能（三步）

**第 1 步：把现有 SKILL.md 放进** `skills/<id>/SKILL.md`。
模板要求见 `skills/note-worthiness/SKILL.md`：明确执行步骤、输出 envelope
的 JSON 结构、以及"最终把 envelope 写到请求指定的 result 文件"。

**第 2 步：registry.yaml 注册**

```yaml
skills:
  my-editor:
    name: 内容主编
    description: 根据素材生成选题方向和写作任务书
    type: agent
    risk_level: read_only            # v1 建议 Agent 型只做只读技能
    first_class: true

    runtime:
      provider: claude-code
      executable: claude
      skill_file: skills/my-editor/SKILL.md
      model: haiku                   # 省钱选 haiku，质量选 sonnet
      max_turns: 15                  # 限制内层 agent 的回合数
      timeout_seconds: 300
      allowed_tools:                 # ← 未列出的工具一律自动拒绝
        - Read
        - Glob
        - Grep
        - Write
```

**第 3 步：重启 + 验证**，同上。

> Agent 型的权限强制靠 `allowed_tools` 白名单（无头模式下未列出即拒绝）+
> 只允许碰 workspace。v1 没有 Docker，**不要注册会发布/发邮件/推 Git 的
> Agent 技能**——那需要容器化隔离后才有意义。

---

## 五、一个服务多个命令行为（多 Action）怎么处理

很常见：一个"素材整理服务"里有 `预览 / 整理 / 去重` 三种动作。
**规范提供两种模式，按风险是否相同来选：**

### 模式 A：action 枚举（推荐——风险相同、入口相同）

参数里声明 `action` 枚举，技能内部分发。契约层原生支持：调用方传
`inputs.action` 时，hub 会把它镜像到请求 envelope 的 `action` 字段。

```yaml
input_schema:
  type: object
  properties:
    action:
      type: string
      enum: [preview, organize, dedupe]   # ← 客户端在 describe_skill 里能看到
    source_path:
      type: string
      x-path-scope: read
  required: [action, source_path]
```

```python
inputs = request["inputs"]
action = request["action"]        # envelope 字段，或 inputs["action"]，二选一

if action == "preview":
    ...
elif action == "organize":
    ...
elif action == "dedupe":
    ...
else:
    print(json.dumps({"status": "error",
                      "summary": f"未知 action: {action}",
                      "data": {}, "artifacts": [], "warnings": []}))
    return 1
```

客户端视角：

```json
{ "skill_id": "my-cleaner", "inputs": { "action": "preview",
  "source_path": "inbox/note.md" } }
```

- ✅ 一个技能一个工具，工具列表不膨胀
- ✅ `describe_skill` 直接告诉模型有哪些动作可选
- ⚠️ 所有 action 共享同一个 risk_level 和超时

### 模式 B：多注册条目（风险不同时必须拆）

同一个入口脚本，注册成多个条目，各配各的 Schema、风险、超时：

```yaml
skills:
  materials-preview:            # 只读动作 → 可自动执行
    type: script
    risk_level: read_only
    runtime:
      executable: python
      args: [skills/materials/run.py, --mode, preview]
    input_schema: { ... }

  materials-write:              # 写入动作 → dry_run 默认开启
    type: script
    risk_level: workspace_write
    runtime:
      executable: python
      args: [skills/materials/run.py, --mode, write]
    input_schema: { ... }
```

- ✅ 风险、超时、权限按动作独立控制
- ✅ 客户端看到的工具语义更清晰（`materials_preview` vs `materials_write`）
- ⚠️ registry 条目数量 = 动作数量

### 选择规则

```
多个动作之间风险等级相同吗？
├─ 相同 ────► 模式 A（action 枚举）
└─ 不同 ────► 模式 B（按风险拆成多个注册条目）
              规则：external_write（发布/邮件/付费）永远单独拆条目，
              并等 Docker 隔离落地后再注册。
```

Agent 型技能的多动作同理：在 SKILL.md 里写"请求的 action 决定执行哪套
步骤"，或按模式 B 拆成多个 Agent 技能。

---

## 六、契约与规范汇总

### 6.1 请求 envelope（hub → 技能，stdin）

```json
{
  "request_id": "req_ab12cd34ef56",
  "action": "run",
  "skill_id": "my-cleaner",
  "inputs": { "action": "preview", "source_path": "D:\\...\\inbox\\note.md" },
  "context": { "client": "first-class:my_cleaner" },
  "dry_run": true
}
```

注意 `source_path` 是 **hub 校验围栏后的绝对路径**——技能拿到的不是调用方
原始输入，不需要（也不要）自己再拼相对路径。

### 6.2 响应 envelope（技能 → hub，stdout）

```json
{
  "status": "success",
  "summary": "已整理 12 条素材",
  "data": { "cleaned": 12 },
  "artifacts": [ { "type": "markdown", "path": "output/cleaned.md" } ],
  "warnings": []
}
```

五个键缺一不可（hub 端会自动补默认值，但规范上写全）。`summary` 是给
模型看的，写人话；`data` 是给程序看的，放结构化数据。

### 6.3 硬性规范

| 规范 | 原因 |
| --- | --- |
| 路径参数必须标 `x-path-scope: read` 或 `write` | hub 强制围栏，防目录穿越 |
| executable 只能写命令名/绝对路径，调用方不可传 | 防注入，无 shell |
| 写文件前必须检查 `dry_run` | 调用方默认 dry_run=true |
| env 只通过 `permissions.environment.allow` 声明 | 密钥不进子进程 |
| Agent 型 `allowed_tools` 最小化 | 未列出即拒绝 |
| `external_write` 技能 v1 不注册 | 无容器隔离 |

### 6.4 风险等级

| 等级 | 含义 | 审批策略 |
| --- | --- | --- |
| `read_only` | 只读，可自动执行 | 无 |
| `workspace_write` | 写 workspace 内文件 | dry_run 默认开 |
| `external_write` | 发布/邮件/Git/付费 | v1 禁止注册 |

---

## 七、常见问题

| 问题 | 答案 |
| --- | --- |
| token 在哪？ | `secrets.token` 文件，或启动前设 `HUB_TOKEN` 环境变量 |
| 改了 registry.yaml 不生效？ | 重启 server（v1 不做热加载） |
| 技能能访问网络吗？ | 没人拦（v1 无容器），但规范禁止；别把密钥放进 allow |
| 能注册 `ecology-workflow` 这类工作内网技能吗？ | 建议等 Docker 隔离后；或仅在可信局域网环境使用 |
| 手机不在同一 Wi-Fi？ | 下一步装 Tailscale，`config.yaml` 的 host 改绑 Tailscale IP 即可，代码零改动 |
| 怎么看调用记录？ | `logs/audit.jsonl`，每次调用一行 |
| 技能卡死怎么办？ | 超时后 hub 自动 `taskkill /T` 杀整棵进程树并返回错误 |

## 八、测试

```bash
.venv/Scripts/python -m pytest tests/ -q --cov=hub --cov=server    # 51 用例
cd tests/thirdparty && node verify_remote.mjs                      # 第三方客户端实测（需先启动 server）
```

详细质量数据见 `TEST-REPORT.md`。
