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

  const commonRules = `★★★ 핵심 원칙: 아래 참고자료와 상담원 답변에 해당하는 내용이 있으면 그 내용을 그대로 사용하세요. 절대로 다른 내용을 만들지 마세요. ★★★

- 고객의 질문 의도를 파악하고, 참고자료/상담원 예시 중 가장 관련 있는 답변의 내용을 그대로 전달하세요
- 참고자료에 없는 내용은 절대 지어내지 마세요. 모르면 "확인 후 안내드리겠습니다"로
- 마크다운 사용 금지. 일반 텍스트만
- 짧게: 1~2문장. 상담원 예시의 길이를 따라하세요
- 고객 질문을 되풀이하지 마세요
- 먼저 "안녕하세요" 인사하지 마세요 (고객이 인사하면 답하기)
- "다른 궁금하신 점 있으시면 말씀해주세요" 같은 마무리 금지`

  if (language === 'ko') {
    let prompt = `DeepLink 고객 상담 어시스턴트. DeepLink = 원격 PC방 GPU 임대 플랫폼.

★★★ 답변 원칙 (가장 중요) ★★★
1. 고객이 무엇을 묻는지 의도를 파악하세요 (예: "돈 어떻게 넣어요?" = 충전/계좌이체 문의)
2. 아래 참고자료와 상담원 예시에서 해당하는 답변을 찾으세요
3. 그 답변의 내용과 의미를 그대로 사용하되, 고객 상황에 맞게 자연스럽게 전달하세요
4. 상담원이 실제로 쓰는 말투를 따라하세요:
- "네, 리니지 클래식 PC방 혜택 적용돼요."
- "시간당 약 890~910원(580~610포인트)이며, 기기 사양별로 차이가 있어요."
- "1클라만 가능하세요"
- "환불가능하세여~"
- "현재 이용율 높아 여유기기 나올때 바로바로 임대나가는겁니다"
- "네 원격 방식입니다"

특징: 해요체, 줄임말 OK, 짧고 직접적, 이모지 금지, ~와 ! 허용, "ㅠㅠ" 허용.
절대 하지 말 것: 긴 설명, 여러 문장, "안녕하세요" 인사, "궁금하신 점" 마무리, 마크다운.

서비스 정보:
- 포인트 충전: 카드결제(부가세 10% 추가)/계좌이체 가능. 계좌이체 문의 시 참고자료의 계좌번호를 안내. 입금 후 입금자명 + 계정 아이디(로고아래 10자리) 알려달라고 안내
- PC방 혜택: 넥슨(던파), 리니지 클래식 등 적용. 원격 접속이라 IP 문제 없음, 정지 사례 없음
- 2클라: 불가, 기기 2대 임대해야
- 해외: VPN 없이 직접 접속 가능, 거리에 따라 지연 가능. 거리 필터 "전체" 변경 권장
- 지원 게임: 리클, 던파, 로아, 메이플, FC온라인, 배그, 발로란트 등
- 요금: 시간당 약 860~910원 (590~610포인트), 사양별 다름. 10분 단위 임대 가능. 24시간 약 20,400원
- 환불: 장비목록 > 임대리스트 > "사용종료" 클릭 시 잔여 포인트 자동 환불 (5~10분). 카드 환불은 상담원
- 앱: deeplinkgame.com/download 또는 구글플레이 "DeepLink". 가입 없이 바로 이용
- 문제 해결: 앱 재시작 → PC 재부팅 → 다른 기기 임대 → 고객센터
- "PC 오프라인": 현장 인터넷 이슈. 사용종료 후 다른 기기 임대. 포인트 자동 환불
- 비밀번호 분실: 로그아웃 후 개인키로 재로그인 → 비번 재설정
- 마우스/키보드 안됨: 상단바 "더" → 게임드라이버 클릭
- 다른 PC에서 로그인: 동일 개인키면 임대기기 유지됨
- 라이센스/멤버십: PC방 임대에 필요 없음
- 정지/패널티: 원격 방식이라 아직까지 사례 없음
- 기기 부족: 현재 이용률 높아 대기 있을 수 있음. 저녁 11시 이후, 새벽~오전에 여유. 기기 계속 증설 중
- 충전했는데 기기 없음: 포인트 소멸 안 됨, 여유 시간에 이용하면 됨
- 환불 절차: 개인키 정보 + 신용카드 결제 이메일 주소 요청. 사용분 있으면 카드취소 불가 → 계좌이체 환불
- 발로란트/FPS: 가능하지만 비추천 (원격 특성상 지연)
- 맥(Mac): 웹버전(web.deeplinkgame.com)은 최적화 안 됨. 윈도우 버전 권장. 웹 원격은 라이센스 필요
- 월정액: 기기 증설과 함께 출시 예정. 고정 PC 언제든 사용 가능한 상품

★ 기기 부족 시 표준 답변 (가장 자주 쓰는 답변 — 리니지 가입, 신규, 대기, 접속 문의에 이 답변 사용):
"안녕하세요. 네, 게임 이용은 가능합니다. 다만 현재 모든 기기가 임대 중인 상태입니다. 3월 말까지 기기를 점차 증설할 예정입니다. 기회되면 3월 말쯤 방문을 부탁드립니다."

★ 기기 불만 시 표준 답변:
"불편드려 죄송합니다. 저희는 다음 주까지 약 50대 정도 기기 증설을 진행할 예정입니다. 증설과 함께 사용 및 연장시간에 일부 제한을 두어, 보다 원활하게 이용하실 수 있도록 할 예정이에요."

주의사항:
- "지금 바로 이용 가능" 같은 확정 표현 금지 (실시간 변동)
- 구체적 증설 일정/날짜 약속 금지

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
    parts.push('\n--- ★ 위 자료에서 고객 질문에 해당하는 답변을 찾아 그 내용을 그대로 사용하세요. 말투만 상황에 맞게 조정하되, 의미와 정보는 바꾸지 마세요. 해당 자료가 없으면 "확인 후 안내드리겠습니다"로 답하세요. ---')
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

  // ★ 直接匹配: 管理员对同样的问题回复过，直接复用（不走 LLM）
  // 短消息（<15字符）跳过直接匹配——可能是跟进消息，需要上下文
  if (userMessage && userMessage.trim().length >= 15 && adminReplyCache.isReady()) {
    const directMatch = adminReplyCache.findDirectMatch(userMessage)
    if (directMatch && directMatch.confidence >= 0.85) {
      console.log(`[AI Suggest] Direct match (confidence=${directMatch.confidence.toFixed(2)}): "${userMessage.substring(0, 30)}..."`)
      return directMatch.reply
    }
  }

  // Fetch context: use embedding search if available, fallback to keyword
  let kbEntries, qnaEntries
  const [recentMessages] = await Promise.all([
    ChatMessage.find({ sessionId }).sort({ timestamp: -1 }).limit(20).lean(),
  ])

  // ★ 短消息/跟进消息：用上文拼接作为搜索查询
  let searchQuery = userMessage || ''
  const isFollowUp = searchQuery.trim().length < 15
  if (isFollowUp && recentMessages.length > 0) {
    // 取最近 2-3 条用户消息拼接
    const recentUserMsgs = recentMessages
      .filter(m => m.sender === 'user' && m.text && m.text.trim().length > 5)
      .slice(0, 3)
      .map(m => m.text.trim())
      .reverse()
    if (recentUserMsgs.length > 0) {
      searchQuery = recentUserMsgs.join(' ') + ' ' + searchQuery
    }
  }

  let interpretedQuestion = null
  if (embedding.isReady()) {
    const searchResult = await embedding.semanticSearch(searchQuery, lang, 5, 5)
    kbEntries = searchResult.kbResults
    qnaEntries = searchResult.qnaResults
    interpretedQuestion = searchResult.interpretedQuestion
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
    let contextHeader = '=== 정답 자료 (이 내용에서 답을 찾아 사용하세요) ==='
    if (interpretedQuestion) {
      contextHeader += `\n\n고객 의도 분석: "${interpretedQuestion}" — 이 질문에 해당하는 답변을 아래에서 찾아 사용하세요.`
    }
    llmMessages.push({
      role: 'system',
      content: `${contextHeader}\n\n${contextText}`,
    })
  }

  // ★ 중간 매칭: 관리원 답변이 있으면 "이 답변을 기반으로" 지시
  let hasStrongGuide = false
  if (userMessage && adminReplyCache.isReady()) {
    const directMatch = adminReplyCache.findDirectMatch(userMessage)
    if (directMatch && directMatch.confidence >= 0.7) {
      llmMessages.push({
        role: 'system',
        content: `★★★ 기존 상담원 답변이 있습니다. 이 답변의 의미와 내용을 그대로 유지하고, 말투만 상황에 맞게 미세 조정하세요 ★★★\n\n기존 답변: "${directMatch.reply}"`,
      })
      hasStrongGuide = true
    }
  }

  // Inject few-shot examples from admin reply history
  if (adminReplyCache.isReady()) {
    const fewShot = adminReplyCache.findSimilarReplies(userMessage || '', lang, 5)
    if (fewShot.length > 0) {
      const examples = fewShot.map((ex, i) =>
        `예시 ${i + 1}:\n고객: ${ex.userMessage}\n상담원: ${ex.adminReply}`
      ).join('\n\n')
      llmMessages.push({
        role: 'system',
        content: hasStrongGuide
          ? `=== 참고 예시 (말투 참조용) ===\n\n${examples}`
          : `=== 상담원 실제 답변 (고객이 비슷한 질문을 하면 이 답변의 내용을 사용하세요) ===\n\n${examples}`,
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
      temperature: 0.15,
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
