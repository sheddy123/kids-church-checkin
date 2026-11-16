/*
 * Local stand-in for the Claude artifact runtime (window.claude).
 *
 * On claude.ai the page gets a shared, live database via claude.use("db")
 * and the viewer's identity via claude.use("user"). Neither exists on your
 * machine, so this file fakes both:
 *   - data is kept in this browser's localStorage (survives reloads)
 *   - open two tabs to act as two volunteers: changes sync between them
 *
 * URL options (add to the address, e.g. http://localhost:5173/?as=viewer#pickup):
 *   ?as=owner      default: can read and write
 *   ?as=viewer     read-only volunteer: writes are refused
 *   ?as=signedout  no database at all (shows the sign-in screen)
 *   ?reset         wipe the local test data first
 *
 * dev/server.js injects this script into index.html. Never ship it.
 */
(function () {
  'use strict';
  var KEY = 'kidsCheckinDevDB';
  var params = new URLSearchParams(location.search);
  var role = params.get('as') || 'owner';
  if (params.has('reset')) { try { localStorage.removeItem(KEY); } catch (e) {} }

  var store = load();
  var listeners = new Set();
  var META = Object.freeze({ fromCache: false, hasPendingWrites: false });
  var LATENCY = 40; // ms, roughly like a real network

  function load() {
    try { return new Map(Object.entries(JSON.parse(localStorage.getItem(KEY) || '{}'))); }
    catch (e) { return new Map(); }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(store))); } catch (e) {} }
  function notify() { setTimeout(function () { listeners.forEach(function (fn) { fn(); }); }, 5); }
  window.addEventListener('storage', function (e) { if (e.key === KEY) { store = load(); notify(); } });

  function delay(v) { return new Promise(function (r) { setTimeout(function () { r(v); }, LATENCY); }); }
  function fail(code, message) { return Promise.reject({ code: code, message: message }); }
  function canWrite() { return role === 'owner' || role === 'editor'; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function genId() { var a = new Uint8Array(10); crypto.getRandomValues(a); return Array.from(a, function (b) { return (b % 36).toString(36); }).join(''); }
  function segs(p) { return p.split('/').filter(Boolean); }
  function checkDocPath(p) { if (segs(p).length % 2 !== 0) throw new TypeError('Document path needs an even number of segments: ' + p); }
  function checkColPath(p) { if (segs(p).length % 2 !== 1) throw new TypeError('Collection path needs an odd number of segments: ' + p); }

  function snapDoc(path) {
    var d = store.get(path);
    var frozen = d ? Object.freeze(clone(d)) : undefined;
    return { id: segs(path).pop(), exists: !!d, data: function () { return frozen; }, metadata: META };
  }
  function cmp(x, op, v) {
    switch (op) {
      case '==': return x === v;
      case '!=': return x !== v;
      case '<': return x < v;
      case '<=': return x <= v;
      case '>': return x > v;
      case '>=': return x >= v;
      case 'in': return Array.isArray(v) && v.indexOf(x) !== -1;
      case 'not-in': return Array.isArray(v) && v.indexOf(x) === -1;
      case 'array-contains': return Array.isArray(x) && x.indexOf(v) !== -1;
      default: return false;
    }
  }

  function makeQuery(col, filters, order, lim) {
    function run() {
      var docs = Array.from(store.keys())
        .filter(function (p) { var s = segs(p); return s.slice(0, -1).join('/') === col; })
        .sort()
        .map(snapDoc);
      filters.forEach(function (f) { docs = docs.filter(function (d) { return cmp(d.data()[f[0]], f[1], f[2]); }); });
      if (order) {
        var dir = order[1] === 'desc' ? -1 : 1;
        docs.sort(function (a, b) { var x = a.data()[order[0]], y = b.data()[order[0]]; return (x === y ? 0 : x > y ? 1 : -1) * dir; });
      }
      if (lim) docs = docs.slice(0, lim);
      return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return []; }, metadata: META };
    }
    return {
      where: function (f, op, v) { return makeQuery(col, filters.concat([[f, op, v]]), order, lim); },
      orderBy: function (f, dir) { return makeQuery(col, filters, [f, dir || 'asc'], lim); },
      limit: function (n) { return makeQuery(col, filters, order, n); },
      get: function () { return delay(run()); },
      onSnapshot: function (next) {
        var alive = true;
        var fn = function () { if (alive) next(run()); };
        listeners.add(fn); setTimeout(fn, LATENCY);
        return function () { alive = false; listeners.delete(fn); };
      }
    };
  }

  function docRef(path) {
    checkDocPath(path);
    return {
      id: segs(path).pop(), path: path,
      get: function () { return delay(snapDoc(path)); },
      set: function (data) {
        if (!canWrite()) return fail('invalid_argument', 'write not allowed (dev role: ' + role + ')');
        store.set(path, clone(data)); save(); notify(); return delay();
      },
      update: function (data) {
        if (!canWrite()) return fail('invalid_argument', 'write not allowed (dev role: ' + role + ')');
        if (!store.has(path)) return fail('invalid_argument', 'update needs an existing document');
        store.set(path, Object.assign({}, store.get(path), clone(data))); save(); notify(); return delay();
      },
      delete: function () {
        if (!canWrite()) return fail('invalid_argument', 'write not allowed (dev role: ' + role + ')');
        store.delete(path); save(); notify(); return delay();
      },
      acquire: function () { return delay({ acquired: true, version: 1 }); },
      onSnapshot: function (next) {
        var alive = true;
        var fn = function () { if (alive) next(snapDoc(path)); };
        listeners.add(fn); setTimeout(fn, LATENCY);
        return function () { alive = false; listeners.delete(fn); };
      },
      collection: function (c) { return colRef(path + '/' + c); }
    };
  }
  function colRef(col) {
    checkColPath(col);
    var q = makeQuery(col, [], null, 0);
    return Object.assign({}, q, {
      path: col,
      doc: function (id) { return docRef(col + '/' + (id || genId())); },
      add: function (d) { var r = docRef(col + '/' + genId()); return r.set(d).then(function () { return r; }); }
    });
  }

  var db = { doc: docRef, collection: colRef };
  var me = 'dev-' + role;
  var user = {
    id: function () { return Promise.resolve(me); },
    me: function () { return Promise.resolve({ id: me, name: 'Dev volunteer' }); },
    isOwner: function () { return role === 'owner'; },
    canEdit: function () { return canWrite(); },
    can: function (name) { return Promise.resolve(name === 'data.write' ? canWrite() : null); },
    profiles: function (ids) {
      var out = {}; ids.forEach(function (i) { out[i] = { name: i.indexOf('dev-') === 0 ? 'Dev volunteer' : '' }; });
      return Promise.resolve(out);
    }
  };

  window.__devDB = { reset: function () { store = new Map(); save(); notify(); }, dump: function () { return Object.fromEntries(store); } };
  window.claude = {
    use: function (name) {
      if (role === 'signedout') return Promise.resolve(null);
      return delay(name === 'db' ? db : name === 'user' ? user : null);
    }
  };
  console.info('[dev] Using local mock database as "' + role + '". window.__devDB.dump() shows the data.');
})();
