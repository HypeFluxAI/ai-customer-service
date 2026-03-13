# AI Customer Service Desktop Automation

KakaoTalk 桌面自动客服系统 — 截图分析 + AI 回复 + 知识库自进化

## 架构

```
截图 → 差异检测 → Claude Vision 分析 → 知识库检索 → AI 回复生成 → 桌面自动化发送
                                                                    ↓
                                                              自学习积累知识
```

## 快速开始

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 配置 API Key
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY

# 3. 修改 config.yaml
# - kakao.window_title_pattern: 你的 KakaoTalk 聊天室名
# - kakao.bot_account_name: 你的客服账号名

# 4. 导入知识库
python run.py --import knowledge.pdf
python run.py --import-dir data/knowledge/

# 5. 测试截图
python run.py --test-capture

# 6. 测试 Vision 分析
python run.py --test-vision data/screenshots/test_capture.png

# 7. 启动服务
python run.py
```

## 命令

| 命令 | 说明 |
|------|------|
| `python run.py` | 启动自动客服 |
| `python run.py --import FILE` | 导入知识库文件 |
| `python run.py --import-dir DIR` | 批量导入目录 |
| `python run.py --test-capture` | 测试窗口截图 |
| `python run.py --test-vision IMG` | 测试 AI 截图分析 |

## 支持的知识库格式

PDF, DOCX, TXT, Markdown, CSV, Excel (.xlsx), JSON

## 安全机制

- **Kill Switch**: `Ctrl+Shift+Q` 立即停止
- **速率限制**: 10秒/1条，1小时/20条
- **连续回复上限**: 连续 5 条后暂停
- **人工升级**: 检测到 "관리자/환불/불만" 等关键词自动跳过
- **内容过滤**: 不回复含钱包地址、密码等敏感内容
- **窗口验证**: 每次操作前验证目标窗口

## 自学习

- 成功的 Q&A 对在 5 分钟后自动学习
- 过滤敏感信息（钱包地址、Email 等）
- 学习内容优先级低于手动导入的知识库
- 审计日志: `data/conversations/learned.jsonl`

## 项目结构

```
core/        主引擎和状态机
capture/     窗口检测、截图、差异检测
analysis/    Claude Vision 分析、消息去重
knowledge/   ChromaDB 知识库、文件导入、自学习
response/    AI 回复生成、安全防护
automation/  KakaoTalk 桌面操作（鼠标/键盘）
```
