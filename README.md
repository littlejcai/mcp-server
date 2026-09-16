# skill-hub

把本地散落的脚本、CLI、SKILL.md 技能统一包装成 **MCP 工具**，供
Notion / 手机端 / 网页 agent 这类加载不了本地 Skill 的客户端远程调用。

```
客户端（手机/网页/Notion）
   │ MCP over HTTP + Bearer Token
   ▼
server.py ──► hub/ ──► skills/（脚本型 run.py · Agent 型 SKILL.md）
  鉴权/工具面      │            ▲
              registry.yaml ────┘  ← 注册技能只改这里
```

- **使用说明**（架构图 / 模块图 / 时序图 / 注册规范 / 多 Action 规范）：见 [USAGE.md](USAGE.md)
- **架构设计**（第一性原理 / 目标架构 / 升级清单）：见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **产品路线图**（v0.2 地基 → v0.3 安全 → v0.4 产品化 → v1.0 开源）：见 [docs/ROADMAP.md](docs/ROADMAP.md)
- **质量数据**（53 用例 / 覆盖率 92%）：见 [TEST-REPORT.md](TEST-REPORT.md)

## 快速开始

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt

.venv/Scripts/python server.py          # 首次运行自动生成 secrets.token
curl http://127.0.0.1:8800/health       # {"ok": true, "skills": 2}
```

客户端添加远程 MCP（手机与电脑同一 Wi-Fi）：

```json
{
  "mcpServers": {
    "skill-hub": {
      "url": "http://<局域网IP>:8800/mcp",
      "headers": { "Authorization": "Bearer <secrets.token 内容>" }
    }
  }
}
```

## 工具面

| 工具 | 用途 |
| --- | --- |
| `list_skills` | 技能目录 |
| `describe_skill(skill_id)` | 参数 JSON Schema、超时、可用 action |
| `run_skill(skill_id, inputs, dry_run)` | 统一执行入口（dry_run 默认 true） |
| `<skill_id>` 独立工具 | `first_class: true` 的技能自动生成 |

内置两个示例技能：`md-stats`（脚本型，Markdown 统计）、
`note-worthiness`（Agent 型，内层 Claude Code 判断素材是否值得写）。

## 安全模型（v1 如实说明）

**强制**：无 shell（argv 数组）、路径围栏（`x-path-scope` + resolve 校验）、
最小环境变量、超时杀进程树、Bearer 鉴权、全局并发 1、JSONL 审计、错误脱敏。

**仅声明未强制**：`network: false`（无容器拦不住主动联网）、技能内部自行
open 任意路径（但 hub 传入的路径已校验）。因此 v1 **只注册无外部副作用的
技能**，`external_write`（发布/邮件/付费）等 Docker 隔离落地后再上。

## 目录

```
├── server.py          # 接入层：MCP 工具、鉴权、HTTP
├── config.yaml        # 端口 / workspace / 并发
├── registry.yaml      # 技能目录（注册技能改这里）
├── hub/               # registry / runner / agent_runner / security / audit / envelope
├── skills/            # 技能本体（run.py 或 SKILL.md）
├── workspace/         # inbox / output / temp —— 技能只能碰这里
├── tests/             # 51 用例 + tests/thirdparty（Node SDK 实测）
├── USAGE.md           # 使用说明（含架构图/模块图/时序图/注册规范）
└── TEST-REPORT.md     # 测试报告
```

## 路线图

1. **现在**：局域网 HTTP + Token，示例技能跑通
2. **下一步**：接入真实技能（obsidian 日志、写作链路）；Tailscale 实现外网可达不暴露公网
3. **之后**：Docker 隔离强制 network/filesystem；Notion 直连时上 Cloudflare Tunnel
