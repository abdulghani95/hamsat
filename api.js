/*
 * همسة — Firebase client over plain REST (no SDK).
 *   Auth:      Identity Toolkit email/password (the "email" is username@hamsa.app)
 *   Database:  Realtime Database REST + server-sent events for live updates
 * Works in the browser (window.Api) and in Node 20+ (require('./js/api.js')) so it can be tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Api = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class ApiError extends Error {
    constructor(code, status) {
      super(code);
      this.code = code;
      this.status = status || 0;
    }
  }

  const PLACEHOLDER = /^(PASTE|YOUR|<)/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ───────── tree helpers for the event stream ───────── */
  function applyPut(tree, path, data) {
    const segs = String(path).split('/').filter(Boolean);
    if (!segs.length) return data === undefined ? null : data;
    const root = tree && typeof tree === 'object' ? tree : {};
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      let next = node[segs[i]];
      if (!next || typeof next !== 'object') { next = {}; node[segs[i]] = next; }
      node = next;
    }
    const last = segs[segs.length - 1];
    if (data === null || data === undefined) delete node[last];
    else node[last] = data;
    return root;
  }
  function applyPatch(tree, path, data) {
    let t = tree;
    const base = String(path).replace(/\/+$/, '');
    for (const k of Object.keys(data || {})) t = applyPut(t, base + '/' + k, data[k]);
    return t;
  }

  // Minimal server-sent-events parser: feed text chunks, get (eventName, dataString).
  function sseParser(onEvent) {
    let buf = '';
    let ev = '';
    let data = [];
    return function feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (ev || data.length) onEvent(ev || 'message', data.join('\n'));
          ev = '';
          data = [];
        } else if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    };
  }

  function create(cfg, deps) {
    deps = deps || {};
    const doFetch = deps.fetch || ((...a) => fetch(...a));
    const idBase = (cfg.identityBase || 'https://identitytoolkit.googleapis.com/v1').replace(/\/+$/, '');
    const tokBase = (cfg.tokenBase || 'https://securetoken.googleapis.com/v1').replace(/\/+$/, '');
    const dbBase = String(cfg.databaseURL || '').replace(/\/+$/, '');
    const key = cfg.apiKey || '';

    let session = null; // { uid, idToken, refreshToken, expiresAt }
    let refreshing = null;
    const now = () => Date.now();

    const configured = () => !!key && !!dbBase && !PLACEHOLDER.test(key) && !PLACEHOLDER.test(dbBase);

    /* ───────── auth ───────── */
    async function post(url, init) {
      let res;
      try { res = await doFetch(url, init); }
      catch (e) { throw new ApiError('NETWORK', 0); }
      let body = null;
      try { body = await res.json(); } catch (e) { /* empty body */ }
      if (!res.ok) {
        const msg = body && body.error && (body.error.message || body.error);
        throw new ApiError(String(msg || 'HTTP_' + res.status).split(/[ :]/)[0], res.status);
      }
      return body;
    }
    function setSession(r) {
      session = {
        uid: r.localId || r.user_id,
        idToken: r.idToken || r.id_token,
        refreshToken: r.refreshToken || r.refresh_token,
        expiresAt: now() + (Number(r.expiresIn || r.expires_in) || 3600) * 1000,
      };
      return session;
    }
    async function identity(method, email, password) {
      const r = await post(idBase + '/accounts:' + method + '?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      return setSession(r);
    }
    const signUp = (email, password) => identity('signUp', email, password);
    const signIn = (email, password) => identity('signInWithPassword', email, password);

    async function refresh(refreshToken) {
      const rt = refreshToken || (session && session.refreshToken);
      if (!rt) throw new ApiError('NO_SESSION', 0);
      if (!refreshing) {
        refreshing = post(tokBase + '/token?key=' + encodeURIComponent(key), {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt),
        }).then(setSession).finally(() => { refreshing = null; });
      }
      return refreshing;
    }
    async function token(force) {
      if (!session) throw new ApiError('NO_SESSION', 0);
      if (force || session.expiresAt - now() < 120000) await refresh();
      return session.idToken;
    }
    function signOut() { session = null; }

    /* ───────── database ───────── */
    const dbUrl = (path, tok, query) =>
      dbBase + '/' + String(path).replace(/^\/+|\/+$/g, '') + '.json?auth=' + encodeURIComponent(tok) + (query ? '&' + query : '');

    async function call(method, path, body, query, silent) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const tok = await token(attempt > 0);
        let res;
        try {
          res = await doFetch(dbUrl(path, tok, (query ? query + '&' : '') + (silent ? 'print=silent' : '')).replace(/[&?]$/, ''), {
            method,
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
        } catch (e) { throw new ApiError('NETWORK', 0); }
        if (res.status === 401 && attempt === 0) continue; // token expired: refresh once and retry
        if (!res.ok) throw new ApiError(res.status === 401 || res.status === 403 ? 'PERMISSION_DENIED' : 'HTTP_' + res.status, res.status);
        if (silent || res.status === 204) return null;
        try { return await res.json(); } catch (e) { return null; }
      }
      throw new ApiError('PERMISSION_DENIED', 401);
    }
    const get = (path, query) => call('GET', path, undefined, query, false);
    const put = (path, value) => call('PUT', path, value, '', true);
    const patch = (path, value) => call('PATCH', path, value, '', true);
    const del = (path) => call('DELETE', path, undefined, '', true);

    /*
     * Live data. Calls h.onData(tree) with the whole value at `path` every time it changes,
     * h.onState('online'|'offline') as the connection comes and goes. Reconnects with back-off.
     */
    function stream(path, query, h) {
      h = h || {};
      let closed = false;
      let ctrl = null;
      let tree = null;
      let attempt = 0;
      let forceToken = false;

      function onEvent(type, raw) {
        if (type === 'keep-alive') return;
        if (type === 'auth_revoked') { forceToken = true; if (ctrl) ctrl.abort(); return; }
        if (type === 'cancel') { if (ctrl) ctrl.abort(); return; }
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }
        if (!msg || typeof msg.path !== 'string') return;
        if (type === 'put') tree = applyPut(tree, msg.path, msg.data);
        else if (type === 'patch') tree = applyPatch(tree, msg.path, msg.data);
        else return;
        if (h.onData) h.onData(tree);
      }

      async function run() {
        while (!closed) {
          try {
            const tok = await token(forceToken);
            forceToken = false;
            ctrl = new AbortController();
            const res = await doFetch(dbUrl(path, tok, query), { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
            if (res.status === 401 || res.status === 403) { forceToken = true; throw new Error('auth'); }
            if (!res.ok || !res.body) throw new Error('http ' + res.status);
            attempt = 0;
            tree = null;
            if (h.onState) h.onState('online');
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            const feed = sseParser(onEvent);
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              feed(dec.decode(r.value, { stream: true }));
            }
          } catch (e) { /* fall through to reconnect */ }
          if (closed) return;
          if (h.onState) h.onState('offline');
          attempt++;
          await sleep(Math.min(15000, 1000 * Math.pow(2, Math.min(attempt - 1, 4))));
        }
      }
      run();
      return { close() { closed = true; if (ctrl) ctrl.abort(); } };
    }

    return {
      configured, signUp, signIn, refresh, token, signOut,
      get, put, patch, del, stream,
      session: () => session,
      restoreSession: (s) => { session = s; },
    };
  }

  return { create, ApiError, applyPut, applyPatch, sseParser };
});
