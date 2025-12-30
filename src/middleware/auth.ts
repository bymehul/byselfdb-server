import { Request, Response, NextFunction } from 'express';
import { getSession, SessionData } from '../lib/sessionStore.js';

export interface AuthenticatedRequest extends Request {
  session?: SessionData;
  sessionId?: string;
}

/**
 * checks if user has a valid session cookie.
 */
export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const cookieName = process.env.NODE_ENV === 'production' ? 'byselfdb_session' : 'byselfdb_session_dev';
  const sessionId = req.cookies[cookieName];

  if (!sessionId) {
    res.status(401).json({
      success: false,
      error: 'No session found. Please connect to a database first.',
    });
    return;
  }

  const sessionData = getSession(sessionId);

  if (!sessionData) {
    res.status(401).json({
      success: false,
      error: 'Invalid or expired session. Please reconnect.',
    });
    return;
  }

  req.session = sessionData;
  req.sessionId = sessionId;
  next();
}

/**
 * optional auth. doesn't block.
 */
export function optionalAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const cookieName = process.env.NODE_ENV === 'production' ? 'byselfdb_session' : 'byselfdb_session_dev';
  const sessionId = req.cookies[cookieName];

  if (sessionId) {
    const sessionData = getSession(sessionId);
    if (sessionData) {
      req.session = sessionData;
      req.sessionId = sessionId;
    }
  }

  next();
}
