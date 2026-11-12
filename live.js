// About Me: live data layer (Firebase Auth + Firestore with offline cache).
// Anyone can be an author with a unique username. Readers open a book with username + reader password.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut as fbSignOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, deleteDoc, collection, onSnapshot, writeBatch, getDocs
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

let A, auth, fs, user = null, phase = 'auth';
let ownerUnsubs = [], rxUnsub = null, readerUnsubs = [];
let synced = null;               // owner: what the server already has
let readerSynced = {};           // pseudo id -> canon of my reactions
let reading = {};                // pseudo id -> shareId
let pend = { s: 0, a: 0, f: 0 };

/* ---------- helpers ---------- */
function canon(v) {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
function clean(o) {
  if (Array.isArray(o)) return o.map(x => (x && typeof x === 'object') ? clean(x) : x);
  const out = {};
  Object.keys(o).forEach(k => { const v = o[k]; if (v !== undefined) out[k] = (v && typeof v === 'object') ? clean(v) : v; });
  return out;
}
async function sha(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}
const shareIdFor = (nick, pw) => sha('aboutme|share|' + nick + '|' + pw);
async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += 400) { const b = writeBatch(fs); ops.slice(i, i + 400).forEach(fn => fn(b)); await b.commit(); }
}
function queueOps(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(fs); ops.slice(i, i + 400).forEach(fn => fn(b));
    b.commit().catch(e => A.toast('Couldn’t sync: ' + (e.code || e.message)));
  }
}
const isLocked = (a) => !!(a && a.lockUntil && a.lockUntil > Date.now());
function answerFromDoc(d) {
  const a = { text: d.text || '', answeredAt: d.answeredAt || Date.now(), editedAt: d.editedAt || null };
  ['fav', 'hidden'].forEach(k => { if (d[k]) a[k] = true; });
  if (d.mood) a.mood = d.mood;
  if (d.song && d.song.url) a.song = { url: d.song.url, title: d.song.title || '' };
  if (d.lockUntil) a.lockUntil = d.lockUntil;
  if (Array.isArray(d.versions) && d.versions.length) a.versions = d.versions.map(v => ({ text: v.text || '', at: v.at || 0, mood: v.mood || null }));
  return a;
}
function freeFromDoc(id, d) {
  const p = { id, title: d.title || '', text: d.text || '', answeredAt: d.answeredAt || Date.now(), editedAt: d.editedAt || null };
  if (d.hidden) p.hidden = true;
  return p;
}
function settingsOf(db, uid) {
  const b = db.authors[uid] || {};
  return clean({
    nick: b.nick || null, ownerHash: b.ownerHash || null, readerOn: !!b.readerOn, readerPlain: b.readerPlain || null,
    readerHash: b.readerHash || null, shareId: b.shareId || null, profile: b.profile || null,
    skipped: b.skipped || {}, shared: !!b.shared, createdAt: b.createdAt || Date.now(),
    seen: db.seen[uid] || {}, shelves: db.shelves[uid] || [], shelfInfo: db.shelfInfo || {}
  });
}
function buildMirror(b) {
  const m = {};
  Object.keys(b.answers).forEach(k => {
    const a = b.answers[k];
    if (a.hidden || isLocked(a) || !a.text.trim()) return;
    m['q' + k] = clean({ kind: 'q', n: +k, text: a.text, answeredAt: a.answeredAt, editedAt: a.editedAt || null, mood: a.mood || null, song: a.song });
  });
  b.free.forEach(p => {
    if (p.hidden || !(p.text || '').trim()) return;
    m['f' + p.id] = clean({ kind: 'f', id: p.id, title: p.title || '', text: p.text, answeredAt: p.answeredAt, editedAt: p.editedAt || null });
  });
  return m;
}
const canonMap = (m) => { const o = {}; Object.keys(m).forEach(k => { o[k] = canon(m[k]); }); return o; };
function bookDoc(b, uid) {
  return clean({ owner: uid, nick: b.nick, profile: { avatar: b.profile.avatar, color: b.profile.color, bio: b.profile.bio || '', pinned: b.profile.pinned || null }, updatedAt: Date.now() });
}

/* ---------- lifecycle ---------- */
export function init(api) {
  A = api;
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  getRedirectResult(auth).catch(() => {});
  onAuthStateChanged(auth, onUser);
}
export const busy = () => phase !== 'ready';
export const pending = () => pend.s + pend.a + pend.f;

