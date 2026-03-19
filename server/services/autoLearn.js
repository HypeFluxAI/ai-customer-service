const { AiSuggestion } = require('../models/AiSuggestion');
const { KnowledgeBase } = require('../models/KnowledgeBase');
const { refreshKBEntry } = require('./embedding');
const { onEvaluated } = require('./evaluateQuality');

const MIN_REPLY_LENGTH = 20;      // Skip very short admin replies
const MAX_PER_RUN = 5;            // Max KB entries created per catch-up run
const CATCHUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes (catch-up only)

// Korean stop words (particles, endings)
const KO_STOP = new Set([
    '은', '는', '이', '가', '을', '를', '에', '의', '로', '와', '과',
    '도', '만', '요', '네', '건', '거', '것', '수', '좀', '잘', '더',
    '다', '고', '서', '면', '데', '게', '지', '까', '해', '안', '못',
]);

// Patterns that should NOT be auto-learned (sensitive info only, NOT temporal)
// Note: temporal info (기기 증설 예정, 모든 기기 임대 중, 특정 날짜) is OK to learn
// because it reflects real admin communication patterns useful for few-shot learning
const SKIP_PATTERNS = [
    /\d{10,}/,                          // bank account numbers
    /@\w+\.\w+/,                        // email addresses
    /카카오뱅크|국민은행|신한은행/,          // bank names
    /개인키/,                            // private keys
    /0x[a-f0-9]{20,}/i,                 // wallet addresses
    /카드.*뒷자리/,                       // card numbers
];

/**
 * Extract meaningful keywords from text
 */
function extractKeywords(text) {
    if (!text) return [];
    const normalized = text.toLowerCase()
        .replace(/[^\w\s가-힣一-龥]/g, '')
        .split(/\s+/)
        .filter(w => w.length >= 2 && !KO_STOP.has(w));
    // Deduplicate and take top 8
    return [...new Set(normalized)].slice(0, 8);
}

/**
 * Check if a similar KB entry already exists using text search
 */
async function findDuplicateKb(title, keywords, language) {
    const searchTerms = [title, ...keywords].join(' ');
    try {
        const results = await KnowledgeBase.find(
            { $text: { $search: searchTerms }, isActive: true, language },
            { score: { $meta: 'textScore' } }
        ).sort({ score: { $meta: 'textScore' } }).limit(1).lean();

        // textScore > 2 means strong overlap
        if (results.length > 0 && results[0].score > 2) {
            return results[0];
        }
    } catch {
        // Text index may not exist — fallback to keyword overlap check
        const existing = await KnowledgeBase.find({ isActive: true, language }).lean();
        for (const entry of existing) {
            const entryKws = new Set((entry.keywords || []).map(k => k.toLowerCase()));
            const overlap = keywords.filter(k => entryKws.has(k)).length;
            if (overlap >= 2) return entry;
        }
    }
    return null;
}

/**
 * Validate that an item passes safety checks (patterns, length, etc.)
 * Returns true if the item should be skipped
 */
function shouldSkip(item) {
    if (!item.adminReply || item.adminReply.length < MIN_REPLY_LENGTH) return true;

    const combined = (item.userMessage || '') + ' ' + item.adminReply;
    if (SKIP_PATTERNS.some(p => p.test(combined))) return true;

    const userMsg = (item.userMessage || '').trim();
    if (userMsg.length < 5 || /^(안녕|네|넵|감사|사장님|\.|\?|!)+$/.test(userMsg.replace(/\s/g, ''))) return true;

    return false;
}

/**
 * Determine confidence based on LLM evaluation result
 */
function calcConfidence(result) {
    // Low quality_score = AI was far off = admin correction is highly valuable
    if (result.category === 'correction' && result.quality_score < 30) return 0.9;
    if (result.category === 'new_knowledge' && result.quality_score < 50) return 0.7;
    return 0.5;
}

/**
 * Immediately process a single evaluated suggestion (called by evaluateQuality callback)
 */
