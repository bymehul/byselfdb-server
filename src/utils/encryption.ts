import * as jose from 'jose';
import { config } from '../config/index.js';
import type { EncryptedSessionPayload } from '../types/index.js';
import { pbkdf2Sync, randomBytes } from 'crypto';

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;

/**
 * Derive encryption key from secret and salt using PBKDF2.
 */
function deriveKey(salt: Buffer): Buffer {
  return pbkdf2Sync(config.SESSION_SECRET, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

export async function encryptSession(payload: EncryptedSessionPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 60 * 60 * 24;

  // Generate random salt for this session
  const salt = randomBytes(SALT_LENGTH);
  const encryptionKey = deriveKey(salt);

  const jwe = await new jose.EncryptJWT({ ...payload })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .encrypt(encryptionKey);

  // Prepend salt to encrypted token (salt:jwe)
  return `${salt.toString('base64')}.${jwe}`;
}

export async function decryptSession(token: string): Promise<EncryptedSessionPayload | null> {
  try {
    const [saltB64, jwe] = token.split('.');
    if (!saltB64 || !jwe) {
      return null;
    }

    const salt = Buffer.from(saltB64, 'base64');
    if (salt.length !== SALT_LENGTH) {
      return null;
    }

    const encryptionKey = deriveKey(salt);
    const { payload } = await jose.jwtDecrypt(jwe, encryptionKey);
    return payload as unknown as EncryptedSessionPayload;
  } catch {
    return null;
  }
}
