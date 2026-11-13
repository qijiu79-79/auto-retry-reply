import { DEFAULT_KEYWORDS, detectFailure } from './detector.js';
import { isRetryableApiError } from './api-error.js';

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    retryEmpty: true,
    retryApology: true,
    retryApiErrors: true,
    maxRetries: 20,
    delayMs: 2000,
    keywords: DEFAULT_KEYWORDS,
});

export function normalizeSettings(value = {}) {
    const result = { ...DEFAULT_SETTINGS };
    for (const key of ['enabled', 'retryEmpty', 'retryApology', 'retryApiErrors']) {
        if (typeof value?.[key] === 'boolean') result[key] = value[key];
    }
    for (const [key, min, max] of [['maxRetries', 1, 20], ['delayMs', 500, 60000]]) {
        const number = Number(value?.[key]);
        if (value?.[key] !== '' && value?.[key] != null && Number.isFinite(number)) {
            result[key] = Math.min(max, Math.max(min, Math.round(number)));
        }
    }
    if (typeof value?.keywords === 'string') result.keywords = value.keywords;
    return result;
}

function newRunId() {
    try {
        const crypto = globalThis.crypto;
        if (typeof crypto?.randomUUID === 'function') {
            const id = crypto.randomUUID().replaceAll('-', '').toLowerCase();
            if (/^[0-9a-f]{32}$/.test(id)) return id;
        }
        if (typeof crypto?.getRandomValues === 'function') {
            return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        }
    } catch { /* Without secure randomness, leave requests unmarked. */ }
    return null;
}