function emptyDb() { return { accounts: {}, authors: {}, usernames: {}, reactions: {}, shelves: {}, shelfInfo: {}, seen: {} }; }
function stopOwner() { ownerUnsubs.forEach(u => u()); ownerUnsubs = []; if (rxUnsub) { rxUnsub(); rxUnsub = null; } synced = null; pend = { s: 0, a: 0, f: 0 }; }
function stopReader() { readerUnsubs.forEach(u => u()); readerUnsubs = []; }

async function onUser(u) {
  stopOwner(); stopReader(); reading = {}; readerSynced = {};
  user = u; A.S.unlocked = false;
  const db = emptyDb(); A.setDb(db);
  if (!u) { A.dev.account = null; A.saveDev(); phase = 'ready'; A.start(); return; }
  phase = 'loading'; A.start();
  A.dev.account = u.uid; A.saveDev();
  db.accounts[u.uid] = { name: u.displayName || 'You', email: u.email || '' };
  try { await loadMine(); } catch (e) { A.toast('Couldn’t load your book: ' + (e.code || e.message)); }
  phase = 'ready'; A.start();
}

/* ---------- my book ---------- */
function loadMine() {
  return new Promise((resolve, reject) => {
    const uid = user.uid, got = { s: false, a: false, f: false };
    synced = { settings: null, answers: {}, free: {}, mirror: {}, book: null };
    let done = false;
    const ready = () => {
      if (done || !(got.s && got.a && got.f)) return;
      done = true;
      const b = A.getDb().authors[uid];
      if (b && b.readerOn && b.shareId) { synced.mirror = canonMap(buildMirror(b)); synced.book = canon(bookDoc(b, uid)); listenMyReactions(b.shareId); }
      resolve();
      setTimeout(() => sync(), 50); // writes any time capsule that opened since last visit
    };
    const fail = (e) => { if (!done) { done = true; reject(e); } else A.toast('Sync problem: ' + (e.code || e.message)); };
    const book = () => { const db = A.getDb(); if (!db.authors[uid]) { db.authors[uid] = A.newBook(''); db.authors[uid].ownerHash = null; } return db.authors[uid]; };

    ownerUnsubs.push(onSnapshot(doc(fs, 'authors', uid), { includeMetadataChanges: true }, (s) => {
      pend.s = s.metadata.hasPendingWrites ? 1 : 0;
      if (!got.s || !s.metadata.hasPendingWrites) {
        const db = A.getDb(), d = s.data();
        if (d) {
          const b = book(), oldShare = b.shareId;
          b.nick = d.nick || ''; b.ownerHash = d.ownerHash || null; b.readerOn = !!d.readerOn; b.readerPlain = d.readerPlain || null;
          b.readerHash = d.readerHash || null; b.shareId = d.shareId || null; if (d.profile) b.profile = d.profile;
          b.skipped = d.skipped || {}; b.shared = !!d.shared; b.createdAt = d.createdAt || Date.now();
          db.seen[uid] = d.seen || {}; db.shelves[uid] = d.shelves || []; db.shelfInfo = d.shelfInfo || {};
          if (b.nick) db.usernames[b.nick] = uid;
          if (got.s && b.shareId !== oldShare && b.readerOn && b.shareId) listenMyReactions(b.shareId);
        }
        const c = d ? canon(settingsOf(db, uid)) : null, changed = got.s && synced.settings !== c;
        synced.settings = c; got.s = true; ready();
        if (changed && phase === 'ready') A.softRender();
      }
      A.statusRefresh();
    }, fail));

    ownerUnsubs.push(onSnapshot(collection(fs, 'authors', uid, 'answers'), { includeMetadataChanges: true }, (snap) => {
      const b = book(); let changed = false;
      snap.docChanges().forEach(ch => {
        const n = +ch.doc.id;
        if (ch.type === 'removed') { if (!ch.doc.metadata.hasPendingWrites && b.answers[n]) { delete b.answers[n]; changed = true; } delete synced.answers[n]; return; }
        if (got.a && ch.doc.metadata.hasPendingWrites) return;
        const a = answerFromDoc(ch.doc.data()), c = canon(a);
        if (canon(b.answers[n]) !== c) { b.answers[n] = a; changed = true; }
        synced.answers[n] = c;
      });
      pend.a = snap.docs.filter(d => d.metadata.hasPendingWrites).length;
      got.a = true; ready(); if (changed && phase === 'ready') A.softRender(); A.statusRefresh();
    }, fail));

    ownerUnsubs.push(onSnapshot(collection(fs, 'authors', uid, 'free'), { includeMetadataChanges: true }, (snap) => {
      const b = book(); let changed = false;
      snap.docChanges().forEach(ch => {
        const id = ch.doc.id;
        if (ch.type === 'removed') { if (!ch.doc.metadata.hasPendingWrites && b.free.some(p => p.id === id)) { b.free = b.free.filter(p => p.id !== id); changed = true; } delete synced.free[id]; return; }
        if (got.f && ch.doc.metadata.hasPendingWrites) return;
        const p = freeFromDoc(id, ch.doc.data()), c = canon(p), i = b.free.findIndex(x => x.id === id);
        if (i < 0) { b.free.push(p); changed = true; } else if (canon(b.free[i]) !== c) { b.free[i] = p; changed = true; }
        synced.free[id] = c;
      });
      pend.f = snap.docs.filter(d => d.metadata.hasPendingWrites).length;
      got.f = true; ready(); if (changed && phase === 'ready') A.softRender(); A.statusRefresh();
    }, fail));
  });
}
function listenMyReactions(shareId) {
  if (rxUnsub) { rxUnsub(); rxUnsub = null; }
  if (!shareId) return;
  const uid = user.uid;
  rxUnsub = onSnapshot(collection(fs, 'books', shareId, 'reactions'), (snap) => {
    const db = A.getDb(), R = {};
    snap.docs.forEach(d => {
      const v = d.data() || {}, who = d.id, r = v.r || {};
      db.accounts[who] = db.accounts[who] || { name: v.name || 'Someone', email: '' };
      if (v.nick) { db.accounts[who].name = '@' + v.nick; }
      Object.keys(r).forEach(key => { (R[key] = R[key] || {})[who] = r[key]; });
    });
    db.reactions[uid] = R;
    if (phase === 'ready') { A.softRender(); A.checkStickers(); }
  }, () => {});
}

