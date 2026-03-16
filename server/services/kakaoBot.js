const {
  findRelevantKnowledge,
  findRelevantQnA,
  buildSystemPrompt,
  buildContextMessages,
  cleanHtml,
  resolveLanguage,
  truncate,
} = require('./aiSuggest')
const { ChatMessage } = require('../models/Chat')

const OpenAI = require('openai')

const client = process.env.ZENMUX_API_KEY
  ? new OpenAI({
      baseURL: 'https://zenmux.ai/api/v1',
      apiKey: process.env.ZENMUX_API_KEY,
    })
  : null

const MODEL = process.env.ZENMUX_MODEL || 'anthropic/claude-sonnet-4.5'

const FALLBACK_MESSAGES = {
  ko: '상담원이 확인 후 답변드릴게요~ 잠시만 기다려주세요!',
  zh: '客服确认后会回复您，请稍等！',
  en: 'Our agent will check and get back to you shortly!',
}

/**
 * Three-tier reply engine for KakaoTalk (total budget: 4.5s)
 *
 * Tier 1 — KB match (< 500ms): findRelevantKnowledge() → return plain text if match
 * Tier 2 — AI generation (3.5s timeout): simplified logic, 10 history, max_tokens 500
 * Tier 3 — Fallback: "상담원이 확인 후 답변드릴게요~"
 */
async function getKakaoBotResponse(sessionId, userMessage, language) {
  const lang = resolveLanguage(language)

  // Tier 1: KB keyword match (fast)
  try {
    const kbEntries = await findRelevantKnowledge(userMessage, lang)
    if (kbEntries.length > 0) {
      const topEntry = kbEntries[0]
      const score = topEntry.score || 0
      // Only use direct KB match if score is high enough (exact title match = 3+)
      if (score >= 3 || (topEntry.title && userMessage.toLowerCase().includes(topEntry.title.toLowerCase()))) {
        const plainText = truncate(cleanHtml(topEntry.contentHtml), 800)
        if (plainText) {
          return { text: plainText, source: 'kb' }
        }
      }
    }
  } catch (err) {
    console.error('[KakaoBot] KB lookup error:', err.message)
  }

  // Tier 2: AI generation (3.5s timeout)
  if (client) {
    try {
      const result = await generateKakaoAiReply(sessionId, userMessage, lang)
      if (result) {
        return { text: result, source: 'ai' }
      }
    } catch (err) {
      console.error('[KakaoBot] AI generation error:', err.message)
    }
  }

  // Tier 3: Fallback
  return { text: FALLBACK_MESSAGES[lang] || FALLBACK_MESSAGES.ko, source: 'fallback' }
}

async function generateKakaoAiReply(sessionId, userMessage, lang) {
  const [kbEntries, qnaEntries, recentMessages] = await Promise.all([
    findRelevantKnowledge(userMessage, lang),
    findRelevantQnA(userMessage, lang),
    ChatMessage.find({ sessionId }).sort({ timestamp: -1 }).limit(10).lean(),
  ])

  const contextText = buildContextMessages(kbEntries, qnaEntries, recentMessages, lang)

  const llmMessages = [
    { role: 'system', content: buildSystemPrompt(lang) },
  ]

  if (contextText) {
    llmMessages.push({
      role: 'system',
      content: `Reference context:\n\n${contextText}`,
    })
  }

  // Add conversation history (oldest first), limit to 10
  const history = recentMessages.reverse()
  for (const msg of history) {
    llmMessages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text || '[Image]',
    })
  }

  // Add current user message if not already in history
  const lastMsg = history[history.length - 1]
  if (!lastMsg || lastMsg.text !== userMessage) {
    llmMessages.push({ role: 'user', content: userMessage })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3500)

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: llmMessages,
      max_tokens: 500,
      temperature: 0.4,
    }, { signal: controller.signal })

    return completion.choices?.[0]?.message?.content?.trim() || null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Format response as Kakao i Open Builder JSON
 */
function formatKakaoResponse(text, quickReplies = []) {
  const response = {
    version: '2.0',
    template: {
      outputs: [
        {
          simpleText: { text },
        },
      ],
    },
  }

  if (quickReplies.length > 0) {
    response.template.quickReplies = quickReplies.map((label) => ({
      messageText: label,
      action: 'message',
      label,
    }))
  }

  return response
}

module.exports = {
  getKakaoBotResponse,
  formatKakaoResponse,
}
