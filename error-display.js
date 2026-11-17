// Display only. Never use these summaries to decide whether to retry, and never
// stringify an entire error/request or retain the raw object in UI history.
export function sanitizeErrorText(value, secrets = []) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    let text = String(value);
    if (text.length > 4096) return '[错误详情过长，已隐藏]';
    // Free-form messages can echo a single chat message or an unfamiliar body
    // shape. Hide the whole structured suffix, not just known prompt keys.
    text = text.replace(/[\[{][\s\S]*/, '[结构化详情已隐藏]');
    for (const secret of secrets) {
        if (typeof secret !== 'string' || !secret) continue;
        for (const form of [secret, encodeURIComponent(secret)]) text = text.split(form).join('[已隐藏]');
    }
    text = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ');
    // Do not show URLs: they can contain credentials in paths as well as queries.
    text = text.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, '[地址已隐藏]')
        .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>\]}]+/gi, '[凭据已隐藏]')
        .replace(/\b(?:sk-[a-z0-9_-]{6,}|AIza[a-z0-9_-]{12,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)/gi, '[凭据已隐藏]')
        .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|proxy[_ -]?password|password|authorization|secret|token|\bkey|密钥)["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;<>\]}]+)/gi, '$1[已隐藏]')
        .replace(/(\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret|token|key)\s+)(?:"[^"]*"|'[^']*'|[a-z0-9_./+=-]{12,})/gi, '$1[已隐藏]');
    // Error messages sometimes echo the complete submitted body. Keep the
    // preceding explanation only; request fields themselves are never walked.
    text = text.replace(/(?:["']?\b(?:messages?|prompt|contents?|parts|text|input|payload|request[_ ]?body|headers|config)["']?\s*[:=]|(?:请求体|提示词|聊天内容)\s*[:：])[\s\S]*/i, '[请求内容已隐藏]');
    return text.replace(/\s+/g, ' ').trim().slice(0, 320);
}

export function summarizeApiFailure({error, status, model, elapsedMs, secrets = []} = {}) {
    try {
        const messages = [], codes = [], names = [], seen = new Set();
        let visited = 0, recorded = false;
        const add = (list, value) => {
            const text = sanitizeErrorText(value, secrets);
            if (text && !list.includes(text)) list.push(text);
        };
        function walk(value, depth = 0) {
            if (depth > 4 || visited++ >= 16 || value == null) return;
            if (typeof value === 'string') { add(messages, value); return; }
            if (typeof value !== 'object' || seen.has(value)) return;
            seen.add(value);
            if (Array.isArray(value)) { for (const entry of value.slice(0, 3)) walk(entry, depth + 1); return; }
            if (value.g4keep?.version === 1 && value.g4keep.outcome === 'failed') recorded = true;
            add(names, value.name);
            for (const field of ['message', 'msg']) add(messages, value[field]);
            for (const field of ['code', 'type', 'status']) add(codes, value[field]);
            if (value.quota_error) add(codes, 'quota_error');
            for (const field of ['error', 'detail', 'cause']) walk(value[field], depth + 1);
        }
        walk(error);
        const actualStatus = Number(status);
        const http = Number.isInteger(actualStatus) && actualStatus >= 400 && actualStatus <= 599 ? `HTTP ${actualStatus}` : '';
        const code = codes.filter(x => x !== String(actualStatus)).slice(0, 2).join(' / ').slice(0, 96);
        let category = http || recorded || error?.error ? 'API 返回错误' : '请求失败';
        let message = messages.filter(x => !/^(?:结果取回失败：HTTP|Got response status) \d+$/.test(x)).join('；').slice(0, 480);
        const description = [...names, ...codes, ...messages].join(' ');
        if (recorded && /Upstream generation failed/i.test(message)) {
            category = '上游生成失败';
        } else if (recorded && /NewAPI\/upstream rejected request/i.test(message)) {
            category = '服务端或上游拒绝请求';
        } else if (recorded && /output\/thinking limit/i.test(message)) {
            category = '达到输出或思考长度上限';
        } else if (/G4_DELIVERY_/.test(description) || names.includes('DeliveryHttpError') || messages.some(x => /^结果取回失败：HTTP/.test(x))) {
            category = '结果取回失败';
        } else if (names.includes('SyntaxError')) {
            category = '响应解析失败'; message = '收到的数据无法按预期格式解析。';
        } else if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|Failed to fetch|fetch failed|NetworkError|network request failed|Load failed|connection (?:lost|closed)/i.test(description)) {
            category = '连接或传输失败';
        } else if (/TimeoutError|timed? out|timeout|超时/i.test(description)) {
            category = '请求或连接超时';
        }
        // The old bridge's phrase describes its own lack of internal retries,
        // not this extension's policy. Do not present it as a ban on retrying.
        if (recorded) message = message.replace(/;?\s*no automatic retry/gi, '').trim();
        if (category === '结果取回失败') {
            const reasons = {
                G4_DELIVERY_MISSING:'没有可取回的结果：可能尚未受理、记录已过期或服务重启；不能据此判断此前是否生成。',
                G4_DELIVERY_FAILED:'回传中断，未能取回完整结果；不等于已确认模型生成失败。',
                G4_DELIVERY_BUSY:'结果取回服务暂忙或保护空间已满。',
                G4_DELIVERY_EXPIRED:'暂存的回复已过期，无法取回。',
                G4_DELIVERY_SUPERSEDED:'同一 Key 的下一次生成已释放旧的暂存回复。',
            };
            for (const code of codes) if (reasons[code]) { message = reasons[code]; break; }
        }
        if (!message) message = '接口未提供具体错误原因，不能仅凭此判断是网络还是模型问题。';
        const modelName = sanitizeErrorText(model, secrets).slice(0, 96);
        const seconds = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? `${Math.round(elapsedMs / 1000)} 秒` : '';
        const heading = [category, http, code].filter(Boolean).join(' · ');
        const context = [modelName, seconds && `本次等待 ${seconds}`].filter(Boolean).join(' · ');
        const summary = `${heading}：${message.slice(0,160)}${context ? '\n' + context : ''}`;
        const detail = [heading, modelName && `模型：${modelName}`, seconds && `本次等待：${seconds}`, `错误详情：${message}`].filter(Boolean).join('\n');
        return {summary, detail};
    } catch {
        return {summary:'请求失败：错误详情无法读取',detail:'错误详情无法读取；不能据此判断是网络还是模型问题。'};
    }
}
