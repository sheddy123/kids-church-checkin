/*
 * Storage for the register. Two interchangeable backends with the same shape
 * (collection / doc / where / onSnapshot / set / update / delete):
 *
 *   local  Everything stays on this phone, in IndexedDB.
 *   cloud  Firebase Firestore + email sign-in, so several phones share one
 *          live register. Used when js/config.js has a FIREBASE_CONFIG.
 *
 * Use:  const be = await Backend.connect();
 *       be.mode  -> 'local' | 'cloud'
 *       be.db    -> the database
 *       be.user  -> { id, name }            (local only)
 *       be.auth  -> { onChange, signIn, signOut, reset }   (cloud only)
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Local backend                                                       */
  /* ------------------------------------------------------------------ */
  var DB_NAME = 'kidsCheckin';
  var META = Object.freeze({ fromCache: false, hasPendingWrites: false });

  function openIDB() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('docs'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function readAll(idb) {
    return new Promise(function (res, rej) {
      var out = new Map();
      var req = idb.transaction('docs').objectStore('docs').openCursor();
      req.onsuccess = function () { var c = req.result; if (c) { out.set(c.key, c.value); c.continue(); } else res(out); };
      req.onerror = function () { rej(req.error); };
    });
  }

  async function localBackend() {
    var idb = await openIDB();
    var store = await readAll(idb);
    var listeners = new Set();
    var chan = null;
    try { chan = new BroadcastChannel(DB_NAME); } catch (e) {}
    var pending = false;

    function notify() {
      if (pending) return; pending = true;
      setTimeout(function () { pending = false; listeners.forEach(function (fn) { fn(); }); }, 0);
    }
    if (chan) chan.onmessage = function (e) {
      var m = e.data || {};
      if (m.clear) store.clear();
      else if (m.val === null) store.delete(m.path);
      else if (m.path) store.set(m.path, m.val);
      notify();
    };
    function persist(path, val) {
      return new Promise(function (res, rej) {
        var tx = idb.transaction('docs', 'readwrite');
        if (val === null) tx.objectStore('docs').delete(path); else tx.objectStore('docs').put(val, path);
        tx.oncomplete = function () { res(); };
        tx.onerror = tx.onabort = function () { rej({ code: 'unavailable', message: String(tx.error) }); };
      });
    }
    function put(path, val) {
      if (val === null) store.delete(path); else store.set(path, val);
      if (chan) { try { chan.postMessage({ path: path, val: val }); } catch (e) {} }
      notify();
      return persist(path, val);
    }

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function genId() { var a = new Uint8Array(14); crypto.getRandomValues(a); return Array.from(a, function (b) { return (b % 36).toString(36); }).join(''); }
    function segs(p) { return String(p).split('/').filter(Boolean); }
    function snapDoc(path) {
      var d = store.get(path);
      var copy = d ? clone(d) : undefined;
      return { id: segs(path).pop(), exists: !!d, data: function () { return copy; }, metadata: META };
    }
    function cmp(x, op, v) {
      switch (op) {
        case '==': return x === v;
        case '!=': return x !== v;
        case '<': return x < v;
        case '<=': return x <= v;
        case '>': return x > v;
        case '>=': return x >= v;
        default: return false;
      }
    }
    // onSnapshot accepts (next), (next, error) or (options, next, error) like Firestore.
    function pickNext(a, b) { return typeof a === 'function' ? a : b; }

    function makeQuery(col, filters, lim) {
      function run() {
        var prefix = col + '/';
        var docs = [];
        store.forEach(function (_v, p) {
          if (p.indexOf(prefix) === 0 && p.indexOf('/', prefix.length) === -1) docs.push(p);
        });
        docs = docs.sort().map(snapDoc);
        filters.forEach(function (f) { docs = docs.filter(function (d) { return cmp(d.data()[f[0]], f[1], f[2]); }); });
        if (lim) docs = docs.slice(0, lim);
        return { docs: docs, size: docs.length, empty: !docs.length, metadata: META };
      }
      return {
        where: function (f, op, v) { return makeQuery(col, filters.concat([[f, op, v]]), lim); },
        limit: function (n) { return makeQuery(col, filters, n); },
        get: function () { return Promise.resolve(run()); },
        onSnapshot: function (a, b) {
          var next = pickNext(a, b), alive = true;
          var fn = function () { if (alive) next(run()); };
          listeners.add(fn); setTimeout(fn, 0);
          return function () { alive = false; listeners.delete(fn); };
        }
      };
    }
    function docRef(path) {
      if (segs(path).length % 2 !== 0) throw new TypeError('Bad document path: ' + path);
      return {
        id: segs(path).pop(), path: path,
        get: function () { return Promise.resolve(snapDoc(path)); },
        set: function (data) { return put(path, clone(data)); },
        update: function (data) {
          if (!store.has(path)) return Promise.reject({ code: 'not-found', message: 'No such record' });
          return put(path, Object.assign({}, store.get(path), clone(data)));
        },
        delete: function () { return put(path, null); },
        onSnapshot: function (a, b) {
          var next = pickNext(a, b), alive = true;
          var fn = function () { if (alive) next(snapDoc(path)); };
          listeners.add(fn); setTimeout(fn, 0);
          return function () { alive = false; listeners.delete(fn); };
        }
      };
    }
    function colRef(col) {
      if (segs(col).length % 2 !== 1) throw new TypeError('Bad collection path: ' + col);
      return Object.assign(makeQuery(col, [], 0), { path: col, doc: function (id) { return docRef(col + '/' + (id || genId())); } });
    }

    var name = '';
    try { name = localStorage.getItem('kc.volunteer') || ''; } catch (e) {}
    return {
      mode: 'local',
      db: { doc: docRef, collection: colRef },
      user: { id: 'this-phone', name: name },
      // Handy in the browser console and used by the tests.
      debug: {
        dump: function () { return Object.fromEntries(store); },
        wipe: function () {
          return new Promise(function (res) {
            store.clear();
            if (chan) { try { chan.postMessage({ clear: true }); } catch (e) {} }
            var tx = idb.transaction('docs', 'readwrite'); tx.objectStore('docs').clear();
            tx.oncomplete = function () { notify(); res(); };
          });
        }
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Cloud backend (Firebase)                                            */
  /* ------------------------------------------------------------------ */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  async function cloudBackend(cfg) {
    await loadScript('vendor/firebase-app-compat.js');
    await loadScript('vendor/firebase-auth-compat.js');
    await loadScript('vendor/firebase-firestore-compat.js');
    var fb = window.firebase;
    var emu = cfg.emulator; // { firestore: 'host:port', auth: 'http://host:port' } for local testing only
    var clean = Object.assign({}, cfg); delete clean.emulator;
    fb.initializeApp(clean);
    var auth = fb.auth(), fs = fb.firestore();
    if (emu) {
      var hp = String(emu.firestore || '127.0.0.1:8080').split(':');
      fs.useEmulator(hp[0], +hp[1]);
      auth.useEmulator(emu.auth || 'http://127.0.0.1:9099', { disableWarnings: true });
    }
    // Keep a copy on the phone so the register still opens with no signal.
    try { await fs.enablePersistence({ synchronizeTabs: true }); } catch (e) {}
    return {
      mode: 'cloud',
      db: fs,
      auth: {
        onChange: function (cb) {
          return auth.onAuthStateChanged(function (u) {
            cb(u ? { id: u.uid, name: u.displayName || String(u.email || '').split('@')[0], email: u.email || '' } : null);
          });
        },
        signIn: function (email, password) { return auth.signInWithEmailAndPassword(email, password); },
        signOut: function () { return auth.signOut(); },
        reset: function (email) { return auth.sendPasswordResetEmail(email); },
        setName: function (name) { return auth.currentUser ? auth.currentUser.updateProfile({ displayName: name }) : Promise.resolve(); }
      }
    };
  }

  window.Backend = {
    connect: function () {
      var cfg = window.FIREBASE_CONFIG;
      return (cfg && cfg.projectId) ? cloudBackend(cfg) : localBackend();
    }
  };
})();
