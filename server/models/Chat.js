const mongoose = require('mongoose');

// Chat Message Schema
const ChatMessageSchema = new mongoose.Schema({
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatSession', required: true, index: true },
    sender: { type: String, enum: ['user', 'admin', 'bot'], required: true },
    text: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now }
});

// Chat Session Schema
const ChatSessionSchema = new mongoose.Schema({
    visitorToken: { type: String, index: true },
    visitorId: { type: String, index: true },
    userName: { type: String, default: '익명' },
    userLocation: { type: String, default: '' },
    ip: { type: String },
    userAgent: { type: String },
    language: { type: String, default: 'ko' },
    channel: { type: String, enum: ['web', 'kakao'], default: 'web' },
    kakaoUserId: { type: String, default: null, sparse: true },
    status: { type: String, enum: ['active', 'closed'], default: 'active' },
    unreadCount: { type: Number, default: 0 },
    lastMessage: { type: String, default: '' },
    lastMessageTime: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Compound indexes for common query patterns
ChatMessageSchema.index({ sessionId: 1, timestamp: -1 });
ChatSessionSchema.index({ status: 1, lastMessageTime: -1 });
ChatSessionSchema.index({ channel: 1, kakaoUserId: 1, status: 1 });

// Auto-update updatedAt on save
ChatSessionSchema.pre('save', function() {
    this.updatedAt = new Date();
});

const ChatMessage = mongoose.model('ChatMessage', ChatMessageSchema, 'chat_messages');
const ChatSession = mongoose.model('ChatSession', ChatSessionSchema, 'chat_sessions');

module.exports = { ChatMessage, ChatSession };
