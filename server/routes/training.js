/**
 * 训练 API — 训练员通过 Admin UI 对话训练客服 AI
 *
 * POST /api/training/chat     — 模拟客户对话，AI 回复
 * POST /api/training/teach    — 直接教学 (Q&A)
 * POST /api/training/correct  — 纠正错误回复
 * GET  /api/training/review   — 待审核的自学习知识
 * POST /api/training/review/:id — 审核通过/拒绝
 * GET  /api/training/history  — 训练历史记录
 */

const express = require('express')
const router = express.Router()
const mongoose = require('mongoose')
const { KnowledgeBase } = require('../models/KnowledgeBase')
const QnA = require('../models/QnA')
const { ChatMessage, ChatSession } = require('../models/Chat')
const { AiSuggestion } = require('../models/AiSuggestion')
const { generateSuggestion, findRelevantKnowledge, findRelevantQnA, buildSystemPrompt, buildContextMessages, resolveLanguage } = require('../services/aiSuggest')
const embedding = require('../services/embedding')

// 训练记录 Model (内存 + 可选持久化)
const trainingHistory = []

// ── 数据查询检测 + MongoDB 上下文构建 ─────────────────────
const DATA_KEYWORDS = [
  '몇 건', '몇건', '얼마나', '통계', '분석',
  '어제', '오늘', '이번 주', '지난주', '최근',
  '다少', '多少', '几条', '统计', '昨天', '今天', '本周', '上周', '最近',
  'how many', 'yesterday', 'today', 'last week', 'this week', 'recent', 'statistics', 'stats',
  'report', '보고서', '리포트', '报告',
]

function isDataQuestion(message) {
  const lower = message.toLowerCase()
  return DATA_KEYWORDS.some(kw => lower.includes(kw))
}

async function buildDataContext(message) {
  const parts = []
  const now = new Date()

  try {
    // Yesterday
    const yesterdayStart = new Date(now)
    yesterdayStart.setDate(yesterdayStart.getDate() - 1)
    yesterdayStart.setHours(0, 0, 0, 0)
    const yesterdayEnd = new Date(yesterdayStart)
    yesterdayEnd.setHours(23, 59, 59, 999)

    // Today
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)

    // Last 7 days
    const weekStart = new Date(now)
    weekStart.setDate(weekStart.getDate() - 7)

    // Query stats
    const [
      yesterdayMsgs, yesterdayUserMsgs, yesterdaySessions,
      todayMsgs, todayUserMsgs, todaySessions,
      weekMsgs, weekUserMsgs, weekSessions,
      totalKB, totalQnA, totalLearned,
      aiSuggestionCount, linkedCount,
    ] = await Promise.all([
      ChatMessage.countDocuments({ timestamp: { $gte: yesterdayStart, $lte: yesterdayEnd } }).catch(() => 0),
      ChatMessage.countDocuments({ timestamp: { $gte: yesterdayStart, $lte: yesterdayEnd }, sender: 'user' }).catch(() => 0),
      ChatSession.countDocuments({ lastMessageTime: { $gte: yesterdayStart, $lte: yesterdayEnd } }).catch(() => 0),
      ChatMessage.countDocuments({ timestamp: { $gte: todayStart } }).catch(() => 0),
      ChatMessage.countDocuments({ timestamp: { $gte: todayStart }, sender: 'user' }).catch(() => 0),
      ChatSession.countDocuments({ lastMessageTime: { $gte: todayStart } }).catch(() => 0),
      ChatMessage.countDocuments({ timestamp: { $gte: weekStart } }).catch(() => 0),
      ChatMessage.countDocuments({ timestamp: { $gte: weekStart }, sender: 'user' }).catch(() => 0),
      ChatSession.countDocuments({ lastMessageTime: { $gte: weekStart } }).catch(() => 0),
      KnowledgeBase.countDocuments({ isActive: true }).catch(() => 0),
      QnA.countDocuments({ isActive: true }).catch(() => 0),
      KnowledgeBase.countDocuments({ source: { $in: ['auto_learn', 'training_teach', 'training_correction'] }, isActive: true }).catch(() => 0),
      AiSuggestion.countDocuments({ createdAt: { $gte: weekStart } }).catch(() => 0),
      AiSuggestion.countDocuments({ adminReplyId: { $ne: null }, createdAt: { $gte: weekStart } }).catch(() => 0),
    ])

    parts.push('=== 실시간 데이터 (Real-time Data) ===')
    parts.push(`어제 (${yesterdayStart.toISOString().split('T')[0]}):`)
    parts.push(`  - 총 메시지: ${yesterdayMsgs}건 (사용자 문의: ${yesterdayUserMsgs}건)`)
    parts.push(`  - 활성 세션: ${yesterdaySessions}개`)
    parts.push(`오늘 (${todayStart.toISOString().split('T')[0]}):`)
    parts.push(`  - 총 메시지: ${todayMsgs}건 (사용자 문의: ${todayUserMsgs}건)`)
    parts.push(`  - 활성 세션: ${todaySessions}개`)
    parts.push(`최근 7일:`)
    parts.push(`  - 총 메시지: ${weekMsgs}건 (사용자 문의: ${weekUserMsgs}건)`)
    parts.push(`  - 활성 세션: ${weekSessions}개`)
    parts.push(`  - AI 건의: ${aiSuggestionCount}건 (관리자 채택: ${linkedCount}건)`)
    parts.push(`지식베이스:`)
    parts.push(`  - KB: ${totalKB}건, QnA: ${totalQnA}건, 자동학습: ${totalLearned}건`)

    // Get recent user questions (last 20)
    const recentQuestions = await ChatMessage.find({
      sender: 'user',
      timestamp: { $gte: yesterdayStart },
    }).sort({ timestamp: -1 }).limit(20).select('text timestamp').lean().catch(() => [])

    if (recentQuestions.length > 0) {
      parts.push(`\n최근 사용자 질문 (${recentQuestions.length}건):`)
      recentQuestions.forEach((q, i) => {
        const time = new Date(q.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        parts.push(`  ${i + 1}. [${time}] ${(q.text || '').substring(0, 80)}`)
      })
    }
  } catch (err) {
    parts.push(`데이터 조회 오류: ${err.message}`)
  }

  return parts.join('\n')
}

