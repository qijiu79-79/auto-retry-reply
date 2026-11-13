// Read only error descriptors, never stringify/log entire request objects.
function describeError(error, seen = new Set()) {
    if (typeof error === 'string' || typeof error === 'number') return String(error);
    if (!error || typeof error !== 'object' || seen.has(error)) return '';
    seen.add(error);
    const parts = error.quota_error ? ['quota_error'] : [];
    for (const field of ['name', 'message', 'code', 'type', 'error', 'detail', 'payload', 'cause']) {
        parts.push(describeError(error[field], seen));
    }
    return parts.join(' ');
}

export function isRetryableApiError({ error, status } = {}) {
    const description = describeError(error).toLowerCase();
    const code = Number(status);
    if (/\baborterror\b|operation was aborted|user aborted|generation was aborted|clicked stop button/.test(description)) return false;
    if ([401, 402, 403, 404, 405, 413, 415, 422].includes(code)) return false;

    const permanent = [
        /invalid[_ -]?(?:api[_ -]?)?key|incorrect[_ -]api[_ -]key|authentication|unauthorized|unauthorised|invalid[_ -]credentials/,
        /insufficient[_ -]quota|quota[_ -]error|quota[_ -]exceeded|quota[^.]*exhausted|exceeded[^.]*quota/,
        /insufficient[^.]*(?:balance|credit)|credit[^.]*exhausted|billing[^.]*(?:limit|hard)|余额不足|余额耗尽|额度耗尽|额度不足|配额耗尽/,
        /invalid[_ -]request|invalid[_ -]parameter|unsupported[_ -]parameter|context[_ -]length|maximum context|too many tokens|token limit/,
        /content[_ -]filter|content[_ -]policy|policy[_ -]violation|moderation|safety[_ -](?:filter|block)|违反政策|内容违规/,
    ];
    if (permanent.some(pattern => pattern.test(description))) return false;
    if ([408, 409, 425, 429].includes(code) || code >= 500 && code <= 599) return true;
    // Generic upstream errors (notably openai_error) carry very little detail.
    // They are eligible only because this is called from a failed API request,
    // not from arbitrary toast messages or model-generated prose.
    return description.trim().length > 0;
}