// Called by the UI after every change. Writes only what changed.
export function sync() {
  if (!user) return;
  const db = A.getDb(), uid = user.uid, ops = [];
  syncReactions(db, ops);
  const b = db.authors[uid];
  if (synced && b && b.ownerHash) {
    const st = settingsOf(db, uid), stc = canon(st);
    if (stc !== synced.settings) { ops.push(x => x.set(doc(fs, 'authors', uid), st)); synced.settings = stc; }
    Object.keys(b.answers).forEach(k => {
      const a = b.answers[k], c = canon(a);
      if (c !== synced.answers[k]) { const data = clean(Object.assign({ n: +k }, a)); ops.push(x => x.set(doc(fs, 'authors', uid, 'answers', String(k)), data)); synced.answers[k] = c; }
    });
    Object.keys(synced.answers).forEach(k => { if (!b.answers[k]) { ops.push(x => x.delete(doc(fs, 'authors', uid, 'answers', String(k)))); delete synced.answers[k]; } });
    const ids = {};
    b.free.forEach(p => {
      ids[p.id] = 1; const c = canon(p);
      if (c !== synced.free[p.id]) { const data = clean(Object.assign({}, p)); ops.push(x => x.set(doc(fs, 'authors', uid, 'free', p.id), data)); synced.free[p.id] = c; }
    });
    Object.keys(synced.free).forEach(id => { if (!ids[id]) { ops.push(x => x.delete(doc(fs, 'authors', uid, 'free', id))); delete synced.free[id]; } });
    if (b.readerOn && b.shareId) {
      const sid = b.shareId, m = buildMirror(b), prev = synced.mirror || {}, next = {};
      Object.keys(m).forEach(k => { const c = canon(m[k]); next[k] = c; if (c !== prev[k]) ops.push(x => x.set(doc(fs, 'books', sid, 'pages', k), m[k])); });
      Object.keys(prev).forEach(k => { if (!next[k]) ops.push(x => x.delete(doc(fs, 'books', sid, 'pages', k))); });
      synced.mirror = next;
      const bd = bookDoc(b, uid), bdc = canon(Object.assign({}, bd, { updatedAt: 0 }));
      if (bdc !== synced.book) { ops.push(x => x.set(doc(fs, 'books', sid), bd)); synced.book = bdc; }
    }
  } else if (b && !b.ownerHash && synced) {
    // Reader-only account: keep the shelf in sync.
    const st = clean({ shelves: db.shelves[uid] || [], shelfInfo: db.shelfInfo || {} }), c = canon(st);
    if (c !== synced.settings) { ops.push(x => x.set(doc(fs, 'authors', uid), st, { merge: true })); synced.settings = c; }
  }
  if (ops.length) queueOps(ops);
}
function syncReactions(db, ops) {
  const me = user.uid;
  Object.keys(reading).forEach(pid => {
    const sid = reading[pid], R = db.reactions[pid] || {}, mine = {};
    Object.keys(R).forEach(key => { if (R[key][me]) mine[key] = R[key][me]; });
    const c = canon(mine);
    if (c !== readerSynced[pid]) {
      readerSynced[pid] = c;
      const myNick = db.authors[me] && db.authors[me].ownerHash ? db.authors[me].nick : null;
      const data = clean({ name: (db.accounts[me] && db.accounts[me].name || 'Someone').split(' ')[0], nick: myNick, r: mine, updatedAt: Date.now() });
      ops.push(x => x.set(doc(fs, 'books', sid, 'reactions', me), data));
    }
  });
}

