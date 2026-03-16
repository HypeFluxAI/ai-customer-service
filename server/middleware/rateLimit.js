const rateLimit = require('express-rate-limit');

/**
 * 解析速率限制格式
 * 支持格式: "100-M", "50-S", "1000-H", "10000-D"
 * S=秒, M=分钟, H=小时, D=天
 */
function parseRateLimit(rateLimitStr) {
    const defaultLimit = { max: 100, windowMs: 60 * 1000 };

    if (!rateLimitStr) return defaultLimit;

    const match = rateLimitStr.match(/^(\d+)-([SMHD])$/i);
    if (!match) {
        // 尝试解析为纯数字（向后兼容）
        const num = parseInt(rateLimitStr);
        if (!isNaN(num)) {
            return { max: num, windowMs: 60 * 1000 };
        }
        console.warn(`警告: 速率限制配置无效 (${rateLimitStr})，使用默认值 100-M`);
        return defaultLimit;
    }

    const max = parseInt(match[1]);
    const unit = match[2].toUpperCase();

    const unitMs = {
        'S': 1000,           // 秒
        'M': 60 * 1000,      // 分钟
        'H': 60 * 60 * 1000, // 小时
        'D': 24 * 60 * 60 * 1000 // 天
    };

    return {
        max,
        windowMs: unitMs[unit] || 60 * 1000
    };
}

/**
 * 速率限制中间件
 * 默认: 100 请求/分钟
 * 支持格式: "100-M", "50-S", "1000-H", "10000-D"
 */
function createRateLimiter(rateLimitStr) {
    const { max, windowMs } = parseRateLimit(rateLimitStr);

    return rateLimit({
        windowMs,
        max,
        message: {
            error: 'Too Many Requests',
            msg: '请求过于频繁，请稍后重试'
        },
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => {
            // 使用 X-Forwarded-For 或 IP 作为限制键
            return req.headers['x-forwarded-for'] || req.ip;
        }
    });
}

module.exports = createRateLimiter;