// Content failures create new swipe versions. API failures instead retry the
// exact in-progress request, so a missing reply never targets an older message.
export function createRetryController({ getState, getSettings, retry, notify = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let active = null;
    let pending = null;
    let launching = null;
    let inFlight = null;
    let timer = null;
    let apiWait = null;
    const requestRuns = new WeakMap();

    function clearPending() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        pending = null;
    }

    function cancel(reason = '已取消本轮自动重试') {
        const hadWork = active !== null || pending !== null || launching !== null;
        apiWait?.finish(false);
        clearPending();
        active = null;
        launching = null;
        if (inFlight) inFlight.cancelled = true;
        if (hadWork) notify({ kind: 'cancelled', reason });
    }

    function sameChat(run, state) {
        return state.key === run.key && state.chat === run.chat && !state.groupId;
    }

    function onStart(type, options = {}, dryRun = false) {
        if (dryRun || type === 'quiet') return;
        const state = getState();
        // Native swipe prepares its new slot asynchronously. A stop during that
        // preparation must not make the later start look like a fresh user turn.
        if (type === 'swipe' && inFlight?.cancelled && sameChat(inFlight, state)) return;
        const owned = type === 'swipe' && launching !== null && sameChat(launching, state);
        const owner = owned ? launching : null;
        const attempts = owned ? launching.attempts : 0;
        apiWait?.finish(false);
        clearPending();
        active = null;
        launching = null;
        if (!getSettings().enabled || state.groupId || options.signal?.aborted || ![undefined, 'normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
        active = {
            key: state.key, chat: state.chat, attempts, owned, owner, type, runId: owned ? owner.runId : newRunId(),
            prefix: type === 'continue' ? (state.chat.at(-1)?.mes ?? '') : '',
            ended: false, message: null, id: -1,
        };
        notify({ kind: owned ? 'retrying' : 'monitoring', attempts });
    }

    function onRequestStarted(request) {
        const run = active;
        if (!run || (request.type ?? 'normal') !== (run.type ?? 'normal') || request.signal?.aborted) return false;
        if (!sameChat(run, getState())) return false;
        requestRuns.set(request, run);
        return true;
    }

    function getRoutingContext(request) {
        const run = requestRuns.get(request);
        if (!run || active !== run || request.signal?.aborted || !getSettings().enabled || !sameChat(run, getState())) return null;
        return { runId: run.runId, attempt: run.attempts };
    }

    function cancelRequest(request, reason) {
        const run = requestRuns.get(request);
        if (run && active === run) cancel(reason);
    }

    async function onRequestFailed(event) {
        const run = requestRuns.get(event.request);
        if (!run || active !== run || apiWait || !sameChat(run, getState())) return;
        const settings = getSettings();
        if (!settings.enabled || !settings.retryApiErrors || event.request.signal?.aborted || !isRetryableApiError(event)) {
            cancel('API 请求失败，本轮不再自动重试');
            return;
        }
        if (run.attempts >= settings.maxRetries) {
            cancel();
            notify({ kind: 'limit', attempts: run.attempts });
            return;
        }

        const state = getState();
        const message = state.chat.at(-1);
        const length = state.chat.length;
        const text = message?.mes;
        const swipeId = message?.swipe_id;
        const signal = event.request.signal;
        let delayMs = settings.delayMs;
        if (event.retryAfter) {
            const seconds = Number(event.retryAfter);
            const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(event.retryAfter) - Date.now();
            if (Number.isFinite(serverDelay)) delayMs = Math.max(delayMs, serverDelay);
        }
        // Avoid overflowing setTimeout and accidentally retrying immediately.
        if (delayMs > 2147483647) return cancel('服务端要求稍后重试，请稍后手动尝试');
        notify({ kind: 'pending', failure: { kind: 'api' }, attempts: run.attempts + 1, maxRetries: settings.maxRetries, delayMs });

        const ready = await new Promise(resolve => {
            let timeout;
            const abort = () => wait.finish(false);
            const wait = { finish: value => {
                if (apiWait !== wait) return;
                clearTimer(timeout);
                signal?.removeEventListener('abort', abort);
                apiWait = null;
                resolve(value);
            } };
            apiWait = wait;
            timeout = setTimer(() => wait.finish(true), delayMs);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) wait.finish(false);
        });
        if (!ready || active !== run) return;
        const current = getState();
        const currentSettings = getSettings();
        if (!currentSettings.enabled || !currentSettings.retryApiErrors || signal?.aborted || !sameChat(run, current)
            || current.chat.length !== length || current.chat.at(-1) !== message || message?.mes !== text || message?.swipe_id !== swipeId
            || current.blocked || run.attempts >= currentSettings.maxRetries) {
            return cancel('请求或聊天状态已变化，取消 API 重试');
        }
        run.attempts++;
        run.apiRetrying = true;
        event.retry = true;
        notify({ kind: 'retrying', attempts: run.attempts });
    }

    function onReceived(id, type) {
        if (!active || ['first_message', 'quiet', 'impersonate'].includes(type)) return;
        const state = getState();
        if (state.streamFailed) return cancel('生成已中断，不自动重试');
        if (!sameChat(active, state) || id !== state.chat.length - 1) return;
        const message = state.chat[id];
        if (!message || message.is_user || message.is_system) return;
        active.message = message;
        active.id = id;
        considerRetry();
    }

    function onEnded() {
        if (!active) return;
        if (getState().streamFailed) return cancel('生成已中断，不自动重试');
        active.ended = true;
        considerRetry();
    }

    function failureFor(run, settings) {
        const message = run.message;
        let text = message.mes ?? '';
        // A failed continuation is detected from the appended part, not old text.
        if (run.type === 'continue' && text.startsWith(run.prefix)) text = text.slice(run.prefix.length);
        const failure = detectFailure(text, { ...settings, totalText: message.mes ?? '' });
        // Image/audio-only responses are valid, not empty text failures.
        const hasMedia = message.extra?.image || message.extra?.video || message.extra?.audio || message.extra?.media?.length;
        return failure?.kind === 'empty' && hasMedia ? null : failure;
    }

    function considerRetry() {
        const run = active;
        if (!run?.ended || !run.message || pending) return;
        const settings = getSettings();
        if (!settings.enabled) return cancel('插件已关闭');
        const failure = failureFor(run, settings);
        if (!failure) {
            active = null;
            notify({ kind: 'success', attempts: run.attempts });
            return;
        }
        if (run.attempts >= settings.maxRetries) {
            active = null;
            notify({ kind: 'limit', attempts: run.attempts });
            return;
        }
        const job = {
            run, failure, text: run.message.mes, swipeId: run.message.swipe_id,
            waits: 0,
        };
        pending = job;
        notify({ kind: 'pending', failure, attempts: run.attempts + 1, maxRetries: settings.maxRetries, delayMs: settings.delayMs });
        timer = setTimer(() => execute(job), settings.delayMs);
    }

    async function execute(job) {
        timer = null;
        if (pending !== job || active !== job.run) return;
        const state = getState();
        const settings = getSettings();
        const run = job.run;
        const message = state.chat[run.id];
        if (!settings.enabled || !sameChat(run, state) || run.id !== state.chat.length - 1
            || message !== run.message || message.mes !== job.text || message.swipe_id !== job.swipeId) {
            return cancel('聊天或回复已变化，取消重试');
        }
        if (state.blocked) return cancel(state.blocked);
        if (!failureFor(run, settings)) return cancel('当前回复不再符合重试条件');
        if (run.attempts >= settings.maxRetries) return cancel('已达到重试上限');
        // GENERATION_ENDED can precede MESSAGE_RECEIVED on streams. The native
        // swipe/save cleanup can also still be running; never overlap requests.
        if (state.busy || inFlight) {
            if (++job.waits > 60) return cancel('酒馆仍在忙碌，已取消自动重试');
            timer = setTimer(() => execute(job), 250);
            return;
        }
        pending = null;
        const token = { key: run.key, chat: run.chat, attempts: run.attempts + 1, runId: run.runId };
        launching = token;
        inFlight = token;
        try {
            await retry(run.id);
            if (launching === token) cancel('未启动新回复，请手动检查连接和聊天状态');
            else if (active?.owner === token && !active.message) cancel('未收到新回复，已停止自动重试');
        } catch (error) {
            // An old request failing after a chat switch must not cancel new work.
            if (active === run || active?.owner === token) {
                cancel();
                notify({ kind: 'error', error });
            }
        } finally {
            if (launching === token) launching = null;
            if (inFlight === token) inFlight = null;
        }
    }

    return {
        onStart, onReceived, onEnded, onRequestStarted, onRequestFailed, getRoutingContext, cancelRequest, cancel,
        onSwiped: () => { if (!launching && pending) cancel('已手动切换回复'); },
        cancelPending: () => { if (pending || apiWait) cancel('回复已编辑或删除'); },
        isRetrying: () => Boolean(launching || active?.owned || active?.apiRetrying || apiWait),
    };
}
