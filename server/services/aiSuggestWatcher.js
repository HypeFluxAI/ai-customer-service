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

// 短消息固定回复（不调 LLM，直接返回管理员常用回复）
const QUICK_REPLIES = new Map([
  // 打招呼
  ['안녕하세요', '네 안녕하세요~ 어떤 부분 도움이 필요하신가요?'],
  ['안녕하세여', '네 안녕하세요~ 어떤 부분 도움이 필요하신가요?'],
  ['안녕하세용', '네 안녕하세요~ 어떤 부분 도움이 필요하신가요?'],
  ['사장님', '네 안녕하세요~ 어떤 부분 도움이 필요하신가요?'],
  // 감사/확인
  ['네네 감사합니다', '좋은 하루 되세요~'],
  ['감사합니다', '좋은 하루 되세요~ 추가 문의 있으시면 언제든 말씀해주세요!'],
  ['답변감사합니다', '감사합니다! 더 궁금한 점 있으시면 언제든 문의해주세요~'],
  ['네 알겠습니다', '추가로 궁금한 점 있으시면 언제든지 말씀해주세요~'],
  ['네 감사합니다', '좋은 하루 되세요~'],
  ['알겠습니다', '추가로 궁금한 점 있으시면 언제든지 말씀해주세요~'],
  // 계좌이체는 getQuickReply() 에서 DB 설정으로 처리
])

// 转账关键词（匹配后从 DB 读取账号信息）
const BANK_TRANSFER_KEYWORDS = ['계좌이체', '계좌이체요', '계좌이체하고싶어요', '계좌이체 하고 싶습니다']

// 从 DB 读取的转账信息缓存
let _bankTransferInfo = null
async function getBankTransferReply() {
  // 每次从 DB 读取最新配置（或用缓存）
  if (!_bankTransferInfo) {
    const { SiteSettings } = require('../models/Settings')
    const setting = await SiteSettings.findOne({ key: 'bank_transfer_info' })
    _bankTransferInfo = setting?.value || '3333290349818 카카오뱅크 보내주시면 됩니다. 입금 후 입금자명 및 계정 아이디(로고아래 10자리) 알려주세요.'
    // 5分钟后清缓存，下次重新读
    setTimeout(() => { _bankTransferInfo = null }, 5 * 60 * 1000)
  }
  return _bankTransferInfo
}

// 短消息 — 不值得生成建议，直接跳过
const SKIP_PATTERNS = /^(네|넵|넹|ㅇㅇ|ㅋ+|ㅎ+|ㅠ+|ㅜ+|ok|ㄹ|확인|사진|네네|넵넵|\?)$/i

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
        const trimmed = text.trim()

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
    const trimmed = userMessage.trim()

    // ★ 固定回复: 打招呼/感谢 等高频短消息 + 转账信息从 DB 读取
    let quickReply = QUICK_REPLIES.get(trimmed)
    // 转账关键词 → 从 DB 读取最新账号
    if (!quickReply && BANK_TRANSFER_KEYWORDS.includes(trimmed)) {
      quickReply = await getBankTransferReply()
    }
    if (quickReply) {
      console.log(`[AI Watcher] Quick reply for: "${trimmed}"`)
      const saved = await AiSuggestion.create({
        sessionId, userMessageId: doc._id, userMessage: trimmed,
        suggestion: quickReply, language: 'ko', createdAt: new Date(),
      })
      try {
        const { broadcastToAdmins } = require('../realtime/chatRealtime')
        broadcastToAdmins({ type: 'ai_suggestion', sessionId, suggestion: quickReply, messageId: doc._id.toString(), suggestionId: saved._id.toString() })
      } catch {}
      return
    }

    // ★ 跳过无意义消息（"네"、"ㅋ"、"?" 等）
    if (SKIP_PATTERNS.test(trimmed)) return

    // 检查是否已经有未处理的建议（原系统可能也生成了）
    const existing = await AiSuggestion.findOne({
      sessionId,
      adminReplyId: null,
      createdAt: { $gte: new Date(Date.now() - 30000) }, // 30 秒内
    })

    if (existing) return

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
