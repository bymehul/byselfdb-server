import rateLimit from 'express-rate-limit';

// prevent brute force (5/min)
export const connectRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: {
        success: false,
        error: 'Too many connection attempts. Please try again in a minute.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// chill out (100/min)
export const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: {
        success: false,
        error: 'Too many requests. Please slow down.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// slow down writes (30/min)
export const mutationRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: {
        success: false,
        error: 'Too many write operations. Please slow down.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});
