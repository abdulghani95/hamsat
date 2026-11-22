/*
 * همسة — Hamsa messenger
 * Pure logic with no DOM access, so it runs in the browser (window.Logic)
 * and under Node for unit tests (require('./js/logic.js')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MOODS = {
    calm: { name: 'هادئ', color: '#38bdf8' },
    spark: { name: 'متحمس', color: '#f59e0b' },
    creative: { name: 'مبدع', color: '#c084fc' },
    love: { name: 'عاطفي', color: '#ec4899' },
    focus: { name: 'مركّز', color: '#22c55e' },
  };

  // [seconds, label]
  const FADE_OPTIONS = [[10, '10 ث'], [30, '30 ث'], [60, 'دقيقة']];
  const CAPSULE_OPTIONS = [[20, '20 ث'], [60, 'دقيقة'], [3600, 'ساعة']];
  const MODES = ['plain', 'fade', 'capsule', 'secret'];

  const SECRET_VIEW_MS = 6000; // how long a secret message stays readable once opened
  const SECRET_AUTO_BURN_MS = 9000; // sender's copy burns on its own
  const VANISH_MS = 450; // length of the vanish animation before removal

  const HANDLE_RE = /^[a-z0-9._]{3,20}$/;
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1

  function normalizeHandle(s) {
    return String(s == null ? '' : s).trim().replace(/^@+/, '').toLowerCase();
  }

  function validateUsername(input) {
    const value = normalizeHandle(input);
    if (!HANDLE_RE.test(value) || /^[._]|[._]$/.test(value) || /[._]{2}/.test(value)) {
      return {
        ok: false,
        error: 'استخدم من 3 إلى 20 حرفًا إنجليزيًا أو أرقامًا أو نقطة، دون بدء الاسم أو إنهائه بنقطة.',
      };
    }
    return { ok: true, value };
  }

  function validateName(input) {
    const value = String(input == null ? '' : input).trim().replace(/\s+/g, ' ');
    if (value.length < 2 || value.length > 24) {
      return { ok: false, error: 'اكتب اسمًا ظاهرًا من حرفين إلى 24 حرفًا.' };
    }
    return { ok: true, value };
  }

  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // randomBytes(n) -> array-like of n bytes. Defaults to Web Crypto / Node crypto.
  function defaultRandomBytes(n) {
    const out = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(out);
    else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  function recoveryCode(randomBytes) {
    const bytes = (randomBytes || defaultRandomBytes)(9);
    let chars = '';
    for (let i = 0; i < 9; i++) chars += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return chars.slice(0, 3) + '-' + chars.slice(3, 6) + '-' + chars.slice(6, 9);
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }

  function optionLabel(list, seconds) {
    const hit = list.find((o) => o[0] === seconds);
    return hit ? hit[1] : seconds + ' ث';
  }

  /*
   * Message shapes
   *   plain   : { text }
   *   fade    : { text, expiresAt, gone, goneAt }
   *   capsule : { text, unlockAt, total, unlocked }
   *   secret  : { text, open, openUntil, burned, autoBurn (mine only) }
   *   sys     : { text }   (centred notice)
   */
  function createMessage(o) {
    const now = o.now;
    const m = {
      id: o.id,
      from: o.from,
      text: o.text,
      mode: o.mode || 'plain',
      t: now,
    };
    if (o.media) m.media = o.media; // { type: 'image'|'audio'|'video', src, dur? }
    if (m.from === 'me') m.status = o.status || 'sent';
    if (m.mode === 'fade') {
      m.expiresAt = now + o.option * 1000;
      m.gone = false;
    } else if (m.mode === 'capsule') {
      m.total = o.option * 1000;
      m.unlockAt = now + m.total;
      m.unlocked = false;
    } else if (m.mode === 'secret') {
      m.open = false;
      m.burned = false;
      if (m.from === 'me') m.autoBurn = now + SECRET_AUTO_BURN_MS;
    }
    return m;
  }

  function burn(m) {
    m.burned = true;
    m.open = false;
    m.text = '';
  }

  function openSecret(m, now) {
    if (!m || m.mode !== 'secret' || m.burned || m.open) return false;
    m.open = true;
    m.openUntil = now + SECRET_VIEW_MS;
    return true;
  }

  // Advance one message to `now`. Returns { changed, remove }.
  function stepMessage(m, now) {
    let changed = false;
    let remove = false;
    if (m.mode === 'fade') {
      if (!m.gone && now >= m.expiresAt) {
        m.gone = true;
        m.goneAt = now;
        changed = true;
      }
      if (m.gone && now - m.goneAt >= VANISH_MS) remove = true;
    } else if (m.mode === 'capsule') {
      if (!m.unlocked && now >= m.unlockAt) {
        m.unlocked = true;
        changed = true;
      }
    } else if (m.mode === 'secret' && !m.burned) {
      if (m.open && now >= m.openUntil) {
        burn(m);
        changed = true;
      } else if (!m.open && m.from === 'me' && m.autoBurn && now >= m.autoBurn) {
        burn(m);
        changed = true;
      }
    }
    return { changed, remove };
  }

  // Advance a whole contact. Returns { changed, newlyUnlockedFromThem }.
  function stepContact(c, now) {
    let changed = false;
    let newlyUnlocked = 0;
    for (const m of c.msgs) {
      const wasUnlocked = m.unlocked;
      const r = stepMessage(m, now);
      if (r.changed) changed = true;
      if (m.mode === 'capsule' && !wasUnlocked && m.unlocked && m.from === 'them') newlyUnlocked++;
    }
    const before = c.msgs.length;
    c.msgs = c.msgs.filter((m) => !(m.mode === 'fade' && m.gone && now - m.goneAt >= VANISH_MS));
    if (c.msgs.length !== before) changed = true;
    return { changed, newlyUnlocked };
  }

  function previewOf(m) {
    if (!m) return '';
    if (m.mode === 'sys') return m.text;
    const p = m.from === 'me' ? 'أنت: ' : '';
    if (m.mode === 'fade') return p + (m.gone ? 'اختفت الرسالة' : 'رسالة تتلاشى');
    if (m.mode === 'capsule') return p + (m.unlocked ? 'كبسولة مفتوحة' : 'كبسولة زمنية');
    if (m.mode === 'secret') return p + (m.burned ? 'احترقت الرسالة' : 'رسالة سرية');
    if (m.media) return p + (m.media.type === 'audio' ? 'رسالة صوتية' : m.media.type === 'video' ? 'فيديو' : 'صورة');
    return p + m.text;
  }

  function lastVisible(c) {
    for (let i = c.msgs.length - 1; i >= 0; i--) if (!c.msgs[i].gone) return c.msgs[i];
    return null;
  }

  function replyDelay(m, now) {
    if (m.mode === 'capsule') return Math.max(0, m.unlockAt - now) + 2500;
    return 1800;
  }

  const SPECIAL_REPLIES = {
    fade: 'سأردّ قبل أن تختفي رسالتك!',
    capsule: 'فتحتُ الكبسولة للتو، كانت تستحق الانتظار.',
    secret: 'قرأتها واحترقت. شكرًا على ثقتك.',
  };
  const GENERIC_REPLIES = [
    'وصلتني! أحب أن الهوية هنا اسم مستخدم فقط.',
    'جرّب رسالة تتلاشى، ستعجبك.',
    'ممتاز، نكمل الحديث بعد قليل.',
  ];

  function nextReply(contact, sent) {
    if (sent && sent.media) {
      return sent.media.type === 'audio' ? 'سمعت رسالتك الصوتية، وصلت واضحة.' : 'صورة جميلة! شكرًا لمشاركتها.';
    }
    if (sent && SPECIAL_REPLIES[sent.mode]) return SPECIAL_REPLIES[sent.mode];
    const list = contact.replies && contact.replies.length ? contact.replies : GENERIC_REPLIES;
    const i = contact.ri || 0;
    contact.ri = i + 1;
    return list[i % list.length];
  }

  function newContact(handle, moodKey, name) {
    return {
      id: 'u_' + handle,
      name: name || handle,
      handle,
      mood: moodKey,
      unread: 0,
      typing: false,
      ri: 0,
      replies: GENERIC_REPLIES.slice(),
      statuses: [],
      seenSt: {},
      msgs: [],
    };
  }

  function searchContacts(contacts, q) {
    const s = normalizeHandle(q);
    if (!s) return contacts.slice();
    return contacts.filter(
      (c) => c.name.toLowerCase().includes(s) || c.handle.toLowerCase().includes(s) || c.name.includes(String(q).trim())
    );
  }

  function canAddHandle(contacts, q, selfHandle) {
    const v = validateUsername(q);
    if (!v.ok) return { ok: false, reason: 'invalid' };
    if (selfHandle && v.value === normalizeHandle(selfHandle)) return { ok: false, reason: 'self' };
    if (contacts.some((c) => c.handle === v.value)) return { ok: false, reason: 'exists' };
    return { ok: true, handle: v.value };
  }

  // Deterministic QR-looking pattern (for the add-me code). Not a real QR code.
  function qrCells(seed, size) {
    const N = size || 21;
    let x = hash32(String(seed)) || 1;
    const rnd = () => {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      return x / 4294967296;
    };
    const inFinder = (r, c) => (r < 8 && c < 8) || (r < 8 && c >= N - 8) || (r >= N - 8 && c < 8);
    const cells = [];
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (inFinder(r, c)) continue;
        if (rnd() > 0.52) cells.push([r, c]);
      }
    }
    const finders = [[0, 0], [0, N - 7], [N - 7, 0]];
    return { size: N, cells, finders };
  }

  /* ───────── Status (stories) ───────── */
  const STATUS_TTL_MS = 24 * 3600 * 1000;
  const STATUS_VIEW_MS = 5000;
  const STATUS_MAX_CHARS = 180;
  // Gradient pairs; white text on every stop passes WCAG AA (checked in tests).
  const STATUS_BGS = [
    ['#5b21b6', '#7c3aed'],
    ['#0369a1', '#4338ca'],
    ['#be185d', '#c2410c'],
    ['#047857', '#0f766e'],
    ['#b45309', '#9a3412'],
    ['#1e1b4b', '#4c1d95'],
  ];

  function isLive(st, now) {
    return !!st && st.t + STATUS_TTL_MS > now;
  }
  function liveStatuses(list, now) {
    return (list || []).filter((s) => isLive(s, now));
  }

  const statusViewMs = (s) => (s && s.kind === 'video' ? Math.max(STATUS_VIEW_MS, Math.round((s.dur || 0) * 1000)) : STATUS_VIEW_MS);

  function statusAgo(t, now) {
    const min = Math.floor(Math.max(0, now - t) / 60000);
    if (min < 1) return 'الآن';
    if (min < 60) return 'منذ ' + min + ' د';
    return 'منذ ' + Math.floor(min / 60) + ' س';
  }

  function validateStatusText(input, required) {
    const value = String(input == null ? '' : input).trim();
    if (required && !value) return { ok: false, error: 'اكتب شيئًا قبل النشر.' };
    if (value.length > STATUS_MAX_CHARS) {
      return { ok: false, error: 'الحد الأقصى ' + STATUS_MAX_CHARS + ' حرفًا.' };
    }
    return { ok: true, value };
  }

  // c.statuses: [{id,kind,text,bg,t}], c.seenSt: {id:true}
  function statusInfo(c, now) {
    const live = liveStatuses(c.statuses, now);
    const seen = c.seenSt || {};
    const unseen = live.filter((s) => !seen[s.id]).length;
    return { live, count: live.length, unseen, latest: live.length ? live[live.length - 1].t : 0 };
  }

  // Contacts that have a live status: unseen first, then newest first.
  function statusContacts(contacts, now) {
    return contacts
      .map((c) => ({ c, info: statusInfo(c, now) }))
      .filter((x) => x.info.count > 0)
      .sort((a, b) => (b.info.unseen > 0) - (a.info.unseen > 0) || b.info.latest - a.info.latest);
  }

  /* ───────── Image geometry (pure, so it can be tested) ───────── */
  function fitSize(w, h, max) {
    if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
    const k = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  function cropSquare(w, h) {
    const s = Math.min(w, h);
    return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), s };
  }
  function isImageData(s) {
    return typeof s === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s);
  }

  /* ───────── Voice messages ───────── */
  const MAX_VOICE_SECONDS = 120;

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(total / 60) + ':' + pad2(total % 60);
  }
  function isAudioData(s) {
    return typeof s === 'string' && /^data:audio\/[a-z0-9.+-]+(;codecs=[a-z0-9.,]+)?;base64,[A-Za-z0-9+/=]+$/i.test(s);
  }
  /* ───────── Calls (signalling records, pure) ───────── */
  const RING_MS = 45000;
  const CALL_KINDS = ['audio', 'video'];
  const callKind = (k) => (CALL_KINDS.indexOf(k) >= 0 ? k : 'audio');
  // An incoming ring is real only while it is fresh.
  const ringActive = (r, now) => !!r && typeof r.t === 'number' && now - r.t < RING_MS && now - r.t > -60000;
  function parseRings(tree, now) {
    if (!tree || typeof tree !== 'object') return [];
    return Object.keys(tree).map((uid) => {
      const r = tree[uid];
      return r && ringActive(r, now) ? { uid, t: r.t, kind: callKind(r.kind) } : null;
    }).filter(Boolean).sort((a, b) => b.t - a.t);
  }
  const defaultIce = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  /* ───────── Video clips (short, stored inline in the database) ───────── */
  const MAX_VIDEO_SECONDS = 15;
  const MAX_VIDEO_CHARS = 3200000; // about 2.3 MB of video
  function isVideoData(s) {
    return typeof s === 'string' && s.length <= MAX_VIDEO_CHARS &&
      /^data:video\/[a-z0-9.+-]+(;codecs=[a-z0-9.,]+)?;base64,[A-Za-z0-9+/=]+$/i.test(s);
  }
  function bytesToBase64(bytes) {
    const T = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += T[a >> 2] + T[((a & 3) << 4) | ((b || 0) >> 4)];
      out += i + 1 < bytes.length ? T[((b & 15) << 2) | ((c || 0) >> 6)] : '=';
      out += i + 2 < bytes.length ? T[c & 63] : '=';
    }
    return out;
  }
  // A short, gentle three-note chime as an 8-bit mono WAV, used for the demo voice message.
  function toneWav(seconds, rate) {
    const R = rate || 8000;
    const n = Math.round(R * seconds);
    const bytes = new Uint8Array(44 + n);
    const w32 = (o, v) => { bytes[o] = v & 255; bytes[o + 1] = (v >> 8) & 255; bytes[o + 2] = (v >> 16) & 255; bytes[o + 3] = (v >> 24) & 255; };
    const tag = (o, s) => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
    tag(0, 'RIFF'); w32(4, 36 + n); tag(8, 'WAVE'); tag(12, 'fmt ');
    w32(16, 16); bytes[20] = 1; bytes[22] = 1; w32(24, R); w32(28, R); bytes[32] = 1; bytes[34] = 8;
    tag(36, 'data'); w32(40, n);
    const notes = [440, 523.25, 659.25];
    const seg = n / notes.length;
    for (let i = 0; i < n; i++) {
      const k = Math.min(notes.length - 1, Math.floor(i / seg));
      const t = (i - k * seg) / R;
      const env = Math.exp(-3.2 * t) * Math.min(1, (i - k * seg) / 80);
      bytes[44 + i] = Math.round(128 + 90 * env * Math.sin(2 * Math.PI * notes[k] * t));
    }
    return { src: 'data:audio/wav;base64,' + bytesToBase64(bytes), dur: Math.round(seconds), bytes };
  }

  /* ───────── Online model: what is stored in the database ───────── */
  const TYPING_MS = 6000;
  const PASSWORD_MIN = 8;
  const MAX_TEXT = 4000;
  const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

  const chatId = (a, b) => [String(a), String(b)].sort().join('_');
  // Realtime Database keys cannot contain ".", so a username's dots become commas.
  const handleKey = (h) => normalizeHandle(h).replace(/\./g, ',');
  const syntheticEmail = (handle) => normalizeHandle(handle) + '@hamsa.app';

  function validatePassword(p) {
    const v = String(p == null ? '' : p);
    if (v.length < PASSWORD_MIN) return { ok: false, error: 'كلمة المرور 8 أحرف على الأقل.' };
    if (v.length > 128) return { ok: false, error: 'كلمة المرور طويلة جدًا.' };
    return { ok: true, value: v };
  }

  function normalizePhone(input) {
    let s = String(input == null ? '' : input).trim().replace(/[\s\-().]/g, '');
    if (s.startsWith('00')) s = '+' + s.slice(2);
    if (!/^\+[1-9][0-9]{7,14}$/.test(s)) {
      return { ok: false, error: 'اكتب الرقم مع رمز الدولة، مثل +966501234567.' };
    }
    return { ok: true, value: s };
  }
  const looksLikePhone = (input) => /^(\+|00)\d[\d\s\-().]*$/.test(String(input == null ? '' : input).trim());
  function maskPhone(p) {
    const s = String(p);
    return s.length <= 7 ? s : s.slice(0, 4) + '•'.repeat(s.length - 7) + s.slice(-3);
  }
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const phoneKey = (normalized) => sha256Hex('hamsa-phone:' + normalized);

  // Sortable by time, unique enough for two people chatting.
  function newMsgId(now, randomBytes) {
    const b = (randomBytes || defaultRandomBytes)(4);
    let r = '';
    for (let i = 0; i < 4; i++) r += ID_ALPHABET[b[i] % ID_ALPHABET.length];
    return Math.floor(now).toString(36).padStart(9, '0') + r;
  }

  const ttlOf = (rec) => Math.max(1, Math.min(86400, Number(rec && rec.ttl) || 0));

  function recordFromMessage(m, uid) {
    const rec = { from: uid, t: m.t, mode: m.mode };
    if (m.text) rec.text = m.text;
    if (m.mode === 'fade') rec.ttl = Math.round((m.expiresAt - m.t) / 1000);
    if (m.mode === 'capsule') rec.ttl = Math.round(m.total / 1000);
    if (m.media) {
      rec.media = { type: m.media.type, src: m.media.src };
      if (m.media.type === 'audio' || m.media.type === 'video') rec.media.dur = m.media.dur || 0;
    }
    return rec;
  }

  const recordExpired = (rec, now) =>
    !!rec && rec.mode === 'fade' && typeof rec.t === 'number' && rec.t + ttlOf(rec) * 1000 + VANISH_MS <= now;

  // Build (or update) the local message object for a stored record. Local-only state
  // (an open secret, a vanishing animation) lives on `prev` and is kept.
  function messageFromRecord(id, rec, meUid, now, prev) {
    if (!rec || typeof rec !== 'object' || typeof rec.from !== 'string' || typeof rec.t !== 'number') return null;
    const mode = MODES.indexOf(rec.mode) >= 0 ? rec.mode : 'plain';
    const mine = rec.from === meUid;
    const m = prev || { id };
    m.id = id;
    m.from = mine ? 'me' : 'them';
    m.mode = mode;
    m.t = rec.t;
    m.text = rec.burned ? '' : String(rec.text == null ? '' : rec.text).slice(0, MAX_TEXT);
    delete m.media;
    const md = rec.media;
    if (md && md.type === 'image' && isImageData(md.src)) m.media = { type: 'image', src: md.src };
    else if (md && md.type === 'video' && isVideoData(md.src)) {
      m.media = { type: 'video', src: md.src, dur: Math.max(0, Math.min(MAX_VIDEO_SECONDS + 1, Number(md.dur) || 0)) };
    } else if (md && md.type === 'audio' && isAudioData(md.src)) {
      m.media = { type: 'audio', src: md.src, dur: Math.max(0, Math.min(MAX_VOICE_SECONDS, Number(md.dur) || 0)) };
    }
    if (mode === 'fade') {
      m.expiresAt = rec.t + ttlOf(rec) * 1000;
      if (m.gone === undefined) m.gone = false;
    } else if (mode === 'capsule') {
      m.total = ttlOf(rec) * 1000;
      m.unlockAt = rec.t + m.total;
      if (m.unlocked === undefined) m.unlocked = now >= m.unlockAt;
    } else if (mode === 'secret') {
      if (m.burned === undefined) { m.burned = false; m.open = false; }
      if (rec.burned) { burn(m); m.burnSent = true; }
      else if (mine) {
        m.autoBurn = rec.t + SECRET_AUTO_BURN_MS;
        if (now >= m.autoBurn) burn(m);
      } else if (typeof rec.opened === 'number') {
        if (now >= rec.opened + SECRET_VIEW_MS) burn(m);
        else if (!m.burned) { m.open = true; m.openUntil = rec.opened + SECRET_VIEW_MS; }
      }
      if (m.burned) m.text = '';
    }
    if (mine) m.status = 'sent';
    return m;
  }

  // Short text for the conversation list. Never reveals protected content.
  function previewLabel(rec) {
    if (rec.mode === 'fade') return 'رسالة تتلاشى';
    if (rec.mode === 'capsule') return 'كبسولة زمنية';
    if (rec.mode === 'secret') return 'رسالة سرية';
    if (rec.media) return rec.media.type === 'audio' ? 'رسالة صوتية' : rec.media.type === 'video' ? 'فيديو' : 'صورة';
    return String(rec.text || '').slice(0, 80);
  }
  const entryPreview = (e, meUid) => (e.from === meUid ? 'أنت: ' : '') + e.last;
  const isTyping = (e, now) => !!e && typeof e.typing === 'number' && e.typing > 0 && now - e.typing < TYPING_MS;
  const deliveryState = (m, seenAt) => {
    if (m.from !== 'me') return '';
    if (m.status === 'sending' || m.status === 'failed') return m.status;
    return m.t <= (seenAt || 0) ? 'read' : 'sent';
  };

  function parseInbox(tree) {
    if (!tree || typeof tree !== 'object') return [];
    return Object.keys(tree).map((uid) => {
      const e = tree[uid];
      if (!e || typeof e !== 'object') return null;
      return {
        uid,
        t: Number(e.t) || 0,
        last: typeof e.last === 'string' ? e.last.slice(0, 120) : '',
        from: typeof e.from === 'string' ? e.from : '',
        unread: Math.max(0, Math.min(999, Number(e.unread) || 0)),
        seen: Number(e.seen) || 0,
        typing: Number(e.typing) || 0,
        cleared: Number(e.cleared) || 0,
      };
    }).filter(Boolean).sort((a, b) => b.t - a.t);
  }

  // A conversation the person deleted "for me" stays hidden until something newer arrives.
  const inboxHidden = (e) => !!e && e.cleared > 0 && e.t <= e.cleared;

  function userFromRecord(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const name = String(rec.name == null ? '' : rec.name).trim().slice(0, 24);
    const handle = normalizeHandle(rec.handle == null ? '' : rec.handle);
    if (!name || !HANDLE_RE.test(handle)) return null;
    return { name, handle, mood: MOODS[rec.mood] ? rec.mood : 'creative', photo: isImageData(rec.photo) ? rec.photo : null };
  }

  function statusFromRecord(id, rec) {
    if (!rec || typeof rec !== 'object' || typeof rec.t !== 'number') return null;
    const kind = rec.kind === 'image' ? 'image' : rec.kind === 'video' ? 'video' : 'text';
    if (kind === 'image' && !isImageData(rec.img)) return null;
    if (kind === 'video' && !isVideoData(rec.vid)) return null;
    const text = String(rec.text == null ? '' : rec.text).slice(0, STATUS_MAX_CHARS);
    if (kind === 'text' && !text.trim()) return null;
    const bg = Number.isInteger(rec.bg) && rec.bg >= 0 && rec.bg < STATUS_BGS.length ? rec.bg : 0;
    return {
      id, kind, text, bg, img: kind === 'image' ? rec.img : null, vid: kind === 'video' ? rec.vid : null,
      dur: kind === 'video' ? Math.max(1, Math.min(MAX_VIDEO_SECONDS + 1, Number(rec.dur) || MAX_VIDEO_SECONDS)) : 0, t: rec.t,
    };
  }
  function statusRecord(s) {
    const rec = { kind: s.kind, text: s.text || '', bg: s.bg, t: s.t };
    if (s.kind === 'image') rec.img = s.img;
    if (s.kind === 'video') { rec.vid = s.vid; rec.dur = s.dur || 0; }
    return rec;
  }

  return {
    TYPING_MS, PASSWORD_MIN, chatId, handleKey, syntheticEmail, validatePassword, normalizePhone, looksLikePhone,
    maskPhone, sha256Hex, phoneKey, newMsgId, recordFromMessage, recordExpired, messageFromRecord, previewLabel,
    entryPreview, isTyping, deliveryState, parseInbox, inboxHidden, userFromRecord, statusFromRecord, statusRecord,
    MAX_VOICE_SECONDS, MAX_VIDEO_SECONDS, MAX_VIDEO_CHARS, isVideoData, formatElapsed, isAudioData, bytesToBase64, toneWav,
    STATUS_TTL_MS, STATUS_VIEW_MS, STATUS_MAX_CHARS, STATUS_BGS,
    isLive, liveStatuses, statusViewMs, statusAgo, validateStatusText, statusInfo, statusContacts,
    fitSize, cropSquare, isImageData, RING_MS, callKind, ringActive, parseRings, defaultIce,
    MOODS, FADE_OPTIONS, CAPSULE_OPTIONS, MODES,
    SECRET_VIEW_MS, SECRET_AUTO_BURN_MS, VANISH_MS,
    normalizeHandle, validateUsername, validateName,
    hash32, recoveryCode, formatCountdown, optionLabel,
    createMessage, burn, openSecret, stepMessage, stepContact,
    previewOf, lastVisible, replyDelay, nextReply, newContact,
    searchContacts, canAddHandle, qrCells,
  };
});
