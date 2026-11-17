import { sanitizeErrorText, summarizeApiFailure } from './error-display.js';

export function createRetryNotifier({toastr, getPanel = () => null}) {
    let lastReason, lastToast;
    // Display failures must never interrupt a retry or a manual cancellation.
    // Do not log caught objects: they may contain the original private request.
    const safely = action => { try { return action(); } catch {} };
    const clearToast = () => {
        if (lastToast) safely(() => toastr.clear?.(lastToast, {force:true}));
        lastToast = null;
    };
    const show = (kind, text, timeout = 8000) => {
        clearToast();
        lastToast = safely(() => toastr[kind](text, '自动重试', {
            escapeHtml:true,toastClass:'toast arr-retry-toast',timeOut:timeout,extendedTimeOut:8000,
        }));
    };
    const reasonFor = failure => {
        if (failure?.diagnostic) return failure.diagnostic;
        const summary = failure?.kind === 'empty' ? '内容检查：空回或只有思考，没有正文'
            : failure?.kind === 'api' ? 'API 请求失败：接口未提供具体错误原因'
                : `内容检查：命中关键词「${sanitizeErrorText(failure?.keyword)}」`;
        return {summary,detail:summary};
    };
    function update(event) {
        if (event.kind === 'monitoring') { lastReason = null; clearToast(); }
        if (event.failure) lastReason = reasonFor(event.failure);
        if (event.diagnostic) lastReason = event.diagnostic;
        let text;
        switch (event.kind) {
            case 'monitoring': text = '正在等待本次回复完成…'; break;
            case 'pending':
                text = `${lastReason.summary}\n${event.delayMs / 1000} 秒后重试（${event.attempts}/${event.maxRetries}）`;
                show('info', text, Math.min(12000, Math.max(6000, event.delayMs)));
                break;
            case 'retrying':
                text = `正在自动生成第 ${event.attempts} 次重试…${lastReason ? '\n上次原因：' + lastReason.summary : ''}`;
                break;
            case 'success':
                clearToast(); text = event.attempts ? `回复正常，本轮重试 ${event.attempts} 次后结束` : '回复正常，无需重试'; break;
            case 'limit':
                text = `已连续重试 ${event.attempts} 次，达到上限，已停止${lastReason ? '\n最近原因：' + lastReason.summary : ''}`;
                show('warning', text); break;
            case 'error':
                lastReason = event.diagnostic || summarizeApiFailure({error:event.error});
                text = `自动重试失败，已停止\n${lastReason.summary}`; show('error', text); break;
            case 'delivery-error':
                text = sanitizeErrorText(event.reason); lastReason = {summary:text,detail:text}; show('error', text); break;
            default:
                clearToast(); text = event.reason || '已就绪';
                if (event.diagnostic) text += '\n' + event.diagnostic.summary;
        }
        const panel = getPanel();
        const status = panel?.querySelector('[data-status]');
        if (status) status.textContent = text;
        const recent = panel?.querySelector('[data-last-error]');
        if (recent) recent.hidden = !lastReason;
        const detail = panel?.querySelector('[data-error-detail]');
        if (detail) detail.textContent = lastReason?.detail || '';
    }
    return event => safely(() => update(event));
}
