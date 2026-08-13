/* Obsidian Bases, read at build time.
 *
 * A `.base` file is YAML: `filters`, `formulas`, `properties`, `views`. The
 * views name columns and a sort; the filters and formulas are written in a
 * small expression language. Both are handled here — a subset of the language,
 * chosen to cover what a `.base` in this vault plausibly says, and anything
 * outside it is reported rather than silently dropped.
 *
 * Supported in expressions
 *   literals            12  3.4  'text'  "text"  true  false  null  [a, b]
 *   properties          status   note.author   file.name   formula.ppu
 *   operators           ! && || == != > >= < <= + - * / %
 *   file methods        hasTag  hasLink  inFolder  hasProperty
 *   value methods       contains  isEmpty  startsWith  endsWith
 *                       toLowerCase  toUpperCase  length  trim
 *   functions           if  number  min  max  round  list  date  link
 *
 * Not supported: anything else, including the whole of `date()` arithmetic
 * beyond comparison, and `file.mtime`-style filesystem lookups.
 */

/* ------------------------------------------------------------------- YAML */
/* Indentation-based, enough for a .base: nested maps, sequences, scalars,
   inline flow lists, quoted strings. No anchors, tags or block scalars. */
export function yaml(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
    .map((l, i) => ({ i: i + 1, raw: l }))
    .filter(l => l.raw.trim() !== '' && !/^\s*#/.test(l.raw));
  let at = 0;
  const indent = l => l.raw.match(/^ */)[0].length;

  function scalar(s) {
    const t = String(s).trim();
    if (t === '') return '';
    if (/^(?:'.*'|".*")$/s.test(t)) return t.slice(1, -1).replace(/\\"/g, '"');
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === '~') return null;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d*\.\d+$/.test(t)) return Number(t);
    if (/^\[.*\]$/s.test(t)) {
      const inner = t.slice(1, -1).trim();
      if (!inner) return [];
      return splitTop(inner).map(scalar);
    }
    if (/^\{.*\}$/s.test(t)) {
      const o = {};
      for (const part of splitTop(t.slice(1, -1))) {
        const k = part.indexOf(':');
        if (k < 0) continue;
        o[scalar(part.slice(0, k))] = scalar(part.slice(k + 1));
      }
      return o;
    }
    return t;
  }

  /* split on commas that aren't inside quotes, brackets or parentheses */
  function splitTop(s) {
    const out = []; let cur = '', d = 0, q = null;
    for (const ch of String(s)) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if ('[{('.includes(ch)) d++;
      if (']})'.includes(ch)) d--;
      if (ch === ',' && d === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(x => x.trim());
  }

  function block(level) {
    /* a sequence, if the first line at this level is a dash */
    if (at < lines.length && indent(lines[at]) === level && /^-\s|^-$/.test(lines[at].raw.trim())) {
      const seq = [];
      while (at < lines.length && indent(lines[at]) === level && /^-(\s|$)/.test(lines[at].raw.trim())) {
        const rest = lines[at].raw.trim().replace(/^-\s*/, '');
        at++;
        if (rest === '') { seq.push(block(level + 1)); continue; }
        /* `- key: value` starts a map whose first key sits on the dash */
        const kv = rest.match(/^([\w.$-]+):\s*(.*)$/);
        if (kv) {
          const item = {};
          const inner = level + 2;
          item[kv[1]] = kv[2].trim() === '' ? block(deeper(inner)) : scalar(kv[2]);
          while (at < lines.length && indent(lines[at]) >= inner) {
            const sub = map(indent(lines[at]));
            Object.assign(item, sub);
            break;
          }
          seq.push(item);
          continue;
        }
        seq.push(scalar(rest));
      }
      return seq;
    }
    return map(level);
  }

  function deeper(from) {
    return at < lines.length ? Math.max(from, indent(lines[at])) : from;
  }

  function map(level) {
    const obj = {};
    while (at < lines.length) {
      const l = lines[at];
      const ind = indent(l);
      if (ind < level) break;
      if (ind > level) { at++; continue; }              /* stray, skip */
      const t = l.raw.trim();
      if (/^-(\s|$)/.test(t)) break;
      const kv = t.match(/^([^:]+):\s*(.*)$/);
      if (!kv) { at++; continue; }
      const k = kv[1].trim().replace(/^["'](.*)["']$/, '$1');
      const v = kv[2].trim();
      at++;
      if (v === '') {
        const next = at < lines.length ? indent(lines[at]) : level;
        obj[k] = next > level ? block(next) : '';
      } else {
        obj[k] = scalar(v);
      }
    }
    return obj;
  }

  return lines.length ? block(indent(lines[0])) : {};
}

/* ------------------------------------------------------- the little language */
const PUNCT = ['&&', '||', '==', '!=', '>=', '<=', '>', '<', '+', '-', '*', '/', '%',
  '(', ')', '[', ']', ',', '.', '!'];

function lex(src) {
  const out = []; let i = 0;
  const s = String(src);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, v = '';
      while (j < s.length && s[j] !== c) { if (s[j] === '\\') { v += s[j + 1]; j += 2; continue; } v += s[j++]; }
      out.push({ t: 'str', v }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
      out.push({ t: 'num', v: Number(s.slice(i, j)) }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < s.length && /[A-Za-z0-9_$-]/.test(s[j])) j++;
      out.push({ t: 'name', v: s.slice(i, j) }); i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (PUNCT.includes(two)) { out.push({ t: two }); i += 2; continue; }
    if (PUNCT.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`can't read "${c}" in ${JSON.stringify(src)}`);
  }
  out.push({ t: 'end' });
  return out;
}

const BINDS = { '||': 1, '&&': 2, '==': 3, '!=': 3, '>': 4, '>=': 4, '<': 4, '<=': 4,
  '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

function parse(src) {
  const ts = lex(src); let p = 0;
  const peek = () => ts[p];
  const take = t => { if (ts[p].t !== t) throw new Error(`expected ${t}, found ${ts[p].t}`); return ts[p++]; };

  function primary() {
    const tk = ts[p];
    if (tk.t === 'num' || tk.t === 'str') { p++; return { k: tk.t, v: tk.v }; }
    if (tk.t === '!') { p++; return { k: 'not', a: unary() }; }
    if (tk.t === '-') { p++; return { k: 'neg', a: unary() }; }
    if (tk.t === '(') { p++; const e = expr(0); take(')'); return e; }
    if (tk.t === '[') {
      p++; const items = [];
      while (peek().t !== ']') { items.push(expr(0)); if (peek().t === ',') p++; }
      take(']'); return { k: 'list', items };
    }
    if (tk.t === 'name') {
      p++;
      if (tk.v === 'true') return { k: 'lit', v: true };
      if (tk.v === 'false') return { k: 'lit', v: false };
      if (tk.v === 'null') return { k: 'lit', v: null };
      let node = { k: 'ref', path: [tk.v] };
      if (peek().t === '(') node = { k: 'call', name: tk.v, args: args() };
      return node;
    }
    throw new Error(`unexpected ${tk.t}`);
  }
  function args() {
    take('(');
    const a = [];
    while (peek().t !== ')') { a.push(expr(0)); if (peek().t === ',') p++; }
    take(')');
    return a;
  }
  function unary() {
    let node = primary();
    for (;;) {
      if (peek().t !== '.') break;
      p++;
      const nm = take('name').v;
      if (peek().t === '(') node = { k: 'method', on: node, name: nm, args: args() };
      else if (node.k === 'ref') node = { k: 'ref', path: node.path.concat(nm) };
      else node = { k: 'field', on: node, name: nm };
    }
    return node;
  }
  function expr(min) {
    let left = unary();
    for (;;) {
      const t = peek().t;
      const b = BINDS[t];
      if (!b || b < min) return left;
      p++;
      const right = expr(b + 1);
      left = { k: 'bin', op: t, a: left, b: right };
    }
  }
  const tree = expr(0);
  if (peek().t !== 'end') throw new Error(`trailing ${peek().t}`);
  return tree;
}

/* ------------------------------------------------------------- evaluation */
const truthy = v => !(v === null || v === undefined || v === false || v === '' ||
  (Array.isArray(v) && !v.length) || (typeof v === 'number' && Number.isNaN(v)));
const asList = v => Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v]);
const lower = v => String(v ?? '').toLowerCase();

function cmp(a, b) {
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

function evaluate(node, env) {
  const ev = n => evaluate(n, env);
  switch (node.k) {
    case 'num': case 'str': case 'lit': return node.v;
    case 'list': return node.items.map(ev);
    case 'not': return !truthy(ev(node.a));
    case 'neg': return -Number(ev(node.a));
    case 'ref': return env.lookup(node.path);
    case 'field': return field(ev(node.on), node.name);
    case 'bin': {
      const { op } = node;
      if (op === '&&') return truthy(ev(node.a)) && truthy(ev(node.b));
      if (op === '||') return truthy(ev(node.a)) ? ev(node.a) : ev(node.b);
      const a = ev(node.a), b = ev(node.b);
      switch (op) {
        case '==': return same(a, b);
        case '!=': return !same(a, b);
        case '>': return cmp(a, b) > 0;
        case '>=': return cmp(a, b) >= 0;
        case '<': return cmp(a, b) < 0;
        case '<=': return cmp(a, b) <= 0;
        case '+': return (typeof a === 'number' && typeof b === 'number')
          ? a + b : `${a ?? ''}${b ?? ''}`;
        case '-': return Number(a) - Number(b);
        case '*': return Number(a) * Number(b);
        case '/': return Number(b) === 0 ? null : Number(a) / Number(b);
        case '%': return Number(a) % Number(b);
        default: throw new Error(`no operator ${op}`);
      }
    }
    case 'call': return fn(node.name, node.args.map(ev), env);
    case 'method': {
      const on = node.on.k === 'ref' && node.on.path.length === 1 && node.on.path[0] === 'file'
        ? ' file' : ev(node.on);
      return method(on, node.name, node.args.map(ev), env);
    }
    default: throw new Error(`no node ${node.k}`);
  }
}

const same = (a, b) => Array.isArray(a) || Array.isArray(b)
  ? asList(a).some(x => asList(b).some(y => lower(x) === lower(y)))
  : (a === null || a === undefined ? (b === null || b === undefined || b === '')
    : lower(a) === lower(b));

function field(v, name) {
  if (name === 'length') return Array.isArray(v) ? v.length : String(v ?? '').length;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v[name];
  return null;
}

function fn(name, a, env) {
  switch (name) {
    case 'if': return truthy(a[0]) ? a[1] : (a.length > 2 ? a[2] : null);
    case 'number': { const n = Number(a[0]); return Number.isNaN(n) ? null : n; }
    case 'min': return Math.min(...a.flat().map(Number));
    case 'max': return Math.max(...a.flat().map(Number));
    case 'round': return Math.round(Number(a[0]) * 10 ** (a[1] || 0)) / 10 ** (a[1] || 0);
    case 'list': return a.flat();
    case 'date': return String(a[0] ?? '').slice(0, 10);
    case 'link': return { link: String(a[0] ?? ''), label: a[1] ? String(a[1]) : '' };
    case 'join': return a[0] === undefined ? '' : asList(a[0]).join(a[1] ?? ', ');
    default: throw new Error(`no function ${name}()`);
  }
}

function method(on, name, a, env) {
  if (on === ' file') {
    switch (name) {
      case 'hasTag': return a.flat().some(t => env.tags.has(String(t).replace(/^#/, '')));
      case 'hasLink': return a.flat().some(t => env.links.has(env.key(String(t))));
      case 'inFolder': return a.flat().some(f => env.folder === String(f) ||
        env.folder.startsWith(`${String(f)}/`));
      case 'hasProperty': return a.flat().some(k => env.has(String(k)));
      default: throw new Error(`no file.${name}()`);
    }
  }
  switch (name) {
    case 'isEmpty': return !truthy(on);
    case 'contains': return a.flat().some(x => Array.isArray(on)
      ? on.some(y => lower(y) === lower(x)) : lower(on).includes(lower(x)));
    case 'startsWith': return lower(on).startsWith(lower(a[0]));
    case 'endsWith': return lower(on).endsWith(lower(a[0]));
    case 'toLowerCase': return String(on ?? '').toLowerCase();
    case 'toUpperCase': return String(on ?? '').toUpperCase();
    case 'trim': return String(on ?? '').trim();
    case 'length': return Array.isArray(on) ? on.length : String(on ?? '').length;
    case 'join': return asList(on).join(a[0] ?? ', ');
    default: throw new Error(`no .${name}()`);
  }
}

/* ------------------------------------------------------------------- rows */
const CACHE = new Map();
function compile(src, warn) {
  const s = String(src);
  if (!CACHE.has(s)) {
    try { CACHE.set(s, parse(s)); }
    catch (e) { warn(`${e.message} — in \`${s}\``); CACHE.set(s, null); }
  }
  return CACHE.get(s);
}

/* `filters` is a tree of and / or / not with expression strings at the leaves */
function keep(filter, env, warn) {
  if (filter === undefined || filter === null || filter === '') return true;
  if (Array.isArray(filter)) return filter.every(f => keep(f, env, warn));
  if (typeof filter === 'object') {
    if ('and' in filter) return keep(filter.and, env, warn);
    if ('or' in filter) return asArray(filter.or).some(f => keep(f, env, warn));
    if ('not' in filter) return !keep(filter.not, env, warn);
    return Object.values(filter).every(f => keep(f, env, warn));
  }
  const tree = compile(filter, warn);
  if (!tree) return true;                    /* a filter we can't read excludes nothing */
  try { return truthy(evaluate(tree, env)); }
  catch (e) { warn(`${e.message} — in \`${filter}\``); return true; }
}
const asArray = v => Array.isArray(v) ? v : [v];

/* Build the environment one note sees. */
function envFor(note, base, warn) {
  const props = note.props || {};
  const formulas = base.formulas || {};
  const done = new Map();
  const env = {
    folder: note.folder || '',
    tags: new Set(note.tags || []),
    links: new Set(note.links || []),
    key: s => String(s).replace(/^\[\[|\]\]$/g, '').trim().toLowerCase(),
    has: k => props[k] !== undefined && props[k] !== '',
    lookup(path) {
      const [head, ...rest] = path;
      if (head === 'file') {
        const f = { name: note.name, basename: note.basename ?? note.name,
          path: note.path, folder: note.folder, ext: note.ext,
          links: [...(note.links || [])], tags: [...(note.tags || [])] };
        return rest.length ? rest.reduce((v, k) => (v == null ? v : field(v, k) ?? v?.[k]), f) : f;
      }
      if (head === 'formula') {
        const nm = rest.join('.');
        if (done.has(nm)) return done.get(nm);
        done.set(nm, null);                                /* a formula cycle yields null */
        const tree = formulas[nm] === undefined ? null : compile(formulas[nm], warn);
        let v = null;
        if (tree) { try { v = evaluate(tree, env); } catch (e) { warn(`${e.message} — in formula \`${nm}\``); } }
        done.set(nm, v);
        return v;
      }
      const name = head === 'note' ? rest.join('.') : path.join('.');
      if (props[name] !== undefined) return props[name];
      if (name === 'name' || name === 'title') return note.name;
      return null;
    },
  };
  return env;
}

/* A `.base` and a set of notes in; the views, with their rows, out. */
export function runBase(text, notes, { warn = () => {} } = {}) {
  const base = yaml(text) || {};
  const views = asArray(base.views || []).filter(v => v && typeof v === 'object');
  if (!views.length) views.push({ type: 'table', name: 'Table' });

  const labels = {};
  const sizes = {};
  for (const [k, v] of Object.entries(base.properties || {})) {
    labels[k] = (v && v.displayName) || k.replace(/^(?:note|file|formula)\./, '');
  }

  const rows = notes.map(n => ({ note: n, env: envFor(n, base, warn) }));
  const wide = rows.filter(r => keep(base.filters, r.env, warn));

  return {
    base,
    views: views.map(v => {
      let mine = wide.filter(r => keep(v.filters, r.env, warn));
      const order = asArray(v.order || []).filter(Boolean).map(String);
      const sort = asArray(v.sort || []).filter(s => s && (s.property || typeof s === 'string'));
      if (sort.length) {
        mine = mine.slice().sort((a, b) => {
          for (const s of sort) {
            const key = String(s.property || s);
            const dir = /desc/i.test(String(s.direction || 'ASC')) ? -1 : 1;
            const c = cmp(read(a.env, key), read(b.env, key));
            if (c) return c * dir;
          }
          return 0;
        });
      }
      const limit = Number(v.limit) || 0;
      if (limit > 0) mine = mine.slice(0, limit);
      const cols = order.length ? order : ['file.name'];
      return {
        type: String(v.type || 'table').toLowerCase(),
        name: v.name || '',
        columns: cols.map(c => ({ key: c, label: labels[c] || tidy(c), size: sizes[c] })),
        image: v.image ? String(v.image) : '',
        rows: mine.map(r => ({
          note: r.note,
          cells: cols.map(c => read(r.env, c)),
          value: k => read(r.env, k),
        })),
      };
    }),
  };
}

const tidy = c => {
  const s = String(c).replace(/^(?:note|file|formula)\./, '').replace(/[-_]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function read(env, key) {
  try { return env.lookup(String(key).split('.')); }
  catch { return null; }
}
export { tidy as columnLabel };
