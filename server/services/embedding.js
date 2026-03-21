/**
 * Semantic search via LLM query expansion + keyword matching
 *
 * Instead of vector embeddings (ZenMux doesn't support embedding API),
 * we use Claude to expand user queries into standard search terms,
 * then combine with enhanced keyword matching against KB and QnA.
 *
 * Example: "린클 되나요?" → "리니지 클래식 리니지클래식 PC방 혜택 게임 이용 가능"
 */

const OpenAI = require('openai')
const { KnowledgeBase } = require('../models/KnowledgeBase')
const QnA = require('../models/QnA')

const client = process.env.ZENMUX_API_KEY
  ? new OpenAI({
      baseURL: 'https://zenmux.ai/api/v1',
      apiKey: process.env.ZENMUX_API_KEY,
    })
  : null

const EXPAND_MODEL = process.env.ZENMUX_MODEL || 'anthropic/claude-sonnet-4.5'

// In-memory cache
let kbCache = []
let qnaCache = []
let initialized = false

// Korean gaming abbreviation dictionary (fast local expansion)
const ABBREV_MAP = {
  // 게임 약어
  '린클': '리니지 클래식 리니지클래식',
  '리클': '리니지 클래식 리니지클래식',
  '던파': '던전앤파이터 던전 파이터',
  '로아': '로스트아크 로스트 아크',
  '메이플': '메이플스토리 메이플 스토리',
  '배그': '배틀그라운드 PUBG',
  '발로': '발로란트 VALORANT',
  '서든': '서든어택 서든 어택',
  '롤': '리그오브레전드 LOL',
  '옵치': '오버워치 오버 워치',
  '와우': '월드오브워크래프트 WOW',
  '디아': '디아블로 diablo',
  '카트': '카트라이더 카트 라이더',
  '피파': '피파온라인 FC온라인',
  '스타': '스타크래프트 starcraft',
  '피방': 'PC방 피씨방',
  '지방': 'PC방 피씨방 지피방',
  '지피방': 'PC방 피씨방',
  '2클': '2클라이언트 2클라 듀얼',
  '2클라': '2클라이언트 듀얼',
  // 기기 가용성 관련
  '만석': '임대 불가 모두 임대 중 여유기기 없음 대기',
  '접속대기': '대기 임대 불가 이용 가능 기기 없음',
  '이용불가': '임대 불가 사용 불가 기기 없음',
  '이용가능': '임대 가능 여유기기 기기 있음',
  '기기없': '기기 없음 임대 불가 여유기기 없음 대기',
  '자리없': '만석 임대 불가 모두 임대 중',
  '빈자리': '여유기기 이용 가능 임대 가능',
  '대기시간': '대기 시간 얼마나 기다려야 임대 불가',
  // 가격/결제 관련
  '얼마': '가격 요금 비용 포인트',
  '싼': '할인 가격 저렴 프로모션',
  '충전': '포인트 충전 결제 구매',
  '계좌': '계좌이체 은행 송금',
  '카드': '카드결제 신용카드 체크카드',
  '환불': '환불 반환 취소 포인트반환',
  // 문제/오류 관련
  '안됨': '오류 에러 안되 문제 해결',
  '에러': '오류 에러 문제 해결',
  '렉': '렉 지연 속도 느림 프레임',
  '튕김': '튕김 크래시 강제종료 오류',
  '화면': '화면 디스플레이 모니터 해상도',
  // 서비스 관련
  '원격': '원격 리모트 접속',
  '사양': '스펙 사양 GPU CPU RTX',
  '시간': '시간 포인트 이용시간 임대시간',
}

/**
 * Expand abbreviations locally (instant, no API call)
 */
function expandAbbreviations(text) {
  if (!text) return text
  let expanded = text
  for (const [abbr, full] of Object.entries(ABBREV_MAP)) {
    if (text.includes(abbr)) {
      expanded += ' ' + full
    }
  }
  return expanded
}

