const mongoose = require('mongoose');

// 管理员用户 schema
const AdminSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // TODO: 生产环境使用 bcrypt
    role: { type: String, enum: ['superadmin', 'admin', 'viewer', 'marketer'], default: 'admin' },
    lastLogin: { type: Date },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// 站点配置 schema (key-value 存储)
const SiteSettingsSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed,
    description: { type: String },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String }
});

// 通知配置 schema
const NotificationSettingsSchema = new mongoose.Schema({
    type: { type: String, required: true }, // 'email', 'slack', 'discord'
    enabled: { type: Boolean, default: false },
    config: mongoose.Schema.Types.Mixed,
    events: [String],
    updatedAt: { type: Date, default: Date.now }
});

const Admin = mongoose.model('Admin', AdminSchema);
const SiteSettings = mongoose.model('SiteSettings', SiteSettingsSchema);
const NotificationSettings = mongoose.model('NotificationSettings', NotificationSettingsSchema);

module.exports = { Admin, SiteSettings, NotificationSettings };