async function processEvaluatedItem(doc, result) {
    try {
        if (!result.should_learn) {
            doc.autoLearnStatus = 'skipped';
            await doc.save();
            return;
        }

        if (result.category !== 'new_knowledge' && result.category !== 'correction') {
            doc.autoLearnStatus = 'skipped';
            await doc.save();
            return;
        }

        // Safety check (second layer)
        if (shouldSkip(doc)) {
            doc.autoLearnStatus = 'skipped';
            await doc.save();
            console.log(`[AutoLearn] skipped (safety): "${(doc.userMessage || '').substring(0, 40)}..."`);
            return;
        }

        const title = result.learned_title || (doc.userMessage || '').substring(0, 100) || 'Untitled';
        const content = result.learned_content || doc.adminReply;
        const keywords = extractKeywords(doc.userMessage);
        const language = doc.language || 'ko';

        // Dedup check
        const duplicate = await findDuplicateKb(title, keywords, language);
        if (duplicate) {
            doc.autoLearnStatus = 'skipped';
            await doc.save();
            console.log(`[AutoLearn] skipped duplicate: "${title.substring(0, 40)}..." (matched: "${duplicate.title}")`);
            return;
        }

        // 时间敏感内容自动设置 30 天过期
        const combined = title + ' ' + content;
        const isTemporal = /다음 주|담주|이번 주|금주|[0-9]+월.*말|증설.*예정|출시.*예정|곧|조만간/.test(combined);
        const expiresAt = isTemporal ? new Date(Date.now() + 30 * 86400000) : null;

        const kbEntry = await KnowledgeBase.create({
            language,
            title,
            contentHtml: `<p>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
            keywords,
            source: 'auto_learn',
            isActive: true,
            confidence: calcConfidence(result),
            sourceEvaluationId: doc._id,
            expiresAt,
        });

        doc.autoLearnStatus = 'created_kb';
        await doc.save();

        refreshKBEntry(kbEntry._id).catch(() => {});
        console.log(`[AutoLearn] created KB: "${title.substring(0, 40)}..." (score: ${result.quality_score}, cat: ${result.category}, confidence: ${calcConfidence(result)})`);
    } catch (err) {
        console.error('[AutoLearn] process error:', err.message);
    }
}

/**
 * Catch-up: process any evaluated items that were missed (e.g., due to restart)
 */
async function catchUpProcess() {
    try {
        // Find items that were evaluated but autoLearnStatus is still null
        const candidates = await AiSuggestion.find({
            evaluatedAt: { $ne: null },
            autoLearnStatus: null,
            adminReply: { $ne: null },
        }).limit(MAX_PER_RUN);

        for (const doc of candidates) {
            const result = {
                should_learn: doc.evaluationCategory === 'new_knowledge' || doc.evaluationCategory === 'correction',
                category: doc.evaluationCategory,
                quality_score: doc.qualityScore,
                learned_title: doc.learnedTitle || null,
                learned_content: doc.learnedContent || null,
            };
            await processEvaluatedItem(doc, result);
        }

        if (candidates.length > 0) {
            console.log(`[AutoLearn] catch-up processed ${candidates.length} items`);
        }
    } catch (err) {
        console.error('[AutoLearn] catch-up error:', err.message);
    }
}

let intervalId = null;

function startAutoLearn() {
    console.log(`[AutoLearn] started (LLM-driven mode, catch-up interval: ${CATCHUP_INTERVAL_MS / 60000}min)`);

    // Register callback to process evaluations immediately
    onEvaluated((doc, result) => {
        processEvaluatedItem(doc, result).catch(err =>
            console.error('[AutoLearn] callback error:', err.message)
        );
    });

    // Catch-up run after 3 minutes
    setTimeout(() => {
        catchUpProcess();
        intervalId = setInterval(catchUpProcess, CATCHUP_INTERVAL_MS);
    }, 3 * 60 * 1000);
}

function stopAutoLearn() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
    }
}

module.exports = { startAutoLearn, stopAutoLearn, processAutoLearn: catchUpProcess };
