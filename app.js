/* همسة — UI layer (online). Rules live in logic.js, the server protocol in api.js. */
(function () {
  'use strict';

  const L = window.Logic;
  const A = window.Api;
  const SESSION_KEY = 'hamsa.v2';
  const MAX_TEXT = 4000;
  const POLL_MS = 45000;
  const CHAT_QUERY = 'orderBy=%22%24key%22&limitToLast=100';
  const cfg = Object.assign({}, window.HAMSA_CONFIG || {}, window.HAMSA_TEST_CONFIG || {});
  const API = A.create(cfg);
  const ignore = () => {};

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (name, cls) => '<svg class="i ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';

  let me = null; // { uid, name, handle, mood, photo, phone, phoneKey, rt, seenStore }
  let contacts = [];
  let myStatuses = [];
  let active = null;
  let ghost = false;
  let hidePreview = false;
  let mode = 'plain';
  let tab = 'chats';
  let sheetMode = 'profile';
  let draft = { kind: 'text', bg: 0, text: '', img: null };
  let confirmLogout = false;
  let tickTimer = null;
  let lastSig = '';
  let lastPoll = 0;
  let lastTypingWrite = 0;
  let V = null; // status viewer state
  let rec = null; // voice recording state
  let player = null; // voice playback state
  let authMode = 'signup';
  let authBusy = false;
  let inboxStream = null;
  let chatStream = null;
  let statusStream = null;
  let inboxLoaded = false;
  let inboxFirst = true;
  let pState = {};
  let pToken = 0;
  const streamOn = { inbox: true, chat: true };
  const opt = { fade: 30, capsule: 60 };

  /* ───────── persistence ───────── */
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const s = raw ? JSON.parse(raw) : null;
      return s && s.uid && s.refreshToken && s.profile ? s : null;
    } catch (e) { return null; }
  }
  function saveSession() {
    try {
      if (!me) { localStorage.removeItem(SESSION_KEY); return; }
      const s = API.session();
      if (s && s.refreshToken) me.rt = s.refreshToken;
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        uid: me.uid,
        refreshToken: me.rt,
        profile: { name: me.name, handle: me.handle, mood: me.mood, photo: me.photo },
        phone: me.phone || null,
        ghost, hidePreview,
        seenStore: me.seenStore,
      }));
    } catch (e) { /* storage unavailable: the app still works for this session */ }
  }

  /* ───────── helpers ───────── */
  const wide = () => window.matchMedia('(min-width: 860px)').matches;
  const cur = () => contacts.find((c) => c.id === active) || null;
  const contactById = (id) => contacts.find((c) => c.id === id) || null;
  const byId = (id) => {
    for (const c of contacts) for (const m of c.msgs) if (m.id === id) return m;
    return null;
  };
  const cname = (c) => c.name || '…';
  function clock(t) {
    try { return new Date(t).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, 3200);
  }
  function avatar(name, moodKey, cls, photo) {
    const color = (L.MOODS[moodKey] || L.MOODS.creative).color;
    const ch = String(name || '?').trim().charAt(0).toUpperCase();
    const inner = L.isImageData(photo) ? '<img src="' + esc(photo) + '" alt="">' : '<span>' + esc(ch) + '</span>';
    return '<div class="av ' + (cls || '') + '" style="--mc:' + color + '">' + inner + '</div>';
  }
  function errorText(e) {
    const m = {
      NETWORK: 'تعذّر الاتصال بالإنترنت. تحقق من الشبكة وأعد المحاولة.',
      EMAIL_EXISTS: 'اسم المستخدم محجوز، اختر اسمًا آخر.',
      INVALID_LOGIN_CREDENTIALS: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      INVALID_PASSWORD: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      EMAIL_NOT_FOUND: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
      USER_DISABLED: 'هذا الحساب موقوف.',
      WEAK_PASSWORD: 'كلمة المرور ضعيفة، استخدم 8 أحرف على الأقل.',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.',
      OPERATION_NOT_ALLOWED: 'فعّل تسجيل الدخول بالبريد وكلمة المرور في Firebase (انظر دليل الإعداد).',
      CONFIGURATION_NOT_FOUND: 'فعّل تسجيل الدخول بالبريد وكلمة المرور في Firebase (انظر دليل الإعداد).',
      API: 'مفتاح API في ملف config.js غير صحيح.',
      PERMISSION_DENIED: 'رفض الخادم العملية. تأكد من نشر قواعد قاعدة البيانات (انظر دليل الإعداد).',
      HTTP_404: 'رابط قاعدة البيانات في config.js غير صحيح.',
    };
    return (e && m[e.code]) || 'حدث خطأ غير متوقع. حاول مرة أخرى.';
  }
  const retryable = (e) => !!e && (e.code === 'NETWORK' || /^HTTP_5/.test(e.code || ''));

  /* ───────── images ───────── */
  function loadImg(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }
  async function imageToDataUrl(file, o) {
    if (!file || !/^image\//.test(file.type)) throw new Error('not an image');
    if (file.size > 25 * 1024 * 1024) throw new Error('too big');
    const img = await loadImg(file);
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    if (o.square) {
      const k = L.cropSquare(img.naturalWidth, img.naturalHeight);
      c.width = c.height = o.size;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, o.size, o.size);
      g.drawImage(img, k.sx, k.sy, k.s, k.s, 0, 0, o.size, o.size);
    } else {
      const d = L.fitSize(img.naturalWidth, img.naturalHeight, o.max);
      c.width = d.w;
      c.height = d.h;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, d.w, d.h);
      g.drawImage(img, 0, 0, d.w, d.h);
    }
    return c.toDataURL('image/jpeg', o.quality || 0.8);
  }

  /* ───────── history: the Android back button closes one layer, not the app ───────── */
  const navStack = [];
  function navPush(k) {
    let pushed = false;
    try { history.pushState({ hamsa: k }, ''); pushed = true; } catch (e) { /* no history: fall back to direct close */ }
    navStack.push({ k, pushed, closing: false });
  }
  function navClose(k) {
    const top = navStack[navStack.length - 1];
    if (top && top.k === k) {
      if (top.closing) return;
      if (top.pushed) { top.closing = true; history.back(); return; }
      navStack.pop();
    }
    applyClose(k);
  }
  function applyClose(k) {
    if (k === 'chat') {
      cancelRec();
      sendTyping(false);
      stopChatStream();
      const c = cur();
      active = null;
      if (c && c.pending && !c.msgs.length) contacts = contacts.filter((x) => x !== c);
      renderAll(false);
    } else if (k === 'sheet') {
      $('#scrim').hidden = true;
      confirmLogout = false;
      if (me) $('#meBtn').focus();
    } else if (k === 'status') {
      hideViewer();
    }
  }
  window.addEventListener('popstate', () => {
    const e = navStack.pop();
    if (e) applyClose(e.k);
  });

  /* ───────── contacts ───────── */
  function contactFor(uid) {
    let c = contacts.find((x) => x.id === uid);
    if (c) return c;
    me.seenStore[uid] = me.seenStore[uid] || {};
    c = {
      id: uid, uid, name: '', handle: '', mood: 'creative', photo: null,
      unread: 0, rawUnread: 0, typing: false, typingVal: 0, typingAt: 0, seen: 0, seenSent: 0,
      last: '', lastT: 0, lastFrom: '', statuses: [], seenSt: me.seenStore[uid], msgs: [],
      profileAt: 0, pending: false, inInbox: false,
    };
    contacts.push(c);
    return c;
  }
  async function fetchProfile(c, force) {
    if (!force && c.profileAt && Date.now() - c.profileAt < 300000) return;
    c.profileAt = Date.now();
    try {
      const u = L.userFromRecord(await API.get('users/' + c.uid));
      if (u) {
        Object.assign(c, { name: u.name, handle: u.handle, mood: u.mood, photo: u.photo });
        renderAll(false);
      }
    } catch (e) { c.profileAt = 0; }
  }

  /* ───────── live data ───────── */
  function setConn(which, on) {
    streamOn[which] = on;
    $('#connBar').hidden = !!(streamOn.inbox && streamOn.chat);
  }

  function onInbox(tree) {
    if (!me) return;
    const entries = L.parseInbox(tree);
    const keep = new Set();
    for (const e of entries) {
      if (e.uid === me.uid) continue;
      const c = contactFor(e.uid);
      keep.add(c.id);
      const before = c.unread;
      c.inInbox = true;
      c.pending = false;
      c.lastT = e.t;
      c.last = e.last;
      c.lastFrom = e.from;
      c.seen = e.seen;
      c.rawUnread = e.unread;
      c.unread = active === c.id ? 0 : e.unread;
      if (e.typing && e.typing !== c.typingVal) { c.typingVal = e.typing; c.typingAt = Date.now(); }
      if (!e.typing) { c.typingVal = 0; c.typingAt = 0; }
      if (!inboxFirst && c.unread > before && c.id !== active) toast('رسالة جديدة من ' + (c.name || 'مستخدم'));
      fetchProfile(c);
    }
    contacts = contacts.filter((c) => keep.has(c.id) || c.pending || c.id === active);
    inboxLoaded = true;
    inboxFirst = false;
    const c = cur();
    if (c) markRead(c);
    if (!lastPoll) pollStatuses();
    renderAll(false);
  }

  function markRead(c) {
    if (!me || !c) return;
    if (c.rawUnread > 0) {
      c.rawUnread = 0;
      API.patch('inbox/' + me.uid + '/' + c.uid, { unread: 0 }).catch(ignore);
    }
    if (ghost) return;
    let latest = 0;
    for (const m of c.msgs) if (m.from === 'them' && m.t > latest) latest = m.t;
    if (latest > c.seenSent) {
      c.seenSent = latest;
      API.patch('inbox/' + c.uid + '/' + me.uid, { seen: latest }).catch(ignore);
    }
  }

  function startChatStream(c) {
    stopChatStream();
    chatStream = API.stream('chats/' + L.chatId(me.uid, c.uid), CHAT_QUERY, {
      onData: (tree) => onChatData(c, tree),
      onState: (s) => setConn('chat', s === 'online'),
    });
  }
  function stopChatStream() {
    if (chatStream) chatStream.close();
    chatStream = null;
    setConn('chat', true);
  }
  function onChatData(c, tree) {
    if (!me || active !== c.id) return;
    const now = Date.now();
    const prev = new Map(c.msgs.map((m) => [m.id, m]));
    const out = [];
    const cid = L.chatId(me.uid, c.uid);
    for (const id of Object.keys(tree || {}).sort()) {
      const r = tree[id];
      if (L.recordExpired(r, now)) {
        API.del('chats/' + cid + '/' + id).catch(ignore);
        continue;
      }
      const m = L.messageFromRecord(id, r, me.uid, now, prev.get(id));
      if (m) out.push(m);
    }
    for (const m of c.msgs) {
      if (m.from === 'me' && (m.status === 'sending' || m.status === 'failed') && !(tree && tree[m.id])) out.push(m);
    }
    out.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
    c.msgs = out;
    markRead(c);
    renderMsgs(false);
    renderList();
  }

  function onMyStatuses(tree) {
    if (!me) return;
    const now = Date.now();
    const list = [];
    for (const sid of Object.keys(tree || {})) {
      const s = L.statusFromRecord(sid, tree[sid]);
      if (!s) continue;
      if (!L.isLive(s, now)) { API.del('statuses/' + me.uid + '/' + sid).catch(ignore); continue; }
      const views = tree[sid].views && typeof tree[sid].views === 'object' ? Object.values(tree[sid].views) : [];
      s.viewers = views
        .filter((v) => v && typeof v === 'object')
        .sort((a, b) => (a.t || 0) - (b.t || 0))
        .map((v) => String(v.n || '').slice(0, 24))
        .filter(Boolean);
      list.push(s);
    }
    myStatuses = list.sort((a, b) => a.t - b.t);
    renderStatus();
    renderTabs();
    if (V && V.owner === 'me') renderViewerFoot();
  }

  async function pollStatuses() {
    if (!me) return;
    lastPoll = Date.now();
    const now = Date.now();
    await Promise.all(contacts.filter((c) => c.uid).map(async (c) => {
      try {
        const tree = await API.get('statuses/' + c.uid);
        const list = [];
        for (const sid of Object.keys(tree || {})) {
          const s = L.statusFromRecord(sid, tree[sid]);
          if (s && L.isLive(s, now)) list.push(s);
        }
        c.statuses = list.sort((a, b) => a.t - b.t);
      } catch (e) { /* keep what we had */ }
    }));
    if (me) { renderStatus(); renderTabs(); }
  }

  function startStreams() {
    inboxFirst = true;
    inboxLoaded = false;
    inboxStream = API.stream('inbox/' + me.uid, '', {
      onData: onInbox,
      onState: (s) => setConn('inbox', s === 'online'),
    });
    statusStream = API.stream('statuses/' + me.uid, '', { onData: onMyStatuses });
  }
  function stopStreams() {
    if (inboxStream) inboxStream.close();
    if (statusStream) statusStream.close();
    inboxStream = statusStream = null;
    stopChatStream();
  }

  /* ───────── rendering: tabs ───────── */
  function totalUnread() { return contacts.reduce((n, c) => n + (c.unread || 0), 0); }
  function anyUnseenStatus() {
    const now = Date.now();
    return contacts.some((c) => L.statusInfo(c, now).unseen > 0);
  }
  function renderTabs() {
    const n = totalUnread();
    const b = $('#tabBadge');
    b.hidden = n === 0;
    b.textContent = n;
    $('#tabDot').hidden = !anyUnseenStatus();
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
    $('#panelChats').hidden = tab !== 'chats';
    $('#panelStatus').hidden = tab !== 'status';
    $('#panelPeople').hidden = tab !== 'people';
  }
  function setTab(t) {
    tab = t;
    renderTabs();
    if (t === 'status') { renderStatus(); pollStatuses(); }
    if (t === 'people') renderPeople();
  }

  /* ───────── rendering: conversation list ───────── */
  function renderList() {
    if (!me) return;
    const q = $('#q').value;
    const rows = $('#rows');
    const list = L.searchContacts(contacts, q).sort((a, b) => b.lastT - a.lastT);
    let html = '';
    for (const c of list) {
      let pv;
      if (c.typing) pv = '<span class="pv typing-pv">يكتب…</span>';
      else pv = '<span class="pv">' + esc(c.last ? (c.lastFrom === me.uid ? 'أنت: ' : '') + c.last : 'ابدأ المحادثة') + '</span>';
      html += '<button type="button" class="row" role="listitem" data-open="' + esc(c.id) + '"' +
        (c.id === active ? ' aria-current="true"' : '') + '>' +
        avatar(cname(c), c.mood, '', c.photo) +
        '<span class="row-text"><span class="row-top"><b>' + esc(cname(c)) + '</b>' + (c.lastT ? '<time>' + clock(c.lastT) + '</time>' : '') + '</span>' +
        '<span class="row-bot">' + pv + (c.unread ? '<span class="badge" aria-label="' + c.unread + ' غير مقروءة">' + c.unread + '</span>' : '') + '</span></span></button>';
    }
    if (q.trim() && !list.length) {
      const find = q.trim().replace(/^@/, '');
      if (L.looksLikePhone(find) || L.validateUsername(find).ok) {
        html += '<button type="button" class="row add-row" data-find="' + esc(find) + '">' +
          '<span class="plus">' + ic('search') + '</span>' +
          '<span class="row-text"><b>ابحث عن «' + esc(find) + '»</b><span class="pv">بحث بين كل المستخدمين</span></span></button>';
      } else {
        html += '<p class="none">لا توجد نتائج.</p>';
      }
    } else if (!list.length) {
      html += inboxLoaded
        ? '<div class="none"><p>لا توجد محادثات بعد.</p><p>افتح تبويب «أشخاص» وابحث عن صديق باسم المستخدم أو رقم الهاتف.</p>' +
          '<button type="button" class="addbtn" data-goto-people>ابحث عن أشخاص</button></div>'
        : '<p class="none">جارٍ تحميل محادثاتك…</p>';
    }
    rows.innerHTML = html;
    rows.classList.toggle('blurprev', hidePreview);
  }

  function renderMe() {
    if (!me) return;
    $('#meBtn').innerHTML = avatar(me.name, me.mood, 'sm', me.photo);
  }

  /* ───────── rendering: status tab ───────── */
  function renderStatus() {
    if (!me) return;
    const now = Date.now();
    const mine = L.liveStatuses(myStatuses, now);
    const has = mine.length > 0;
    $('#stMine').innerHTML =
      '<div class="row" role="listitem">' +
      '<button type="button" class="row-main" data-st-mine aria-label="حالتي">' +
      '<span class="avwrap">' + avatar(me.name, me.mood, has ? 'st' : '', me.photo) +
      (has ? '' : '<span class="addbadge">' + ic('plus') + '</span>') + '</span>' +
      '<span class="row-text"><b>حالتي</b><span class="sub">' +
      (has ? esc(L.statusAgo(mine[mine.length - 1].t, now)) + ' · ' + mine.length + (mine.length === 1 ? ' حالة' : ' حالات') : 'اضغط لإضافة حالة') +
      '</span></span></button>' +
      '<button type="button" class="round-btn" data-st-add aria-label="إضافة حالة جديدة">' + ic('plus') + '</button></div>';

    const list = L.statusContacts(contacts, now);
    $('#stRows').innerHTML = list.length
      ? list.map((x) =>
        '<button type="button" class="row" role="listitem" data-st="' + esc(x.c.id) + '">' +
        avatar(cname(x.c), x.c.mood, 'st' + (x.info.unseen ? '' : ' seen'), x.c.photo) +
        '<span class="row-text"><b>' + esc(cname(x.c)) + '</b><span class="sub">' + esc(L.statusAgo(x.info.latest, now)) + '</span></span></button>').join('')
      : '<p class="none">لا توجد تحديثات جديدة من جهات اتصالك.</p>';
  }

  /* ───────── people: search by username or phone ───────── */
  function personRow(p) {
    return '<div class="row" role="listitem">' + avatar(p.name, p.mood, '', p.photo) +
      '<span class="row-text"><b>' + esc(p.name) + '</b><span class="sub" dir="ltr" style="text-align:start">@' + esc(p.handle) + '</span></span>' +
      '<button type="button" class="addbtn" data-chat="' + esc(p.uid) + '" aria-label="مراسلة ' + esc(p.name) + '">مراسلة</button></div>';
  }
  function renderPeople() {
    if (!me) return;
    const q = $('#pq').value;
    const mine = q.trim() ? L.searchContacts(contacts, q) : [];
    let html = '';
    if (mine.length) {
      html += '<div class="sh-title pad">في محادثاتك</div>' + mine.map((c) =>
        '<button type="button" class="row" role="listitem" data-open="' + esc(c.id) + '">' + avatar(cname(c), c.mood, '', c.photo) +
        '<span class="row-text"><b>' + esc(cname(c)) + '</b><span class="sub" dir="ltr" style="text-align:start">@' + esc(c.handle) + '</span></span></button>').join('');
    }
    if (pState.busy) html += '<p class="none" role="status">جارٍ البحث…</p>';
    else if (pState.person) {
      html += '<div class="sh-title pad">نتيجة البحث</div>' + personRow(pState.person);
      if (pState.byPhone) html += '<p class="note">رقم الهاتف غير موثّق برسالة نصية. تأكد من اسم المستخدم قبل مراسلة شخص لا تعرفه.</p>';
    } else if (pState.msg) html += '<p class="none" role="status">' + esc(pState.msg) + '</p>';
    else if (!mine.length) {
      html += '<p class="none">اكتب اسم المستخدم كاملًا، أو رقم الهاتف مع رمز الدولة مثل <bdi dir="ltr">+966501234567</bdi>، ثم اضغط «بحث».</p>';
    }
    $('#pRows').innerHTML = html;
  }
  async function searchPeople(raw) {
    const q = String(raw || '').trim().replace(/^@/, '');
    const token = ++pToken;
    if (!q) { pState = {}; renderPeople(); return; }
    pState = { busy: true };
    renderPeople();
    let result;
    try {
      let found = null;
      let byPhone = false;
      if (L.looksLikePhone(q)) {
        const p = L.normalizePhone(q);
        if (!p.ok) { result = { msg: p.error }; throw result; }
        byPhone = true;
        found = await API.get('phones/' + (await L.phoneKey(p.value)));
      } else {
        const v = L.validateUsername(q);
        if (!v.ok) { result = { msg: v.error }; throw result; }
        found = await API.get('handles/' + L.handleKey(v.value));
      }
      if (typeof found !== 'string' || !found) result = { msg: 'لم نعثر على أحد بهذا ' + (byPhone ? 'الرقم' : 'الاسم') + '.' };
      else if (found === me.uid) result = { msg: 'هذا حسابك أنت.' };
      else {
        const u = L.userFromRecord(await API.get('users/' + found));
        result = u ? { person: Object.assign({ uid: found }, u), byPhone } : { msg: 'لم نعثر على أحد بهذا ' + (byPhone ? 'الرقم' : 'الاسم') + '.' };
      }
    } catch (e) {
      if (!result) result = { msg: errorText(e) };
    }
    if (token !== pToken) return;
    pState = result;
    renderPeople();
  }
  function startChatWith(p) {
    const c = contactFor(p.uid);
    Object.assign(c, { name: p.name, handle: p.handle, mood: p.mood, photo: p.photo, profileAt: Date.now() });
    if (!c.inInbox) { c.pending = true; c.lastT = Date.now(); }
    $('#q').value = '';
    $('#pq').value = '';
    pState = {};
    setTab('chats');
    openChat(c.id);
  }

  /* ───────── rendering: chat ───────── */
  function tickHtml(m, c) {
    if (m.from !== 'me') return '';
    const st = L.deliveryState(m, c.seen);
    if (st === 'sending') return '<span class="ticks" aria-label="جارٍ الإرسال">' + ic('timer') + '</span>';
    if (st === 'failed') return '<button type="button" class="retry" data-retry="' + m.id + '" aria-label="فشل الإرسال، اضغط لإعادة المحاولة">لم تُرسل · إعادة المحاولة</button>';
    return '<span class="ticks" aria-label="' + (st === 'read' ? 'قُرئت' : 'أُرسلت') + '">' + ic('check') + (st === 'read' ? ic('check') : '') + '</span>';
  }
  function mediaHtml(m) {
    const md = m.media;
    if (!md) return '';
    if (md.type === 'image' && L.isImageData(md.src)) return '<img class="mimg" src="' + esc(md.src) + '" alt="صورة مرسلة">';
    if (md.type === 'audio' && L.isAudioData(md.src)) {
      return '<div class="vm"><button type="button" class="vm-play" data-play="' + m.id + '" aria-label="تشغيل الرسالة الصوتية">' + ic('play') + '</button>' +
        '<div class="vm-bar"><i data-vmbar="' + m.id + '"></i></div>' +
        '<span class="vm-time" data-vmtime="' + m.id + '">' + L.formatElapsed((md.dur || 0) * 1000) + '</span></div>';
    }
    return '';
  }
  const capPercent = (m, now) => Math.min(100, Math.max(0, (1 - (m.unlockAt - now) / m.total) * 100));
  function bubble(m, c) {
    if (m.mode === 'sys') return '<div class="sys">' + esc(m.text) + '</div>';
    const mine = m.from === 'me';
    const cls = 'msg ' + (mine ? 'me' : 'them') + (m.gone ? ' vanish' : '');
    const meta = (extra) => '<div class="meta">' + (extra || '') + '<time>' + clock(m.t) + '</time>' + tickHtml(m, c) + '</div>';
    const textP = m.text ? '<p>' + esc(m.text) + '</p>' : '';
    let body;

    if (m.mode === 'capsule' && !m.unlocked) {
      body = '<div class="b cap"><div class="cap-head">' + ic('hourglass') + (mine ? 'كبسولة زمنية مرسلة' : 'كبسولة زمنية') + '</div>' +
        '<div class="cap-sub">تُفتح بعد <b data-cd="' + m.id + '" data-k="cap">' + L.formatCountdown(m.unlockAt - Date.now()) + '</b></div>' +
        '<div class="bar"><i data-bar="' + m.id + '" style="width:' + capPercent(m, Date.now()) + '%"></i></div></div>';
      return '<div class="' + cls + '" data-id="' + m.id + '">' + body + '</div>';
    }
    if (m.mode === 'capsule') {
      body = '<div class="b"><p>' + esc(m.text) + '</p>' + meta('<span class="chip">' + ic('hourglass') + 'فُتحت</span>') + '</div>';
    } else if (m.mode === 'fade') {
      body = '<div class="b' + (m.media ? ' media' : '') + '">' + mediaHtml(m) + textP +
        meta('<span class="chip">' + ic('timer') + '<span data-cd="' + m.id + '" data-k="fade">' + L.formatCountdown(m.expiresAt - Date.now()) + '</span></span>') + '</div>';
    } else if (m.mode === 'secret') {
      if (m.burned) {
        body = '<div class="b burned">' + ic('flame') + 'احترقت بعد القراءة</div>';
      } else if (m.open) {
        body = '<div class="b"><p>' + esc(m.text) + '</p>' +
          meta('<span class="chip">' + ic('flame') + 'تحترق بعد <span data-cd="' + m.id + '" data-k="burn">' + L.formatCountdown(m.openUntil - Date.now()) + '</span></span>') + '</div>';
      } else if (mine) {
        body = '<div class="b sec mine"><span class="blur">' + esc(m.text) + '</span>' +
          '<span class="hint">' + ic('lock') + 'أُرسلت · تُحرق بعد أن يقرأها</span>' + meta() + '</div>';
      } else {
        body = '<button type="button" class="b sec" data-secret="' + m.id + '" aria-label="رسالة سرية، اضغط لقراءتها مرة واحدة">' +
          '<span class="blur">' + esc(m.text) + '</span>' +
          '<span class="hint">' + ic('lock') + 'اضغط للكشف · تُحرق بعد القراءة</span></button>';
      }
    } else {
      body = '<div class="b' + (m.media ? ' media' : '') + '">' + mediaHtml(m) + textP + meta() + '</div>';
    }
    return '<div class="' + cls + '" data-id="' + m.id + '">' + body + '</div>';
  }

  function renderChatHead() {
    const c = cur();
    if (!c) return;
    $('#chAv').innerHTML = avatar(cname(c), c.mood, 'sm', c.photo);
    $('#chName').textContent = cname(c);
    const s = $('#chStatus');
    if (c.typing) { s.textContent = 'يكتب…'; s.className = 'status live'; }
    else { s.innerHTML = (ghost ? 'أنت متخفٍّ · ' : '') + (c.handle ? '<bdi dir="ltr">@' + esc(c.handle) + '</bdi>' : ''); s.className = 'status'; }
    $('#ghostBanner').hidden = !ghost;
  }

  function renderMsgs(force) {
    const c = cur();
    const el = $('#msgs');
    if (!c) { el.innerHTML = ''; return; }
    const near = force || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const keep = el.scrollTop;
    el.innerHTML = (c.msgs.length ? '' : '<div class="sys">ابدأ المحادثة، رسائلك تصل فور إرسالها.</div>') +
      c.msgs.map((m) => bubble(m, c)).join('') +
      (c.typing ? '<div class="msg them" aria-label="يكتب"><div class="b typing"><i></i><i></i><i></i></div></div>' : '');
    el.scrollTop = near ? el.scrollHeight : keep;
    updateCountdowns();
    syncAudio();
  }

  function hintText() {
    if (mode === 'fade') return 'تختفي من المحادثة بعد ' + L.optionLabel(L.FADE_OPTIONS, opt.fade) + ' من إرسالها.';
    if (mode === 'capsule') return 'تظهر مقفلة وتُفتح بعد ' + L.optionLabel(L.CAPSULE_OPTIONS, opt.capsule) + '.';
    if (mode === 'secret') return 'تُعرض مموّهة وتُحرق بعد قراءتها مرة واحدة.';
    return 'رسالة عادية تبقى في المحادثة.';
  }
  function renderComposer() {
    const defs = [['plain', 'chat', 'عادية'], ['fade', 'timer', 'تتلاشى'], ['capsule', 'hourglass', 'كبسولة'], ['secret', 'flame', 'سرّية']];
    $('#modes').innerHTML = defs.map((d) =>
      '<button type="button" class="mode" data-mode="' + d[0] + '" aria-pressed="' + (mode === d[0]) + '">' + ic(d[1]) + d[2] + '</button>').join('');
    const list = mode === 'fade' ? L.FADE_OPTIONS : mode === 'capsule' ? L.CAPSULE_OPTIONS : null;
    let html = '';
    if (list) {
      html += list.map((o) => '<button type="button" class="opt" data-opt="' + o[0] + '" aria-pressed="' + (opt[mode] === o[0]) + '">' + o[1] + '</button>').join('');
    }
    html += '<span data-hint>' + esc(hintText()) + '</span>';
    $('#opts').innerHTML = html;
  }

  function renderChat(force) {
    const c = cur();
    $('#chatEmpty').hidden = !!c;
    $('#chatBody').hidden = !c;
    $('#main').dataset.view = c ? 'chat' : 'list';
    if (!c) return;
    renderChatHead();
    renderMsgs(force);
  }
  function renderAll(force) {
    if (!me) return;
    renderList();
    renderStatus();
    renderPeople();
    renderTabs();
    renderChat(force);
  }

  function updateCountdowns() {
    const now = Date.now();
    document.querySelectorAll('[data-cd]').forEach((el) => {
      const m = byId(el.dataset.cd);
      if (!m) return;
      const end = el.dataset.k === 'cap' ? m.unlockAt : el.dataset.k === 'fade' ? m.expiresAt : m.openUntil;
      el.textContent = L.formatCountdown(end - now);
    });
    document.querySelectorAll('[data-bar]').forEach((el) => {
      const m = byId(el.dataset.bar);
      if (!m) return;
      el.style.width = capPercent(m, now) + '%';
    });
  }

  /* ───────── voice playback ───────── */
  function stopPlayer() {
    if (!player) return;
    try { player.el.pause(); } catch (e) { /* ignore */ }
    player = null;
  }
  function togglePlay(id) {
    const m = byId(id);
    if (!m || !m.media || m.media.type !== 'audio') return;
    if (player && player.id === id) {
      if (player.el.paused) player.el.play().catch(() => {});
      else player.el.pause();
      syncAudio();
      return;
    }
    stopPlayer();
    const el = new Audio(m.media.src);
    player = { id, el };
    el.addEventListener('timeupdate', syncAudio);
    el.addEventListener('play', syncAudio);
    el.addEventListener('pause', syncAudio);
    el.addEventListener('ended', () => { if (player && player.el === el) player = null; syncAudio(); });
    el.play().catch(() => { toast('تعذّر تشغيل الصوت على هذا الجهاز.'); });
  }
  function syncAudio() {
    document.querySelectorAll('[data-play]').forEach((b) => {
      const on = !!player && player.id === b.dataset.play && !player.el.paused;
      b.innerHTML = ic(on ? 'pause' : 'play');
      b.setAttribute('aria-label', on ? 'إيقاف مؤقت' : 'تشغيل الرسالة الصوتية');
    });
    document.querySelectorAll('[data-vmbar]').forEach((b) => {
      const m = byId(b.dataset.vmbar);
      let pct = 0;
      if (m && player && player.id === m.id && m.media.dur) pct = Math.min(100, (player.el.currentTime / m.media.dur) * 100);
      b.style.width = pct + '%';
    });
    document.querySelectorAll('[data-vmtime]').forEach((b) => {
      const m = byId(b.dataset.vmtime);
      if (!m) return;
      const ms = player && player.id === m.id ? player.el.currentTime * 1000 : (m.media.dur || 0) * 1000;
      b.textContent = L.formatElapsed(ms);
    });
  }

  /* ───────── voice recording ───────── */
  function mediaAllowed() {
    if (mode === 'capsule' || mode === 'secret') {
      toast('الصور والرسائل الصوتية متاحة للرسائل العادية والمتلاشية.');
      return false;
    }
    return true;
  }
  function showRecBar(on) {
    $('#recBar').hidden = !on;
    $('#sendForm').hidden = on;
    $('#recTime').textContent = '0:00';
  }
  async function startRec() {
    if (rec || !cur() || !mediaAllowed()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('التسجيل الصوتي غير مدعوم في هذا المتصفح.');
      return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast('اسمح للتطبيق باستخدام الميكروفون لتسجيل رسالة صوتية.'); return; }
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mime = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    let mr;
    try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); toast('تعذّر بدء التسجيل على هذا الجهاز.'); return; }
    const r = { mr, stream, chunks: [], start: Date.now(), send: false, timer: null, chat: active };
    rec = r;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.onstop = () => onRecStop(r);
    mr.start();
    r.timer = setInterval(() => {
      const ms = Date.now() - r.start;
      $('#recTime').textContent = L.formatElapsed(ms);
      if (ms >= L.MAX_VOICE_SECONDS * 1000) stopRec(true);
    }, 250);
    showRecBar(true);
  }
  function stopRec(send) {
    const r = rec;
    if (!r) return;
    r.send = send;
    r.dur = Math.round((Date.now() - r.start) / 1000);
    clearInterval(r.timer);
    rec = null;
    showRecBar(false);
    try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch (e) { /* already stopped */ }
    r.stream.getTracks().forEach((t) => t.stop());
  }
  function cancelRec() {
    if (rec) stopRec(false);
  }
  function onRecStop(r) {
    if (!r.send) return;
    if (r.dur < 1) { toast('التسجيل قصير جدًا.'); return; }
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      if (!L.isAudioData(src)) { toast('تعذّر قراءة التسجيل.'); return; }
      sendMedia({ type: 'audio', src, dur: r.dur }, '', r.chat);
    };
    reader.onerror = () => toast('تعذّر قراءة التسجيل.');
    reader.readAsDataURL(blob);
  }

  /* ───────── time loop ───────── */
  function statusSig(now) {
    return contacts.map((c) => L.liveStatuses(c.statuses, now).length).join(',') + '|' + L.liveStatuses(myStatuses, now).length;
  }
  function tick() {
    if (!me) return;
    const now = Date.now();
    let changed = false;

    for (const c of contacts) {
      const t = c.typingVal > 0 && now - c.typingAt < L.TYPING_MS;
      if (t !== c.typing) { c.typing = t; changed = true; }
    }

    const c = cur();
    if (c) {
      const cid = L.chatId(me.uid, c.uid);
      for (const m of c.msgs) {
        if (m.mode === 'fade' && m.gone && !m.delSent) {
          m.delSent = true;
          API.del('chats/' + cid + '/' + m.id).catch(ignore);
        }
      }
      const r = L.stepContact(c, now);
      if (r.changed) changed = true;
      for (const m of c.msgs) {
        if (m.mode === 'secret' && m.burned && m.from === 'them' && !m.burnSent) {
          m.burnSent = true;
          API.patch('chats/' + cid + '/' + m.id, { burned: true, text: null }).catch(ignore);
        }
      }
    }

    for (const st of myStatuses) {
      if (!L.isLive(st, now) && !st.delSent) {
        st.delSent = true;
        API.del('statuses/' + me.uid + '/' + st.id).catch(ignore);
      }
    }
    if (myStatuses.length && L.liveStatuses(myStatuses, now).length !== myStatuses.length) {
      myStatuses = L.liveStatuses(myStatuses, now);
    }
    const sig = statusSig(now);
    if (sig !== lastSig) {
      lastSig = sig;
      renderStatus();
      renderTabs();
    }
    const s = API.session();
    if (s && s.refreshToken && s.refreshToken !== me.rt) saveSession();
    if (now - lastPoll > POLL_MS) pollStatuses();

    if (changed) renderAll(false);
    else updateCountdowns();
  }
  function startTick() {
    clearInterval(tickTimer);
    lastSig = statusSig(Date.now());
    tickTimer = setInterval(tick, 500);
  }

  /* ───────── actions: chat ───────── */
  function openChat(id) {
    const c = contactById(id);
    if (!c) return;
    const was = active;
    active = id;
    c.unread = 0;
    if (!wide() && !navStack.some((e) => e.k === 'chat')) navPush('chat');
    if (was !== id) {
      cancelRec();
      c.msgs = c.pending ? c.msgs : [];
      startChatStream(c);
      fetchProfile(c, true);
    }
    renderAll(true);
    markRead(c);
    if (wide()) $('#msg').focus();
  }
  function closeChat() {
    navClose('chat');
  }

  function sendTyping(on) {
    const c = cur();
    if (!c || ghost || !me) return;
    const now = Date.now();
    if (on && now - lastTypingWrite < 3000) return;
    if (!on && !lastTypingWrite) return;
    lastTypingWrite = on ? now : 0;
    API.patch('inbox/' + c.uid + '/' + me.uid, { typing: on ? now : 0 }).catch(ignore);
  }

  async function deliver(c, m) {
    m.status = 'sending';
    renderAll(false);
    try {
      const cid = L.chatId(me.uid, c.uid);
      const record = L.recordFromMessage(m, me.uid);
      await API.put('chats/' + cid + '/' + m.id, record);
      const last = L.previewLabel(record);
      if (!m.peerDone) {
        await API.patch('inbox/' + c.uid + '/' + me.uid, { t: m.t, last, from: me.uid, unread: { '.sv': { increment: 1 } }, typing: 0 });
        m.peerDone = true;
      }
      if (!m.meDone) {
        await API.patch('inbox/' + me.uid + '/' + c.uid, { t: m.t, last, from: me.uid, unread: 0 });
        m.meDone = true;
      }
      m.status = 'sent';
      c.pending = false;
      c.lastT = m.t;
      c.last = last;
      c.lastFrom = me.uid;
    } catch (e) {
      m.status = 'failed';
      if (e && e.code === 'PERMISSION_DENIED') toast(errorText(e));
    }
    if (me) renderAll(false);
  }

  function send() {
    const input = $('#msg');
    const text = input.value.trim().slice(0, MAX_TEXT);
    const c = cur();
    if (!text || !c) return;
    const o = mode === 'fade' ? opt.fade : mode === 'capsule' ? opt.capsule : 0;
    const now = Date.now();
    const m = L.createMessage({ id: L.newMsgId(now), from: 'me', text, mode, now, option: o, status: 'sending' });
    c.msgs.push(m);
    input.value = '';
    lastTypingWrite = 0;
    renderAll(true);
    deliver(c, m);
  }

  function sendMedia(media, caption, chatId) {
    const c = chatId ? contactById(chatId) : cur();
    if (!c) return;
    const kind = mode === 'fade' ? 'fade' : 'plain';
    const now = Date.now();
    const m = L.createMessage({
      id: L.newMsgId(now), from: 'me', text: caption || '', mode: kind, now,
      option: kind === 'fade' ? opt.fade : 0, media, status: 'sending',
    });
    c.msgs.push(m);
    renderAll(true);
    deliver(c, m);
  }

  async function onChatFile(file) {
    if (!file || !mediaAllowed()) return;
    try {
      const src = await imageToDataUrl(file, { max: 1024, quality: 0.78 });
      const caption = $('#msg').value.trim();
      $('#msg').value = '';
      sendMedia({ type: 'image', src }, caption);
    } catch (e) {
      toast('تعذّر إرسال هذه الصورة. جرّب صورة أخرى.');
    }
  }

  /* ───────── status viewer ───────── */
  function vList() {
    if (!V) return [];
    const now = Date.now();
    if (V.owner === 'me') return L.liveStatuses(myStatuses, now);
    const c = contactById(V.owner);
    return c ? L.liveStatuses(c.statuses, now) : [];
  }
  function openViewer(owner) {
    const prev = V;
    V = { owner, idx: 0, t0: Date.now(), timer: null };
    if (!vList().length) { V = prev; return; }
    $('#viewer').hidden = false;
    navPush('status');
    renderViewer();
    V.timer = setInterval(vTick, 100);
  }
  function renderViewer() {
    const list = vList();
    if (!list.length) { navClose('status'); return; }
    V.idx = Math.min(V.idx, list.length - 1);
    const s = list[V.idx];
    const mine = V.owner === 'me';
    const owner = mine ? { name: me.name, mood: me.mood, photo: me.photo } : contactById(V.owner);
    if (!mine) {
      owner.seenSt[s.id] = true;
      saveSession();
      if (!ghost) {
        owner.viewed = owner.viewed || {};
        if (!owner.viewed[s.id]) {
          owner.viewed[s.id] = true;
          API.put('statuses/' + owner.uid + '/' + s.id + '/views/' + me.uid, { n: me.name, t: Date.now() }).catch(() => { owner.viewed[s.id] = false; });
        }
      }
    }

    $('#vBars').innerHTML = list.map((x, i) => '<i><b data-vb="' + i + '"></b></i>').join('');
    $('#vHead').innerHTML = avatar(cname(owner), owner.mood, 'sm', owner.photo) +
      '<div class="who"><b>' + esc(mine ? 'حالتي' : cname(owner)) + '</b><small>' + esc(L.statusAgo(s.t, Date.now())) + '</small></div>' +
      (mine ? '<button type="button" class="icon-btn" id="vDelete" aria-label="حذف هذه الحالة">' + ic('trash') + '</button>' : '') +
      '<button type="button" class="icon-btn" id="vClose" aria-label="إغلاق">' + ic('close') + '</button>';

    const body = $('#vBody');
    if (s.kind === 'image' && L.isImageData(s.img)) {
      body.style.background = '#000';
      body.innerHTML = '<img src="' + esc(s.img) + '" alt="صورة الحالة">' + (s.text ? '<div class="v-cap">' + esc(s.text) + '</div>' : '');
    } else {
      const bg = L.STATUS_BGS[s.bg] || L.STATUS_BGS[0];
      body.style.background = 'linear-gradient(160deg,' + bg[0] + ',' + bg[1] + ')';
      body.innerHTML = '<p>' + esc(s.text) + '</p>';
    }
    renderViewerFoot();
    vTick();
  }
  function renderViewerFoot() {
    if (!V) return;
    const list = vList();
    const s = list[V.idx];
    if (!s) return;
    let html = '';
    if (V.owner === 'me') {
      const v = s.viewers || [];
      html = ic('eye') + '<span>' + (v.length ? v.length + ' مشاهدة · ' + esc(v.join('، ')) : 'لم يشاهدها أحد بعد') + '</span>';
    } else if (ghost) {
      html = ic('ghost') + '<span>وضع الشبح: لا يعلمون بمشاهدتك.</span>';
    }
    $('#vFoot').innerHTML = html;
  }
  function vTick() {
    if (!V) return;
    const list = vList();
    const el = Date.now() - V.t0;
    const pct = Math.min(1, el / L.STATUS_VIEW_MS);
    document.querySelectorAll('[data-vb]').forEach((b) => {
      const i = Number(b.dataset.vb);
      b.style.width = (i < V.idx ? 100 : i === V.idx ? pct * 100 : 0) + '%';
    });
    if (el >= L.STATUS_VIEW_MS) vNext(list);
  }
  function vNext(list) {
    list = list || vList();
    V.idx++;
    V.t0 = Date.now();
    if (V.idx >= list.length) navClose('status');
    else renderViewer();
  }
  function vPrev() {
    if (V.idx > 0) V.idx--;
    V.t0 = Date.now();
    renderViewer();
  }
  function hideViewer() {
    if (V) clearInterval(V.timer);
    V = null;
    $('#viewer').hidden = true;
    $('#vBody').innerHTML = '';
    if (me) renderAll(false);
  }
  async function deleteStatus() {
    const s = vList()[V.idx];
    if (!s) return;
    try {
      await API.del('statuses/' + me.uid + '/' + s.id);
      myStatuses = myStatuses.filter((x) => x.id !== s.id);
      toast('حُذفت الحالة.');
      if (V) { V.t0 = Date.now(); renderViewer(); }
    } catch (e) { toast(errorText(e)); }
  }

  /* ───────── sheet: profile + new status ───────── */
  function profileHtml() {
    const moods = Object.keys(L.MOODS).map((k) =>
      '<button type="button" class="mood" data-mood="' + k + '" style="--c:' + L.MOODS[k].color + '" aria-pressed="' + (me.mood === k) + '"><i></i>' + L.MOODS[k].name + '</button>').join('');
    const phone = me.phone
      ? '<div class="set"><div><b>رقم هاتفك</b><span dir="ltr" style="text-align:start">' + esc(L.maskPhone(me.phone)) + '</span><span>يستطيع أصدقاؤك العثور عليك به. غير موثّق برسالة نصية.</span></div>' +
        '<button type="button" class="btn quiet sm" id="phoneRemove">إزالة</button></div>'
      : '<div><div class="sh-title">رقم الهاتف (اختياري)</div>' +
        '<div class="inline-form"><input id="phoneInput" type="tel" dir="ltr" inputmode="tel" autocomplete="tel" placeholder="+966501234567" aria-label="رقم الهاتف مع رمز الدولة">' +
        '<button type="button" class="addbtn" id="phoneSave">ربط</button></div>' +
        '<p class="fine">يسمح لأصدقائك بالعثور عليك برقمك. لا نرسل رسالة تحقق، ولا يظهر رقمك لأحد.</p></div>';
    return '<div class="sh-head">' +
      '<button type="button" class="photo-btn" id="photoBtn" aria-label="تغيير الصورة الشخصية">' + avatar(me.name, me.mood, 'lg', me.photo) + '<span class="cam">' + ic('camera') + '</span></button>' +
      '<div class="grow"><h2 id="sheetTitle">' + esc(me.name) + '</h2>' +
      '<span class="handle">@' + esc(me.handle) + ' <button type="button" id="copyHandle" aria-label="نسخ اسم المستخدم">' + ic('copy') + '</button></span></div>' +
      '<button type="button" class="icon-btn" id="closeSheet" aria-label="إغلاق">' + ic('close') + '</button></div>' +
      (me.photo ? '<button type="button" class="btn quiet" id="rmPhoto">إزالة الصورة الشخصية</button>' : '') +
      phone +
      '<div><div class="sh-title">هالة المزاج</div><div class="moods">' + moods + '</div></div>' +
      '<div class="set"><div><b>وضع الشبح</b><span>اقرأ واكتب دون أن يرى الآخرون أثرك.</span></div>' +
      '<button type="button" class="switch" role="switch" id="swGhost" aria-label="وضع الشبح" aria-checked="' + ghost + '"></button></div>' +
      '<div class="set"><div><b>إخفاء معاينة الرسائل</b><span>تمويه آخر رسالة في قائمة المحادثات.</span></div>' +
      '<button type="button" class="switch" role="switch" id="swPrev" aria-label="إخفاء معاينة الرسائل" aria-checked="' + hidePreview + '"></button></div>' +
      '<button type="button" class="btn danger" id="logout">' + (confirmLogout ? 'اضغط مرة أخرى لتأكيد الخروج' : 'تسجيل الخروج') + '</button>';
  }
  function composeHtml() {
    const isImg = draft.kind === 'image';
    const bg = L.STATUS_BGS[draft.bg] || L.STATUS_BGS[0];
    const sw = L.STATUS_BGS.map((b, i) =>
      '<button type="button" class="swatch" data-bg="' + i + '" style="background:linear-gradient(135deg,' + b[0] + ',' + b[1] + ')" aria-label="لون الخلفية ' + (i + 1) + '" aria-pressed="' + (draft.bg === i) + '"></button>').join('');
    return '<div class="sh-head"><h2 id="sheetTitle" class="grow">حالة جديدة</h2>' +
      '<button type="button" class="icon-btn" id="closeSheet" aria-label="إغلاق">' + ic('close') + '</button></div>' +
      '<div class="stp' + (isImg ? ' img' : '') + '"' + (isImg ? '' : ' style="background:linear-gradient(160deg,' + bg[0] + ',' + bg[1] + ')"') + '>' +
      (isImg ? '<img src="' + esc(draft.img) + '" alt="معاينة صورة الحالة">' : '') +
      '<textarea id="stText" maxlength="' + L.STATUS_MAX_CHARS + '" rows="' + (isImg ? 2 : 4) + '" placeholder="' + (isImg ? 'أضف تعليقًا (اختياري)' : 'اكتب حالتك') + '" aria-label="نص الحالة">' + esc(draft.text) + '</textarea></div>' +
      (isImg ? '' : '<div><div class="sh-title">لون الخلفية</div><div class="swatches">' + sw + '</div></div>') +
      '<div class="row-actions"><button type="button" class="btn quiet" id="stPhoto">' + ic('camera') + (isImg ? 'تغيير الصورة' : 'إضافة صورة') + '</button>' +
      (isImg ? '<button type="button" class="btn quiet" id="stNoPhoto">نص فقط</button>' : '') + '</div>' +
      '<button type="button" class="btn primary" id="stPost">نشر الحالة</button>' +
      '<p class="fine">تختفي الحالة بعد 24 ساعة.</p>';
  }
  function refreshSheet() {
    $('#sheet').innerHTML = sheetMode === 'status' ? composeHtml() : profileHtml();
  }
  function openSheet(m) {
    sheetMode = m || 'profile';
    confirmLogout = false;
    refreshSheet();
    $('#scrim').hidden = false;
    navPush('sheet');
    $('#sheet').focus();
  }
  function openCompose() {
    draft = { kind: 'text', bg: 0, text: '', img: null };
    openSheet('status');
  }
  async function postStatus() {
    const v = L.validateStatusText(draft.text, draft.kind === 'text');
    if (!v.ok) { toast(v.error); return; }
    const s = { id: L.newMsgId(Date.now()), kind: draft.kind, text: v.value, bg: draft.bg, img: draft.kind === 'image' ? draft.img : null, t: Date.now(), viewers: [] };
    const btn = $('#stPost');
    if (btn) btn.disabled = true;
    try {
      await API.put('statuses/' + me.uid + '/' + s.id, L.statusRecord(s));
    } catch (e) {
      if (btn) btn.disabled = false;
      toast(errorText(e));
      return;
    }
    if (!myStatuses.some((x) => x.id === s.id)) myStatuses.push(s);
    tab = 'status';
    renderAll(false);
    navClose('sheet');
    toast('نُشرت حالتك.');
  }

  async function saveProfile(patch) {
    try { await API.patch('users/' + me.uid, patch); return true; }
    catch (e) { toast(errorText(e)); return false; }
  }
  async function onAvatarFile(file) {
    if (!file) return;
    let photo;
    try { photo = await imageToDataUrl(file, { square: true, size: 256, quality: 0.82 }); }
    catch (e) { toast('تعذّر استخدام هذه الصورة. جرّب صورة أخرى.'); return; }
    if (!(await saveProfile({ photo }))) return;
    me.photo = photo;
    saveSession();
    renderMe();
    renderAll(false);
    if (!$('#scrim').hidden && sheetMode === 'profile') refreshSheet();
    toast('تم تحديث الصورة الشخصية.');
  }
  async function onStatusFile(file) {
    if (!file) return;
    try {
      draft.text = $('#stText') ? $('#stText').value : draft.text;
      draft.img = await imageToDataUrl(file, { max: 960, quality: 0.78 });
      draft.kind = 'image';
      refreshSheet();
    } catch (e) {
      toast('تعذّر استخدام هذه الصورة. جرّب صورة أخرى.');
    }
  }

  /* ───────── phone number (optional) ───────── */
  async function loadPhone() {
    try {
      const p = await API.get('private/' + me.uid);
      if (p && typeof p.phone === 'string' && typeof p.phoneKey === 'string') { me.phone = p.phone; me.phoneKey = p.phoneKey; }
      else { me.phone = null; me.phoneKey = null; }
      saveSession();
    } catch (e) { /* keep the cached value */ }
  }
  async function claimPhone(raw) {
    const n = L.normalizePhone(raw);
    if (!n.ok) { toast(n.error); return; }
    try {
      const key = await L.phoneKey(n.value);
      const owner = await API.get('phones/' + key);
      if (owner && owner !== me.uid) { toast('هذا الرقم مرتبط بحساب آخر.'); return; }
      await API.put('phones/' + key, me.uid);
      await API.put('private/' + me.uid, { phone: n.value, phoneKey: key });
      if (me.phoneKey && me.phoneKey !== key) await API.del('phones/' + me.phoneKey).catch(ignore);
      me.phone = n.value;
      me.phoneKey = key;
      saveSession();
      refreshSheet();
      toast('رُبط رقمك. يمكن لأصدقائك البحث عنك به.');
    } catch (e) { toast(errorText(e)); }
  }
  async function removePhone() {
    try {
      if (me.phoneKey) await API.del('phones/' + me.phoneKey);
      await API.del('private/' + me.uid);
      me.phone = null;
      me.phoneKey = null;
      saveSession();
      refreshSheet();
      toast('أُزيل رقمك.');
    } catch (e) { toast(errorText(e)); }
  }

  /* ───────── session: enter / leave ───────── */
  function showOnly(which) {
    $('#auth').hidden = which !== 'auth';
    $('#splash').hidden = which !== 'splash';
    $('#main').hidden = which !== 'main';
  }
  function enter() {
    showOnly('main');
    active = null;
    tab = 'chats';
    lastPoll = 0;
    renderMe();
    renderComposer();
    renderAll(true);
    startStreams();
    startTick();
    loadPhone();
  }
  function logout() {
    cancelRec();
    stopPlayer();
    stopStreams();
    if (V) { clearInterval(V.timer); V = null; }
    $('#viewer').hidden = true;
    clearInterval(tickTimer);
    API.signOut();
    me = null; contacts = []; myStatuses = []; active = null; ghost = false; hidePreview = false; mode = 'plain'; tab = 'chats';
    pState = {}; inboxLoaded = false;
    navStack.length = 0;
    saveSession();
    $('#scrim').hidden = true;
    $('#q').value = '';
    $('#pq').value = '';
    $('#passInput').value = '';
    $('#connBar').hidden = true;
    setAuthMode('login');
    showOnly('auth');
  }

  function splash(msg, canRetry) {
    showOnly('splash');
    $('#splashMsg').textContent = msg;
    $('#splashRetry').hidden = !canRetry;
    $('#splashOut').hidden = !canRetry;
  }
  async function resume(s) {
    splash('جارٍ الاتصال…', false);
    me = {
      uid: s.uid, name: s.profile.name, handle: s.profile.handle,
      mood: L.MOODS[s.profile.mood] ? s.profile.mood : 'creative',
      photo: L.isImageData(s.profile.photo) ? s.profile.photo : null,
      phone: s.phone || null, phoneKey: null, rt: s.refreshToken,
      seenStore: s.seenStore && typeof s.seenStore === 'object' ? s.seenStore : {},
    };
    ghost = !!s.ghost;
    hidePreview = !!s.hidePreview;
    API.restoreSession({ uid: s.uid, idToken: '', refreshToken: s.refreshToken, expiresAt: 0 });
    try {
      await API.token(true);
      const u = L.userFromRecord(await API.get('users/' + me.uid));
      if (u) Object.assign(me, u);
    } catch (e) {
      if (retryable(e)) { splash('تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة.', true); return; }
      me = null;
      saveSession();
      showOnly('auth');
      setAuthMode('login');
      return;
    }
    saveSession();
    enter();
  }

  /* ───────── auth ───────── */
  function setAuthMode(m) {
    authMode = m;
    const signup = m === 'signup';
    $('#segSignup').setAttribute('aria-selected', String(signup));
    $('#segLogin').setAttribute('aria-selected', String(!signup));
    $('#nameRow').hidden = !signup;
    $('#authSubmit').textContent = signup ? 'أنشئ حسابي' : 'تسجيل الدخول';
    $('#passInput').setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
    $('#authFine').hidden = !signup;
    $('#authErr').hidden = true;
  }
  function authError(msg, focus) {
    const err = $('#authErr');
    err.textContent = msg;
    err.hidden = false;
    if (focus) focus.focus();
  }
  async function onAuthSubmit(e) {
    e.preventDefault();
    if (authBusy) return;
    const signup = authMode === 'signup';
    const n = signup ? L.validateName($('#nameInput').value) : { ok: true, value: '' };
    const h = L.validateUsername($('#handleInput').value);
    const p = L.validatePassword($('#passInput').value);
    if (!n.ok) return authError(n.error, $('#nameInput'));
    if (!h.ok) return authError(h.error, $('#handleInput'));
    if (!signup && !String($('#passInput').value)) return authError('اكتب كلمة المرور.', $('#passInput'));
    if (signup && !p.ok) return authError(p.error, $('#passInput'));
    $('#authErr').hidden = true;
    authBusy = true;
    const btn = $('#authSubmit');
    btn.disabled = true;
    try {
      const email = L.syntheticEmail(h.value);
      const key = L.handleKey(h.value);
      const sess = signup ? await API.signUp(email, p.value) : await API.signIn(email, $('#passInput').value);
      let profile;
      if (signup) {
        await API.put('handles/' + key, sess.uid);
        profile = { name: n.value, handle: h.value, mood: 'creative', t: Date.now() };
        await API.put('users/' + sess.uid, profile);
      } else {
        profile = L.userFromRecord(await API.get('users/' + sess.uid));
        if (!profile) { // an earlier sign-up was interrupted: finish it
          await API.put('handles/' + key, sess.uid).catch(ignore);
          profile = { name: h.value, handle: h.value, mood: 'creative', t: Date.now() };
          await API.put('users/' + sess.uid, profile);
        }
      }
      me = {
        uid: sess.uid, name: profile.name, handle: profile.handle, mood: profile.mood || 'creative',
        photo: L.isImageData(profile.photo) ? profile.photo : null,
        phone: null, phoneKey: null, rt: sess.refreshToken, seenStore: {},
      };
      ghost = false;
      hidePreview = false;
      $('#passInput').value = '';
      saveSession();
      enter();
    } catch (err) {
      API.signOut();
      me = null;
      authError(errorText(err));
    } finally {
      authBusy = false;
      btn.disabled = !API.configured();
    }
  }

  /* ───────── wiring ───────── */
  function bind() {
    $('#authForm').addEventListener('submit', onAuthSubmit);
    $('#segSignup').addEventListener('click', () => setAuthMode('signup'));
    $('#segLogin').addEventListener('click', () => setAuthMode('login'));
    $('#splashRetry').addEventListener('click', () => { const s = loadSession(); if (s) resume(s); else showOnly('auth'); });
    $('#splashOut').addEventListener('click', () => { if (me) logout(); else showOnly('auth'); });

    $('#q').addEventListener('input', renderList);
    $('#q').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const f = $('#rows').querySelector('[data-find]');
      if (f) goFind(f.dataset.find);
    });
    const goFind = (q) => { $('#pq').value = q; setTab('people'); searchPeople(q); };
    $('#rows').addEventListener('click', (e) => {
      if (e.target.closest('[data-goto-people]')) return setTab('people');
      const f = e.target.closest('[data-find]');
      if (f) return goFind(f.dataset.find);
      const row = e.target.closest('[data-open]');
      if (row) openChat(row.dataset.open);
    });

    $('#tabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) setTab(t.dataset.tab);
    });

    $('#stMine').addEventListener('click', (e) => {
      if (e.target.closest('[data-st-add]')) return openCompose();
      if (e.target.closest('[data-st-mine]')) {
        if (L.liveStatuses(myStatuses, Date.now()).length) openViewer('me');
        else openCompose();
      }
    });
    $('#stRows').addEventListener('click', (e) => {
      const r = e.target.closest('[data-st]');
      if (r) openViewer(r.dataset.st);
    });

    $('#pq').addEventListener('input', () => { pToken++; pState = {}; renderPeople(); });
    $('#pq').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchPeople($('#pq').value); });
    $('#pGo').addEventListener('click', () => searchPeople($('#pq').value));
    $('#pRows').addEventListener('click', (e) => {
      const add = e.target.closest('[data-chat]');
      if (add && pState.person && pState.person.uid === add.dataset.chat) return startChatWith(pState.person);
      const row = e.target.closest('[data-open]');
      if (row) { setTab('chats'); openChat(row.dataset.open); }
    });

    $('#backBtn').addEventListener('click', closeChat);
    $('#meBtn').addEventListener('click', () => openSheet('profile'));
    $('#sendForm').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    $('#msg').addEventListener('input', () => sendTyping($('#msg').value.length > 0));
    $('#attachBtn').addEventListener('click', () => { if (mediaAllowed()) $('#chatFile').click(); });
    $('#chatFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; onChatFile(f); });
    $('#micBtn').addEventListener('click', startRec);
    $('#recCancel').addEventListener('click', () => stopRec(false));
    $('#recSend').addEventListener('click', () => stopRec(true));

    $('#modes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      mode = b.dataset.mode;
      renderComposer();
    });
    $('#opts').addEventListener('click', (e) => {
      const b = e.target.closest('[data-opt]');
      if (!b) return;
      opt[mode] = Number(b.dataset.opt);
      renderComposer();
    });
    $('#msgs').addEventListener('click', (e) => {
      const c = cur();
      const rt = e.target.closest('[data-retry]');
      if (rt && c) {
        const m = byId(rt.dataset.retry);
        if (m && m.status === 'failed') deliver(c, m);
        return;
      }
      const p = e.target.closest('[data-play]');
      if (p) return togglePlay(p.dataset.play);
      const b = e.target.closest('[data-secret]');
      if (!b || !c) return;
      const m = byId(b.dataset.secret);
      if (m && m.from === 'them' && L.openSecret(m, Date.now())) {
        renderMsgs(false);
        API.patch('chats/' + L.chatId(me.uid, c.uid) + '/' + m.id, { opened: Date.now() }).catch(ignore);
      }
    });

    $('#vNext').addEventListener('click', () => { if (V) vNext(); });
    $('#vPrev').addEventListener('click', () => { if (V) vPrev(); });
    $('#vHead').addEventListener('click', (e) => {
      if (e.target.closest('#vClose')) return navClose('status');
      if (e.target.closest('#vDelete')) deleteStatus();
    });

    $('#avatarFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; onAvatarFile(f); });
    $('#statusFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; onStatusFile(f); });

    $('#scrim').addEventListener('click', (e) => { if (e.target.id === 'scrim') navClose('sheet'); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const top = navStack[navStack.length - 1];
      if (top && top.k !== 'chat') navClose(top.k);
    });
    $('#sheet').addEventListener('input', (e) => {
      if (e.target.id === 'stText') draft.text = e.target.value;
    });
    $('#sheet').addEventListener('click', async (e) => {
      const t = e.target;
      if (t.closest('#closeSheet')) return navClose('sheet');
      if (sheetMode === 'status') {
        const bg = t.closest('[data-bg]');
        if (bg) { draft.text = $('#stText').value; draft.bg = Number(bg.dataset.bg); refreshSheet(); return; }
        if (t.closest('#stPhoto')) { $('#statusFile').click(); return; }
        if (t.closest('#stNoPhoto')) { draft.text = $('#stText').value; draft.kind = 'text'; draft.img = null; refreshSheet(); return; }
        if (t.closest('#stPost')) { draft.text = $('#stText').value; postStatus(); }
        return;
      }
      const mood = t.closest('[data-mood]');
      if (mood) {
        const k = mood.dataset.mood;
        if (await saveProfile({ mood: k })) { me.mood = k; saveSession(); renderMe(); refreshSheet(); renderAll(false); }
        return;
      }
      if (t.closest('#photoBtn')) { $('#avatarFile').click(); return; }
      if (t.closest('#rmPhoto')) {
        if (await saveProfile({ photo: null })) { me.photo = null; saveSession(); renderMe(); renderAll(false); refreshSheet(); }
        return;
      }
      if (t.closest('#phoneSave')) { claimPhone($('#phoneInput').value); return; }
      if (t.closest('#phoneRemove')) { removePhone(); return; }
      if (t.closest('#swGhost')) {
        ghost = !ghost;
        saveSession();
        refreshSheet();
        renderChat(false);
        if (ghost) sendTyping(false);
        else { const c = cur(); if (c) markRead(c); }
        return;
      }
      if (t.closest('#swPrev')) { hidePreview = !hidePreview; saveSession(); refreshSheet(); renderList(); return; }
      if (t.closest('#copyHandle')) {
        const text = '@' + me.handle;
        const ok = () => toast('نُسخ ' + text);
        const fail = () => toast('انسخه يدويًا: ' + text);
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fail);
        else fail();
        return;
      }
      if (t.closest('#logout')) {
        if (!confirmLogout) { confirmLogout = true; refreshSheet(); return; }
        logout();
      }
    });
  }

  function boot() {
    bind();
    try { localStorage.removeItem('hamsa.v1'); localStorage.removeItem('hamsa.status.v1'); } catch (e) { /* ignore */ }
    setAuthMode('signup');
    if (!API.configured()) {
      $('#cfgWarn').hidden = false;
      $('#authSubmit').disabled = true;
    }
    const s = loadSession();
    if (s && API.configured()) resume(s);
    else showOnly('auth');
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  boot();
})();
