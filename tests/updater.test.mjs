import test from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionUpdater, refreshBlockedReason, MESSAGE_EDIT_SELECTOR } from '../updater.js';

function harness({ type = 'local', blocked = '' } = {}) {
    let next = 0, now = 0, reloads = 0;
    const timers = new Map(), calls = [], states = [], results = [];
    const context = { type, blocked };
    const setTimer = (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; };
    const clearTimer = id => timers.delete(id);
    const tick = ms => {
        const until = now + ms;
        for (;;) {
            const nextTimer = [...timers.entries()].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!nextTimer) break;
            timers.delete(nextTimer[0]); now = nextTimer[1].at; nextTimer[1].fn();
        }
        now = until;
    };
    const updater = createExtensionUpdater({
        fetch: async (path, options) => { calls.push({ path, options }); return results.shift()(path, options); },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'fixture' }),
        getExtensionType: () => context.type, getBlockedReason: () => {
            if (context.blocked instanceof Error) throw context.blocked;
            return context.blocked;
        },
        reload: () => { reloads++; }, onState: state => states.push(state), setTimer, clearTimer,
    });
    return { updater, calls, states, results, context, timers, tick, get reloads() { return reloads; } };
}
const repo = { isUpToDate: false, currentCommitHash: 'abc123', remoteUrl: 'https://example.test/repo.git' };
const updated = { isUpToDate: false, shortCommitHash: 'def456', remoteUrl: repo.remoteUrl };
const response = data => () => new Response(JSON.stringify(data));
const phase = h => h.states.at(-1)?.phase;

test('native check and update use detected local/global scope and reload after success', async () => {
    for (const type of ['local', 'global']) {
        const h = harness({ type }); h.results.push(response(repo), response(updated));
        assert.equal((await h.updater.check()).phase, 'available');
        assert.equal((await h.updater.update()).phase, 'waiting-reload');
        assert.deepEqual(h.calls.map(x => x.path), ['/api/extensions/version', '/api/extensions/update']);
        for (const call of h.calls) {
            assert.deepEqual(JSON.parse(call.options.body), { extensionName: 'auto-retry-reply', global: type === 'global' });
            assert.equal(call.options.headers['X-CSRF-Token'], 'fixture');
        }
        h.tick(999); assert.equal(h.reloads, 0);
        h.tick(1); assert.equal(h.reloads, 1); assert.equal(phase(h), 'reloading');
        h.tick(10000); assert.equal(h.reloads, 1); assert.equal(h.timers.size, 0);
    }
});

test('unknown install scope, changed scope, non-git or malformed version never update', async () => {
    const h = harness({ type: 'system' });
    assert.equal((await h.updater.check()).phase, 'error'); await h.updater.update(); assert.equal(h.calls.length, 0);
    h.context.type = 'local'; h.results.push(response({ isUpToDate: true, currentCommitHash: '', remoteUrl: '' }));
    assert.equal((await h.updater.check()).phase, 'error');
    h.results.push(response({ ...repo, isUpToDate: 'true' })); assert.equal((await h.updater.check()).phase, 'error');
    h.results.push(response(repo)); await h.updater.check(); h.context.type = 'global';
    assert.equal((await h.updater.update()).phase, 'error'); assert.equal(h.calls.length, 3);
});

test('already current, failed requests, invalid update response and timeouts never reload', async () => {
    const h = harness();
    h.results.push(response({ ...repo, isUpToDate: true }));
    assert.equal((await h.updater.check()).phase, 'current'); await h.updater.update(); assert.equal(h.calls.length, 1);
    h.results.push(() => { throw new Error('offline'); }); assert.equal((await h.updater.check()).phase, 'error');
    h.results.push(response(repo), () => new Response('bad json'));
    await h.updater.check(); assert.equal((await h.updater.update()).phase, 'error');
    h.results.push(() => new Promise(() => {}));
    const pending = h.updater.check(); h.tick(30000); assert.equal((await pending).phase, 'error');
    assert.match(h.states.at(-1).message, /超时/);
    h.results.push(response(repo), () => new Promise(() => {}));
    await h.updater.check(); const updating = h.updater.update(); h.tick(60000);
    assert.match((await updating).message, /可能已安装/); assert.equal(h.reloads, 0); assert.equal(h.timers.size, 0);
});