// ── 管理员认证中间件 ──────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = process.env.CHAT_ADMIN_TOKEN
  if (!token) return next() // 未配置 token 时跳过认证 (开发模式)

  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== token) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

router.use(requireAdmin)

// ── POST /chat — 模拟客户对话 ─────────────────────────────
router.post('/chat', async (req, res) => {
  try {
    const { message, language = 'ko', history = [] } = req.body

    if (!message) {
      return res.status(400).json({ error: 'message is required' })
    }

    const lang = resolveLanguage(language)

    // 1. 搜索知识库
    let kbEntries, qnaEntries
    if (embedding.isReady()) {
      const results = await embedding.semanticSearch(message, lang, 5, 5)
      kbEntries = results.kbResults
      qnaEntries = results.qnaResults
    } else {
      kbEntries = await findRelevantKnowledge(message, lang)
      qnaEntries = await findRelevantQnA(message, lang)
    }

    // 2. 生成 AI 回复 (复用 aiSuggest 的完整上下文)
    const reply = await generateSuggestion(
      new mongoose.Types.ObjectId().toString(),  // 虚拟 sessionId (valid ObjectId)
      message,
      lang,
      null,  // no image
      20000, // 20s timeout for training (more lenient)
    )

    if (!reply) {
      return res.status(500).json({ error: 'AI generation failed' })
    }

    // 3. 记录
    const entry = {
      type: 'chat',
      question: message,
      answer: reply,
      kbHits: kbEntries.length,
      qnaHits: qnaEntries.length,
      kbTitles: kbEntries.map(kb => kb.title || ''),
      language: lang,
      timestamp: new Date(),
    }
    trainingHistory.push(entry)

    res.json({
      reply,
      kb: {
        hits: kbEntries.length,
        titles: kbEntries.map(kb => kb.title || ''),
        qnaHits: qnaEntries.length,
      },
    })
  } catch (err) {
    console.error('[Training] chat error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /teach — 直接教学 ─────────────────────────────────
router.post('/teach', async (req, res) => {
  try {
    const { question, answer, language = 'ko', keywords = [] } = req.body

    if (!question || !answer) {
      return res.status(400).json({ error: 'question and answer are required' })
    }

    const lang = resolveLanguage(language)

    // 提取关键词 (如果没提供)
    let kws = keywords
    if (kws.length === 0) {
      kws = extractKeywords(question)
    }

    // 写入 KB
    const kb = await KnowledgeBase.create({
      language: lang,
      title: question.substring(0, 100),
      keywords: kws,
      contentHtml: answer,
      source: 'training_teach',
      isActive: true,
    })

    // 同时写入 QnA
    const qnaData = {
      question: { [lang]: question },
      answer: { [lang]: answer },
      isActive: true,
    }
    await QnA.create(qnaData)

    // 刷新 embedding 缓存
    if (embedding.isReady()) {
      embedding.refreshCache()
    }

    // 记录
    trainingHistory.push({
      type: 'teach',
      question,
      answer,
      language: lang,
      kbId: kb._id,
      timestamp: new Date(),
    })

    res.json({
      status: 'ok',
      message: `已学习: ${question.substring(0, 50)}...`,
      kbId: kb._id,
    })
  } catch (err) {
    console.error('[Training] teach error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /correct — 纠正回复 ──────────────────────────────
router.post('/correct', async (req, res) => {
  try {
    const { question, wrongAnswer, correctAnswer, language = 'ko' } = req.body

    if (!question || !correctAnswer) {
      return res.status(400).json({ error: 'question and correctAnswer are required' })
    }

    const lang = resolveLanguage(language)
    const kws = extractKeywords(question)

    // 创建新的 KB 条目 (正确答案)
    const kb = await KnowledgeBase.create({
      language: lang,
      title: question.substring(0, 100),
      keywords: kws,
      contentHtml: correctAnswer,
      source: 'training_correction',
      isActive: true,
    })

    // 刷新缓存
    if (embedding.isReady()) {
      embedding.refreshCache()
    }

    trainingHistory.push({
      type: 'correct',
      question,
      wrongAnswer: wrongAnswer || '',
      correctAnswer,
      language: lang,
      kbId: kb._id,
      timestamp: new Date(),
    })

    res.json({
      status: 'ok',
      message: '已纠正并学习',
      kbId: kb._id,
    })
  } catch (err) {
    console.error('[Training] correct error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /review — 待审核的自学习知识 ──────────────────────
router.get('/review', async (req, res) => {
  try {
    const pending = await KnowledgeBase.find({
      source: { $in: ['auto_learn', 'training_teach', 'training_correction'] },
      reviewStatus: 'flagged',
      isActive: true,
    }).sort({ createdAt: -1 }).limit(50)

    res.json({ entries: pending, count: pending.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /review/:id — 审核通过/拒绝 ──────────────────────
router.post('/review/:id', async (req, res) => {
  try {
    const { action } = req.body // 'approve' | 'reject'
    const kb = await KnowledgeBase.findById(req.params.id)

    if (!kb) {
      return res.status(404).json({ error: 'not found' })
    }

    if (action === 'approve') {
      kb.reviewStatus = 'active'
      await kb.save()
      res.json({ status: 'approved' })
    } else if (action === 'reject') {
      kb.isActive = false
      kb.reviewStatus = 'archived'
      await kb.save()
      res.json({ status: 'rejected' })
    } else {
      res.status(400).json({ error: 'action must be approve or reject' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /history — 训练历史 ────────────────────────────────
router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200)
  const recent = trainingHistory.slice(-limit).reverse()
  res.json({ entries: recent, total: trainingHistory.length })
})

// ── GET /stats — 训练统计 ──────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [kbCount, qnaCount, learnedCount] = await Promise.all([
      KnowledgeBase.countDocuments({ isActive: true }),
      QnA.countDocuments({ isActive: true }),
      KnowledgeBase.countDocuments({ source: { $in: ['auto_learn', 'training_teach', 'training_correction'] }, isActive: true }),
    ])

    const chatCount = trainingHistory.filter(h => h.type === 'chat').length
    const teachCount = trainingHistory.filter(h => h.type === 'teach').length
    const correctCount = trainingHistory.filter(h => h.type === 'correct').length

    res.json({
      kb: { total: kbCount, qna: qnaCount, learned: learnedCount },
      training: { chats: chatCount, teaches: teachCount, corrections: correctCount, total: trainingHistory.length },
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── 辅助函数 ───────────────────────────────────────────────
function extractKeywords(text) {
  // 简单的韩语/中文关键词提取
  const words = text
    .replace(/[^\w\s가-힣一-龥]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)

  // 去重
  return [...new Set(words)].slice(0, 10)
}

// ── POST /smart-chat — 直接调代理 (带 MCP 工具) ──────────
router.post('/smart-chat', async (req, res) => {
  try {
    const { message, language = 'ko' } = req.body
    if (!message) {
      return res.status(400).json({ error: 'message is required' })
    }

    const https = require('https')
    const http = require('http')

    // 调用本地代理 (gemini2openai.js on port 3002)
    const proxyBody = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: message }] }],
      config: {
        maxOutputTokens: 2048,
        temperature: 0.3,
        systemInstruction: `你是 DeepLink GPU 클라우드 서비스的客服训练助手。你有以下能力:
1. 回答客服问题 (使用 mcp_kb_search 搜索知识库)
2. 查询数据统计 (使用 mcp_chat_stats, mcp_chat_logs_query)
3. 分析 AI 质量 (使用 mcp_ai_quality_report)
4. 发现知识库缺口 (使用 mcp_frequent_questions)
5. 管理知识库 (使用 mcp_kb_list, mcp_kb_add, mcp_kb_teach)

请根据用户问题自动选择合适的工具。回答要简洁、准确。
如果是数据类问题，先调用工具获取数据再回答。
如果是客服类问题，先搜索知识库再回答。
回答语言跟随用户使用的语言。`,
      },
    })

    const result = await new Promise((resolve, reject) => {
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: 3002,
        path: '/v1beta/models/claude:generateContent',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(proxyBody),
        },
        timeout: 45000,
      }, (proxyRes) => {
        proxyRes.setEncoding('utf8')
        let data = ''
        proxyRes.on('data', chunk => data += chunk)
        proxyRes.on('end', () => resolve(data))
      })
      proxyReq.on('error', reject)
      proxyReq.on('timeout', () => {
        proxyReq.destroy()
        reject(new Error('Proxy timeout'))
      })
      proxyReq.write(proxyBody)
      proxyReq.end()
    })

    const geminiResp = JSON.parse(result)
    const reply = geminiResp.candidates?.[0]?.content?.parts
      ?.map(p => p.text || '').join('') || ''

    if (!reply) {
      return res.status(500).json({ error: 'No response' })
    }

    trainingHistory.push({
      type: 'chat',
      question: message,
      answer: reply,
      source: 'smart-proxy',
      language,
      timestamp: new Date(),
    })

    res.json({ reply, source: 'smart-proxy' })
  } catch (err) {
    console.error('[Training] smart-chat error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /gemini-chat — 通过 Gemini CLI 对话 ──────────────
router.post('/gemini-chat', async (req, res) => {
  try {
    const { message, language = 'ko' } = req.body
    if (!message) {
      return res.status(400).json({ error: 'message is required' })
    }

    const { execFile } = require('child_process')
    const path = require('path')

    // Gemini CLI wrapper script path
    const wrapperPath = path.resolve(__dirname, '../../scripts/gemini-wrapper.sh')
    const fs = require('fs')

    if (!fs.existsSync(wrapperPath)) {
      return res.status(501).json({ error: 'Gemini CLI not configured' })
    }

    // Run gemini -p in headless mode
    const timeoutMs = 30000
    const result = await new Promise((resolve, reject) => {
      const child = execFile('bash', [wrapperPath, '-p', message], {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: Object.assign({}, process.env, {
          PATH: (process.env.HOME || '/home/dbc') + '/node22/bin:' +
                (process.env.HOME || '/home/dbc') + '/.npm-global/bin:' +
                (process.env.PATH || ''),
          GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL || 'http://localhost:3002',
          GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'proxy-mode',
          TERM: 'dumb', // No TUI formatting
        }),
        cwd: path.resolve(__dirname, '../..'),
      }, (err, stdout, stderr) => {
        if (err && err.killed) {
          reject(new Error('Gemini CLI timeout'))
        } else if (err) {
          // Still return stdout if available
          resolve(stdout || stderr || err.message)
        } else {
          resolve(stdout)
        }
      })
    })

    // Clean ANSI escape codes and MCP error messages
    let reply = result
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // ANSI escapes
      .replace(/\[MCP error\].*\n?/g, '')      // MCP errors
      .replace(/MCP issues detected.*\n?/g, '') // MCP warnings
      .replace(/Error during discovery.*\n?/g, '')
      .trim()

    if (!reply) {
      return res.status(500).json({ error: 'No response from Gemini CLI' })
    }

    // Log training
    trainingHistory.push({
      type: 'chat',
      question: message,
      answer: reply,
      source: 'gemini-cli',
      language,
      timestamp: new Date(),
    })

    res.json({ reply, source: 'gemini-cli' })
  } catch (err) {
    console.error('[Training] gemini-chat error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
