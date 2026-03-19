/**
 * LLM-based quality evaluation for AI suggestions
 *
 * Evaluates each admin reply against the AI suggestion using Sonnet
 * to determine quality score, category, and whether to auto-learn.
 *
 * Architecture: in-memory queue + 10s polling, max 3 per batch, 8s timeout
 */

const OpenAI = require('openai')
const { AiSuggestion } = require('../models/AiSuggestion')

const client = process.env.ZENMUX_API_KEY
  ? new OpenAI({
      baseURL: 'https://zenmux.ai/api/v1',
      apiKey: process.env.ZENMUX_API_KEY,
    })
  : null

const EVAL_MODEL = process.env.ZENMUX_EVAL_MODEL || 'anthropic/claude-sonnet-4.5'
const EVAL_TIMEOUT = 30000
const POLL_INTERVAL = 5000
const BATCH_SIZE = 10

// In-memory queue of AiSuggestion IDs to evaluate
const queue = []
const retryCount = new Map() // id -> retry count
const MAX_RETRIES = 3
let pollTimer = null
let processing = false

/**
 * Add an AiSuggestion ID to the evaluation queue
 */
function enqueueEvaluation(suggestionId) {
  if (!client) return
  queue.push(suggestionId.toString())
}

/**
 * Call LLM to evaluate multiple suggestion+admin reply pairs in one request
 * Returns array of results matching input docs order, null for failures
 */