test('generation or draft delays refresh until safe, with a fresh check each time', async () => {
    const h = harness({ blocked: '正在生成' }); h.results.push(response(repo), response(updated));
    await h.updater.check(); await h.updater.update(); h.tick(1000);
    assert.equal(phase(h), 'waiting-reload'); assert.match(h.states.at(-1).message, /正在生成/); assert.equal(h.reloads, 0);
    h.context.blocked = '存在草稿'; h.tick(1000); assert.match(h.states.at(-1).message, /存在草稿/); assert.equal(h.reloads, 0);
    h.context.blocked = ''; h.tick(1000); assert.equal(h.reloads, 1); assert.equal(h.timers.size, 0);
});

test('cancel or dispose clears pending refresh; dispose also settles and clears network timer', async () => {
    for (const kind of ['cancelRefresh', 'dispose']) {
        const h = harness({ blocked: '正在编辑' }); h.results.push(response(repo), response(updated));
        await h.updater.check(); await h.updater.update(); h.tick(1000); h.updater[kind]();
        h.context.blocked = ''; h.tick(5000); assert.equal(h.reloads, 0); assert.equal(h.timers.size, 0);
        if (kind === 'cancelRefresh') assert.match(h.states.at(-1).message, /手动刷新/);
    }
    const h = harness(); h.results.push(() => new Promise(() => {}));
    const pending = h.updater.check(); assert.equal(h.timers.size, 1); h.updater.dispose(); await pending;
    assert.equal(h.timers.size, 0); assert.equal(h.reloads, 0);
});

test('repeated clicks cannot duplicate checks or updates', async () => {
    const h = harness(); let resolveCheck, resolveUpdate;
    h.results.push(() => new Promise(r => { resolveCheck = r; }), () => new Promise(r => { resolveUpdate = r; }));
    const a = h.updater.check(); await h.updater.check(); await h.updater.update(); assert.equal(h.calls.length, 1);
    resolveCheck(new Response(JSON.stringify(repo))); await a;
    const b = h.updater.update(); await h.updater.update(); await h.updater.check(); assert.equal(h.calls.length, 2);
    resolveUpdate(new Response(JSON.stringify(updated))); await b;
    await h.updater.update(); await h.updater.check(); h.tick(1000);
    assert.equal(h.calls.length, 2); assert.equal(h.reloads, 1);
});

test('a failed safety check blocks automatic refresh', async () => {
    const h = harness(); h.results.push(response(repo), response(updated));
    await h.updater.check(); await h.updater.update();
    h.context.blocked = Error('unknown'); h.tick(1000);
    assert.equal(h.reloads, 0); assert.match(h.states.at(-1).message, /无法确认页面状态/);
    h.updater.dispose(); assert.equal(h.timers.size, 0);
});

test('actual Tavern edit selectors and file-only drafts prevent refresh', () => {
    const elements=new Map();
    const doc={querySelector:selector=>selector.split(',').map(x=>elements.get(x.trim())).find(Boolean)};
    assert.equal(refreshBlockedReason(doc,false),'');
    assert.match(refreshBlockedReason(doc,true),/生成/);
    for(const selector of ['#chat .edit_textarea','#chat .reasoning_edit_textarea','#chat .mes_edit_textarea']) {
        assert(MESSAGE_EDIT_SELECTOR.includes(selector));
        elements.set(selector,{});assert.match(refreshBlockedReason(doc,false),/编辑/);elements.clear();
    }
    elements.set('#file_form_input',{files:[{}]});assert.match(refreshBlockedReason(doc,false),/附件/);elements.clear();
    elements.set('#send_textarea',{value:'unsent fixture'});assert.match(refreshBlockedReason(doc,false),/草稿/);
});
