// Only the explicitly configured Argon proxy is eligible for per-attempt routing.
export function routedOptions(payload, options, context) {
    if (payload?.chat_completion_source !== 'makersuite' || payload?.model !== 'gemini-4-argon'
        || typeof payload?.reverse_proxy !== 'string' || !/^https:\/\/api\.doggego\.online\/?$/.test(payload.reverse_proxy)
        || !/^[0-9a-f]{32}$/.test(context?.runId ?? '')
        || !Number.isInteger(context?.attempt) || context.attempt < 0 || context.attempt > 20) return options;
    return { ...options, body: JSON.stringify({ ...payload,
        reverse_proxy: `https://api.doggego.online/g4r1/${context.runId}/${context.attempt}` }) };
}