async function evaluateBatch(docs) {
  if (!docs.length) return []

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EVAL_TIMEOUT)

  // Build numbered items for batch evaluation
  const items = docs.map((doc, i) =>
    `[${i + 1}]\nUser question: ${(doc.userMessage || '(no text)').substring(0, 200)}\nAI suggestion: ${(doc.suggestion || '').substring(0, 300)}\nAdmin reply: ${(doc.adminReply || '').substring(0, 300)}`
  ).join('\n\n')

  try {
    const res = await client.chat.completions.create({
      model: EVAL_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are an AI quality evaluator for a customer support system (DeepLink — remote PC bang GPU rental platform).

You will receive ${docs.length} items to evaluate. For each item, evaluate how good the AI suggestion was compared to the admin reply.

Return ONLY a valid JSON array (no markdown, no explanation) with exactly ${docs.length} objects:
[
  {
    "quality_score": <0-100 integer>,
    "semantic_similarity": <0-100 integer>,
    "category": "<new_knowledge|correction|style_improvement|no_learn>",
    "should_learn": <true|false>,
    "reason": "<1 sentence in Korean>",
    "learned_title": "<short Korean title or null>",
    "learned_content": "<refined Korean answer or null>"
  },
  ...
]

semantic_similarity (매우 중요 — 의미적 유사도):
- AI 건의와 관리자 답변이 전달하는 의미/정보가 같은지 판단 (단어가 달라도 의미가 같으면 높은 점수)
- 100: 완전히 같은 의미 (단어만 다름)
- 80: 핵심 정보 일치, 부가 정보 약간 차이
- 60: 방향은 맞지만 구체적 내용 차이
- 40: 부분적으로만 일치
- 20: 거의 다른 내용
- 0: 완전히 다른 답변

Categories:
- new_knowledge: admin provided information the AI didn't know (score usually < 50)
- correction: AI was wrong, admin corrected it (score usually < 30)
- style_improvement: AI had right info but admin phrased better (score usually 50-80)
- no_learn: AI suggestion was good enough or admin reply is too generic/short to learn from

Rules:
- If admin reply is very short (< 15 chars) or just "네"/"감사합니다" → no_learn, score 70+, semantic_similarity 80+
- If both say essentially the same thing in different words → style_improvement or no_learn, score 60+, semantic_similarity 70+
- learned_content should be a clean, reusable answer (not conversation-specific)
- Set learned_title and learned_content to null when should_learn is false`
        },
        {
          role: 'user',
          content: items
        }
      ],
      max_tokens: 300 * docs.length,
      temperature: 0,
    }, { signal: controller.signal })

    const raw = res.choices?.[0]?.message?.content?.trim()
    if (!raw) return docs.map(() => null)

    const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(jsonStr)

    if (Array.isArray(parsed) && parsed.length === docs.length) {
      return parsed
    }
    // If array length mismatch, return what we can
    if (Array.isArray(parsed)) {
      console.warn(`[EvalQuality] batch returned ${parsed.length} results for ${docs.length} items`)
      return docs.map((_, i) => parsed[i] || null)
    }
    // Single object returned for single item
    if (docs.length === 1 && parsed.quality_score !== undefined) {
      return [parsed]
    }
    return docs.map(() => null)
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[EvalQuality] batch timeout (${docs.length} items)`)
    } else {
      console.error('[EvalQuality] batch LLM error:', err.message)
    }
    return docs.map(() => null)
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Process queued evaluations (max BATCH_SIZE per tick)
 */
async function processQueue() {
  if (processing || queue.length === 0) return
  processing = true

  try {
    const batch = queue.splice(0, BATCH_SIZE)

    // Load all docs in parallel
    const docs = await Promise.all(batch.map(id => AiSuggestion.findById(id).catch(() => null)))
    const validPairs = batch.map((id, i) => ({ id, doc: docs[i] }))
      .filter(({ doc }) => doc && doc.adminReply && !doc.evaluatedAt)

    if (validPairs.length === 0) { processing = false; return }

    // Single LLM call to evaluate all items at once
    const results = await evaluateBatch(validPairs.map(p => p.doc))

    // Save results
    for (let i = 0; i < validPairs.length; i++) {
      const { id, doc } = validPairs[i]
      const result = results[i]
      try {
        if (!result) {
          const retries = (retryCount.get(id) || 0) + 1
          if (retries < MAX_RETRIES) {
            retryCount.set(id, retries)
            queue.push(id)
          } else {
            retryCount.delete(id)
            console.warn(`[EvalQuality] giving up on ${id} after ${MAX_RETRIES} retries`)
          }
          continue
        }
        retryCount.delete(id)

        doc.qualityScore = result.quality_score
        doc.evaluationCategory = result.category
        doc.evaluationReason = result.reason
        // LLM 语义相似度覆盖词匹配相似度（更准确）
        if (result.semantic_similarity != null) {
          doc.similarity = result.semantic_similarity
        }
        doc.learnedTitle = result.learned_title || null
        doc.learnedContent = result.learned_content || null
        doc.evaluatedAt = new Date()
        await doc.save()

        console.log(`[EvalQuality] ${id}: score=${result.quality_score}, cat=${result.category}, learn=${result.should_learn}`)

        // Notify autoLearn to process immediately
        if (_onEvaluatedCallback) {
          _onEvaluatedCallback(doc, result)
        }
      } catch (err) {
        console.error(`[EvalQuality] process error for ${id}:`, err.message)
      }
    }
  } finally {
    processing = false
  }
}

// Module-level callback for evaluation completion (set by autoLearn)
let _onEvaluatedCallback = null

function onEvaluated(callback) {
  _onEvaluatedCallback = callback
}

/**
 * Catch-up: find unprocessed suggestions that have admin replies but no evaluation
 */
async function catchUp() {
  if (!client) return
  try {
    const unprocessed = await AiSuggestion.find({
      adminReply: { $ne: null },
      evaluatedAt: null,
    }).select('_id').limit(500).lean()

    const queued = new Set(queue)
    for (const doc of unprocessed) {
      const idStr = doc._id.toString()
      if (!queued.has(idStr)) {
        queue.push(idStr)
        queued.add(idStr)
      }
    }
    if (unprocessed.length > 0) {
      console.log(`[EvalQuality] catch-up: queued ${unprocessed.length} unprocessed suggestions`)
    }
  } catch (err) {
    console.error('[EvalQuality] catch-up error:', err.message)
  }
}

/**
 * Start the evaluation service
 */
function startEvaluationService() {
  if (!client) {
    console.log('[EvalQuality] skipped (no ZENMUX_API_KEY)')
    return
  }
  console.log(`[EvalQuality] started (poll: ${POLL_INTERVAL / 1000}s, batch: ${BATCH_SIZE}, model: ${EVAL_MODEL})`)

  // Catch-up after 10 seconds (let server stabilize), then every 5 minutes
  setTimeout(() => {
    catchUp()
    setInterval(() => catchUp(), 5 * 60 * 1000)
  }, 10000)

  // Poll queue
  pollTimer = setInterval(() => processQueue(), POLL_INTERVAL)
}

function stopEvaluationService() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

module.exports = {
  enqueueEvaluation,
  startEvaluationService,
  stopEvaluationService,
  onEvaluated,
}