/**
 * LLM 语义理解: 把用户消息转成标准化问题 + 搜索关键词
 * 例: "돈 어떻게 넣어요?" → { question: "포인트 충전/계좌이체 방법", keywords: "충전 계좌이체 포인트 결제" }
 */
async function interpretWithLLM(userMessage, language) {
  if (!client || !userMessage || userMessage.length < 3) return null

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await client.chat.completions.create({
      model: EXPAND_MODEL,
      messages: [
        {
          role: 'system',
          content: `DeepLink(원격 PC방 GPU 임대 플랫폼) 고객 문의를 분석합니다.

고객 메시지를 보고 다음 JSON을 출력하세요 (JSON만, 설명 없이):
{"question": "표준화된 질문 (예: 포인트 충전 방법)", "keywords": "검색 키워드 (공백 구분, 최대 15개)"}

규칙:
- question: 고객이 실제로 알고 싶은 것을 명확한 한국어 질문으로
- keywords: 약어 풀어쓰기 (린클→리니지 클래식, 피방→PC방), 관련 개념 추가
- 예시:
  "돈 어떻게 넣어요?" → {"question":"포인트 충전/계좌이체 방법","keywords":"충전 계좌이체 포인트 결제 카드 입금"}
  "린클 되나요?" → {"question":"리니지 클래식 이용 가능 여부","keywords":"리니지 클래식 가능 이용 PC방 혜택 임대"}`
        },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 150,
      temperature: 0,
    }, { signal: controller.signal })

    const raw = res.choices?.[0]?.message?.content?.trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw.replace(/^```json?\s*/, '').replace(/\s*```$/, ''))
      return {
        question: parsed.question || null,
        keywords: parsed.keywords || null,
      }
    } catch {
      // JSON 파싱 실패 시 keywords만 추출
      return { question: null, keywords: raw }
    }
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function cleanHtml(html) {
  if (!html) return ''
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeText(value) {
  if (!value) return ''
  return String(value).toLowerCase().replace(/[^\w\s가-힣一-龥]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Score a KB entry against expanded search terms
 */
function scoreKBEntry(entry, searchWords) {
  let score = 0
  const title = normalizeText(entry.title)
  const content = normalizeText(cleanHtml(entry.contentHtml)).substring(0, 1000)
  const keywords = (entry.keywords || []).map(k => normalizeText(k))

  for (const word of searchWords) {
    if (word.length < 2) continue
    if (title.includes(word)) score += 4      // title match = highest
    for (const kw of keywords) {
      if (kw.length < 2) continue             // skip single-char keywords
      // Only match if both sides are meaningful length
      if (kw === word) score += 3             // exact match = highest keyword score
      else if (kw.length >= 3 && word.length >= 3 && (kw.includes(word) || word.includes(kw))) score += 2
    }
    if (content.includes(word)) score += 1    // content match
  }
  return score
}

/**
 * Score a QnA entry against expanded search terms
 */
function scoreQnAEntry(qna, searchWords, lang) {
  let score = 0
  const question = normalizeText(qna.question?.[lang] || qna.question?.ko || '')
  const answer = normalizeText(cleanHtml(qna.answer?.[lang] || qna.answer?.ko || ''))

  for (const word of searchWords) {
    if (word.length < 2) continue
    if (question.includes(word)) score += 3
    if (answer.includes(word)) score += 1
  }
  return score
}

/**
 * Initialize in-memory cache on startup
 */
async function initEmbeddings() {
  console.log('[SemanticSearch] loading KB and QnA into memory...')

  const kbEntries = await KnowledgeBase.find({ isActive: true }).lean()
  kbCache = kbEntries.map(e => ({
    id: e._id.toString(),
    title: e.title,
    contentHtml: e.contentHtml,
    keywords: e.keywords,
    language: e.language,
    isActive: e.isActive,
  }))

  const qnaEntries = await QnA.find({ isActive: true }).lean()
  qnaCache = qnaEntries.map(e => ({
    id: e._id.toString(),
    question: e.question,
    answer: e.answer,
    isActive: e.isActive,
  }))

  initialized = true
  console.log(`[SemanticSearch] ready: ${kbCache.length} KB, ${qnaCache.length} QnA`)
}

/**
 * Combined semantic search: LLM 意图理解 + 标准化问题匹配 + 关键词匹配
 */
async function semanticSearch(messageText, language, kbTopK = 5, qnaTopK = 5) {
  if (!initialized || !messageText) return { kbResults: [], qnaResults: [], interpretedQuestion: null }

  // Step 1: Local abbreviation expansion (instant)
  const localExpanded = expandAbbreviations(messageText)

  // Step 2: LLM 语义理解 → 标准化问题 + 关键词
  const interpretation = await interpretWithLLM(messageText, language)
  const llmQuestion = interpretation?.question || null
  const llmKeywords = interpretation?.keywords || null

  // Combine all search terms
  const allTerms = normalizeText(localExpanded + ' ' + (llmKeywords || '') + ' ' + (llmQuestion || ''))
  const searchWords = [...new Set(allTerms.split(/\s+/).filter(w => w.length >= 2))]

  if (searchWords.length === 0) return { kbResults: [], qnaResults: [] }

  // Step 3: Score and rank KB entries (filter by language)
  // 标准化问题 vs KB 标题的语义匹配（额外加分）
  const questionWords = llmQuestion
    ? [...new Set(normalizeText(llmQuestion).split(/\s+/).filter(w => w.length >= 2))]
    : []

  const langKb = kbCache.filter(e => e.language === language)
  const kbScored = langKb
    .map(e => {
      let score = scoreKBEntry(e, searchWords)
      // LLM 标准化问题与 KB 标题的匹配加分
      if (questionWords.length > 0) {
        const title = normalizeText(e.title)
        for (const qw of questionWords) {
          if (qw.length >= 2 && title.includes(qw)) score += 3
        }
      }
      return { entry: e, score }
    })
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, kbTopK)

  const kbResults = kbScored.map(r => ({
    title: r.entry.title,
    contentHtml: r.entry.contentHtml,
    keywords: r.entry.keywords,
    score: r.score,
  }))

  // Async reference tracking (non-blocking)
  if (kbScored.length > 0) {
    const hitIds = kbScored.map(r => r.entry.id)
    KnowledgeBase.updateMany(
      { _id: { $in: hitIds } },
      { $inc: { referenceCount: 1 }, $set: { lastReferencedAt: new Date() } }
    ).catch(() => {})
  }

  // Step 4: Score and rank QnA entries
  const qnaScored = qnaCache
    .map(e => ({ entry: e, score: scoreQnAEntry(e, searchWords, language) }))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, qnaTopK)

  const qnaResults = qnaScored.map(r => ({
    question: r.entry.question,
    answer: r.entry.answer,
    score: r.score,
  }))

  return { kbResults, qnaResults, interpretedQuestion: llmQuestion }
}

/**
 * Refresh cache for a single KB entry (call after create/update)
 */
async function refreshKBEntry(entryId) {
  const entry = await KnowledgeBase.findById(entryId).lean()
  if (!entry || !entry.isActive) {
    removeKBFromCache(entryId)
    return
  }

  const cached = {
    id: entryId.toString(),
    title: entry.title,
    contentHtml: entry.contentHtml,
    keywords: entry.keywords,
    language: entry.language,
    isActive: entry.isActive,
  }
  const idx = kbCache.findIndex(e => e.id === entryId.toString())
  if (idx >= 0) kbCache[idx] = cached
  else kbCache.push(cached)
}

/**
 * Remove KB entry from cache
 */
function removeKBFromCache(entryId) {
  kbCache = kbCache.filter(e => e.id !== entryId.toString())
}

module.exports = {
  semanticSearch,
  initEmbeddings,
  refreshKBEntry,
  removeKBFromCache,
  expandAbbreviations,
  isReady: () => initialized,
}
