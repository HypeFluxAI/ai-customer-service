/**
 * AI 建议自动生成 — 监听 MongoDB 新用户消息，自动生成 AI 建议
 *
 * 原理:
 *   1. Watch chat_messages collection via Change Stream
 *   2. 当用户发送新消息时触发
 *   3. 调用 aiSuggest.generateSuggestion() 生成建议
 *   4. 写入 ai_suggestions collection
 *   5. 通过 WebSocket 推送给管理员面板
 *
 * 这样原系统的前端会自动显示新系统生成的 AI 建议
 */

const mongoose = require('mongoose')
const { ChatMessage, ChatSession } = require('../models/Chat')
const { AiSuggestion } = require('../models/AiSuggestion')
const { generateSuggestion } = require('./aiSuggest')

let watcher = null
let isRunning = false

// 防重复: 记录最近处理过的消息 ID
const recentlyProcessed = new Set()
const MAX_RECENT = 500

// 去重 + 防抖: 同一 session 短时间内多条消息只生成一次建议
const sessionDebounce = new Map() // sessionId → timeout
const DEBOUNCE_MS = 3000 // 3 秒防抖

async function startWatcher() {
  if (isRunning) return
  isRunning = true

  const db = mongoose.connection.db
  if (!db) {
    console.error('[AI Watcher] MongoDB not connected')
    isRunning = false
    return
  }

  console.log('[AI Watcher] Starting Change Stream on chat_messages...')

  try {
    const collection = db.collection('chat_messages')

    // 只监听新插入的用户消息
    const pipeline = [
      {
        $match: {
          operationType: 'insert',
          'fullDocument.sender': 'user',
        },
      },
    ]

    watcher = collection.watch(pipeline, {
      fullDocument: 'updateLookup',
    })

    watcher.on('change', async (change) => {
      try {
        const doc = change.fullDocument
        if (!doc) return

        const msgId = doc._id.toString()
        const sessionId = doc.sessionId?.toString()
        const text = doc.text || ''

        // 跳过: 没文字、已处理、图片消息
        if (!text.trim() || !sessionId) return
        if (recentlyProcessed.has(msgId)) return

        // 跳过无意义消息（纯打招呼、单字符、表情等 — 不值得生成 AI 建议）
        const trimmed = text.trim()
        if (trimmed.length <= 3 && /^[ㄱ-ㅎㅋㅎㅠㅜ!?.~]+$/.test(trimmed)) return
        if (/^(네|넵|넹|ㅇㅇ|ㅋ+|ㅎ+|ㅠ+|ㅜ+|감사합니다|감사해요|고마워요|알겠습니다|ok|ㄹ|확인|사진)$/i.test(trimmed)) return

        recentlyProcessed.add(msgId)
        if (recentlyProcessed.size > MAX_RECENT) {
          const first = recentlyProcessed.values().next().value
          recentlyProcessed.delete(first)
        }

        // 防抖: 同一 session 3 秒内的消息只处理最后一条
        if (sessionDebounce.has(sessionId)) {
          clearTimeout(sessionDebounce.get(sessionId))
        }

        sessionDebounce.set(sessionId, setTimeout(async () => {
          sessionDebounce.delete(sessionId)
          await handleUserMessage(sessionId, text, doc)
        }, DEBOUNCE_MS))

      } catch (err) {
        console.error('[AI Watcher] Change event error:', err.message)
      }
    })

    watcher.on('error', (err) => {
      console.error('[AI Watcher] Stream error:', err.message)
      // 自动重连
      isRunning = false
      setTimeout(startWatcher, 5000)
    })

    watcher.on('close', () => {
      console.log('[AI Watcher] Stream closed')
      isRunning = false
    })

  } catch (err) {
    console.error('[AI Watcher] Failed to start:', err.message)
    isRunning = false
    setTimeout(startWatcher, 10000)
  }
}

async function handleUserMessage(sessionId, userMessage, doc) {
  try {
    // 检查是否已经有未处理的建议（原系统可能也生成了）
    const existing = await AiSuggestion.findOne({
      sessionId,
      adminReplyId: null,
      createdAt: { $gte: new Date(Date.now() - 30000) }, // 30 秒内
    })

    if (existing) {
      // 原系统已经生成了建议，跳过
      return
    }

    // 获取 session 语言
    const session = await ChatSession.findById(sessionId).lean()
    const language = session?.language || 'ko'

    console.log(`[AI Watcher] Generating suggestion for: "${userMessage.substring(0, 50)}..."`)

    // 生成 AI 建议
    const suggestion = await generateSuggestion(
      sessionId,
      userMessage,
      language,
      doc.imageUrl || null,
      15000, // 15s timeout
    )

    if (!suggestion) {
      console.log('[AI Watcher] No suggestion generated')
      return
    }

    // 写入 ai_suggestions
    const saved = await AiSuggestion.create({
      sessionId,
      messageId: doc._id,
      userMessage,
      suggestion,
      language,
      createdAt: new Date(),
    })

    console.log(`[AI Watcher] Suggestion saved: ${saved._id} → "${suggestion.substring(0, 60)}..."`)

    // 通过 WebSocket 推送给管理员（如果 chatRealtime 可用）
    try {
      const { broadcastToAdmins } = require('../realtime/chatRealtime')
      broadcastToAdmins({
        type: 'ai_suggestion',
        sessionId,
        suggestion,
        messageId: doc._id.toString(),
        suggestionId: saved._id.toString(),
      })
    } catch {
      // WebSocket 推送失败不影响主流程
    }

  } catch (err) {
    console.error('[AI Watcher] Generation error:', err.message)
  }
}

function stopWatcher() {
  if (watcher) {
    watcher.close()
    watcher = null
  }
  isRunning = false
  sessionDebounce.forEach(t => clearTimeout(t))
  sessionDebounce.clear()
}

module.exports = { startWatcher, stopWatcher }
