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

## 更新日志
- 2026-03-16: 添加交互式训练模式 (training/cli.py)
- 2026-03-16: 创建 CLAUDE.md 项目规则文件
