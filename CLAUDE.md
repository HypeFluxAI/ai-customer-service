# AI Customer Service - 项目规则

## 项目概述
DeepLink GPU 云游戏平台 AI 客服系统 — 多渠道接入 + 知识库自进化
- 后端双语言: Node.js (聊天/KB/AI建议/质量评估) + Python (桌面自动化/MCP/训练)
- AI 后端: ZenMux API (Claude Opus/Sonnet) + Gemini 2.5 Pro
- 数据库: MongoDB (聊天/KB/QnA/AI建议) + ChromaDB (向量检索)
- 实时通信: WebSocket

## 项目结构
```
server/              Node.js 后端服务 (从 DeepLinkGame 移植)
  ├── index.js       入口文件 (Express + WebSocket)
  ├── models/        MongoDB 数据模型
  │   ├── Chat.js        聊天消息 + 会话
  │   ├── KnowledgeBase.js  知识库条目
  │   ├── QnA.js         Q&A 对 (韩/中/英)
  │   ├── AiSuggestion.js  AI 建议 + 相似度追踪
  │   └── Settings.js    管理员/站点配置/通知
  ├── routes/        API 路由
  │   ├── chat.js        聊天 API (消息/会话/图片上传)
  │   ├── knowledgebase.js  KB CRUD API
  │   ├── kakaoWebhook.js   KakaoTalk Bot Webhook
  │   ├── aiQuality.js     AI 质量分析 API
  │   ├── settings.js      管理员认证 + 系统设置
  │   └── qna.js           Q&A 常见问题 CRUD
  ├── services/      业务逻辑
  │   ├── aiSuggest.js      AI 建议生成 (ZenMux/Claude)
  │   ├── embedding.js      语义搜索 + 查询扩展
  │   ├── evaluateQuality.js  AI 质量评估
  │   ├── autoLearn.js      自动学习 (从对话中学习)
  │   ├── kbLifecycle.js    KB 生命周期 (过期/清理)
  │   ├── kakaoBot.js       KakaoTalk 三层回复策略
  │   ├── adminReplyCache.js  管理员回复缓存 (few-shot)
  │   ├── adminStyleProfile.js  管理员风格分析
  │   └── operationalContext.js  实时机器状态
  └── realtime/
      └── chatRealtime.js   WebSocket 实时聊天

── Python 服务端 (可部署到服务器) ──
core/        状态机定义
analysis/    Claude Vision 分析、消息去重
knowledge/   ChromaDB 知识库、文件导入、自学习
response/    AI 回复生成、安全防护
logging_/    日志系统
training/    交互式训练 CLI
mcp/         MCP Server — 知识库服务 (Gemini CLI 集成)
api/         Python HTTP Chat API

── Python 桌面端 (仅本地 Windows) ──
desktop/
  ├── engine.py       桌面自动化主引擎
  ├── capture/        窗口检测、截图、差异检测 (Win32 API)
  ├── automation/     KakaoTalk 桌面操作 (鼠标/键盘)
  └── tools/          窗口调试工具

── 通用 ──
.gemini/     Gemini CLI 配置、Skills、Subagents
scripts/     数据库导入脚本
tests/       测试
data/        数据目录
docs/        文档
```

## 开发规范

### 代码风格
- Python: UTF-8, snake_case, PascalCase 类名
- Node.js: camelCase, ES Module 兼容的 CommonJS
- 注释和文档使用中文

### Git 工作流
- 主分支: `main`
- 每次修改后同步推送到远程 GitHub 仓库
- Commit message 使用英文，格式: `type: description`

### 安全注意事项
- 不要提交 .env 文件（含 API Key）
- 不要提交 data/ 下的用户数据和 node_modules/
- 敏感信息（钱包地址、密码等）需要过滤

### 依赖管理
- Python: `pip install -r requirements.txt`
- Node.js: `cd server && npm install`

### 配置
- Python 配置: config.yaml
- Node.js 配置: .env 环境变量
- 环境变量模板: .env.example

### AI 模型配置
- 聊天 AI 建议: ZenMux → claude-opus-4.6
- 查询扩展/评估: ZenMux → claude-sonnet-4.5
- 桌面 Vision: claude-opus-4-20250514
- 训练模式: Gemini 2.5 Pro (免费)

## 运行命令

### Node.js 后端 (主服务)
```bash
cd server && npm install
node index.js                    # 启动后端 (HTTP + WebSocket)
node --watch index.js            # 开发模式 (自动重启)
node ../scripts/import_kb.js     # 导入初始知识库
```

### Python 服务
```bash
python run.py                    # KakaoTalk 桌面自动化
python run.py --train            # 交互式训练模式
python run.py --import FILE      # 导入知识库文件到 ChromaDB
python api/chat_server.py        # Python HTTP Chat API
```

### Gemini CLI 训练
```bash
gemini                           # 在项目目录启动 Gemini CLI
@cs-trainer                      # 使用专用训练 Agent
```

## Node.js 后端架构 (从 DeepLinkGame 移植)

### 核心功能
1. **实时聊天**: WebSocket + REST API，支持文字/图片消息
2. **AI 建议**: 客户发消息后自动生成管理员回复建议
3. **知识库**: MongoDB 存储，支持多语言 (韩/中/英)
4. **语义搜索**: 缩写词典 + LLM 查询扩展
5. **质量评估**: AI 评估管理员回复 vs AI 建议的差异
6. **自动学习**: 高质量对话自动写入知识库
7. **KB 生命周期**: 每日 03:00 清理过期/低质量条目
8. **KakaoTalk Bot**: Webhook 接入，三层回复策略
9. **管理员风格学习**: 分析管理员回复模式，模仿风格
10. **机器状态**: 实时查询可用 GPU 机器数量

