/**
 * blocks dangerous operators
 */

const BLOCKED_OPERATORS = new Set([
    '$where',           // js execution
    '$function',        // custom js
    '$accumulator',     // custom accumulators
    '$expr',            // expressions
    '$jsonSchema',      // schema bypass
]);

const BLOCKED_OPERATOR_PREFIXES = [
    '$$',               // system vars
];

/**
 * find bad stuff recursively
 */
function findBlockedOperator(obj: unknown, path = ''): string | null {
    if (obj === null || obj === undefined) {
        return null;
    }

    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            const result = findBlockedOperator(obj[i], `${path}[${i}]`);
            if (result) return result;
        }
        return null;
    }

    if (typeof obj === 'object') {
        for (const key of Object.keys(obj)) {
            // operator check
            if (BLOCKED_OPERATORS.has(key)) {
                return `Blocked operator "${key}" found at ${path || 'root'}`;
            }

            // prefix check
            for (const prefix of BLOCKED_OPERATOR_PREFIXES) {
                if (key.startsWith(prefix)) {
                    return `Blocked operator prefix "${prefix}" found in "${key}" at ${path || 'root'}`;
                }
            }

            // dive deep
            const result = findBlockedOperator((obj as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
            if (result) return result;
        }
    }

    return null;
}

/**
 * sanitize a mongodb filter to prevent nosql injection
 * @param filter the filter object to sanitize
 * @returns object with sanitized filter or error
 */
export function sanitizeFilter(filter: unknown): { valid: true; filter: Record<string, unknown> } | { valid: false; error: string } {
    if (filter === null || filter === undefined) {
        return { valid: true, filter: {} };
    }

    if (typeof filter !== 'object' || Array.isArray(filter)) {
        return { valid: false, error: 'Filter must be an object' };
    }

    const blockedOperator = findBlockedOperator(filter);
    if (blockedOperator) {
        return { valid: false, error: blockedOperator };
    }

    return { valid: true, filter: filter as Record<string, unknown> };
}

/**
 * sanitize a mongodb update object
 * @param update the update object to sanitize
 * @returns object with sanitized update or error
 */
export function sanitizeUpdate(update: unknown): { valid: true; update: Record<string, unknown> } | { valid: false; error: string } {
    if (update === null || update === undefined) {
        return { valid: false, error: 'Update object is required' };
    }

    if (typeof update !== 'object' || Array.isArray(update)) {
        return { valid: false, error: 'Update must be an object' };
    }

    const blockedOperator = findBlockedOperator(update);
    if (blockedOperator) {
        return { valid: false, error: blockedOperator };
    }

    return { valid: true, update: update as Record<string, unknown> };
}
