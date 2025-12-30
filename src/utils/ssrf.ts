import { URL } from 'url';

/**
 * Private/internal IP ranges that should be blocked for SSRF protection.
 */
const BLOCKED_IP_PATTERNS = [
    /^127\./,                    // loopback
    /^10\./,                     // private class a
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // private class b
    /^192\.168\./,               // private class c
    /^169\.254\./,               // link-local
    /^0\./,                      // current network
    /^fc00:/i,                   // ipv6 private
    /^fe80:/i,                   // ipv6 link-local
    /^::1$/,                     // ipv6 loopback
    /^localhost$/i,              // localhost
];

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    'metadata.google.internal',  // gcp metadata
    '169.254.169.254',           // aws/azure metadata
]);

/**
 * block private networks (ssrf)
 */
export function validateUriForSsrf(uri: string): { valid: true } | { valid: false; error: string } {
    try {
        const url = new URL(uri);
        const hostname = url.hostname.toLowerCase();

        // bad hostnames
        if (BLOCKED_HOSTNAMES.has(hostname)) {
            return { valid: false, error: 'Connection to internal hosts is not allowed' };
        }

        // bad ips
        for (const pattern of BLOCKED_IP_PATTERNS) {
            if (pattern.test(hostname)) {
                return { valid: false, error: 'Connection to private networks is not allowed' };
            }
        }

        // mongo only
        if (!['mongodb:', 'mongodb+srv:'].includes(url.protocol)) {
            return { valid: false, error: 'Only MongoDB protocols are allowed' };
        }

        return { valid: true };
    } catch {
        return { valid: false, error: 'Invalid URI format' };
    }
}