async function deleteBook(id) {
  for (const sub of ['pages', 'reactions']) {
    const snap = await getDocs(collection(fs, 'books', id, sub));
    await commitOps(snap.docs.map(d => x => x.delete(d.ref)));
  }
  await deleteDoc(doc(fs, 'books', id));
}
async function moveBook(b, nick, pw) {
  const uid = user.uid, id = await shareIdFor(nick, pw), old = b.shareId;
  if (id !== old) {
    try { await setDoc(doc(fs, 'books', id), bookDoc(Object.assign({}, b, { nick }), uid)); }
    catch (e) { throw new Error('That reader password can’t be used. Please choose a different one.'); }
  }
  const m = buildMirror(b);
  await commitOps(Object.keys(m).map(k => x => x.set(doc(fs, 'books', id, 'pages', k), m[k])));
  if (old && old !== id) {
    try {
      const rs = await getDocs(collection(fs, 'books', old, 'reactions'));
      await commitOps(rs.docs.map(d => x => x.set(doc(fs, 'books', id, 'reactions', d.id), d.data())));
      await deleteBook(old);
    } catch (e) {}
  }
  b.shareId = id; b.readerPlain = pw; b.readerHash = await A.hash(pw); b.readerOn = true;
  synced.mirror = canonMap(m); synced.book = canon(Object.assign({}, bookDoc(Object.assign({}, b, { nick }), uid), { updatedAt: 0 }));
  listenMyReactions(id);
}

export async function setup(nick, ownerPw, readerPw) {
  if (!navigator.onLine) throw new Error('You need internet to create your book.');
  const uid = user.uid, ref = doc(fs, 'usernames', nick), s = await getDoc(ref);
  if (s.exists() && s.data().uid !== uid) throw new Error('@' + nick + ' is taken. Try another one.');
  if (!s.exists()) {
    try { await setDoc(ref, { uid, createdAt: Date.now() }); }
    catch (e) { throw new Error('@' + nick + ' is taken. Try another one.'); }
  }
  const db = A.getDb(), b = db.authors[uid] || A.newBook(nick);
  db.authors[uid] = b; b.nick = nick; b.ownerHash = await A.hash(ownerPw); b.readerOn = false; b.createdAt = Date.now();
  db.usernames[nick] = uid; db.seen[uid] = db.seen[uid] || { stickers: [], rx: Date.now() };
  if (readerPw) await moveBook(b, nick, readerPw);
  sync();
}
export async function changeReader(pw) {
  if (!navigator.onLine) throw new Error('You need internet to set the reader password.');
  const b = A.getDb().authors[user.uid];
  await moveBook(b, b.nick, pw); sync();
}
export async function setReaderOn(on) {
  if (!navigator.onLine) throw new Error('You need internet for this.');
  const b = A.getDb().authors[user.uid];
  if (!on) { if (b.shareId) await deleteBook(b.shareId); b.readerOn = false; b.shareId = null; synced.mirror = {}; synced.book = null; listenMyReactions(null); sync(); return; }
  if (!b.readerPlain) throw new Error('Set a reader password first.');
  await moveBook(b, b.nick, b.readerPlain); sync();
}
export async function changeNick(nick) {
  if (!navigator.onLine) throw new Error('You need internet to change your username.');
  const uid = user.uid, db = A.getDb(), b = db.authors[uid], old = b.nick;
  const ref = doc(fs, 'usernames', nick), s = await getDoc(ref);
  if (s.exists() && s.data().uid !== uid) throw new Error('@' + nick + ' is taken.');
  if (!s.exists()) { try { await setDoc(ref, { uid, createdAt: Date.now() }); } catch (e) { throw new Error('@' + nick + ' is taken.'); } }
  if (b.readerOn && b.readerPlain) await moveBook(b, nick, b.readerPlain);
  b.nick = nick; delete db.usernames[old]; db.usernames[nick] = uid;
  sync();
  try { await deleteDoc(doc(fs, 'usernames', old)); } catch (e) {}
}

