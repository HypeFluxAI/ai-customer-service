const OpenAI = require('openai')
const fs = require('fs')
const path = require('path')
const { ChatMessage } = require('../models/Chat')
const { KnowledgeBase } = require('../models/KnowledgeBase')
const QnA = require('../models/QnA')
const embedding = require('./embedding')
const adminReplyCache = require('./adminReplyCache')
const adminStyleProfile = require('./adminStyleProfile')
const operationalContext = require('./operationalContext')

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')

const client = process.env.ZENMUX_API_KEY
  ? new OpenAI({
      baseURL: 'https://zenmux.ai/api/v1',
      apiKey: process.env.ZENMUX_API_KEY,
    })
  : null

const MODEL = process.env.ZENMUX_CHAT_MODEL || 'anthropic/claude-opus-4.6'
const MAX_CONTENT_LENGTH = 2000

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || ''
  return text.substring(0, maxLen) + '...'
}

function normalizeText(value) {
  if (!value) return ''
  return String(value).toLowerCase().replace(/[^\w\s가-힣一-龥]/g, ' ').replace(/\s+/g, ' ').trim()
}

function resolveLanguage(value) {
  if (value === 'ko' || value === 'zh' || value === 'en') return value
  return 'ko'
}

async function findRelevantKnowledge(messageText, language) {
  const normalized = normalizeText(messageText)
  if (!normalized) return []

  const lang = resolveLanguage(language)

  // Try MongoDB text search first (uses text index on title + keywords)
  try {
    const textResults = await KnowledgeBase.find(
      { $text: { $search: messageText }, isActive: true, language: lang },
      { score: { $meta: 'textScore' } }
    ).sort({ score: { $meta: 'textScore' } }).limit(3)

    if (textResults.length > 0) return textResults
  } catch {
    // Text index may not exist yet — fall through to keyword matching
  }

  // Fallback: original keyword matching
  const entries = await KnowledgeBase.find({ isActive: true, language: lang })

  const scored = []
  for (const entry of entries) {
    let score = 0
    const title = normalizeText(entry.title)
    if (title && normalized.includes(title)) score += 3
    const keywords = Array.isArray(entry.keywords) ? entry.keywords : []
    for (const kw of keywords) {
      if (kw && normalized.includes(kw)) score += 2
    }
    if (score > 0) {
      scored.push({ entry, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 3).map((s) => s.entry)
}

async function findRelevantQnA(messageText, language) {
  const normalized = normalizeText(messageText)
  if (!normalized) return []

  const lang = resolveLanguage(language)
  const qnaList = await QnA.find({ isActive: true })

  const scored = []
  for (const qna of qnaList) {
    const question = normalizeText(qna.question?.[lang] || '')
    if (!question) continue

    let score = 0
    const words = normalized.split(/\s+/)
    for (const word of words) {
      if (word.length >= 2 && question.includes(word)) score += 1
    }
    if (score > 0) {
      scored.push({ qna, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 5).map((s) => s.qna)
}

function buildSystemPrompt(language) {
  const langMap = { ko: '한국어', zh: '中文', en: 'English' }
  const langName = langMap[language] || langMap.ko

  const commonRules = `- Use the provided knowledge base and Q&A context to answer accurately
- Do NOT make up information. If you are not sure, say you will check with a senior agent
- Do NOT use markdown formatting. Reply in plain text only
- CRITICAL: Keep replies SHORT — 1-2 sentences max, like the admin examples below
- Do NOT repeat the user's question back to them
- Do NOT add greetings like "안녕하세요" unless the user greets first
- Do NOT add follow-up offers like "다른 궁금하신 점 있으시면 말씀해주세요"`

  if (language === 'ko') {
    let prompt = `DeepLink 고객 상담 어시스턴트. DeepLink = 원격 PC방 GPU 임대 플랫폼.

★★★ 말투 규칙 (가장 중요) ★★★
아래 실제 상담원 답변 스타일을 그대로 따라하세요:
- "네, 리니지 클래식 PC방 혜택 적용돼요."
- "시간당 약 890~910원(580~610포인트)이며, 기기 사양별로 차이가 있어요."
- "1클라만 가능하세요"
- "환불가능하세여~"
- "현재 이용율 높아 여유기기 나올때 바로바로 임대나가는겁니다"
- "네 원격 방식입니다"

특징: 해요체, 줄임말 OK, 짧고 직접적, 이모지 금지, ~와 ! 허용, "ㅠㅠ" 허용.
절대 하지 말 것: 긴 설명, 여러 문장, "안녕하세요" 인사, "궁금하신 점" 마무리, 마크다운.

서비스 정보:
- 포인트 충전: 카드결제/계좌이체 가능. 계좌번호는 "상담원이 안내해드릴게요"로
- PC방 혜택: 넥슨(던파), 리니지 클래식 등 적용. 원격 접속이라 IP 문제 없음, 정지 사례 없음
- 2클라: 불가, 기기 2대 임대해야
- 해외: VPN 없이 직접 접속 가능, 거리에 따라 지연 가능. 거리 필터 "전체" 변경 권장
- 지원 게임: 리클, 던파, 로아, 메이플, FC온라인, 배그, 발로란트 등
- 요금: 시간당 약 835~910원 (580~610포인트), 사양별 다름. 10분 단위 임대 가능
- 환불: 장비목록 > 임대리스트 > "사용종료" 클릭 시 잔여 포인트 자동 환불 (5~10분). 카드 환불은 상담원
- 앱: deeplinkgame.com/download 또는 구글플레이 "DeepLink". 가입 없이 바로 이용
- 문제 해결: 앱 재시작 → PC 재부팅 → 다른 기기 임대 → 고객센터
- "PC 오프라인": 사용종료 후 다른 기기 임대. 포인트 자동 환불
- 라이센스/멤버십: PC방 임대에 필요 없음
- 기기 부족: 현재 이용률 높아 대기 있을 수 있음. 저녁 11시 이후, 새벽~오전에 여유. 기기 계속 증설 중
- 충전했는데 기기 없음: 포인트 소멸 안 됨, 여유 시간에 이용하면 됨

주의사항:
- "지금 바로 이용 가능" 같은 확정 표현 금지 (실시간 변동)
- 구체적 증설 일정/날짜 약속 금지
- 계좌번호, 이메일 등 개인정보 직접 제공 금지 → 상담원 안내

${commonRules}`

    // Append dynamic style directives from admin reply analysis
    const styleDir = adminStyleProfile.getStyleDirectives()
    if (styleDir) prompt += '\n\n' + styleDir

    return prompt
  }

  if (language === 'zh') {
    return `DeepLink 客服助手。DeepLink = 远程网吧 GPU 租赁平台（天堂经典、DNF 等网吧优惠）。

语气：简洁友好，像朋友聊天。不要用"尊敬的用户"等模板话。

服务信息：
- 下载：deeplinkgame.com/download 或 Google Play 搜索 "DeepLink"
- 支持游戏：天堂经典、DNF、失落的方舟、冒险岛、FC Online 等
- 问题排查：重启 App → 重启电脑 → 联系客服
- 退款：未使用积分可退，联系客服处理

${commonRules}`
  }

  return `DeepLink customer support assistant. DeepLink = remote PC bang GPU rental platform (Lineage Classic, DNF with PC bang benefits).

Tone: Friendly but concise. No filler text.

Service Info:
- Download: deeplinkgame.com/download or Google Play "DeepLink"
- Games: Lineage Classic, DNF, Lost Ark, MapleStory, FC Online, etc.
- Troubleshooting: Restart App → Restart PC → Contact Support
- Refunds: Unused points refundable — contact support

${commonRules}`
}

function cleanHtml(html) {
  if (!html) return ''
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildContextMessages(kbEntries, qnaEntries, history, language) {
  const lang = resolveLanguage(language)
  const parts = []

  if (kbEntries.length > 0) {
    parts.push('=== 참고 자료 (Knowledge Base) ===')
    for (const kb of kbEntries) {
      const content = truncate(cleanHtml(kb.contentHtml), MAX_CONTENT_LENGTH)
      parts.push(`【${kb.title}】\n${content}`)
    }
  }

  if (qnaEntries.length > 0) {
    parts.push('\n=== 자주 묻는 질문 (Q&A) ===')
    for (const qna of qnaEntries) {
      const q = qna.question?.[lang] || ''
      const a = qna.answer?.[lang] || ''
      if (q && a) {
        parts.push(`Q: ${q}\nA: ${truncate(cleanHtml(a), MAX_CONTENT_LENGTH)}`)
      }
    }
  }

  if (parts.length > 0) {
    parts.push('\n--- 위 참고 정보가 질문과 관련되면 이를 기반으로 답변하세요. 관련 없으면 DeepLink 서비스 지식으로 답변하되, 구체적 데이터를 지어내지 마세요. ---')
  }

  return parts.join('\n\n')
}

function imageUrlToBase64(imageUrl) {
  if (!imageUrl) return null
  try {
    // imageUrl is like "/uploads/chat/xxx.png" — resolve to local file
    const relativePath = imageUrl.replace(/^\/uploads\//, '')
    // Path traversal protection
    if (relativePath.includes('..') || path.isAbsolute(relativePath)) return null
    const filePath = path.resolve(UPLOADS_DIR, relativePath)
    if (!filePath.startsWith(path.resolve(UPLOADS_DIR))) return null
    if (!fs.existsSync(filePath)) return null
    const buf = fs.readFileSync(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }
    const mime = mimeMap[ext] || 'image/png'
    return { base64: buf.toString('base64'), mime }
  } catch {
    return null
  }
}

function buildMessageContent(text, imageUrl) {
  const img = imageUrlToBase64(imageUrl)
  if (!img) return text || '[Image]'

  // Multimodal content: text + image
  const content = []
  if (text) content.push({ type: 'text', text })
  content.push({
    type: 'image_url',
    image_url: { url: `data:${img.mime};base64,${img.base64}` },
  })
  return content
}

async function generateSuggestion(sessionId, userMessage, language, imageUrl, timeoutMs = 15000) {
  if (!client) return null
  if (!userMessage && !imageUrl) return null

  const lang = resolveLanguage(language)

  // Fetch context: use embedding search if available, fallback to keyword
  let kbEntries, qnaEntries
  const [recentMessages] = await Promise.all([
    ChatMessage.find({ sessionId }).sort({ timestamp: -1 }).limit(20).lean(),
  ])

  if (embedding.isReady()) {
    const { kbResults, qnaResults } = await embedding.semanticSearch(userMessage || '', lang, 5, 5)
    kbEntries = kbResults
    qnaEntries = qnaResults
  } else {
    ;[kbEntries, qnaEntries] = await Promise.all([
      findRelevantKnowledge(userMessage || '', lang),
      findRelevantQnA(userMessage || '', lang),
    ])
  }

  const contextText = buildContextMessages(kbEntries, qnaEntries, recentMessages, lang)

  // Build messages array
  const llmMessages = [
    { role: 'system', content: buildSystemPrompt(lang) },
  ]

  if (contextText) {
    llmMessages.push({
      role: 'system',
      content: `Reference context (use this to answer the user's question):\n\n${contextText}`,
    })
  }

  // Inject few-shot examples from admin reply history
  if (adminReplyCache.isReady()) {
    const fewShot = adminReplyCache.findSimilarReplies(userMessage || '', lang, 3)
    if (fewShot.length > 0) {
      const examples = fewShot.map((ex, i) =>
        `예시 ${i + 1}:\n고객: ${ex.userMessage}\n상담원: ${ex.adminReply}`
      ).join('\n\n')
      llmMessages.push({
        role: 'system',
        content: `=== 상담원 답변 예시 (이 말투와 길이를 따라하세요) ===\n\n${examples}`,
      })
    }
  }

  // Inject operational context (machine availability)
  const opSummary = operationalContext.getOperationalSummary()
  if (opSummary) {
    llmMessages.push({ role: 'system', content: `현재 운영 상황: ${opSummary}` })
  }

  // Add recent conversation history (oldest first)
  const historyMessages = recentMessages.reverse()
  for (const msg of historyMessages) {
    const content = buildMessageContent(msg.text, msg.imageUrl)
    llmMessages.push({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content,
    })
  }

  // If the last message in history isn't the current user message, add it
  const lastHistoryMsg = historyMessages[historyMessages.length - 1]
  const needsCurrentMsg = !lastHistoryMsg || lastHistoryMsg.text !== userMessage
  if (needsCurrentMsg) {
    const content = buildMessageContent(userMessage, imageUrl)
    llmMessages.push({ role: 'user', content })
  }

  // 15-second timeout to prevent AI requests from hanging
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: llmMessages,
      max_tokens: 200,
      temperature: 0.3,
    }, { signal: controller.signal })

    const suggestion = completion.choices?.[0]?.message?.content?.trim()
    return suggestion || null
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = {
  generateSuggestion,
  findRelevantKnowledge,
  findRelevantQnA,
  buildSystemPrompt,
  buildContextMessages,
  cleanHtml,
  resolveLanguage,
  truncate,
}
