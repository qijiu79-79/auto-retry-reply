// Use SillyTavern's own extension updater, without modifying its settings.
const EXTENSION = 'auto-retry-reply';
const REFRESH_DELAY = 1000;
const CHECK_RETRIES = 2;
const CHECK_RETRY_DELAY = 1500;
export const MESSAGE_EDIT_SELECTOR = '#chat .edit_textarea, #chat .mes_edit_textarea, #chat .reasoning_edit_textarea';

export function refreshBlockedReason(document, busy) {
    if (busy) return '仍在生成或等待自动重试';
    if (document.querySelector('#send_textarea')?.value?.trim()) return '有未发送的输入草稿';
    if (document.querySelector('#file_form_input')?.files?.length) return '有未发送的附件';
    if (document.querySelector(MESSAGE_EDIT_SELECTOR)) return '正在编辑消息或思考内容';
    return '';
}

export function createExtensionUpdater({ fetch, getRequestHeaders, getExtensionType, getBlockedReason,
    reload, onState = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let state = { phase: 'idle', message: '尚未检查更新' };
    let busy = false, disposed = false, availableScope = null, refreshTimer = null, pendingRefresh = false;
    let activeAbort, activeCancel;
    const emit = (phase, message, extra = {}) => {
        if (!disposed) { state = { phase, message, ...extra }; onState(state); }
        return state;
    };
    const scope = () => {
        const type = getExtensionType();
        return type === 'local' || type === 'global' ? type : null;
    };
    const finishRefresh = () => {
        refreshTimer = null;
        if (disposed || !pendingRefresh) return;
        let blocked;
        try { blocked = getBlockedReason(); } catch { blocked = '暂时无法确认页面状态'; }
        if (blocked) {
            emit('waiting-reload', `更新已安装，等待安全刷新：${String(blocked)}`);
            refreshTimer = setTimer(finishRefresh, REFRESH_DELAY);
            return;
        }
        pendingRefresh = false;
        emit('reloading', '更新已安装，正在刷新页面');
        reload();
    };
    const request = async (path, type, timeoutMs) => {
        const abort = new AbortController();
        activeAbort = abort;
        let timer;
        const timeout = new Promise((_, reject) => {
            activeCancel = () => { abort.abort(); reject(new Error('已取消')); };
            timer = setTimer(() => { abort.abort(); reject(new Error('请求超时')); }, timeoutMs);
        });
        try {
            const response = await Promise.race([fetch(path, {
                method: 'POST', headers: getRequestHeaders(), signal: abort.signal,
                body: JSON.stringify({ extensionName: EXTENSION, global: type === 'global' }),
            }), timeout]);
            if (!response.ok) {
                response.body?.cancel().catch(() => {});
                throw Object.assign(new Error(`请求失败（${response.status}）`), {
                    retryableCheck: [500, 502, 503, 504].includes(response.status),
                });
            }
            // Include response parsing in the timeout; a stalled body must not
            // prevent the user from trying a later manual check.
            return await Promise.race([response.json(), timeout]);
        } catch (error) {
            if (error?.name === 'TypeError' && !abort.signal.aborted) {
                throw Object.assign(new Error('网络连接失败'), { retryableCheck: true });
            }
            throw error;
        } finally {
            clearTimer(timer);
            if (activeAbort === abort) { activeAbort = null; activeCancel = null; }
        }
    };
    const validRepo = data => typeof data?.isUpToDate === 'boolean'
        && typeof data.remoteUrl === 'string' && Boolean(data.remoteUrl.trim());

    async function checkVersion(type) {
        for (let attempt = 0; ; attempt++) {
            try { return await request('/api/extensions/version', type, 30000); }
            catch (error) {
                // Version queries may fail transiently while Tavern fetches
                // Git metadata. Never repeat an install or a timed-out query.
                if (disposed || !error?.retryableCheck || attempt >= CHECK_RETRIES) throw error;
                emit('checking', `检查暂时失败，正在重试（${attempt + 1}/${CHECK_RETRIES}）…`);
                await new Promise((resolve, reject) => {
                    const timer = setTimer(() => { activeCancel = null; resolve(); }, CHECK_RETRY_DELAY);
                    activeCancel = () => { clearTimer(timer); activeCancel = null; reject(new Error('已取消')); };
                });
                if (disposed) throw new Error('已取消');
                if (scope() !== type) throw new Error('扩展安装位置发生变化，请重新检查更新');
            }
        }
    }

    async function check() {
        if (disposed || busy || pendingRefresh) return state;
        const type = scope();
        availableScope = null;
        if (!type) return emit('error', '无法确定扩展安装位置，请在管理扩展程序中更新');
        busy = true; emit('checking', '正在检查更新…');
        try {
            const data = await checkVersion(type);
            if (disposed) return state;
            if (!validRepo(data) || typeof data.currentCommitHash !== 'string' || !data.currentCommitHash.trim()) {
                return emit('error', '无法确认版本，请检查扩展是否通过 Git 安装');
            }
            if (data.isUpToDate) return emit('current', '磁盘上的扩展已是最新；若此前已更新，请在空闲时刷新页面生效');
            availableScope = type;
            return emit('available', '发现可用更新，可点击更新');
        } catch (error) {
            return emit('error', `检查更新失败：${error?.message || '请稍后重试'}；可稍后重试，或在“管理扩展程序”中更新`);
        } finally { busy = false; }
    }

    async function update() {
        if (disposed || busy || pendingRefresh || state.phase !== 'available' || !availableScope) return state;
        const type = scope();
        if (type !== availableScope) {
            availableScope = null;
            return emit('error', '扩展安装位置发生变化，请重新检查更新');
        }
        busy = true; availableScope = null; emit('updating', '正在更新扩展…');
        try {
            const data = await request('/api/extensions/update', type, 60000);
            if (disposed) return state;
            if (!validRepo(data) || typeof data.shortCommitHash !== 'string' || !data.shortCommitHash.trim()) {
                return emit('error', '酒馆返回的更新结果无法确认，请手动检查');
            }
            if (data.isUpToDate) return emit('current', '扩展已由其他更新操作更新；请在空闲时刷新页面生效');
            pendingRefresh = true;
            emit('waiting-reload', '更新已安装，将在安全时自动刷新');
            refreshTimer = setTimer(finishRefresh, REFRESH_DELAY);
            return state;
        } catch (error) {
            return emit('error', error?.message === '请求超时'
                ? '更新请求超时，可能已安装；请重新检查并在空闲时刷新'
                : `更新失败：${error?.message || '请稍后重试'}`);
        } finally { busy = false; }
    }

    function cancelRefresh() {
        if (!pendingRefresh || disposed) return state;
        pendingRefresh = false;
        if (refreshTimer !== null) clearTimer(refreshTimer);
        refreshTimer = null;
        return emit('idle', '已取消自动刷新；更新已安装，请在空闲时手动刷新');
    }

    function dispose() {
        disposed = true; pendingRefresh = false;
        if (refreshTimer !== null) clearTimer(refreshTimer);
        refreshTimer = null;
        activeCancel?.();
    }
    return { check, update, cancelRefresh, dispose };
}
