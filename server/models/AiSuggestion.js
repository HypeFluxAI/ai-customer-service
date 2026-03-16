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

/**
 * Jaccard similarity between two text strings (0-100)
 */
function calculateSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    const normalize = (t) => t.toLowerCase()
        .replace(/[^\w\s가-힣一-龥]/g, '')
        .split(/\s+/).filter(w => w.length > 1);
    const set1 = new Set(normalize(text1));
    const set2 = new Set(normalize(text2));
    if (set1.size === 0 || set2.size === 0) return 0;
    const intersection = [...set1].filter(w => set2.has(w)).length;
    const union = new Set([...set1, ...set2]).size;
    return Math.round((intersection / union) * 100);
}

const AiSuggestion = mongoose.model('AiSuggestion', AiSuggestionSchema, 'ai_suggestions');

module.exports = { AiSuggestion, calculateSimilarity };
