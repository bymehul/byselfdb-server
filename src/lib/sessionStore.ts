import { randomBytes } from 'crypto';

/**
 * data stays in memory
 */
export interface SessionData {
    uri: string;
    databaseName: string;
    allowedScope: string[];
    readOnly: boolean;
    createdAt: number;
    expiresAt: number;
}

interface StoredSession {
    data: SessionData;
    lastAccessed: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5m
const SESSION_ID_LENGTH = 32;

const sessions = new Map<string, StoredSession>();

/**
 * secure random hex
 */
function generateSessionId(): string {
    return randomBytes(SESSION_ID_LENGTH).toString('hex');
}

/**
 * Create a new session and return the session ID.
 */
export function createSession(data: Omit<SessionData, 'createdAt' | 'expiresAt'>): string {
    const sessionId = generateSessionId();
    const now = Date.now();

    const sessionData: SessionData = {
        ...data,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
    };

    sessions.set(sessionId, {
        data: sessionData,
        lastAccessed: now,
    });

    return sessionId;
}

/**
 * Get session data by ID. Returns null if session doesn't exist or is expired.
 */
export function getSession(sessionId: string): SessionData | null {
    const session = sessions.get(sessionId);

    if (!session) {
        return null;
    }

    const now = Date.now();

    // check expiry
    if (now > session.data.expiresAt) {
        sessions.delete(sessionId);
        return null;
    }

    // Update last accessed time
    session.lastAccessed = now;

    return session.data;
}

/**
 * Update session data (e.g., when switching databases).
 */
export function updateSession(sessionId: string, updates: Partial<Omit<SessionData, 'createdAt'>>): boolean {
    const session = sessions.get(sessionId);

    if (!session) {
        return false;
    }

    const now = Date.now();

    if (now > session.data.expiresAt) {
        sessions.delete(sessionId);
        return false;
    }

    session.data = { ...session.data, ...updates };
    session.lastAccessed = now;

    return true;
}

/**
 * Destroy a session immediately (logout).
 */
export function destroySession(sessionId: string): boolean {
    return sessions.delete(sessionId);
}

/**
 * Get count of active sessions (for monitoring).
 */
export function getActiveSessionCount(): number {
    return sessions.size;
}

/**
 * Clean up expired sessions.
 */
function cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of sessions.entries()) {
        if (now > session.data.expiresAt) {
            sessions.delete(sessionId);
            cleaned++;
        }
    }

    if (cleaned > 0) {
        console.log(`[session] cleaned up ${cleaned} expired sessions`);
    }
}

/**
 * Destroy all sessions (for graceful shutdown).
 */
export function destroyAllSessions(): void {
    const count = sessions.size;
    sessions.clear();
    console.log(`[session] destroyed ${count} sessions`);
}

// start janitor
const cleanupInterval = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

// Allow graceful shutdown
export function stopCleanup(): void {
    clearInterval(cleanupInterval);
}