### API 端点
- `POST /api/chat/message` — 客户发消息
- `GET /api/chat/sessions` — 会话列表
- `GET /api/chat/messages/:sessionId` — 历史消息
- `GET /api/kb` — 知识库列表
- `POST /api/kb` — 添加 KB 条目
- `POST /api/kakao/webhook` — KakaoTalk Bot
- `GET /api/ai-quality/stats` — AI 质量统计
- `GET /api/chat/ai-quality/stats` — AI 质量统计 (DeepLinkGame 前端别名)
- `POST /api/settings/admin/login` — 管理员登录
- `GET /api/settings/system` — 系统信息
- `WebSocket /ws/chat` — 管理员实时面板

### 训练 API (管理员)
- `POST /api/training/chat` — 模拟客户对话，AI 回复 (含 KB 检索结果)
- `POST /api/training/teach` — 直接教学 {question, answer} → 写入 KB + QnA
- `POST /api/training/correct` — 纠正 {question, correctAnswer} → 覆盖学习
- `GET /api/training/review` — 待审核的自学习知识列表
- `POST /api/training/review/:id` — 审核通过/拒绝
- `GET /api/training/history` — 训练历史记录
- `GET /api/training/stats` — 训练统计

### AI 建议流程
```
客户消息 → 异步触发 AI 建议
  ├→ KB 语义搜索 (top 3)
  ├→ QnA 匹配 (top 5)
  ├→ 对话历史 (最近 20 条)
  ├→ 管理员回复示例 (few-shot)
  ├→ 机器运行状态
  └→ Claude Opus → 生成建议 → 推送给管理员
```

### 自动学习流程
```
管理员回复 → 链接到 AI 建议 → 质量评估
  ├→ new_knowledge → 创建 KB 条目
  ├→ correction → 更新已有 KB
  ├→ style_improvement → 仅记录
  └→ no_learn → 跳过
每日 03:00 → 清理过期/低质量 KB
```

## Gemini CLI 集成
- **MCP Server** (`mcp/kb_server.py`): ChromaDB 知识库检索/写入
- **Skill** (`.gemini/skills/deeplink-cs/`): 客服训练技能
- **Subagent** (`.gemini/agents/cs-trainer.md`): 专用训练 Agent
- **使用**: `gemini` → 直接对话训练，免费 Gemini 2.5 Pro

## 部署架构
```
┌─── 云服务器 (7×24 运行) ───────────────────────────┐
│  Node.js 后端 (server/)                             │
│  ├── 聊天 API + WebSocket                           │
│  ├── KB MongoDB + AI 建议                           │
│  ├── 质量评估 + 自动学习                              │
│  └── KakaoTalk Bot Webhook                          │
│                                                     │
│  Python 服务端 (可选)                                │
│  ├── api/chat_server.py (HTTP API)                  │
│  ├── mcp/kb_server.py (MCP Server)                  │
│  └── knowledge/ + response/ + analysis/             │
└─────────────────────────────────────────────────────┘

┌─── 本地 Windows 电脑 ──────────────────────────────┐
│  Python 桌面端 (desktop/)                           │
│  ├── KakaoTalk 截图 + Win32 自动化                   │
│  └── python run.py                                  │
│                                                     │
│  Gemini CLI 训练 (终端)                              │
│  └── gemini / @cs-trainer                           │
└─────────────────────────────────────────────────────┘
```

## Web Terminal (训练员远程使用 Gemini CLI)
- 地址: `http://server:3001/terminal/terminal.html`
- 原理: xterm.js → WebSocket → node-pty → Gemini CLI
- 训练员打开浏览器即可使用完整 Gemini CLI Agent
- 认证: CHAT_ADMIN_TOKEN
- 最多 3 个并发终端会话

## MongoDB MCP Server (mcp/mongo_server.py)
Gemini CLI 通过此 MCP Server 访问 MongoDB 全量数据:
- `chat_logs_query` — 查询聊天日志
- `chat_stats` — 聊天统计分析
- `kb_list/add/update/delete` — KB CRUD
- `qna_list/add` — QnA 管理
- `ai_quality_report` — AI 质量分析报告
- `frequent_questions` — 高频未覆盖问题发掘

## 更新日志
- 2026-03-17: AI 质量优化 — 知识差距分析 API、few-shot 增至 5 条、过滤低质量示例、近期回复融合
- 2026-03-17: 补全 QnA 路由 + onAdminReply 回调，DeepLinkGame 客服功能 100% 迁移完成
- 2026-03-17: 集成 DeepLinkGame 管理后台 — Settings 路由/模型、AI Quality 别名、CORS、cookie-parser、去重 AI 建议
- 2026-03-16: Web Terminal + MongoDB MCP Server — 训练员浏览器远程训练
- 2026-03-16: 添加训练 API (server/routes/training.js) — Admin UI 对话训练
- 2026-03-16: 重构项目结构 — 服务端/桌面端分离 (desktop/)
- 2026-03-16: 从 DeepLinkGame 移植 Node.js 客服后端 (完整系统)
- 2026-03-16: 添加 Chat API Server 多渠道接入 (api/chat_server.py)
- 2026-03-16: 添加 Gemini CLI 架构图解文档 (docs/gemini-cli-architecture.md)
- 2026-03-16: 集成 Gemini CLI (MCP Server + Skill + Subagent)
- 2026-03-16: 添加交互式训练模式 (training/cli.py)
- 2026-03-16: 创建 CLAUDE.md 项目规则文件
