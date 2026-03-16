# AI Customer Service - 项目规则

## 项目概述
KakaoTalk 桌面自动客服系统 — 截图分析 + AI 回复 + 知识库自进化
- 平台: Windows (Win32 API)
- 语言: Python 3
- AI 后端: Anthropic Claude API (Vision + Text)
- 知识库: ChromaDB + sentence-transformers

## 项目结构
```
core/        主引擎和状态机
capture/     窗口检测、截图、差异检测
analysis/    Claude Vision 分析、消息去重
knowledge/   ChromaDB 知识库、文件导入、自学习
response/    AI 回复生成、安全防护
automation/  KakaoTalk 桌面操作（鼠标/键盘）
logging_/    日志系统
tools/       辅助工具
training/    交互式训练 CLI (Python 版)
mcp/         MCP Server — 知识库服务 (Gemini CLI 集成)
api/         HTTP Chat API — Web/Telegram/外部客户端接口
.gemini/     Gemini CLI 配置、Skills、Subagents
tests/       测试
data/        数据目录（截图、对话日志、知识库）
```

## 开发规范

### 代码风格
- Python 代码使用 UTF-8 编码
- 注释和文档使用中文
- 变量名和函数名使用英文 snake_case
- 类名使用 PascalCase

### Git 工作流
- 主分支: `main`
- 每次修改后同步推送到远程 GitHub 仓库
- Commit message 使用英文，格式: `type: description`
  - feat: 新功能
  - fix: 修复
  - refactor: 重构
  - docs: 文档
  - chore: 杂项

### 安全注意事项
- 不要提交 .env 文件（含 API Key）
- 不要提交 data/ 下的用户数据
- 敏感信息（钱包地址、密码等）需要过滤

### 依赖管理
- 依赖列表在 requirements.txt
- 安装: `pip install -r requirements.txt`

### 配置
- 主配置文件: config.yaml
- 环境变量: .env (从 .env.example 复制)
- KakaoTalk 窗口标题模式: config.yaml → kakao.window_title_pattern

### AI 模型配置
- Vision 分析: claude-opus-4-20250514
- 文本生成: claude-sonnet-4-20250514

## 运行命令
- 启动服务: `python run.py`
- 交互式训练: `python run.py --train`
- 导入知识库: `python run.py --import FILE`
- 批量导入: `python run.py --import-dir DIR`
- 测试截图: `python run.py --test-capture`
- 测试 Vision: `python run.py --test-vision IMG`

## 训练模式 (training/)
交互式 CLI 训练，像聊天一样直接与客服系统对话训练:
- 直接输入问题 → 客服回复（使用完整 KB 检索 + AI 生成流程）
- `/teach Q ||| A` — 直接教学，立即写入知识库
- `/correct` — 纠正上一条错误回复并学习
- `/search` — 搜索知识库内容
- `/import FILE` — 从 Q&A JSON 批量训练
- `/export` — 导出训练记录
- 训练日志: `data/training/`

## Gemini CLI 集成
客服系统可通过 Gemini CLI 进行交互式训练:
- **MCP Server** (`mcp/kb_server.py`): 知识库检索/写入服务
- **Skill** (`.gemini/skills/deeplink-cs/`): 客服训练技能
- **Subagent** (`.gemini/agents/cs-trainer.md`): 客服训练专用 Agent
- **配置** (`.gemini/settings.json`): MCP Server + 实验性 Agent 功能
- **使用**: 在项目目录运行 `gemini`，直接对话训练客服
- **免费**: 使用 Gemini 2.5 Pro，60次/分钟，1000次/天

### Gemini CLI 训练方式
1. 直接用韩语提问 → AI 搜索知识库并回答
2. 说 "这个问题应该这样回答" → 立即学习
3. 说 "刚才答错了，正确的是..." → 纠正并学习
4. `@cs-trainer` → 启用专用训练 Agent

## Chat API Server (api/)
HTTP 接口，供 Web/Telegram/外部客户端接入:
- 启动: `python api/chat_server.py --port 8080`
- `POST /chat` — 客户对话（KB 检索 + AI 生成）
- `POST /teach` — [管理员] 教学
- `POST /correct` — [管理员] 纠正
- `GET /search?q=` — [管理员] 搜索知识库
- `GET /stats` — 知识库统计
- 管理员认证: `Authorization: Bearer $ADMIN_API_TOKEN`
- CORS 已开启，支持前端直连

## 多渠道接入架构
```
训练人员 → Gemini CLI → MCP Server → ChromaDB (训练/教学)
客户用户 → Web/Telegram → Chat API → ChromaDB + AI (对话)
客服窗口 → KakaoTalk → 截图引擎 → ChromaDB + AI (自动回复)
```

## 更新日志
- 2026-03-16: 添加 Chat API Server 多渠道接入 (api/chat_server.py)
- 2026-03-16: 添加 Gemini CLI 架构图解文档 (docs/gemini-cli-architecture.md)
- 2026-03-16: 集成 Gemini CLI (MCP Server + Skill + Subagent)
- 2026-03-16: 添加交互式训练模式 (training/cli.py)
- 2026-03-16: 创建 CLAUDE.md 项目规则文件
