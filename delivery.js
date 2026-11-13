// Scoped, single-generation delivery recovery. Never resubmit a generation.
const ENDPOINT = '/api/backends/chat-completions/generate';
const BASE = 'https://api.doggego.online';
const LIMIT = 8 * 1024 * 1024;
const FAILURE = '回复连接中断，未能取回结果；本次可能已扣费，请先检查记录，勿立即重试';

function eligible(input, options, payload, baseUrl, context) {
    try {
        const url = new URL(input instanceof URL ? input.href : input, baseUrl);
        return (typeof input === 'string' || input instanceof URL)
            && url.origin === new URL(baseUrl).origin && url.pathname === ENDPOINT
            && String(options?.method).toUpperCase() === 'POST' && typeof options?.body === 'string'
            && payload?.stream === true && payload.chat_completion_source === 'makersuite'
            && payload.model === 'gemini-4-carbon' && /^https:\/\/api\.doggego\.online\/?$/.test(payload.reverse_proxy)
            && /^[0-9a-f]{32}$/.test(context?.runId ?? '')
            && Array.isArray(payload.tools) && payload.tools.some(tool =>
                /^(?:dispatch_stream_payload_|render_document_chunk_|stream_response_segment_|deliver_formatted_view_)[a-z0-9]{8,32}$/.test(tool?.function?.name ?? '')
                && tool?.function?.parameters?.properties?.display_stream?.type === 'string');
    } catch { return false; }
}

function randomId() {
    try {
        const id = globalThis.crypto?.randomUUID?.().replaceAll('-', '').toLowerCase();
        if (/^[0-9a-f]{32}$/.test(id ?? '')) return id;
        if (globalThis.crypto?.getRandomValues) return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
    } catch { /* Never opt in without secure randomness. */ }
    return null;
}

function deliveryError(message = FAILURE) {
    const error = new Error(message);
    error.code = 'G4_DELIVERY_UNKNOWN';
    return error;
}

function eventData(frame) {
    return frame.split(/\r\n|\r|\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).replace(/^ /, '')).join('\n');
}

