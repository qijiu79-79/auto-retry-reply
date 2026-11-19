import { isGenerating, swipe, getRequestHeaders } from '../../../../script.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE, SWIPE_STATE } from '../../../constants.js';
import { extensionTypes } from '../../../extensions.js';
import { createRetryController, DEFAULT_SETTINGS, normalizeSettings } from './controller.js';
import { createRetryFetch } from './fetch-retry.js';
import { createExtensionUpdater, refreshBlockedReason, MESSAGE_EDIT_SELECTOR } from './updater.js';
import { createRetryNotifier } from './notifications.js';

const KEY = 'auto_retry_reply';
const context = () => SillyTavern.getContext();
const settings = () => normalizeSettings(context().extensionSettings[KEY]);
let panel;

function getState() {
    const ctx = context();
    const stream = ctx.streamingProcessor;
    return {
        key: JSON.stringify([ctx.groupId ?? null, ctx.characterId ?? null, ctx.chatId ?? null]),
        chat: ctx.chat,
        groupId: ctx.groupId,
        busy: isGenerating() || Boolean(stream) || ctx.swipe.state() !== SWIPE_STATE.NONE,
        streamFailed: Boolean(stream?.isStopped || stream?.abortController?.signal.aborted),
        blocked: ctx.onlineStatus === 'no_connection' ? 'API 未连接，已取消自动重试'
            : document.querySelector(MESSAGE_EDIT_SELECTOR) ? '正在编辑消息，已取消自动重试' : '',
    };
}

const notify = createRetryNotifier({toastr, getPanel:() => panel});

const controller = createRetryController({
    getState, getSettings: settings, notify,
    retry: async (id) => {
        const message = context().chat[id];
        await swipe(null, SWIPE_DIRECTION.RIGHT, {
            source: SWIPE_SOURCE.SLASH_COMMAND,
            forceMesId: id,
            // Always create a new variant, even when viewing an older swipe.
            forceSwipeId: Math.max(1, message.swipes?.length ?? 1),
            forceDuration: 0,
        });
    },
});

function fillSettings() {
    const value = settings();
    for (const input of panel.querySelectorAll('[data-setting]')) {
        if (input.type === 'checkbox') input.checked = value[input.dataset.setting];
        else input.value = value[input.dataset.setting];
    }
}

