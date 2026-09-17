---
name: fixture-agent
description: fixture agent skill used by the Node-side AgentRunner tests
---

# 固定评审夹具

你是一个写作素材评审夹具。读取请求 envelope 中 `inputs.note_path`
指向的素材文件，按四个维度打分后给出结论。

## 输出要求

把最终结果作为 response envelope JSON 写到请求中指定的 result 文件：

```json
{
  "status": "success",
  "summary": "一句话结论",
  "data": { "verdict": "strong|ok|skip" },
  "artifacts": [],
  "warnings": []
}
```