export async function deliveryFetch({ fetch, input, options, payload, baseUrl, context, valid, blockRetry,
    doc = globalThis.document, now = () => Date.now(), interval = setInterval, clear = clearInterval,
    tickMs = 1000, timeoutMs = 40000, graceMs = 30000, makeId = randomId }) {
    if (!eligible(input, options, payload, baseUrl, context)) return fetch(input, options);
    const id = makeId();
    if (!/^[0-9a-f]{32}$/.test(id ?? '')) return fetch(input, options);
    const signal = options.signal;
    const requestOptions = (action, privateSignal) => ({ ...options, signal: privateSignal,
        body: JSON.stringify({ ...payload, reverse_proxy: `${BASE}/g4d1/${id}/${action}` }) });
    let issued = false, cancelSent = false, stopped = false, current, reader;
    let timer, last = now(), idle = 0, grace = 0, visible = doc?.visibilityState !== 'hidden';
    let watchdogReject;
    const resetClock = () => { idle = 0; last = now(); };
    const visibility = () => {
        const next = doc?.visibilityState !== 'hidden';
        if (next && !visible) grace = graceMs;
        visible = next; resetClock();
    };
    const sendCancel = () => {
        if (!issued || cancelSent) return;
        cancelSent = true;
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 5000);
        Promise.resolve().then(() => fetch(input, requestOptions('cancel', abort.signal)))
            .catch(() => {}).finally(() => clearTimeout(timeout));
    };
    const terminate = () => {
        if (stopped) return;
        stopped = true; current?.abort(); reader?.cancel().catch(() => {}); sendCancel();
        watchdogReject?.(new DOMException('Request cancelled', 'AbortError'));
    };
    const abortListener = () => terminate();
    signal?.addEventListener('abort', abortListener, { once: true });
    doc?.addEventListener?.('visibilitychange', visibility);
    const cleanup = () => { clear(timer); signal?.removeEventListener('abort', abortListener); doc?.removeEventListener?.('visibilitychange', visibility); };
    timer = interval(() => {
        if (stopped) return;
        if (!valid()) { terminate(); return; }
        const time = now(), elapsed = Math.max(0, time - last); last = time;
        if (!visible) return;
        // Frozen JS callbacks cannot tell whether the page was active: do not
        // count the gap, and give it the same foreground recovery window.
        if (elapsed > tickMs * 2.5) { grace = graceMs; idle = 0; return; }
        if (grace > 0) { grace = Math.max(0, grace - elapsed); return; }
        idle += elapsed;
        if (idle >= timeoutMs) { current?.abort(); watchdogReject(deliveryError()); }
    }, tickMs);
    let rejectWatch;
    let watch;
    const newWatch = () => { watch = new Promise((_, reject) => { rejectWatch = reject; }); watchdogReject = e => rejectWatch(e); };
    async function connect(action) {
        if (stopped || signal?.aborted || !valid()) { terminate(); throw new DOMException('Request cancelled', 'AbortError'); }
        current = new AbortController(); resetClock(); newWatch();
        if (action === 'start') issued = true;
        return Promise.race([fetch(input, requestOptions(action, current.signal)), watch]);
    }
    let attempts = 0, response;
    const resume = async () => {
        while (attempts < 3 && !stopped && !signal?.aborted && valid()) {
            attempts++;
            try { return await connect('resume'); } catch (e) { if (stopped || signal?.aborted) throw e; }
        }
        throw deliveryError();
    };
    const fail = error => { blockRetry(FAILURE); cleanup(); throw error?.name === 'AbortError' ? error : deliveryError(); };
    try {
        let directStartResponse = false;
        try { response = await connect('start'); directStartResponse = true; }
        catch (e) { if (stopped || signal?.aborted) throw e; response = await resume(); }
        if (directStartResponse && response.status === 403) {
            let error; try { error = await Promise.race([response.clone().json(), watch]); } catch {}
            if (error?.error?.code === 'G4_DELIVERY_INELIGIBLE' && error.not_dispatched === true) {
                cleanup(); return fetch(input, options);
            }
        }
        if (!response.ok || !response.body) throw deliveryError();
    } catch (error) { return fail(error); }

    const encoder = new TextEncoder();
    let complete = false, buffered = [], bufferedBytes = 0, pending = '', pendingBytes = 0, decoder = new TextDecoder();
    const process = chunk => {
        const decoded = decoder.decode(chunk, { stream: true });
        pending += decoded; pendingBytes += encoder.encode(decoded).byteLength;
        let match, output = [];
        while ((match = /\r\n\r\n|\r\r|\n\n/.exec(pending))) {
            const frame = pending.slice(0, match.index), raw = pending.slice(0, match.index + match[0].length);
            pending = pending.slice(match.index + match[0].length);
            const rawBytes = encoder.encode(raw).byteLength;
            pendingBytes -= rawBytes;
            const data = eventData(frame);
            if (!data) { if (frame.trim().startsWith(':')) output.push(encoder.encode(raw)); continue; }
            let json; try { json = JSON.parse(data); } catch { throw deliveryError(); }
            bufferedBytes += rawBytes;
            if (bufferedBytes > LIMIT) throw deliveryError();
            buffered.push(raw);
            const isEnd = Boolean(json?.error) || (Array.isArray(json?.candidates) && json.candidates.some(c => typeof c?.finishReason === 'string' && c.finishReason));
            if (isEnd) {
                // Once delivery owns the request, even an ordinary 502/504 may
                // be a lost result after the upstream accepted and charged it.
                if (json?.error) blockRetry(FAILURE);
                output.push(encoder.encode(buffered.join(''))); buffered = []; complete = true; break;
            }
        }
        if (bufferedBytes + pendingBytes > LIMIT) throw deliveryError();
        return output;
    };
    const stream = new ReadableStream({
        async start(controller) {
            try {
                while (!complete && !stopped) {
                    if (!response.ok || !response.body) throw deliveryError();
                    reader = response.body.getReader();
                    try {
                        while (!complete && !stopped) {
                            const result = await Promise.race([reader.read(), watch]);
                            if (result.done) break;
                            resetClock();
                            for (const chunk of process(result.value)) controller.enqueue(chunk);
                        }
                    } catch (error) { if (stopped || signal?.aborted) throw error; }
                    finally { reader.cancel().catch(() => {}); reader.releaseLock(); reader = null; }
                    if (complete || stopped) break;
                    // Resume replays the whole result: discard unexposed fragments.
                    pending = ''; pendingBytes = 0; buffered = []; bufferedBytes = 0; decoder = new TextDecoder();
                    response = await resume();
                }
                if (stopped) throw new DOMException('Request cancelled', 'AbortError');
                cleanup(); controller.close();
            } catch (error) {
                if (!stopped) blockRetry(FAILURE);
                cleanup(); controller.error(error?.name === 'AbortError' ? error : deliveryError());
            }
        },
        cancel() { terminate(); cleanup(); },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
