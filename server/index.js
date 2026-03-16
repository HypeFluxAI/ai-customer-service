#!/usr/bin/env node
/**
 * AI Customer Service Backend Server
 *
 * 整合 DeepLinkGame 的客服后端:
 * - Express HTTP API (聊天、KB、AI 质量)
 * - WebSocket 实时通信 (管理员面板)
 * - AI 建议系统 (ZenMux/Claude)
 * - 知识库管理 + 自动学习
 * - KakaoTalk Bot Webhook
 * - 管理员风格学习
 * - 机器运行状态上下文
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') })

const express = require('express')
const cors = require('cors')
const http = require('http')
const mongoose = require('mongoose')
const path = require('path')

const app = express()
const server = http.createServer(app)

// ── Middleware ───────────────────────────────────────────────
app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// 静态文件 (上传的图片等)
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')))

// ── Routes ──────────────────────────────────────────────────
const chatRoutes = require('./routes/chat')
const kbRoutes = require('./routes/knowledgebase')
const kakaoWebhook = require('./routes/kakaoWebhook')
const aiQualityRoutes = require('./routes/aiQuality')
const trainingRoutes = require('./routes/training')

app.use('/api/chat', chatRoutes)
app.use('/api/kb', kbRoutes)
app.use('/api/kakao', kakaoWebhook)
app.use('/api/ai-quality', aiQualityRoutes)
app.use('/api/training', trainingRoutes)

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ai-customer-service',
    uptime: process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  })
})

// ── WebSocket ───────────────────────────────────────────────
const { initChatWebSocket } = require('./realtime/chatRealtime')
initChatWebSocket(server)

// ── Services Init ───────────────────────────────────────────
const { initEmbeddingService } = require('./services/embedding')
const { initAdminReplyCache } = require('./services/adminReplyCache')
const { initAdminStyleProfile } = require('./services/adminStyleProfile')
const { initOperationalContext } = require('./services/operationalContext')
const { initKbLifecycle } = require('./services/kbLifecycle')

// ── MongoDB + Start ─────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/ai-customer-service'
const PORT = process.env.PORT || 3001

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log(`[MongoDB] Connected: ${MONGO_URI}`)

    // 初始化各服务
    try {
      await initEmbeddingService()
      console.log('[Embedding] Service initialized')
    } catch (e) {
      console.warn('[Embedding] Init warning:', e.message)
    }

    try {
      await initAdminReplyCache()
      console.log('[AdminReplyCache] Initialized')
    } catch (e) {
      console.warn('[AdminReplyCache] Init warning:', e.message)
    }

    try {
      await initAdminStyleProfile()
      console.log('[AdminStyleProfile] Initialized')
    } catch (e) {
      console.warn('[AdminStyleProfile] Init warning:', e.message)
    }

    try {
      await initOperationalContext()
      console.log('[OperationalContext] Initialized')
    } catch (e) {
      console.warn('[OperationalContext] Init warning:', e.message)
    }

    try {
      initKbLifecycle()
      console.log('[KbLifecycle] Initialized')
    } catch (e) {
      console.warn('[KbLifecycle] Init warning:', e.message)
    }

    // 启动 HTTP + WebSocket
    server.listen(PORT, () => {
      console.log()
      console.log('═══════════════════════════════════════════════')
      console.log('  AI Customer Service Backend')
      console.log('═══════════════════════════════════════════════')
      console.log(`  HTTP API:    http://localhost:${PORT}/api`)
      console.log(`  WebSocket:   ws://localhost:${PORT}/ws/chat`)
      console.log(`  Health:      http://localhost:${PORT}/api/health`)
      console.log()
      console.log('  Endpoints:')
      console.log('    POST /api/chat/message      — 客户发消息')
      console.log('    GET  /api/chat/sessions     — 会话列表')
      console.log('    GET  /api/kb                — 知识库列表')
      console.log('    POST /api/kakao/webhook     — KakaoTalk Bot')
      console.log('    GET  /api/ai-quality/stats  — AI 质量统计')
      console.log('    POST /api/training/chat     — 训练对话')
      console.log('    POST /api/training/teach    — 训练教学')
      console.log('    POST /api/training/correct  — 训练纠正')
      console.log('═══════════════════════════════════════════════')
      console.log()
    })
  })
  .catch(err => {
    console.error('[MongoDB] Connection failed:', err.message)
    process.exit(1)
  })

// 优雅退出
process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await mongoose.disconnect()
  server.close()
  process.exit(0)
})

process.on('unhandledRejection', (err) => {
  console.error('[Unhandled Rejection]', err)
})
