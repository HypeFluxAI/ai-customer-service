const mongoose = require('mongoose');

const QnASchema = new mongoose.Schema({
    question: {
        ko: { type: String, required: true },
        zh: { type: String, required: true },
        en: { type: String, required: true }
    },
    answer: {
        ko: { type: String, required: true },
        zh: { type: String, required: true },
        en: { type: String, required: true }
    },
    embedding: { type: [Number], default: undefined, select: true },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Index for active QnA lookups
QnASchema.index({ isActive: 1 });

// Auto-update updatedAt on save
QnASchema.pre('save', function () {
    this.updatedAt = new Date();
});

module.exports = mongoose.model('QnA', QnASchema, 'qna');