/* ---------- reading someone's book ---------- */
export async function readerUnlock(nick, pw) {
  const id = await shareIdFor(nick, pw);
  let s;
  try { s = await getDoc(doc(fs, 'books', id)); }
  catch (e) { return { ok: false, msg: navigator.onLine ? 'Couldn’t check the password. Try again.' : 'Connect to the internet to open a book.' }; }
  if (!s.exists()) return { ok: false, msg: 'Wrong username or password, or reading is turned off.' };
  if (s.data().owner === user.uid) return { ok: false, msg: 'That’s your own book! Open it from Home.' };
  const pid = 'book:' + id;
  reading[pid] = id;
  await listenBook(pid, id, s.data());
  return { ok: true, uid: pid };
}
function listenBook(pid, id, first) {
  stopReader();
  const db = A.getDb(), me = user.uid;
  const b = A.newBook(first.nick || ''); b.readerOn = true; if (first.profile) b.profile = first.profile;
  db.authors[pid] = b; db.usernames[b.nick] = pid; db.reactions[pid] = db.reactions[pid] || {};
  return new Promise((resolve) => {
    let gotPages = false, gotRx = false;
    const done = () => { if (gotPages && gotRx) resolve(); };
    readerUnsubs.push(onSnapshot(doc(fs, 'books', id), (s) => {
      if (!s.exists()) { if (A.S.readUid === pid) { stopReader(); A.S.readUid = null; A.toast('This book is locked now. The password may have changed.'); A.start(); } return; }
      const d = s.data(); if (d.profile) b.profile = d.profile; if (d.nick) b.nick = d.nick;
      if (gotPages) A.softRender();
    }, () => {}));
    readerUnsubs.push(onSnapshot(collection(fs, 'books', id, 'pages'), (snap) => {
      b.answers = {}; b.free = [];
      snap.docs.forEach(d => { const p = d.data(); if (p.kind === 'q') b.answers[p.n] = answerFromDoc(p); else if (p.kind === 'f') b.free.push(freeFromDoc(p.id, p)); });
      b.free.sort((x, y) => x.answeredAt - y.answeredAt);
      if (!gotPages) { gotPages = true; done(); } else A.softRender();
    }, () => { gotPages = true; done(); }));
    readerUnsubs.push(onSnapshot(collection(fs, 'books', id, 'reactions'), (snap) => {
      const R = {}, mine = {};
      snap.docs.forEach(d => { const r = (d.data() || {}).r || {}; Object.keys(r).forEach(key => { (R[key] = R[key] || {})[d.id] = r[key]; if (d.id === me) mine[key] = r[key]; }); });
      db.reactions[pid] = R; readerSynced[pid] = canon(mine);
      if (!gotRx) { gotRx = true; done(); } else A.softRender();
    }, () => { gotRx = true; done(); }));
  });
}

/* ---------- auth ---------- */
export async function signIn() {
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'].indexOf(e.code) >= 0) { await signInWithRedirect(auth, p); return; }
    if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') A.toast('Sign-in failed: ' + (e.code || e.message));
  }
}
export async function signOut() { stopOwner(); stopReader(); await fbSignOut(auth); }
