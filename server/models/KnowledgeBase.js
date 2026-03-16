const mongoose = require('mongoose')

const KnowledgeBaseSchema = new mongoose.Schema({
    language: { type: String, enum: ['ko', 'zh', 'en'], default: 'ko', index: true },
    title: { type: String, required: true },
    contentHtml: { type: String, required: true },
    keywords: { type: [String], default: [] },
    source: { type: String, enum: ['manual', 'auto_learn'], default: 'manual' },
    embedding: { type: [Number], default: undefined, select: true },
    isActive: { type: Boolean, default: true },
    confidence: { type: Number, default: 1.0 },
    referenceCount: { type: Number, default: 0 },
    lastReferencedAt: { type: Date, default: null },
    reviewStatus: { type: String, enum: ['active', 'flagged', 'archived'], default: 'active' },
    sourceEvaluationId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiSuggestion', default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
})

// Compound index for KB lookups
KnowledgeBaseSchema.index({ language: 1, isActive: 1 });

// Text index for full-text search (weights: title > keywords)
KnowledgeBaseSchema.index(
    { title: 'text', keywords: 'text' },
    { weights: { title: 3, keywords: 2 }, default_language: 'none' }
);

KnowledgeBaseSchema.pre('save', function () {
    this.updatedAt = new Date()
})

const KnowledgeBase = mongoose.model('KnowledgeBase', KnowledgeBaseSchema, 'knowledge_base')

module.exports = { KnowledgeBase }
