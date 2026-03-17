const mongoose = require('mongoose');

const AiSuggestionSchema = new mongoose.Schema({
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSession', required: true, index: true },
    userMessageId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', required: true },
    userMessage: { type: String, default: '' },
    suggestion: { type: String, required: true },
    adminReplyId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatMessage', default: null },
    adminReply: { type: String, default: null },
    similarity: { type: Number, default: null },
    language: { type: String, default: 'ko' },
    linkedAt: { type: Date, default: null },
    autoLearnStatus: { type: String, enum: ['pending', 'created_kb', 'skipped', null], default: null },
    dismissed: { type: Boolean, default: false },
    dismissedAt: { type: Date, default: null },
    qualityScore: { type: Number, default: null },
    evaluationCategory: { type: String, enum: ['new_knowledge', 'correction', 'style_improvement', 'no_learn', null], default: null },
    evaluationReason: { type: String, default: null },
    learnedTitle: { type: String, default: null },
    learnedContent: { type: String, default: null },
    evaluatedAt: { type: Date, default: null },
    adminFeedback: { type: String, enum: ['positive', 'negative', null], default: null },
    createdAt: { type: Date, default: Date.now }
});

AiSuggestionSchema.index({ sessionId: 1, createdAt: -1 });
AiSuggestionSchema.index({ similarity: 1 });
AiSuggestionSchema.index({ createdAt: -1 });

// 韩语常用同义词/缩写映射（用于相似度计算时展开）
const SYNONYMS = {
    '피씨방': 'pc방', '피방': 'pc방', '지방': 'pc방', '지피방': 'pc방',
    '로아': '로스트아크', '린클': '리니지클래식', '리클': '리니지클래식',
    '던파': '던전앤파이터', '메이플': '메이플스토리', '배그': '배틀그라운드',
    '발로': '발로란트', '2클': '2클라이언트', '2클라': '2클라이언트',
    '요금': '가격', '비용': '가격', '얼마': '가격',
    '환불': '반환', '돌려': '반환',
    '안됨': '오류', '안돼': '오류', '에러': '오류', '안되': '오류',
    '빌리': '임대', '렌탈': '임대', '빌려': '임대',
};

/**
 * 개선된 유사도 계산: 동의어 확장 + 단어 + bigram 혼합 (0-100)
 */
function calculateSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;

    const normalize = (t) => {
        let s = t.toLowerCase().replace(/[^\w\s가-힣一-龥]/g, ' ').replace(/\s+/g, ' ').trim();
        // 동의어/약어 확장
        for (const [abbr, full] of Object.entries(SYNONYMS)) {
            if (s.includes(abbr)) s += ' ' + full;
        }
        return s;
    };

    const getTokens = (s) => s.split(/\s+/).filter(w => w.length > 1);
    const getBigrams = (tokens) => {
        const bi = [];
        for (let i = 0; i < tokens.length - 1; i++) {
            bi.push(tokens[i] + '+' + tokens[i + 1]);
        }
        return bi;
    };

    const s1 = normalize(text1);
    const s2 = normalize(text2);
    const tok1 = getTokens(s1);
    const tok2 = getTokens(s2);

    if (tok1.length === 0 || tok2.length === 0) return 0;

    // 단어 Jaccard (가중치 60%)
    const set1 = new Set(tok1);
    const set2 = new Set(tok2);
    const wordIntersect = [...set1].filter(w => set2.has(w)).length;
    const wordUnion = new Set([...set1, ...set2]).size;
    const wordSim = wordUnion > 0 ? wordIntersect / wordUnion : 0;

    // Bigram Jaccard (가중치 25%) — 어순/문맥 반영
    const bi1 = new Set(getBigrams(tok1));
    const bi2 = new Set(getBigrams(tok2));
    let bigramSim = 0;
    if (bi1.size > 0 && bi2.size > 0) {
        const biIntersect = [...bi1].filter(b => bi2.has(b)).length;
        const biUnion = new Set([...bi1, ...bi2]).size;
        bigramSim = biIntersect / biUnion;
    }

    // 부분 포함 매칭 (가중치 15%) — "리니지" ⊂ "리니지클래식" 등
    let partialScore = 0;
    let partialChecks = 0;
    for (const w1 of set1) {
        if (w1.length < 3) continue;
        for (const w2 of set2) {
            if (w2.length < 3) continue;
            partialChecks++;
            if (w1 !== w2 && (w1.includes(w2) || w2.includes(w1))) {
                partialScore++;
            }
        }
    }
    const partialSim = partialChecks > 0 ? Math.min(partialScore / Math.max(set1.size, set2.size), 1) : 0;

    const combined = wordSim * 0.60 + bigramSim * 0.25 + partialSim * 0.15;
    return Math.round(combined * 100);
}

const AiSuggestion = mongoose.model('AiSuggestion', AiSuggestionSchema, 'ai_suggestions');

module.exports = { AiSuggestion, calculateSimilarity };