function initialize() {
    if (document.getElementById('auto-retry-reply-settings')) return;
    panel = document.createElement('div');
    panel.id = 'auto-retry-reply-settings';
    panel.className = 'extension_container';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>空回 / 道歉自动重试（免补丁版）</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input type="checkbox" data-setting="enabled"><span>启用自动重试</span></label>
                <label class="checkbox_label"><input type="checkbox" data-setting="retryEmpty"><span>空白回复 / 只有思考内容时重试</span></label>
                <label class="checkbox_label"><input type="checkbox" data-setting="retryApiErrors"><span>API 临时错误 / openai_error / 断线时重试</span></label>
                <label class="checkbox_label"><input type="checkbox" data-setting="retryApology"><span>整条回复少于 1000 字符且命中道歉 / 拒答关键词时重试</span></label>
                <div class="arr-numbers">
                    <label>每轮最多重试（1–20 次）<input class="text_pole" type="number" min="1" max="20" step="1" data-setting="maxRetries"></label>
                    <label>重试间隔（毫秒）<input class="text_pole" type="number" min="500" max="60000" step="500" data-setting="delayMs"></label>
                </div>
                <label>道歉 / 拒答关键词（每行一个，不区分英文大小写）
                    <textarea class="text_pole" rows="6" data-setting="keywords" spellcheck="false"></textarea>
                </label>
                <small>免补丁版：只安装扩展，不修改酒馆原程序，不影响源码更新。只处理单角色聊天。空回 / 道歉会新建回复版本，原文仍可左右切换；续写内容检测失败时重新生成整条回复。API 错误会重发同一请求，不重发用户输入、不删除旧消息；三类重试共用上限。</small>
                <small>指定反代上的 Argon 首次请求走普通线路，自动重试走防超时线路；历史思考签名仍可能触发保护。其他模型和地址不变。</small>
                <small>Carbon 普通、low、high 保留心跳和断线取回：优先按原型号取回同一次生成；取回失败后，按与其他模型相同的 API 重试规则、次数和间隔处理，不另加“状态未知就禁止重试”的限制，也不做生成前登记。需配套桥 0.3.9 或更新版，完整结果最多暂存 5 分钟，同 Key 下一次保护生成受理可提前清理旧缓存。后台等待回到前台。失败后重新生成仍可能计费。此功能不分 Key、不修改共享预设。</small>
                <small>流式回复已经输出事件后再出错，不自动重发，会保留片段并停止本轮重试，请手动重新生成；这样不会把新旧正文、思考或工具调用拼在一起。</small>
                <small>道歉检测仅处理少于 1000 字符的整条正文，达到 1000 字符即跳过；思考内容不计入。短回复中的正常道歉台词仍可能命中，可删改关键词或关闭道歉检测。API 错误不受字数限制；密钥错误、余额不足、明确内容限制等不重试。重试会额外调用当前 API 并可能计费。停止生成、切换聊天、修改设置可取消重试；限流时遵守服务端等待时间。</small>
                <div class="flex-container">
                    <button type="button" class="menu_button" data-action="cancel">取消本轮重试</button>
                    <button type="button" class="menu_button" data-action="reset-keywords">恢复默认关键词</button>
                </div>
                <div data-status role="status" aria-live="polite">已就绪，等待下一次模型回复</div>
                <div data-last-error class="arr-last-error" hidden>
                    <b>本轮最近一次失败原因</b>
                    <div data-error-detail></div>
                    <small>仅保留在当前页面，下一轮手动生成时清除；未提供详情时不推断网络或模型故障。</small>
                </div>
                <hr>
                <small>当前版本：1.1.13 · 使用酒馆原生更新，保留原设置</small>
                <div class="flex-container arr-update">
                    <button type="button" class="menu_button" data-action="check-update">检查更新</button>
                    <button type="button" class="menu_button" data-action="install-update" hidden>安装更新</button>
                    <button type="button" class="menu_button" data-action="cancel-refresh" hidden>取消自动刷新</button>
                </div>
                <div data-update-status role="status" aria-live="polite">可手动检查；安装成功后自动刷新，有生成或草稿时等待。</div>
            </div>
        </div>`;
    const host = document.getElementById('extensions_settings');
    if (!host) throw new Error('[auto-retry-reply] Extension settings container missing');
    host.append(panel);
    fillSettings();
    panel.addEventListener('change', event => {
        const input = event.target;
        if (!input.matches('[data-setting]')) return;
        const value = settings();
        value[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.value;
        context().extensionSettings[KEY] = normalizeSettings(value);
        context().saveSettingsDebounced();
        controller.cancel('设置已更新，本轮不再自动重试');
        fillSettings();
    });
    panel.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        const stop = controller.isRetrying();
        controller.cancel();
        if (stop) context().stopGeneration();
    });
    panel.querySelector('[data-action="reset-keywords"]').addEventListener('click', () => {
        context().extensionSettings[KEY] = { ...settings(), keywords: DEFAULT_SETTINGS.keywords };
        context().saveSettingsDebounced();
        controller.cancel('关键词已重置');
        fillSettings();
    });

    const checkUpdate = panel.querySelector('[data-action="check-update"]');
    const installUpdate = panel.querySelector('[data-action="install-update"]');
    const cancelRefresh = panel.querySelector('[data-action="cancel-refresh"]');
    const updater = createExtensionUpdater({
        fetch: (...args) => window.fetch(...args), getRequestHeaders,
        getExtensionType: () => extensionTypes['third-party/auto-retry-reply'],
        getBlockedReason: () => refreshBlockedReason(document, getState().busy || controller.hasPendingWork()),
        reload: () => window.location.reload(),
        onState: ({ phase, message }) => {
            panel.querySelector('[data-update-status]').textContent = message;
            checkUpdate.disabled = ['checking', 'updating', 'waiting-reload', 'reloading'].includes(phase);
            installUpdate.hidden = phase !== 'available';
            cancelRefresh.hidden = !['waiting-reload', 'reloading'].includes(phase);
        },
    });
    checkUpdate.addEventListener('click', () => void updater.check());
    installUpdate.addEventListener('click', () => void updater.update());
    cancelRefresh.addEventListener('click', () => updater.cancelRefresh());
    window.addEventListener('pagehide', event => { if (!event.persisted) updater.dispose(); });

    const { eventSource, eventTypes } = context();
    eventSource.on(eventTypes.GENERATION_STARTED, controller.onStart);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, controller.onReceived);
    eventSource.on(eventTypes.GENERATION_ENDED, controller.onEnded);
    eventSource.on(eventTypes.GENERATION_STOPPED, () => controller.cancel());
    if (eventTypes.CHAT_COMPLETION_REQUEST_STARTED && eventTypes.CHAT_COMPLETION_REQUEST_FAILED) {
        // Respect an existing compatible hook if supplied by another build.
        eventSource.on(eventTypes.CHAT_COMPLETION_REQUEST_STARTED, controller.onRequestStarted);
        eventSource.on(eventTypes.CHAT_COMPLETION_REQUEST_FAILED, controller.onRequestFailed);
    } else {
        const marker = Symbol.for('auto-retry-reply.fetch-adapter');
        if (!window.fetch[marker]) {
            const adapter = createRetryFetch({ fetch: window.fetch.bind(window), controller, baseUrl: location.href });
            Object.defineProperty(adapter, marker, { value: true });
            window.fetch = adapter;
        }
    }
    eventSource.on(eventTypes.CHAT_CHANGED, () => controller.cancel('已切换聊天'));
    eventSource.on(eventTypes.MESSAGE_SWIPED, controller.onSwiped);
    eventSource.on(eventTypes.MESSAGE_EDITED, controller.cancelPending);
    eventSource.on(eventTypes.MESSAGE_DELETED, controller.cancelPending);
    // Cancel immediately, before asynchronous generation-stop listeners run.
    document.getElementById('mes_stop')?.addEventListener('click', () => controller.cancel(), true);
    window.addEventListener('pagehide', () => controller.cancel());
}

$(initialize);
