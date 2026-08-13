/* vaultsite — turn an Obsidian vault into a website.
 *
 *     import { build } from 'vaultsite'
 *     build({ vault: '…/Habitability', out: '…/public' })
 *
 * Every word on the page comes from the vault. What a vault contains is the
 * vault's own business: the section notes in its `pages/` folder say which
 * folders are collections, where they land on the site, and how each is drawn.
 * The engine knows about Obsidian — wikilinks, tags, canvases, bases, callouts,
 * transclusion — and nothing about any particular project.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from '../vendor/marked.esm.js';
import katex from '../vendor/katex.mjs';
import { runBase } from './bases.mjs';

/* the engine's own folder, for templates, assets and vendored code */
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let VAULT = '';
let OUT = '';
/* A project may keep its own look in a `theme/` folder beside the vault. Any
   file there of the same name wins over the engine's: the stylesheet, the
   social card, the favicon, the landform. */
let THEME = '';

/* Obsidian's own file types work the same in every vault, so the engine knows
   these without being told. Everything else, the vault declares. */
const EXTRA = {
  canvas: { ext: '.canvas', dir: 'maps',  label: 'Canvas' },
  base:   { ext: '.base',   dir: 'bases', label: 'Base' },
};

/* Built from the vault's section notes when the build starts. */
let KINDS = {};
const LABEL = k => ((KINDS[k] || EXTRA[k] || {}).label || 'Note');

/* ------------------------------------------------------------------- vault */
/* Folders that are never part of a vault, wherever they turn up. A project that
   keeps its vault at the repo root would otherwise hand the build every markdown
   file in its dependencies. */
const NOT_VAULT = new Set(['node_modules', 'public', 'dist', 'build']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || NOT_VAULT.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/* Folders that never publish, whatever they hold. A leading underscore on a
   filename is the other way to keep something back. */
const OFF = ['00 Meta', '05 Notes', 'pages'];
function walkExt(ext) {
  const out = [];
  (function scan(dir, rel) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name.startsWith('_') || NOT_VAULT.has(e.name)) continue;
      const here = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!OFF.includes(here)) scan(path.join(dir, e.name), here); continue; }
      if (e.name.toLowerCase().endsWith(ext)) out.push({ file: path.join(dir, e.name), rel: here });
    }
  })(VAULT, '');
  return out;
}

/* A deliberately small YAML subset: scalars, one-line lists, and lists written
   down the page. That last form matters — Obsidian's property editor always
   writes a multi-value property as a block sequence:

       tags:
         - mood
         - planetarity

   so anything typed as `tags: [a, b]` turns into that the first time the
   property panel touches it. Reading only the one-line form meant those values
   vanished without a word. Nested maps are still ignored. */
function frontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  const unquote = s => String(s).trim().replace(/^["'](.*)["']$/, '$1');
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = unquote(kv[2]);
    if (v === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s+-\s*/.test(lines[i + 1]))
        items.push(unquote(lines[++i].replace(/^\s+-\s*/, '')));
      if (items.length) { data[kv[1]] = items.filter(Boolean); continue; }
    }
    if (v === 'true') v = true; else if (v === 'false') v = false;
    else if (/^\[.*\]$/.test(v))
      v = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
    data[kv[1]] = v;
  }
  return { data, body: raw.slice(m[0].length) };
}

function load(folder) {
  return walk(path.join(VAULT, folder)).map(file => {
    const { data, body } = frontmatter(fs.readFileSync(file, 'utf8'));
    return {
      file, body,
      title: path.basename(file, '.md'),
      rel: path.relative(VAULT, file).replace(/\.md$/, ''),
      folder: path.relative(path.join(VAULT, folder), path.dirname(file)),
      ...data,
    };
  }).filter(n => n.publish !== false);
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const unp = s => String(s ?? '').replace(/^\s*<p>([\s\S]*)<\/p>\s*$/, '$1').trim();
const strip = s => String(s ?? '').replace(/<[^>]+>/g, '').trim();

/* Markdown has regions where its own syntax stops applying, and Obsidian's
   additions should stop there too: a `[[link]]` or an `==em==` being shown as
   an example must survive being shown. `blocks` finds the literal lines —
   fenced code, and four-space code that isn't just a list carrying on — and
   hands the rest over in runs, so a callout spanning several lines stays whole.
   `spanSafe` does the same for `code` inside a line. */
function blocks(text, fn) {
  const lines = String(text).split('\n');
  const lit = new Array(lines.length).fill(false);
  let fence = null, list = false, shown = true;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const f = L.match(/^ {0,3}(```+|~~~+)[ \t]*([A-Za-z0-9_+-]*)/);
    if (fence) { lit[i] = shown; if (f && L.trim().startsWith(fence)) fence = null; continue; }
    /* a mermaid fence is a diagram, not code to be shown, so it stays in the run */
    if (f) { fence = f[1]; shown = f[2] !== 'mermaid'; lit[i] = shown; continue; }
    if (/^ {0,3}(?:[-*+]|\d+[.)])[ \t]/.test(L)) { list = true; continue; }
    if (!L.trim()) continue;
    if (/^(?: {4}|\t)/.test(L)) { lit[i] = !list; continue; }
    list = false;                                    /* back at the left margin */
  }
  const out = [];
  let run = [];
  const flush = () => { if (run.length) { out.push(fn(run.join('\n'))); run = []; } };
  for (let i = 0; i < lines.length; i++) {
    if (lit[i]) { flush(); out.push(lines[i]); } else run.push(lines[i]);
  }
  flush();
  return out.join('\n');
}
const spanSafe = (text, fn) =>
  String(text).split(/(`[^`\n]+`)/g).map((s, i) => (i % 2 ? s : fn(s))).join('');
function outsideCode(html, fn) {
  const rx = /(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g;
  return String(html).split(rx).map((s, i) => (i % 2 ? s : fn(s))).join('');
}

/* Custom fences, so a plain note can still produce the page's set pieces. */
function md(text) {
  let t = String(text || '');
  t = t.replace(/```ruled\r?\n([\s\S]*?)```/g, (_, block) => {
    const [head, ...items] = block.trim().split(/\r?\n/);
    const lis = items.filter(Boolean).map(l =>
      `<li><span>${marked.parseInline(l.replace(/^[-*]\s*/, ''))}</span></li>`).join('\n');
    return `<div class="ruled"><h4>${esc(head)}</h4><ul>\n${lis}\n</ul></div>`;
  });
  t = t.replace(/```button\r?\n([\s\S]*?)```/g, (_, block) => {
    const [label, href = '#'] = block.trim().split(/\r?\n/).map(x => x.trim());
    return `<p class="cta"><a class="button" href="${esc(href)}">` +
      `${marked.parseInline(label || '')}</a></p>`;
  });
  t = t.replace(/```standard\r?\n([\s\S]*?)```/g, (_, block) => {
    const [label, ...rest] = block.trim().split(/\r?\n/);
    return `<div class="standard"><span class="apparatus">${esc(label)}</span>` +
      `<strong>${marked.parseInline(rest.join(' '))}</strong></div>`;
  });
  return marked.parse(t);
}
const inline = t => marked.parseInline(marks(uncomment(String(t || ''))));

/* Filenames lead with a date so Obsidian sorts them; the page should not. */
const detitle = t => String(t).replace(/^\d{4}(?:-\d{2}){0,2}\s+/, '').trim();

const slug = s => String(s).toLowerCase()
  .replace(/[‘’“”]/g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* Headings need ids before [[Note#Heading]] can land on them. */
function anchors(html) {
  return html.replace(/<(h[2-6])>([\s\S]*?)<\/\1>/g, (m, tag, inner) => {
    const id = slug(strip(inner));
    return id ? `<${tag} id="${esc(id)}">${inner}</${tag}>` : m;
  });
}

/* Every file in the vault, by bare filename, so ![[image.jpg]] resolves. */
let MEDIA = new Map();
function indexMedia() {
  MEDIA = new Map();
  const rx = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
  (function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || NOT_VAULT.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (rx.test(e.name)) MEDIA.set(e.name, p);
    }
  })(VAULT);
}
const USED_MEDIA = new Set();

/* --------------------------------------------------------- the note registry
 * One place that knows every note in the vault, the page it has if it has one,
 * and which notes point at it. [[Wikilinks]] and backlinks both read from here.
 * `href` is the note's own page; `url` stays free for the frontmatter's use.
 */
let BY_KEY = new Map();       // slug of a name, path or alias -> note
let BY_HREF = new Map();      // href -> note
let LINKS = new Map();        // target href -> Set of source hrefs
let LINKS_OUT = new Map();    // source href -> Set of names it points at
const MISSING = new Set();
const OFFSTAGE = new Set();
const UNBUILT = new Map();      // an index page that has nothing to show yet

function key(note, k) {
  const s = slug(k);
  if (s && !BY_KEY.has(s)) BY_KEY.set(s, note);
}

function register(notes, offstage = []) {
  BY_KEY = new Map(); BY_HREF = new Map(); LINKS = new Map(); LINKS_OUT = new Map();
  MISSING.clear(); OFFSTAGE.clear(); UNBUILT.clear();
  /* Filenames win over paths and over derived names, as in Obsidian. */
  for (const n of notes) key(n, n.title);
  for (const n of offstage) key(n, n.title);
  for (const n of notes) { key(n, n.name); key(n, n.rel); key(n, `${n.title}.md`); }
  for (const n of offstage) { key(n, n.name); key(n, n.rel); key(n, `${n.title}.md`); }
  for (const n of notes) if (n.href) BY_HREF.set(n.href, n);
}

/* `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[#Heading]]`,
   `[[Note#^block]]`. */
function resolve(raw) {
  const [target, alias] = String(raw).split('|');
  const hash = target.indexOf('#');
  const name = (hash < 0 ? target : target.slice(0, hash)).trim();
  let frag = hash < 0 ? '' : target.slice(hash + 1).trim();
  if (frag.startsWith('^')) frag = '';            // block refs have no anchor
  const label = (alias || '').trim() ||
    (name ? (frag ? `${name} § ${frag}` : name) : frag);
  if (!name) return { self: true, frag: slug(frag), label };
  return { note: BY_KEY.get(slug(name)), frag: slug(frag), label, name };
}

const LINK_RX = /(?<!!)\[\[([^\[\]]+?)\]\]/g;

/* Walk every body once and record who points at whom, before any HTML runs,
   so a note's backlinks are known whatever order the pages are written in. */
function scanLinks(sources) {
  for (const { from, body } of sources) {
    for (const m of String(body || '').matchAll(LINK_RX)) {
      const r = resolve(m[1]);
      if (!r.note) continue;
      if (!LINKS_OUT.has(from)) LINKS_OUT.set(from, new Set());
      for (const t of [r.note.title, r.note.name, r.note.href, r.note.rel])
        if (t) LINKS_OUT.get(from).add(String(t).toLowerCase());
      if (!r.note.href || r.note.href === from) continue;
      if (!LINKS.has(r.note.href)) LINKS.set(r.note.href, new Set());
      LINKS.get(r.note.href).add(from);
    }
  }
}

const upto = d => (d ? '../'.repeat(d) : '');

/* Obsidian embeds and links, resolved before markdown runs. */
function wiki(text, { depth = 0 } = {}) {
  const up = upto(depth);
  return String(text || '')
    /* ![[file.jpg]], ![[file.jpg|A caption]], ![[file.jpg|400]],
       ![[file.jpg|A caption|400]] — any order, width is whichever part is a number */
    .replace(/!\[\[([^\]|]+?)((?:\|[^\]|]*)*)\]\]/g, (_, file, rest) => {
      const name = file.trim();
      if (!MEDIA.has(name)) { console.warn(`  ! missing embed: ${name}`); return ''; }
      USED_MEDIA.add(name);
      const parts = String(rest || '').split('|').map(x => x.trim()).filter(Boolean);
      const width = parts.find(x => /^\d+(?:x\d+)?$/.test(x));
      const caption = parts.filter(x => x !== width).join(' ');
      const w = width ? width.split('x')[0] : '';
      return `<figure class="figure"${w ? ` style="max-width:${w}px"` : ''}>` +
        `<img src="${up}assets/media/${encodeURIComponent(name)}"` +
        ` alt="${esc(caption)}" loading="lazy">` +
        (caption ? `<figcaption class="apparatus">${esc(caption)}</figcaption>` : '') + `</figure>`;
    })
    /* ordinary markdown, with a bare filename resolved from the vault */
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, src) => {
      const name = decodeURIComponent(src.split('/').pop());
      if (src.includes('://') || !MEDIA.has(name)) return whole;
      USED_MEDIA.add(name);
      return `<figure class="figure"><img src="${up}assets/media/${encodeURIComponent(name)}"` +
        ` alt="${esc(alt)}" loading="lazy">` +
        (alt ? `<figcaption class="apparatus">${esc(alt)}</figcaption>` : '') + `</figure>`;
    })
    .replace(LINK_RX, (_, body) => {
      const r = resolve(body);
      if (r.self) return `[${r.label}](#${r.frag})`;
      if (r.note && r.note.href) return `[${r.label}](${up}${r.note.href}${r.frag ? `#${r.frag}` : ''})`;
      /* exists but doesn't publish, or isn't there at all: the words remain */
      if (r.note && r.note.why) UNBUILT.set(r.name, r.note.why);
      else (r.note ? OFFSTAGE : MISSING).add(r.name);
      return r.label;
    });
}

/* A blockquote whose last line begins with an em dash becomes a pull quote. */
function pullquotes(html) {
  return html.replace(/<blockquote>\s*([\s\S]*?)\s*<\/blockquote>/g, (_, inner) => {
    const m = inner.match(/^([\s\S]*?)<p>\s*(?:—|--)\s*([\s\S]*?)<\/p>\s*$/);
    const bare = s => s.replace(/^\s*<p>|<\/p>\s*$/g, '');
    return m
      ? `<blockquote class="pull">${bare(m[1])}<span class="who apparatus">${m[2]}</span></blockquote>`
      : `<blockquote class="pull">${bare(inner)}</blockquote>`;
  });
}

/* Split a note body into { intro, sections } on `## ` headings. */
function movements(body) {
  const parts = String(body || '').split(/^##\s+(.+)$/m);
  const out = { intro: parts[0] || '', named: [] };
  for (let i = 1; i < parts.length; i += 2) out.named.push([parts[i].trim(), parts[i + 1] || '']);
  return out;
}

/* ------------------------------------------------------- the syntax Obsidian
 * adds to markdown. Comments come out, callouts and transclusions are lifted
 * into placeholders so nothing downstream mistakes them for quotations, and
 * footnotes are numbered at the very end, in the order a reader meets them.
 */
let ASIDE_SEQ = 0;              // for ^[inline footnotes], which have no name

/* `stack` is what stops an embed chain eating itself. It is carried across
   every hop, including down into a canvas and back out through the notes its
   file cards render, since a canvas card can point at the very note that
   embedded the canvas. */
const newCtx = (depth = 0, ns = '', file = '', stack = []) =>
  ({ depth, ns, slots: [], notes: new Map(),
     stack: file ? [...stack, file] : [...stack] });

const HOLD = i => `␂H${i}␃`;
const hold = (ctx, html) => { ctx.slots.push(html); return `\n\n${HOLD(ctx.slots.length - 1)}\n\n`; };
function unhold(html, ctx) {
  let out = String(html), n = 0;
  while (/␂H\d+␃/.test(out) && n++ < 32) {
    /* A block that came back from markdown wrapped in a paragraph loses the
       wrapper first; only then is anything left over substituted bare. Doing
       both in one pass would leave <p> around a nested block. */
    const before = out;
    out = out.replace(/<p>\s*␂H(\d+)␃\s*<\/p>/g, (_, i) => ctx.slots[i]);
    if (out !== before) continue;
    out = out.replace(/␂H(\d+)␃/g, (_, i) => ctx.slots[i]);
  }
  return out;
}

const uncomment = t => String(t).replace(/%%[\s\S]*?%%/g, '');

/* What a page turned out to need. Read after the page is rendered, so only
   the pages carrying a diagram ever ask a reader to download the renderer. */
const USES = { mermaid: false, math: false, canvas: false };
const resetUses = () => { USES.mermaid = false; USES.math = false; USES.canvas = false; };

/* $inline$ and $$display$$, turned into MathML at build time. KaTeX runs here
   and is never shipped: browsers draw MathML themselves, so the page carries
   no script, no stylesheet and no fonts on account of the mathematics. */
function tex(src, display, ctx) {
  let out;
  try {
    out = katex.renderToString(src.trim(), {
      displayMode: display, output: 'mathml', throwOnError: true, strict: 'ignore',
    });
  } catch (e) {
    console.warn(`  ! math wouldn't parse: ${String(e.message).split('\n')[0]}`);
    return null;
  }
  USES.math = true;
  /* keep the bare <math>; the KaTeX wrapper only matters to KaTeX's own CSS */
  const bare = out.replace(/^<span class="katex">([\s\S]*)<\/span>$/, '$1');
  return display
    ? hold(ctx, `<div class="math math-block">${bare}</div>`)
    : `<span class="math">${bare}</span>`;
}

function maths(text, ctx) {
  return String(text)
    .replace(/\$\$([\s\S]+?)\$\$/g, (whole, src) => tex(src, true, ctx) ?? whole)
    /* a lone $ needs to stay a dollar sign, so both ends must hug their maths */
    .replace(/(?<![\d$])\$(?!\s)([^\n$]+?)(?<![\s\\])\$(?![\d$])/g,
      (whole, src) => tex(src, false, ctx) ?? whole);
}

/* Mermaid needs a browser to draw, so the source travels as-is and the
   renderer is fetched only by the pages that have a diagram on them. */
function mermaid(text, ctx) {
  return String(text).replace(/^ {0,3}```mermaid[^\n]*\n([\s\S]*?)^ {0,3}```[^\n]*$/gm,
    (_, src) => {
      USES.mermaid = true;
      return hold(ctx, `<div class="mermaid-figure"><pre class="mermaid">${esc(src.trimEnd())}</pre></div>`);
    });
}
const marks = t => String(t).replace(/==(?!\s)([^\n=]+?)==/g, '<mark>$1</mark>');

/* `[^id]: the note`, with indented continuation lines, plus `^[an aside]`. */
function takeFootnotes(text, ctx) {
  const lines = String(text).split('\n');
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[\^([^\]\s]+)\]:\s*(.*)$/);
    if (!m) { keep.push(lines[i]); continue; }
    const buf = [m[2]];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (/^(?: {2,}|\t)/.test(lines[j])) { buf.push(lines[j].trim()); continue; }
      if (lines[j].trim() === '' && /^(?: {2,}|\t)/.test(lines[j + 1] || '')) { buf.push(''); continue; }
      break;
    }
    i = j - 1;
    ctx.notes.set(m[1], buf.join('\n').trim());
  }
  return keep.join('\n').replace(/\^\[([^\]]+)\]/g, (_, body) => {
    const id = `aside-${++ASIDE_SEQ}`;
    ctx.notes.set(id, body);
    return `[^${id}]`;
  });
}

/* Obsidian's callout types, sorted by how loudly they should read. */
const LOUD = new Set(['warning', 'caution', 'attention', 'failure', 'fail',
  'missing', 'danger', 'error', 'bug']);
const CALLOUT_NAME = {
  abstract: 'Summary', summary: 'Summary', tldr: 'Summary', todo: 'To do',
  tip: 'Tip', hint: 'Tip', important: 'Important', success: 'Done',
  check: 'Done', done: 'Done', question: 'Question', help: 'Question',
  faq: 'Question', cite: 'Quote', fail: 'Failure', danger: 'Danger',
};
const titleCase = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function callouts(text, ctx) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*>\s*\[!([A-Za-z_-]+)\]([+-]?)\s*(.*)$/);
    if (!m) { out.push(lines[i]); continue; }
    const inner = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (!/^\s*>/.test(lines[j])) break;
      inner.push(lines[j].replace(/^\s*>[ \t]?/, ''));
    }
    i = j - 1;
    const kind = m[1].toLowerCase();
    const label = m[3].trim() ? inline(marks(m[3].trim()))
      : esc(CALLOUT_NAME[kind] || titleCase(kind));
    const body = inner.join('\n').trim() ? renderChunk(inner.join('\n'), ctx) : '';
    const cls = `callout${LOUD.has(kind) ? ' loud' : ''} callout-${slug(kind) || 'note'}`;
    out.push(hold(ctx, m[2]
      ? `<details class="${cls}" data-callout="${esc(kind)}"${m[2] === '+' ? ' open' : ''}>` +
        `<summary class="callout-title">${label}</summary>` +
        `<div class="callout-body">${body}</div></details>`
      : `<div class="${cls}" data-callout="${esc(kind)}">` +
        `<div class="callout-title">${label}</div>` +
        (body ? `<div class="callout-body">${body}</div>` : '') + `</div>`));
  }
  return out.join('\n');
}

/* `![[Note]]`, `![[Note#Heading]]`, `![[Note#^block]]` — one note inside
   another, with a guard so a note that embeds itself stops rather than spins. */
function slicePart(body, target) {
  const hash = String(target).indexOf('#');
  if (hash < 0) return String(body);
  const frag = String(target).slice(hash + 1).trim();
  const lines = String(body).split('\n');
  if (frag.startsWith('^')) {                       // a block, marked at its end
    const id = frag.slice(1);
    const at = lines.findIndex(l => new RegExp(`\\^${id}\\s*$`).test(l));
    if (at < 0) return '';
    let a = at; while (a > 0 && lines[a - 1].trim() !== '') a--;
    return lines.slice(a, at + 1).join('\n').replace(new RegExp(`\\s*\\^${id}\\s*$`), '');
  }
  const want = slug(frag);
  const at = lines.findIndex(l => /^#{1,6}\s+/.test(l) && slug(l.replace(/^#+\s+/, '')) === want);
  if (at < 0) return '';
  const level = (lines[at].match(/^#+/) || ['#'])[0].length;
  let end = lines.length;
  for (let k = at + 1; k < lines.length; k++) {
    const h = lines[k].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) { end = k; break; }
  }
  return lines.slice(at, end).join('\n');
}

function transclude(text, ctx) {
  return String(text).replace(/!\[\[([^\[\]]+?)\]\]/g, (whole, raw) => {
    const target = String(raw).split('|')[0];
    const bare = target.split('#')[0].trim();
    if (!bare || MEDIA.has(bare)) return whole;              // an image; later
    const r = resolve(raw);
    if (!r.note) { MISSING.add(bare); return whole.slice(1); }
    if (ctx.stack.includes(r.note.file)) {
      console.warn(`  ! circular embed: ${bare}`);
      return '';
    }
    /* A canvas has no markdown to slice — it draws itself. `![[Some map]]`
       brings the whole stage in, pannable, with a link through to its own page.
       A number after a pipe sets its height: `![[Some map|420]]`. */
    if (r.note.kind === 'canvas') {
      /* held back, so there is nothing to draw: fall through to a plain link,
         which keeps its words and reports itself as unpublished */
      if (!r.note.raw || !r.note.href) return whole.slice(1);
      const bits = String(raw).split('|').slice(1).map(x => x.trim()).filter(Boolean);
      const tall = bits.find(x => /^\d+$/.test(x));
      const said = bits.filter(x => x !== tall).join(' ');
      const stage = renderCanvas(r.note.raw,
        { depth: ctx.depth, stack: [...ctx.stack, r.note.file] });
      if (!stage) { console.warn(`  ! canvas wouldn't parse or is empty: ${r.note.rel}`); return ''; }
      /* Without a height of its own an embedded stage takes only as much as the
         drawing needs, so a wide flat map doesn't sit in a tall empty band. */
      const shown = tall
        ? stage.replace('class="cv-stage"', `class="cv-stage" style="height:${tall}px"`)
        : stage.replace('class="cv-stage"', 'class="cv-stage" data-snug="1"');
      const what = said || r.note.name || r.note.title;
      const to = r.note.href
        ? `<a href="${upto(ctx.depth)}${r.note.href}">${inline(what)}</a>` : inline(what);
      const also = !said && r.note.summary ? ` — ${inline(r.note.summary)}` : '';
      return hold(ctx, `<figure class="map-embed">\n${shown}\n` +
        `      <figcaption class="embed-src apparatus">${to}${also}</figcaption>\n    </figure>`);
    }

    const chunk = slicePart(r.note.body, target);
    if (!chunk.trim()) { console.warn(`  ! nothing to embed at ${raw}`); return ''; }
    let inner = renderChunk(chunk, { ...ctx, stack: [...ctx.stack, r.note.file] });
    /* the heading ids belong to the note they came from, not to this page */
    const tag = `e${ctx.slots.length}`;
    inner = inner.replace(/<(h[2-6]) id="([^"]*)"/g, (_, t, id) => `<${t} id="${tag}-${id}"`);
    const name = r.note.name || r.note.title;
    const cite = r.note.href
      ? `<a href="${upto(ctx.depth)}${r.note.href}">${inline(name)}</a>` : inline(name);
    return hold(ctx, `<div class="embed"><div class="embed-src apparatus">${cite}</div>` +
      `<div class="embed-body">${inner}</div></div>`);
  });
}

/* One chunk of a note, in order. Callers share a context so that footnotes,
   placeholders and the embed stack belong to the page rather than the chunk. */
function renderChunk(text, ctx) {
  const t = blocks(String(text || ''), run => {
    let s = uncomment(run);
    s = maths(s, ctx);
    s = mermaid(s, ctx);
    s = takeFootnotes(s, ctx);
    s = transclude(s, ctx);
    s = callouts(s, ctx);
    return spanSafe(s, x => wiki(marks(tagLinks(x, ctx.depth)), { depth: ctx.depth }));
  });
  return anchors(pullquotes(md(t)));
}

/* The numbering waits until the whole page exists, so a reader's first
   footnote is footnote one however the page was assembled. */
let BACK = '↩';                 // what a footnote's return link shows
function footnotes(html, ctx) {
  if (!ctx.notes.size) return html;
  const seen = new Map();
  const tag = ctx.ns ? `${ctx.ns}-` : '';
  const body = outsideCode(html, s => s.replace(/\[\^([^\]\s]+)\]/g, (whole, id) => {
    if (!ctx.notes.has(id)) return whole;
    let e = seen.get(id);
    if (!e) { e = { num: seen.size + 1, uid: `${tag}${seen.size + 1}`, refs: 0 }; seen.set(id, e); }
    e.refs++;
    const at = `fnref-${e.uid}${e.refs > 1 ? `-${e.refs}` : ''}`;
    return `<sup class="fnref" id="${at}"><a href="#fn-${e.uid}">${e.num}</a></sup>`;
  }));
  if (!seen.size) return body;
  const items = [...seen.entries()].sort((a, b) => a[1].num - b[1].num).map(([id, e]) => {
    const raw = md(wiki(marks(uncomment(ctx.notes.get(id))), { depth: ctx.depth }));
    const arrow = `<a class="fnback" href="#fnref-${e.uid}" aria-label="back to text">${esc(BACK)}</a>`;
    const inner = /<\/p>\s*$/.test(raw) ? raw.replace(/<\/p>\s*$/, ` ${arrow}</p>`) : `${raw} ${arrow}`;
    return `      <li id="fn-${e.uid}">${inner}</li>`;
  }).join('\n');
  return `${body}\n    <section class="footnotes"><ol>\n${items}\n    </ol></section>`;
}

/* The one entry point: a note's words in, a page's HTML out. */
function rich(text, depth = 0, opts = {}) {
  const ctx = newCtx(depth, opts.ns || '', opts.file || '', opts.stack || []);
  /* Embeds come back before the footnotes are numbered, so a note carried in
     from somewhere else has its notes counted in the page it appears on. */
  return footnotes(unhold(renderChunk(text, ctx), ctx), ctx);
}

/* A link to the rest, when the landing page is only showing the newest few. */
function moreLink(p, ctx, total, shown) {
  if (!ctx.limit || total <= shown || !p.archive) return '';
  const label = (p.archive_label || `All ${total} ${String(p.heading || '').toLowerCase()}`)
    .replace('{n}', total);
  return `\n    <p class="more apparatus"><a href="${esc(upto(ctx.depth))}${esc(archivePath(p))}/">` +
    `${inline(label)}</a></p>`;
}
const archivePath = p => String(p.archive_path || p.dir || p.section || 'archive');

/* Every section shares this head. Words come from the note. */
function head(p, fallback, ctx = {}) {
  if (p.noHead) return '';
  const h = esc(p.heading || p.title || fallback);
  const a = p.apparatus ? `<span class="apparatus">${inline(p.apparatus)}</span>` : '';
  const d = ctx.depth || 0;
  const note = p.intro && p.intro.trim()
    ? `\n    <div class="sec-note">${rich(p.intro, d, { ns: `${slug(p.anchor || p.section || p.title)}-note`, file: p.file })}</div>` : '';
  return `    <div class="sec-head"><h2>${h}</h2>${a}</div>${note}`;
}

/* A date, in the site's format. */
const when = (dt, fmt = 'en-GB', long = false) => dt
  ? new Date(String(dt).slice(0, 10) + 'T00:00:00Z').toLocaleDateString(fmt || 'en-GB',
      long ? { month: 'long', year: 'numeric', timeZone: 'UTC' }
           : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  : '';

/* The date on a card is the note's permalink, when the note has a page. */
const stamp = (n, label, depth) => n.href
  ? `<a href="${upto(depth)}${n.href}">${esc(label)}</a>` : esc(label);

/* ---------------------------------------------------------------- passages */
/* A `## ` heading that begins with a date is a take. Anything after the
   date is an optional label. `## Source` is the passage itself. */
function parsePassage(n, oldestFirst = true) {
  const { named } = movements(n.body);
  let source = '';
  const takes = [];
  for (const [h, body] of named) {
    if (/^source$/i.test(h)) { source = body; continue; }
    const m = h.match(/^(?:take\s*[—:-]?\s*)?(\d{4}-\d{2}-\d{2})\s*[—:-]?\s*(.*)$/i);
    if (m) takes.push({ date: m[1], label: m[2].trim(), body });
  }
  takes.sort((a, b) => oldestFirst
    ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));
  const latest = takes.length ? takes.map(t => t.date).sort().slice(-1)[0] : (n.date || '');
  return { source, takes, latest };
}

function passageHTML({ n, source, takes }, p, ctx = {}) {
  const d = ctx.depth || 0;
  const fmt = p.date_format || 'en-GB';
  const rows = takes.map(t => `        <article class="take">
          <div class="when">${esc(when(t.date, fmt))}</div>
          <div>${t.label ? `<span class="take-label">${inline(t.label)}</span>` : ''}${rich(t.body, d, { ns: `${n.slug}-${t.date}`, file: n.file })}</div>
        </article>`).join('\n');
  const cite = inline(n.source || n.title);
  return `    <div class="passage">
      <blockquote class="source">
        ${source ? unp(rich(source, d, { ns: `${n.slug}-source`, file: n.file })) : ''}
        <span class="cite apparatus">${ctx.here ? cite : stamp(n, strip(cite), d)}</span>
      </blockquote>
${rows ? `      <div class="takes">\n${rows}\n      </div>`
       : `      <p class="todo">${esc(p.empty_label || 'no takes yet')}</p>`}
    </div>`;
}

/* ---------------------------------------------------------------- sections */
const RENDER = {};

/* Prose in movements, each `## heading` its own block. */
RENDER.movements = (p, vault, ctx = {}) => {
  const d = ctx.depth || 0;
  const { intro, named } = movements(p.body);
  let html = '';
  if (intro.trim()) html += `    <div class="movement"><div class="lede">${rich(intro, d, { ns: 'journey', file: p.file })}</div></div>\n`;
  for (const [title, chunk] of named) {
    const inner = rich(chunk, d, { ns: slug(title), file: p.file })
      .split(/(<div class="(?:ruled|standard)">[\s\S]*?<\/div>|<p class="cta">[\s\S]*?<\/p>)/)
      .filter(s => s && s.trim())
      .map(s => /^(?:<div class="(?:ruled|standard)"|<p class="cta")/.test(s.trim())
        ? s : `<div class="lede">${s}</div>`)
      .join('\n');
    html += `    <div class="movement"><h3>${esc(title)}</h3>\n${inner}</div>\n`;
  }
  return `${head({ ...p, intro: '' }, 'The journey', ctx)}\n${html}`;
};

/* Drawings, newest first — the same shape as the other lists, so `pages/Maps.md`
   carries its heading, its apparatus, its intro, its `limit` and its archive
   exactly the way `pages/Weather reports.md` does. */
/* The drawings — canvases, which every vault has in the same shape. */
RENDER.drawings = (p, vault, ctx = {}) => {
  const all = (vault.maps || []).slice().sort((a, b) =>
    String(b.date || '').localeCompare(String(a.date || '')) ||
    String(a.name).localeCompare(String(b.name)));
  if (!all.length) return `${head(p, p.section, ctx)}\n    <p class="todo">${esc(p.empty_label || 'no maps yet')}</p>`;
  const shown = ctx.limit ? all.slice(0, ctx.limit) : all;
  return `${head(p, p.section, ctx)}
${noteList(shown, ctx.depth || 0, p.date_format)}${moreLink(p, ctx, all.length, shown.length)}`;
};

/* Whole notes, one under another, for a collection short enough to read in
   place. */
RENDER.cards = (p, vault, ctx = {}) => {
  const all = (vault[p.section] || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!all.length) return head(p, p.section, ctx);
  const notes = ctx.limit ? all.slice(0, ctx.limit) : all;
  const fmt = p.date_format || 'en-GB';
  const d = ctx.depth || 0;
  const items = notes.map(n => `      <article class="wx">
        <div class="when">${stamp(n, when(n.date, fmt), d)}</div>
        <div>${rich(n.body, d, { ns: n.slug, file: n.file })}</div>
      </article>`).join('\n');
  return `${head(p, p.section, ctx)}
    <div class="weather">
${items}
    </div>${moreLink(p, ctx, all.length, notes.length)}`;
};

/* Grouped into columns by a field, with a mark against each showing where it
   has got to. A reading list; a set of workstreams; anything with strands. */
RENDER.strands = (p, vault, ctx = {}) => {
  const notes = vault[p.section] || [];
  const d = ctx.depth || 0;
  /* `strands: [key=Label, key=Label]` — one editable line, in order */
  const keys = strandPairs(p).length ? strandPairs(p)
    : [...new Set(notes.map(n => n.strand || n.folder))].filter(Boolean).map(k => [k, k]);
  const cls = { read: 'mark read', reading: 'mark now', waiting: 'mark' };
  const noteWord = p.note_label || 'note';
  const cols = keys.map(([k, label]) => {
    const items = notes.filter(n => (n.strand || n.folder) === k);
    if (!items.length) return '';
    const lis = items.map(n => {
      const name = n.wikipedia
        ? `<a href="${esc(n.wikipedia)}" rel="noopener">${inline(n.title)}</a>`
        : inline(n.title);
      /* a note of his own earns a second, quieter link */
      const mine = n.href
        ? ` <a class="note-link apparatus" href="${upto(d)}${n.href}">${esc(noteWord)}</a>` : '';
      return `          <li><span class="${cls[n.status] || 'mark'}"></span><span>${name}${mine}</span></li>`;
    }).join('\n');
    return `      <div class="strand">\n        <h3>${esc(label)}</h3>\n        <ul>\n${lis}\n        </ul>\n      </div>`;
  }).filter(Boolean).join('\n');
  const legend = [['read', p.legend_read], ['now', p.legend_reading], ['', p.legend_waiting]]
    .filter(([, l]) => l)
    .map(([c, l]) => `      <span><i class="mark ${c}"></i> ${inline(l)}</span>`).join('\n');
  return `${head(p, 'The reading', ctx)}
    <div class="strands">
${cols}
    </div>${legend ? `\n    <div class="legend apparatus">\n${legend}\n    </div>` : ''}`;
};
const strandPairs = p => (Array.isArray(p.strands) ? p.strands : []).map(s => {
  const i = s.indexOf('=');
  return i < 0 ? [s.trim(), s.trim()] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
});

/* One thing, returned to on dates. */
RENDER.takes = (p, vault, ctx = {}) => {
  const oldestFirst = String(p.takes_order || 'oldest').toLowerCase() !== 'newest';
  const allP = (vault[p.section] || [])
    .map(n => ({ n, ...parsePassage(n, oldestFirst) }))
    .sort((a, b) => String(b.latest).localeCompare(String(a.latest)));
  const notes = ctx.limit ? allP.slice(0, ctx.limit) : allP;
  const blocks = notes.map(o => passageHTML(o, p, ctx)).join('\n');
  return `${head(p, p.section, ctx)}\n${blocks}${moreLink(p, ctx, allP.length, notes.length)}`;
};

/* A dated list: when, what it is called, and a line about it. The workhorse. */
RENDER.entries = (p, vault, ctx = {}) => {
  const all = (vault[p.section] || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!all.length) return head(p, p.section, ctx);
  const notes = ctx.limit ? all.slice(0, ctx.limit) : all;
  const fmt = p.date_format || 'en-GB';
  const own = String(vault.siteTitle || '').toLowerCase();
  const rows = notes.map(n => {
    const series = String(n.series || '').toLowerCase() === own ? '' : n.series;
    const label = `${esc(when(n.date, fmt, true))}${series ? ` · ${esc(series)}` : ''}`;
    const title = n.href
      ? `<a class="cell-t" href="${upto(ctx.depth)}${n.href}">${inline(n.name)}</a>`
      : `<span class="cell-t">${inline(n.name)}</span>`;
    return `      <article class="entry${n.href ? '' : ' empty'}">
        <div class="when">${label}</div>
        <div>
          ${title}
          ${n.summary ? `<span class="cell-m">${inline(n.summary)}</span>` : ''}
        </div>
      </article>`;
  }).join('\n');
  return `${head(p, p.section, ctx)}
    <div class="entries">
${rows}
    </div>${moreLink(p, ctx, all.length, notes.length)}`;
};

/* free prose section, for anything that is just words */
RENDER.prose = (p, vault, ctx = {}) => `${head({ ...p, intro: '' }, p.title, ctx)}
    <div class="lede">${rich(p.body, ctx.depth || 0, { ns: slug(p.anchor || p.section || p.title), file: p.file })}</div>`;

/* ------------------------------------------------------------------ tags
 * `#a-tag` in the body and `tags:` in the frontmatter come to the same thing.
 * Every tag gets a page listing what carries it, and the set gets an index.
 */
const TAGS = new Map();                 // tag -> Set of hrefs
const TAG_RX = /(?<=^|[\s(])#([A-Za-z\u00C0-\u024F][\w/-]*)/gm;
const tagHref = t => `tags/${slug(String(t).replace(/\//g, ' '))}`;

function frontTags(n) {
  const raw = n.tags ?? n.tag ?? [];
  return (Array.isArray(raw) ? raw : String(raw).split(','))
    .map(x => String(x).trim().replace(/^#/, '')).filter(Boolean);
}

function scanTags(notes) {
  TAGS.clear();
  for (const n of notes) {
    const set = new Set(frontTags(n));
    blocks(n.body, run => {
      spanSafe(uncomment(run), x => {
        for (const m of x.matchAll(TAG_RX)) set.add(m[1]);
        return x;
      });
      return run;
    });
    n.tagList = [...set].sort((a, b) => a.localeCompare(b));
    if (!n.href) continue;
    for (const t of n.tagList) {
      if (!TAGS.has(t)) TAGS.set(t, new Set());
      TAGS.get(t).add(n.href);
    }
  }
}

/* `#tag` in prose, as a quiet chip rather than a link with a rule under it. */
const tagLinks = (text, depth) => String(text).replace(TAG_RX, (_, t) =>
  `<a class="tag" href="${upto(depth)}${tagHref(t)}">#${esc(t)}</a>`);

/* What the site as a whole turned out to need, so nothing unused is shipped. */
/* The masthead. `terrain` draws the generated landform, `plain` draws nothing.
   A vault says which in `pages/Site.md`, and plain is the default: a landform is
   somebody's house style rather than a feature of the engine. */
const wantsTerrain = site => String(site.masthead || 'plain').toLowerCase() === 'terrain';

const NEEDED = { mermaid: false, canvas: false };
function scripts(depth) {
  const up = upto(depth), out = [];
  if (USES.canvas) {
    NEEDED.canvas = true;
    out.push(`<script src="${up}assets/canvas.js"></script>`);
  }
  if (USES.mermaid) {
    NEEDED.mermaid = true;
    out.push(`<script src="${up}assets/mermaid.min.js"></script>`,
      `<script src="${up}assets/diagram.js"></script>`);
  }
  return out.join('\n');
}

/* A vault sets its own colours and type in `pages/Site.md`; the engine's
   stylesheet carries a plain default and these override it. Anything past a
   handful of values goes in `theme/theme.css`, which loads last. */
const PALETTE = {
  paper: '--paper', paper_2: '--paper-2', paper_3: '--paper-3',
  ink: '--ink', ink_2: '--ink-2', grey: '--grey', grey_2: '--grey-2',
  accent: '--vermilion',
  font_serif: '--serif', font_mono: '--mono', font_cjk: '--cjk',
  measure: '--measure',
};
function palette(site, depth) {
  const set = Object.entries(PALETTE)
    .filter(([k]) => String(site[k] ?? '').trim() !== '')
    .map(([k, v]) => `${v}:${String(site[k]).trim()}`);
  const own = fs.existsSync(path.join(THEME, 'theme.css'))
    ? `\n<link rel="stylesheet" href="${upto(depth)}assets/theme.css">` : '';
  return (set.length ? `<style>:root{${set.join('; ')}}</style>` : '') + own;
}

/* Absolute URLs, canonical tags and social cards, all keyed off `domain:`. */
function meta({ site, url, title, description, image }) {
  const base = site.domain ? `https://${String(site.domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}` : '';
  if (!base) return '';
  const abs = p => {
    const rel = String(p).replace(/^\//, '');
    return rel ? `${base}/${rel}` : `${base}/`;
  };
  const tags = [
    ['link', 'canonical', abs(url)],
    ['og:type', url === '' ? 'website' : 'article'],
    ['og:site_name', site.title],
    ['og:title', title],
    ['og:description', description],
    ['og:url', abs(url)],
    ['og:image', abs(image || 'assets/og.png')],
    ['twitter:card', 'summary_large_image'],
  ];
  return tags.map(t => t[0] === 'link'
    ? `<link rel="canonical" href="${esc(t[2])}">`
    : `<meta property="${t[0]}" content="${esc(t[1])}">`).join('\n');
}

/* ---------------------------------------------------------------- canvases
 * Obsidian's `.canvas` is documented JSON: positioned nodes and edges between
 * their sides. It is laid out here at its own size, with real text rather than
 * a picture of text, and read by panning rather than by shrinking it to fit.
 */
/* Obsidian's six card colours. These are muted so they sit on a light page
   without shouting; a vault can set its own with `canvas_colours:` in Site.md,
   six values in Obsidian's order — red, orange, yellow, green, blue, purple. */
let CANVAS_COLOUR = {};
const DEFAULT_CANVAS_COLOUR = {
  '1': '#9c4a42', '2': '#94684a', '3': '#847048',
  '4': '#5f7358', '5': '#4e6b78', '6': '#6a5f7a',
};
const canvasColour = c => !c ? '' : (CANVAS_COLOUR[String(c)] ||
  (/^#[0-9a-fA-F]{3,8}$/.test(String(c)) ? String(c) : ''));

const SIDE = {
  top:    (n) => [n.x + n.w / 2, n.y,        0, -1],
  bottom: (n) => [n.x + n.w / 2, n.y + n.h,  0,  1],
  left:   (n) => [n.x,           n.y + n.h / 2, -1, 0],
  right:  (n) => [n.x + n.w,     n.y + n.h / 2,  1, 0],
};

function canvasNode(nd, ctx) {
  const colour = canvasColour(nd.color);
  const style = `left:${nd.x}px; top:${nd.y}px; width:${nd.w}px; height:${nd.h}px` +
    (colour ? `; --edge:${colour}` : '');
  if (nd.type === 'group') {
    return `<div class="cv-group" style="${style}">` +
      (nd.label ? `<div class="cv-group-label apparatus">${inline(nd.label)}</div>` : '') + `</div>`;
  }
  if (nd.type === 'text') {
    return `<div class="cv-node cv-text" style="${style}"><div class="cv-in">` +
      rich(nd.text || '', ctx.depth, { ns: `cv-${nd.id}`, stack: ctx.stack || [] }) +
      `</div></div>`;
  }
  if (nd.type === 'link') {
    const u = String(nd.url || '');
    let host = u;
    try { host = new URL(u).host.replace(/^www\./, ''); } catch {}
    return `<div class="cv-node cv-link" style="${style}"><div class="cv-in">` +
      `<a href="${esc(u)}" rel="noopener">${esc(nd.label || host || u)}</a>` +
      `<span class="apparatus">${esc(host)}</span></div></div>`;
  }
  if (nd.type === 'file') {
    const name = String(nd.file || '').split('/').pop();
    if (MEDIA.has(name)) {
      USED_MEDIA.add(name);
      return `<div class="cv-node cv-image" style="${style}">` +
        `<img src="${upto(ctx.depth)}assets/media/${encodeURIComponent(name)}" alt="" loading="lazy"></div>`;
    }
    const bare = name.replace(/\.(md|canvas|base)$/i, '');
    const hit = BY_KEY.get(slug(bare));
    const sub = String(nd.subpath || '');
    const title = hit
      ? (hit.href ? `<a href="${upto(ctx.depth)}${hit.href}${sub ? `#${slug(sub.replace(/^#/, ''))}` : ''}">${inline(hit.name || bare)}</a>`
                  : inline(hit.name || bare))
      : esc(bare);
    const body = hit && hit.body
      ? rich(slicePart(hit.body, sub ? `x${sub}` : 'x'), ctx.depth,
          { ns: `cv-${nd.id}`, file: hit.file, stack: ctx.stack || [] })
      : '';
    return `<div class="cv-node cv-file" style="${style}">` +
      `<div class="cv-head apparatus">${title}</div>` +
      `<div class="cv-in">${body}</div></div>`;
  }
  return '';
}

function canvasEdges(edges, by) {
  const paths = [], labels = [];
  for (const e of edges) {
    const a = by.get(e.fromNode), b = by.get(e.toNode);
    if (!a || !b) continue;
    const from = (SIDE[e.fromSide] || SIDE.right)(a);
    const to = (SIDE[e.toSide] || SIDE.left)(b);
    const gap = Math.max(48, Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.34);
    const c1 = [from[0] + from[2] * gap, from[1] + from[3] * gap];
    const c2 = [to[0] + to[2] * gap, to[1] + to[3] * gap];
    const colour = canvasColour(e.color) || 'var(--grey)';
    const head = (e.toEnd || 'arrow') === 'arrow';
    const tail = e.fromEnd === 'arrow';
    paths.push(`<path d="M${from[0]} ${from[1]} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${to[0]} ${to[1]}"` +
      ` fill="none" stroke="${esc(colour)}" stroke-width="1.6"` +
      (head ? ` marker-end="url(#cv-arrow)"` : '') +
      (tail ? ` marker-start="url(#cv-arrow)"` : '') + `/>`);
    if (e.label) {
      /* the middle of a cubic is the average of its four points, near enough */
      const mx = (from[0] + 3 * c1[0] + 3 * c2[0] + to[0]) / 8;
      const my = (from[1] + 3 * c1[1] + 3 * c2[1] + to[1]) / 8;
      labels.push({ x: mx, y: my, text: e.label });
    }
  }
  return { paths, labels };
}

function renderCanvas(raw, ctx) {
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return null; }
  const nodes = (doc.nodes || []).map(n => ({
    ...n, w: Number(n.width) || 260, h: Number(n.height) || 120,
    x: Number(n.x) || 0, y: Number(n.y) || 0,
  }));
  if (!nodes.length) return null;
  const by = new Map(nodes.map(n => [n.id, n]));
  const pad = 40;
  const minx = Math.min(...nodes.map(n => n.x)) - pad;
  const miny = Math.min(...nodes.map(n => n.y)) - pad;
  const maxx = Math.max(...nodes.map(n => n.x + n.w)) + pad;
  const maxy = Math.max(...nodes.map(n => n.y + n.h)) + pad;
  /* shift everything so the sheet starts at the origin */
  for (const n of nodes) { n.x -= minx; n.y -= miny; }
  const W = Math.round(maxx - minx), H = Math.round(maxy - miny);

  const { paths, labels } = canvasEdges(doc.edges || [], by);
  const order = [...nodes].sort((a, b) =>
    (a.type === 'group' ? 0 : 1) - (b.type === 'group' ? 0 : 1));

  USES.canvas = true;
  return `    <div class="cv-stage" data-w="${W}" data-h="${H}">
      <div class="cv-layer" style="width:${W}px; height:${H}px">
        <svg class="cv-wires" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
          <defs><marker id="cv-arrow" viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 1 L9 5 L0 9 z" fill="context-stroke"/></marker></defs>
${paths.map(p => `          ${p}`).join('\n')}
        </svg>
${order.map(n => `        ${canvasNode(n, ctx)}`).filter(x => x.trim()).join('\n')}
${labels.map(l => `        <div class="cv-elabel apparatus" style="left:${Math.round(l.x)}px; top:${Math.round(l.y)}px">${inline(l.text)}</div>`).join('\n')}
      </div>
    </div>`;
}

/* --------------------------------------------------------------------- bases
 * A `.base` is a saved query with one or more views over it. The query runs
 * here; what comes back is drawn as a table, a set of cards or a list.
 */
function baseCell(v, depth) {
  if (v === null || v === undefined || v === '') return '<span class="bs-nil">—</span>';
  if (v === true) return '<span class="bs-yes">yes</span>';
  if (v === false) return '<span class="bs-no">no</span>';
  if (Array.isArray(v)) return v.map(x => baseCell(x, depth)).join('<span class="bs-sep">, </span>');
  if (typeof v === 'object') {
    if (v.link) {
      const hit = BY_KEY.get(slug(String(v.link).replace(/^\[\[|\]\]$/g, '')));
      const label = v.label || (hit && hit.name) || v.link;
      return hit && hit.href
        ? `<a href="${upto(depth)}${hit.href}">${inline(label)}</a>` : esc(label);
    }
    return esc(JSON.stringify(v));
  }
  if (typeof v === 'number') return esc(String(Math.round(v * 1000) / 1000));
  const t = String(v);
  if (/^https?:\/\//.test(t)) {
    let host = t;
    try { host = new URL(t).host.replace(/^www\./, ''); } catch { /* leave it whole */ }
    return `<a href="${esc(t)}" rel="noopener">${esc(host)}</a>`;
  }
  if (/^\[\[[^\]]+\]\]$/.test(t)) return baseCell({ link: t.slice(2, -2) }, depth);
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return esc(when(t.slice(0, 10)));
  if (/^#[\w/-]+$/.test(t)) return `<a class="tag" href="${upto(depth)}${tagHref(t.slice(1))}">${esc(t)}</a>`;
  return inline(t);
}

const baseTitle = (n, depth) => n.href
  ? `<a href="${upto(depth)}${n.href}">${inline(n.name)}</a>` : inline(n.name);

function baseView(view, depth, labels = {}) {
  const head = view.name
    ? `      <div class="bs-head"><h3>${inline(view.name)}</h3>` +
      `<span class="apparatus">${view.rows.length} ${view.rows.length === 1 ? 'note' : 'notes'}</span></div>\n`
    : '';
  if (!view.rows.length) {
    return `${head}      <p class="todo">${esc(labels.empty || 'nothing matches yet')}</p>`;
  }
  if (view.type === 'cards') {
    const cards = view.rows.map(r => {
      const img = view.image ? r.value(view.image) : '';
      const name = String(Array.isArray(img) ? img[0] : img || '').split('/').pop()
        .replace(/^\[\[|\]\]$/g, '');
      const pic = name && MEDIA.has(name)
        ? (USED_MEDIA.add(name), `<div class="bs-pic"><img src="${upto(depth)}assets/media/${encodeURIComponent(name)}" alt="" loading="lazy"></div>`)
        : '';
      const rest = view.columns.slice(1).map((c, i) => {
        const v = r.cells[i + 1];
        if (v === null || v === undefined || v === '') return '';
        return `<div class="bs-pair"><span class="apparatus">${esc(c.label)}</span>` +
          `<span>${baseCell(v, depth)}</span></div>`;
      }).filter(Boolean).join('\n            ');
      return `        <article class="bs-card">${pic}
          <div class="bs-card-in">
            <div class="bs-card-t">${baseTitle(r.note, depth)}</div>
            ${rest}
          </div>
        </article>`;
    }).join('\n');
    return `${head}      <div class="bs-cards">\n${cards}\n      </div>`;
  }
  if (view.type === 'list') {
    const items = view.rows.map(r => {
      const rest = view.columns.slice(1).map((c, i) => {
        const v = r.cells[i + 1];
        return (v === null || v === undefined || v === '') ? ''
          : `<span class="bs-inline"><span class="apparatus">${esc(c.label)}</span> ${baseCell(v, depth)}</span>`;
      }).filter(Boolean).join(' ');
      return `        <li><span class="bs-list-t">${baseTitle(r.note, depth)}</span>${rest ? ` ${rest}` : ''}</li>`;
    }).join('\n');
    return `${head}      <ul class="bs-list">\n${items}\n      </ul>`;
  }
  /* a table, which is what a base is by default */
  const ths = view.columns.map(c => `<th>${esc(c.label)}</th>`).join('');
  const trs = view.rows.map(r => {
    const tds = view.columns.map((c, i) => {
      const first = i === 0;
      const v = r.cells[i];
      const cell = first && /^(?:file\.name|file\.basename|name|title)$/i.test(c.key)
        ? baseTitle(r.note, depth) : baseCell(v, depth);
      return `<td${first ? ' class="bs-t"' : ''}>${cell}</td>`;
    }).join('');
    return `          <tr>${tds}</tr>`;
  }).join('\n');
  return `${head}      <div class="bs-scroll"><table class="bs-table">
        <thead><tr>${ths}</tr></thead>
        <tbody>
${trs}
        </tbody>
      </table></div>`;
}

/* A list of notes, the same shape wherever notes get listed. */
function noteList(items, depth, fmt = 'en-GB') {
  if (!items.length) return '';
  const rows = items.slice().sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')) ||
      String(a.name).localeCompare(String(b.name)))
    .map(n => `      <article class="entry">
        <div class="when">${esc(when(n.date, fmt) || LABEL(n.kind))}</div>
        <div>
          <a class="cell-t" href="${upto(depth)}${n.href}">${inline(n.name)}</a>
          ${n.summary ? `<span class="cell-m">${inline(n.summary)}</span>` : ''}
        </div>
      </article>`).join('\n');
  return `    <div class="entries">\n${rows}\n    </div>`;
}

/* The tags a note carries, shown at its foot. */
function tagRow(n, depth) {
  if (!n.tagList || !n.tagList.length) return '';
  const chips = n.tagList.map(t =>
    `<a class="tag" href="${upto(depth)}${tagHref(t)}">#${esc(t)}</a>`).join(' ');
  return `<p class="tag-row">${chips}</p>`;
}

/* Notes that point here. */
function backlinks(note, label, depth) {
  const set = LINKS.get(note.href);
  if (!set || !set.size) return '';
  const items = [...set].map(u => BY_HREF.get(u)).filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(n => `        <li><a href="${upto(depth)}${n.href}">${inline(n.name)}</a>` +
      `<span class="apparatus">${esc(LABEL(n.kind))}</span></li>`).join('\n');
  if (!items) return '';
  return `<div class="backlinks">
      <h4 class="apparatus">${esc(label || 'Linked from')}</h4>
      <ul>
${items}
      </ul>
    </div>`;
}

/* --------------------------------------------------------- the two either side
 * Essays, weather reports and passages are sequences: each was written on a
 * date, and its archive reads newest first. So a note page can offer the two
 * notes either side of it. The reading map is not a sequence — it is a map —
 * so its notes have no neighbours.
 *
 * "Older" and "newer" rather than "previous" and "next", which don't say which
 * way time is running. Both slots are always in the markup, so the newer one
 * stays on the right even when there is nothing on the left.
 */
/* Views whose notes run in dated order, and so have a note either side. A map
   or a reading list is not a sequence; a run of essays is. A collection can opt
   out with `sequence: false` on its section note. */
const SEQ_VIEWS = new Set(['entries', 'cards', 'takes']);
const viewOf = kind => String((KINDS[kind] || {}).view || '');
const inSequence = kind => !!KINDS[kind] &&
  KINDS[kind].sequence !== false && SEQ_VIEWS.has(viewOf(kind));

/* Where a note sits in its own sequence — the same rule its section sorts by.
   A thing returned to is dated by the last time it was returned to. */
const seqDate = n => viewOf(n.kind) === 'takes'
  ? String(parsePassage(n).latest || '') : String(n.date || '');

function sequences(live) {
  const by = new Map();
  for (const n of live) {
    if (!inSequence(n.kind)) continue;
    if (!by.has(n.kind)) by.set(n.kind, []);
    by.get(n.kind).push(n);
  }
  for (const list of by.values())
    list.sort((a, b) => seqDate(b).localeCompare(seqDate(a)) ||
      String(a.name).localeCompare(String(b.name)));
  return by;
}

function nearby(n, seq, site, depth) {
  const list = seq.get(n.kind);
  if (!list || list.length < 2) return '';
  const i = list.findIndex(x => x.href === n.href);
  if (i < 0) return '';
  const older = list[i + 1], newer = list[i - 1];
  if (!older && !newer) return '';
  const slot = (m, label, cls) => `<span class="near-one ${cls}">` + (m
    ? `<span class="apparatus">${esc(label)}</span>` +
      `<a href="${upto(depth)}${esc(m.href)}">${inline(m.name)}</a>`
    : '') + '</span>';
  /* a div, not a nav: the foot it sits in is already a nav */
  return `    <div class="nearby">
      ${slot(older, site.older_label || 'Older', 'near-back')}
      ${slot(newer, site.newer_label || 'Newer', 'near-on')}
    </div>`;
}

/* --------------------------------------------------------------------- feed
 * One feed for the whole site, newest first, carrying the note's own words
 * rather than a teaser with a link. A feed needs absolute URLs, so it appears
 * only once `domain:` is set in Site.md.
 *
 * An item needs a date. Essays and weather reports carry one; a passage takes
 * the date of its latest take. A reading note has no date unless it is given
 * one, so reading notes stay out by default — they get revised in place rather
 * than published once, and a feed is a record of publication. Whatever is left
 * out is named in the build log.
 */
function feedDate(n) {
  if (n.date) return String(n.date).slice(0, 10);
  if (viewOf(n.kind) === 'takes') return String(parsePassage(n).latest || '').slice(0, 10);
  return '';
}

const rfc822 = at => new Date(`${at}T00:00:00Z`).toUTCString();
const cdata = s => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

/* A reader shows the item away from the site, so every relative link the page
   would have used has to be spelled out in full. Fragments are left alone:
   inside the item they still point where they should. */
const absolutise = (html, base) => String(html).replace(
  /\b(href|src)="(?!#|[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)([^"]*)"/g,
  (_, attr, url) => `${attr}="${base}/${url.replace(/^\/+/, '')}"`);

/* For a note that carries no summary of its own. Tag chips are apparatus
   rather than prose, so they don't count towards the words. */
function teaser(html, words = 40) {
  const prose = String(html).replace(/<a class="tag"[^>]*>[\s\S]*?<\/a>/g, '');
  const said = strip(prose).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return said.length > words ? `${said.slice(0, words).join(' ')}…` : said.join(' ');
}

function feedXML({ site, host, items, secFor }) {
  const abs = p => `${host}/${String(p).replace(/^\//, '')}`;
  const rows = items.map(({ n, at }) => {
    resetUses();
    const p = secFor(n.kind);
    const html = viewOf(n.kind) === 'takes'
      ? passageHTML({ n, ...parsePassage(n,
          String(p.takes_order || 'oldest').toLowerCase() !== 'newest') }, p,
        { depth: 0, here: true })
      : rich(n.body, 0, { ns: n.slug, file: n.file });
    const body = absolutise(html, host);
    const summary = n.summary ? inline(n.summary) : teaser(body);
    const cats = [LABEL(n.kind), ...(n.tagList || [])]
      .map(c => `      <category>${esc(c)}</category>`).join('\n');
    return `    <item>
      <title>${esc(strip(inline(n.name)))}</title>
      <link>${esc(abs(n.href))}</link>
      <guid isPermaLink="true">${esc(abs(n.href))}</guid>
      <pubDate>${rfc822(at)}</pubDate>
${cats}
      <description>${cdata(summary)}</description>
      <content:encoded>${cdata(body)}</content:encoded>
    </item>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(site.title || '')}</title>
    <link>${esc(abs(''))}</link>
    <atom:link href="${esc(abs('feed.xml'))}" rel="self" type="application/rss+xml"/>
    <description>${esc(site.feed_note || site.description || '')}</description>
    <language>${esc(site.language || 'en')}</language>
    <lastBuildDate>${rfc822(items[0].at)}</lastBuildDate>
${rows}
  </channel>
</rss>
`;
}

/* Delete pages whose notes are gone, but never let a read-only mount fail. */
function prune(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (keep.has(f) || !f.endsWith('.html')) continue;
    try { fs.unlinkSync(path.join(dir, f)); }
    catch { console.warn(`  ! stale page left in place: ${path.basename(dir)}/${f}`); }
  }
}

/* -------------------------------------------------------------------- build */
export function build(opts = {}) {
  VAULT = path.resolve(opts.vault || process.env.VAULT_DIR || '.');
  OUT = path.resolve(opts.out || 'public');
  THEME = path.resolve(opts.theme || path.join(VAULT, '..', 'theme'));
  CANVAS_COLOUR = { ...DEFAULT_CANVAS_COLOUR };
  if (!fs.existsSync(VAULT)) throw new Error(`No vault at ${VAULT}`);
  if (!fs.existsSync(path.join(VAULT, 'pages')))
    throw new Error(`No pages/ folder in ${VAULT} — a vault says what it is in there`);

  indexMedia();
  USED_MEDIA.clear();
  const pages = load('pages');
  const site = pages.find(p => p.type === 'site') || {};
  BACK = site.footnote_back || '↩';
  const ownColours = Array.isArray(site.canvas_colours) ? site.canvas_colours : [];
  ownColours.slice(0, 6).forEach((c, i) => {
    if (String(c).trim()) CANVAS_COLOUR[String(i + 1)] = String(c).trim();
  });

  /* --- what this vault holds, in its own words --------------------------- */
  KINDS = {};
  const declared = pages.slice()
    .sort((a, b) => Number(a.order ?? 999) - Number(b.order ?? 999));
  for (const p of declared) {
    if (p.type === 'site' || !p.source) continue;
    const name = String(p.section || slug(p.title));
    if (EXTRA[name] || name === 'maps') {
      console.warn(`  ! ${path.basename(p.file)}: "${name}" is the engine's own, skipped`);
      continue;
    }
    KINDS[name] = {
      folder: String(p.source),
      dir: String(p.dir || name),
      label: String(p.label || 'Note'),
      view: String(p.view || 'entries'),
      sequence: p.sequence !== false,
    };
  }
  /* Absolute URLs come from `domain:`, and the sitemap, the social cards and
     the feed all need them. Without a domain the site still builds. */
  const host = site.domain
    ? `https://${String(site.domain).replace(/^https?:\/\//, '').replace(/\/$/, '')}` : '';

  /* --- every note, with a page of its own if it earns one ---------------- */
  const vault = {};
  const notes = [];
  for (const [kind, k] of Object.entries(KINDS)) {
    const list = load(k.folder).map(n => {
      const name = n.heading || detitle(n.title);
      const s = n.slug || slug(name);
      /* A note with nothing in it has no page, and neither has one that
         announces itself before it exists with `status: planned`. Both still
         show in the list; neither is a link. */
      const written = n.status !== 'planned' && n.body.trim().length > 0;
      return { ...n, kind, name, slug: s, href: written ? `${k.dir}/${s}` : '' };
    });
    vault[kind] = list;
    notes.push(...list);
  }
  vault.siteTitle = site.title || '';

  /* Obsidian's canvases and bases, from anywhere the vault publishes from.
     Neither format has anywhere to put frontmatter, so a note of the same name
     beside it carries the metadata: `Maps/2026-08-12 A map.md` speaks for
     `Maps/2026-08-12 A map.canvas`.

     A drawing is private until it says otherwise. It publishes only when that
     note exists and says `publish: true` — nothing else will do. A canvas is a
     place to think in, and thinking in public should be a decision rather than
     the default. Everything else in the note is optional. */
  const extras = [];
  const sidecars = new Set();
  const withheld = [];
  for (const [kind, k] of Object.entries(EXTRA)) {
    for (const f of walkExt(k.ext)) {
      const title = path.basename(f.file, k.ext);
      const beside = f.file.replace(new RegExp(`${k.ext}$`, 'i'), '.md');
      const has = fs.existsSync(beside);
      if (has) sidecars.add(beside);
      const { data: front, body } = has
        ? frontmatter(fs.readFileSync(beside, 'utf8')) : { data: {}, body: '' };
      const rel = f.rel.replace(new RegExp(`${k.ext}$`, 'i'), '');
      /* checked here rather than at drawing time, so the section note's list and
         the pages it links to can never disagree */
      if (kind === 'canvas') {
        let ok = false;
        try { ok = (JSON.parse(fs.readFileSync(f.file, 'utf8')).nodes || []).length > 0; }
        catch { ok = false; }
        if (!ok) {
          console.warn(`  ! canvas wouldn't parse or is empty: ${rel}`);
          continue;
        }
      }
      const wanted = front.publish === true ||
        String(front.publish).trim().toLowerCase() === 'true';
      if (!wanted) {
        withheld.push({ file: f.file, title, rel, kind,
          name: front.title ? String(front.title) : detitle(title),
          why: !has ? 'no note beside it'
             : front.publish === false ? 'publish: false'
             : 'its note doesn\'t say publish: true' });
        continue;
      }
      const shown = front.title ? String(front.title) : detitle(title);
      const dated = title.match(/^(\d{4}(?:-\d{2}){0,2})\s+/);
      const s = slug(front.slug ? String(front.slug) : shown);
      extras.push({
        ...front,
        file: f.file, rel, kind, title, name: shown, slug: s,
        href: `${k.dir}/${s}`, sidecar: has ? beside : '',
        body: body || '',
        date: front.date ? String(front.date).slice(0, 10) : (dated ? dated[1] : ''),
        raw: fs.readFileSync(f.file, 'utf8'),
      });
    }
  }
  notes.push(...extras);
  vault.maps = extras.filter(x => x.kind === 'canvas');

  /* A note meant for a drawing has to sit beside it under exactly the same
     name. Rename one and not the other and the pairing breaks in silence — the
     drawing publishes with its defaults and a `publish: false` meant to hold it
     back does nothing. So: any note carrying one of these keys, in a folder that
     holds drawings, matching none of them, gets said out loud. */
  const SIDECAR_KEYS = ['publish', 'summary', 'title', 'slug', 'tags', 'date'];
  const orphans = [];
  {
    const drawingsIn = new Map();
    for (const [, k] of Object.entries(EXTRA))
      for (const f of walkExt(k.ext)) {
        const dir = path.dirname(f.file);
        if (!drawingsIn.has(dir)) drawingsIn.set(dir, new Set());
        drawingsIn.get(dir).add(path.basename(f.file, k.ext));
      }
    for (const [dir, names] of drawingsIn)
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const here = path.join(dir, f);
        if (sidecars.has(here)) continue;
        if (names.has(path.basename(f, '.md'))) continue;
        const { data } = frontmatter(fs.readFileSync(here, 'utf8'));
        if (!SIDECAR_KEYS.some(key => key in data)) continue;
        orphans.push({ note: path.relative(VAULT, here), near: [...names].sort() });
      }
  }

  /* Notes outside the publishing folders exist for linking purposes only:
     a [[link]] to one keeps its words and quietly goes nowhere. */
  const claimed = new Set([...notes.map(n => n.file), ...sidecars]);
  const pagesDir = path.join(VAULT, 'pages') + path.sep;
  const offstage = walk(VAULT)
    .filter(f => !claimed.has(f) && !f.startsWith(pagesDir))
    .map(f => ({ file: f, title: path.basename(f, '.md'), rel: path.relative(VAULT, f).replace(/\.md$/, '') }))
    /* a drawing held back still answers to its name, so a link to it keeps its
       words and is reported as unpublished rather than as pointing at nothing */
    .concat(withheld);

  register(notes, offstage);
  for (const x of [...extras, ...withheld]) key(x, `${x.title}${EXTRA[x.kind].ext}`);
  scanLinks([
    ...notes.filter(n => n.href).map(n => ({ from: n.href, body: n.body })),
    /* a canvas points at notes through its file nodes; those count as links */
    ...extras.filter(x => x.kind === 'canvas').map(x => {
      let refs = '';
      try {
        refs = (JSON.parse(x.raw).nodes || [])
          .filter(n => n.type === 'file' && n.file)
          .map(n => `[[${String(n.file).split('/').pop().replace(/\.md$/i, '')}]]`).join('\n');
      } catch { /* a canvas that won't parse is reported when it renders */ }
      return { from: x.href, body: refs };
    }),
  ]);
  scanTags(notes);
  /* so that [[Tags]] works from anywhere in the vault */
  /* [[Tags]] and [[Graph]] resolve from anywhere — but only once there is a
     page behind them. Until then the words stay words rather than a dead link,
     so putting either in the footer is safe before the vault has grown into it. */
  const liveCount = notes.filter(n => n.href).length;
  const mapCount = extras.filter(x => x.kind === 'canvas').length;
  const mapsPage = pages.find(x => (x.section || '') === 'maps') || {};

  /* --- what goes in the feed, newest first ------------------------------- */
  const undated = [];
  const feed = notes.filter(n => n.href && KINDS[n.kind])
    .map(n => ({ n, at: feedDate(n) }))
    .filter(x => x.at || (undated.push(x.n.name), false))
    .sort((a, b) => b.at.localeCompare(a.at) || a.n.name.localeCompare(b.n.name));
  const feedAll = feed.length;
  const feedMax = site.feed_limit === undefined ? 50 : Number(site.feed_limit) || 0;
  if (feedMax && feed.length > feedMax) feed.length = feedMax;

  /* Every other archived section earns the same treatment as Maps: a
     wikilink to it — `[[Patterns]]`, `[[Essays]]`, whatever the note is
     titled — resolves to its archive page once that page has something on
     it, and stays plain text otherwise. Maps is excluded here because it
     already has its own entry above, with its own reasons. */
  const navSections = pages
    .filter(p => (p.type === 'section' || (p.section && p.type !== 'site')) &&
      p.archive && p.section !== 'maps')
    .map(p => {
      const label = String(p.heading || p.title || p.section);
      const count = (vault[p.section] || []).length;
      return [label, label, `${archivePath(p)}/`, count > 0,
        `nothing published under ${label} yet`];
    });

  for (const [name, title, href, ready, why] of [
    ['Tags', site.tags_title || 'Tags', 'tags/',
      TAGS.size > 0, 'nothing carries a tag yet'],
    ['Graph', site.graph_title || 'The graph', 'graph/',
      site.graph !== false && liveCount > 1 && LINKS.size > 0, 'no two notes link to each other yet'],
    ['Maps', mapsPage.heading || mapsPage.title || 'Maps',
      `${archivePath(mapsPage)}/`,
      !!mapsPage.file && mapsPage.archive && mapCount > 0,
      !mapsPage.file ? 'there is no pages/Maps.md yet'
        : !mapsPage.archive ? 'pages/Maps.md doesn\'t ask for an archive'
        : 'no drawing says publish: true yet'],
    ['Feed', site.feed_title || 'Feed', 'feed.xml',
      site.feed !== false && !!host && feed.length > 0,
      site.feed === false ? 'the feed is switched off in Site.md'
        : !host ? 'the site has no domain: yet, and a feed needs absolute URLs'
                : 'nothing with a date has a page yet'],
    ...navSections,
  ]) key({ name: title, title: name, kind: 'index', href: ready ? href : '', why }, name);

  /* Every section that keeps an archive answers to its own name too, so a note
     can write `[[Weather reports]]` the way it writes `[[Maps]]`, and a link
     survives the section being given a different `archive_path`. Registered
     last, so a real note of the same name always wins, and so the index names
     above keep their own readiness rules. */
  for (const p of pages) {
    if (p.type === 'site' || !p.archive) continue;
    const to = `${archivePath(p)}/`;
    const shown = p.heading || p.title;
    for (const name of [p.heading, p.title, p.section])
      if (name) key({ name: shown, title: name, kind: 'index', href: to }, name);
  }

  /* Autodiscovery, so a reader offered any page on the site finds the feed. */
  const feedLink = depth => (site.feed !== false && host && feed.length)
    ? `<link rel="alternate" type="application/rss+xml" ` +
      `title="${esc(site.title || '')}" href="${upto(depth)}feed.xml">` : '';
  const template = (name, depth, seeded) =>
    fs.readFileSync(path.join(HERE, 'templates', name), 'utf8')
      .replace('{{FEED}}', feedLink(depth))
      .replace('{{THEME}}', palette(site, depth))
      /* the seed placeholder survives, so each page still draws its own ground */
      .replace('{{MASTHEAD}}', wantsTerrain(site)
        ? `\n  <canvas id="terrain"${seeded ? ' data-seed="{{SEED}}"' : ''}></canvas>` : '')
      .replace('{{TERRAIN}}', wantsTerrain(site)
        ? `\n<script src="${upto(depth)}assets/terrain.js"></script>` : '');

  /* --- the landing page ------------------------------------------------- */
  const sections = pages
    .filter(p => p.type === 'section' || (p.section && p.type !== 'site'))
    .sort((a, b) => Number(a.order ?? 999) - Number(b.order ?? 999));

  resetUses();
  const viewName = p => String(p.view || (p.source ? 'entries' : 'prose'));
  const rendered = sections.filter(p => p.landing !== false).map(p => {
    const fn = RENDER[viewName(p)];
    if (!fn) { console.warn(`  ! ${path.basename(p.file)}: no such view "${viewName(p)}" — ` +
      `try ${Object.keys(RENDER).sort().join(', ')}`); return ''; }
    const { intro } = movements(p.body);
    const ctx = { depth: 0, limit: Number(p.limit) || 0 };
    return `  <section id="${esc(p.anchor || p.section || viewName(p))}">\n${fn({ ...p, intro }, vault, ctx).trimEnd()}\n  </section>`;
  }).filter(Boolean).join('\n\n');

  const foot = movements(site.body || '');
  const footSec = Object.fromEntries(foot.named);
  const pick = re => footSec[Object.keys(footSec).find(k => re.test(k)) ?? ''] ?? '';
  const footAt = (re, depth) => rich(pick(re), depth, { ns: 'foot' });

  const itpl = template('index.html', 0, false);
  fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'), itpl
    .replace(/\{\{TITLE\}\}/g, esc(site.title || ''))
    .replace('{{SUBTITLE}}', inline(site.subtitle || ''))
    .replace('{{DESCRIPTION}}', esc(site.description || ''))
    .replace('{{META}}', meta({ site, url: '', title: site.title,
      description: site.description }))
    .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal'))
    .replace('{{SEAL}}', esc(site.seal || ''))
    .replace('{{SECTIONS}}', rendered)
    .replace('{{FOOTER}}', footAt(/^footer$/i, 0))
    .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 0))
    .replace('{{SCRIPTS}}', scripts(0)));

  /* --- an archive page for every section that wants the full run --------- */
  const atpl = template('archive.html', 1, true);
  let archives = 0;
  for (const p of sections) {
    if (!p.archive) continue;
    const fn = RENDER[viewName(p)];
    if (!fn) continue;
    const dir = path.join(OUT, archivePath(p));
    fs.mkdirSync(dir, { recursive: true });
    const { intro } = movements(p.body);
    resetUses();
    const body = fn({ ...p, intro, noHead: true }, vault, { depth: 1, limit: 0 }).trimEnd();
    const title = p.archive_title || p.heading || p.title;
    fs.writeFileSync(path.join(dir, 'index.html'), atpl
      .replace(/\{\{SITE_TITLE\}\}/g, esc(site.title || ''))
      .replace(/\{\{TITLE\}\}/g, esc(title))
      .replace('{{DESCRIPTION}}', esc(strip(rich(intro, 1, { ns: 'x' }))))
      .replace('{{SUBTITLE}}', unp(rich(intro, 1, { ns: `${archivePath(p)}-note` })))
      .replace('{{KICKER}}', p.apparatus ? ` · ${esc(p.apparatus)}` : '')
      .replace('{{ANCHOR}}', esc(p.anchor || p.section || viewName(p)))
      .replace('{{SEED}}', esc(p.seed || title))
      .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal'))
      .replace('{{SEAL}}', esc(site.seal || ''))
      .replace('{{META}}', meta({ site, url: archivePath(p), title,
        description: strip(rich(intro, 1, { ns: 'x' })) }))
      .replace('{{BODY}}', body)
      .replace('{{BACK}}', esc(site.back_label || 'Back'))
      .replace('{{FOOTER}}', footAt(/^footer$/i, 1))
      .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 1))
      .replace('{{SCRIPTS}}', scripts(1)));
    archives++;
  }

  /* --- one page per note ------------------------------------------------- */
  const ntpl = template('note.html', 1, true);
  const secFor = name => sections.find(p => String(p.section || '') === name) || {};
  const own = String(site.title || '').toLowerCase();
  const live = notes.filter(n => n.href);
  const seq = site.nearby === false ? new Map() : sequences(live);

  for (const [kind, k] of Object.entries(KINDS)) {
    const mine = live.filter(n => n.kind === kind);
    const dir = path.join(OUT, k.dir);
    if (!mine.length && !fs.existsSync(dir)) continue;
    fs.mkdirSync(dir, { recursive: true });
    prune(dir, new Set(['index.html', ...mine.map(n => `${n.slug}.html`)]));

    const p = secFor(kind);
    for (const n of mine) {
      let body, kicker;
      resetUses();
      if (k.view === 'takes') {
        const oldestFirst = String(p.takes_order || 'oldest').toLowerCase() !== 'newest';
        body = passageHTML({ n, ...parsePassage(n, oldestFirst) }, p, { depth: 1, here: true });
        kicker = ` · ${esc(k.label)}`;
      } else {
        body = rich(n.body, 1, { ns: n.slug, file: n.file });
        if (k.view === 'strands') {
          /* which column it stands in says more than what kind of note it is */
          const pair = strandPairs(p).find(([sk]) => sk === (n.strand || n.folder));
          kicker = ` · ${esc(((pair && pair[1]) || k.label).trim())}`;
        } else {
          const series = String(n.series || '').toLowerCase() === own ? '' : n.series;
          kicker = [p.page_label === false ? '' : k.label,
            when(n.date, p.date_format, p.date_long === true), series]
            .filter(Boolean).map(x => ` · ${esc(x)}`).join('');
        }
      }

      /* Where else this thing lives: essays are mailed, reading has Wikipedia. */
      const elsewhere = [
        n.url ? `<p class="apparatus">${esc(site.elsewhere_label || 'Published and mailed at')} ` +
          `<a href="${esc(n.url)}">${esc(site.elsewhere_name || 'Ranganaut')}</a></p>` : '',
        n.wikipedia ? `<p class="apparatus">${esc(site.wikipedia_label || 'Read about it at')} ` +
          `<a href="${esc(n.wikipedia)}" rel="noopener">Wikipedia</a></p>` : '',
      ].filter(Boolean).join('\n    ');

      fs.writeFileSync(path.join(dir, `${n.slug}.html`), ntpl
        .replace(/\{\{SITE_TITLE\}\}/g, esc(site.title || ''))
        .replace(/\{\{TITLE\}\}/g, esc(n.name))
        .replace('{{DESCRIPTION}}', esc(n.summary || site.description || ''))
        .replace('{{META}}', meta({ site, url: n.href,
          title: n.name, description: n.summary || site.description }))
        .replace('{{SUMMARY}}', inline(n.summary || ''))
        .replace('{{KICKER}}', kicker || '')
        .replace('{{SEED}}', esc(n.seed || n.name))
        .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal'))
        .replace('{{SEAL}}', esc(site.seal || ''))
        .replace('{{BODY}}', body)
        .replace('{{BACKLINKS}}', tagRow(n, 1) + backlinks(n, site.backlinks_label, 1))
        .replace('{{NEARBY}}', nearby(n, seq, site, 1))
        .replace('{{ELSEWHERE}}', elsewhere)
        .replace('{{BACK}}', esc(site.back_label || 'Back'))
        .replace('{{FOOTER}}', footAt(/^footer$/i, 1))
        .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 1))
        .replace('{{SCRIPTS}}', scripts(1)));
    }
  }

  /* --- a page per tag, and an index of them ------------------------------ */
  const tagDir = path.join(OUT, 'tags');
  const tagPage = (slugName, title, subtitle, body, url) => {
    resetUses();
    fs.writeFileSync(path.join(tagDir, `${slugName}.html`), atpl
      .replace(/\{\{SITE_TITLE\}\}/g, esc(site.title || ''))
      .replace(/\{\{TITLE\}\}/g, esc(title))
      .replace('{{DESCRIPTION}}', esc(strip(subtitle)))
      .replace('{{SUBTITLE}}', subtitle)
      .replace('{{KICKER}}', ` · ${esc(site.tags_kicker || 'Tag')}`)
      .replace('{{ANCHOR}}', 'tag')
      .replace('{{SEED}}', esc(title))
      .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal'))
      .replace('{{SEAL}}', esc(site.seal || ''))
      .replace('{{META}}', meta({ site, url, title, description: strip(subtitle) }))
      .replace('{{BODY}}', body)
      .replace('{{BACK}}', esc(site.back_label || 'Back'))
      .replace('{{FOOTER}}', footAt(/^footer$/i, 1))
      .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 1))
      .replace('{{SCRIPTS}}', ''));
  };
  if (TAGS.size) {
    fs.mkdirSync(tagDir, { recursive: true });
    const names = [...TAGS.keys()].sort((a, b) => a.localeCompare(b));
    prune(tagDir, new Set(['index.html', ...names.map(t => `${slug(t.replace(/\//g, ' '))}.html`)]));
    for (const t of names) {
      const items = [...TAGS.get(t)].map(h => BY_HREF.get(h)).filter(Boolean);
      /* a tag with a slash is a family; the parent gathers its children too */
      const kids = names.filter(x => x !== t && x.startsWith(`${t}/`));
      const under = kids.length
        ? `\n    <div class="tag-kids apparatus">${esc(site.tags_narrower || 'Narrower')}: ` +
          kids.map(k => `<a class="tag" href="${upto(1)}${tagHref(k)}">#${esc(k)}</a>`).join(' ') +
          `</div>` : '';
      tagPage(slug(t.replace(/\//g, ' ')), `#${t}`,
        `${items.length} ${items.length === 1 ? 'note' : 'notes'}`,
        `${noteList(items, 1, site.date_format)}${under}`, tagHref(t));
    }
    /* the index */
    const rows = names.map(t => `      <li><a class="tag" href="${upto(1)}${tagHref(t)}">#${esc(t)}</a>` +
      `<span class="apparatus">${TAGS.get(t).size}</span></li>`).join('\n');
    resetUses();
    fs.writeFileSync(path.join(tagDir, 'index.html'), atpl
      .replace(/\{\{SITE_TITLE\}\}/g, esc(site.title || ''))
      .replace(/\{\{TITLE\}\}/g, esc(site.tags_title || 'Tags'))
      .replace('{{DESCRIPTION}}', esc(site.tags_note || ''))
      .replace('{{SUBTITLE}}', inline(site.tags_note || ''))
      .replace('{{KICKER}}', '')
      .replace('{{ANCHOR}}', 'tags')
      .replace('{{SEED}}', esc(site.tags_title || 'Tags'))
      .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal'))
      .replace('{{SEAL}}', esc(site.seal || ''))
      .replace('{{META}}', meta({ site, url: 'tags', title: site.tags_title || 'Tags',
        description: site.tags_note || '' }))
      .replace('{{BODY}}', `    <ul class="tag-index">\n${rows}\n    </ul>`)
      .replace('{{BACK}}', esc(site.back_label || 'Back'))
      .replace('{{FOOTER}}', footAt(/^footer$/i, 1))
      .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 1))
      .replace('{{SCRIPTS}}', ''));
  }

  /* --- a page per canvas -------------------------------------------------- */
  let canvases = 0;
  const canvasList = extras.filter(x => x.kind === 'canvas');
  if (canvasList.length) {
    const dir = path.join(OUT, EXTRA.canvas.dir);
    fs.mkdirSync(dir, { recursive: true });
    prune(dir, new Set(['index.html', ...canvasList.map(x => `${x.slug}.html`)]));
    for (const x of canvasList) {
      resetUses();
      const body = renderCanvas(x.raw, { depth: 1, stack: [x.file] });
      if (!body) { console.warn(`  ! canvas wouldn't parse or is empty: ${x.rel}`); continue; }
      canvases++;
      /* whatever the note beside it says, above the drawing */
      const intro = x.body && x.body.trim()
        ? `    <div class="sec-note">${rich(x.body, 1, { ns: `${x.slug}-note`, file: x.sidecar || x.file })}</div>\n`
        : '';
      fs.writeFileSync(path.join(dir, `${x.slug}.html`), atpl
        .replace(/\{\{SITE_TITLE\}\}/g, esc(site.title || ''))
        .replace(/\{\{TITLE\}\}/g, esc(x.name))
        .replace('{{DESCRIPTION}}', esc(strip(inline(x.summary || '')) || site.description || ''))
        .replace('{{SUBTITLE}}', inline(x.summary || ''))
        .replace('{{KICKER}}', [site.canvas_label || 'Canvas', when(x.date, site.date_format)]
          .filter(Boolean).map(w => ` · ${esc(w)}`).join(''))
        .replace('{{ANCHOR}}', 'canvas-page')
        .replace('{{SEED}}', esc(x.name))
        .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal'))
        .replace('{{SEAL}}', esc(site.seal || ''))
        .replace('{{META}}', meta({ site, url: x.href, title: x.name,
          description: strip(inline(x.summary || '')) || site.description }))
        .replace('{{BODY}}', `${intro}${body}
    <p class="graph-hint apparatus">${esc(site.canvas_hint ||
      'Drag to move · scroll to come closer · double-click to fit')}</p>
${tagRow(x, 1)}${backlinks(x, site.backlinks_label, 1)}`)
        .replace('{{BACK}}', esc(site.back_label || 'Back'))
        .replace('{{FOOTER}}', footAt(/^footer$/i, 1))
        .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 1))
        .replace('{{SCRIPTS}}', scripts(1)));
    }
  }

  /* --- a page per base ---------------------------------------------------- */
  let bases = 0;
  const baseList = extras.filter(x => x.kind === 'base');
  if (baseList.length) {
    /* every note in a publishing folder is queryable, whether or not it has
       a page of its own; the ones without simply don't get a link */
    const rows = notes.filter(n => KINDS[n.kind]).map(n => ({
      name: n.name, basename: n.title, path: n.rel, ext: 'md',
      folder: path.relative(VAULT, path.dirname(n.file)).split(path.sep).join('/'),
      tags: n.tagList || [], links: LINKS_OUT.get(n.href) || new Set(),
      href: n.href, kind: n.kind,
      props: Object.fromEntries(Object.entries(n).filter(([k, v]) =>
        !['file', 'body', 'raw', 'rel', 'kind', 'href', 'slug', 'tagList', 'folder'].includes(k) &&
        (typeof v !== 'object' || Array.isArray(v)))),
    }));
    const dir = path.join(OUT, EXTRA.base.dir);
    fs.mkdirSync(dir, { recursive: true });
    prune(dir, new Set(['index.html', ...baseList.map(x => `${x.slug}.html`)]));
    for (const x of baseList) {
      const said = new Set();
      const warn = m => { if (!said.has(m)) { said.add(m); console.warn(`  ! ${x.title}.base: ${m}`); } };
      let out;
      try { out = runBase(x.raw, rows, { warn }); }
      catch (e) { console.warn(`  ! base wouldn't read: ${x.rel} — ${e.message}`); continue; }
      bases++;
      resetUses();
      const views = out.views.map(v => `    <div class="bs-view">
${baseView(v, 1, { empty: site.base_empty })}
    </div>`).join('\n');
      const kinds = [...new Set(out.views.map(v => v.type))].join(', ');
      fs.writeFileSync(path.join(dir, `${x.slug}.html`), atpl
        .replace(/\{\{SITE_TITLE\}\}/g, esc(site.title || ''))
        .replace(/\{\{TITLE\}\}/g, esc(x.name))
        .replace('{{DESCRIPTION}}', esc(site.description || ''))
        .replace('{{SUBTITLE}}', '')
        .replace('{{KICKER}}', ` · ${esc(site.base_label || 'Base')} · ${esc(kinds)}`)
        .replace('{{ANCHOR}}', 'base-page')
        .replace('{{SEED}}', esc(x.name))
        .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal'))
        .replace('{{SEAL}}', esc(site.seal || ''))
        .replace('{{META}}', meta({ site, url: x.href, title: x.name,
          description: site.description }))
        .replace('{{BODY}}', `${views}\n${tagRow(x, 1)}${backlinks(x, site.backlinks_label, 1)}`)
        .replace('{{BACK}}', esc(site.back_label || 'Back'))
        .replace('{{FOOTER}}', footAt(/^footer$/i, 1))
        .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 1))
        .replace('{{SCRIPTS}}', ''));
    }
  }

  /* --- the whole vault as a graph ---------------------------------------- */
  let graphed = 0;
  {
    const nodes = live.map(n => ({
      id: n.href, href: `${upto(1)}${n.href}`, kind: n.kind,
      label: strip(inline(n.name)),
    }));
    const seen = new Set(nodes.map(n => n.id));
    const edges = [];
    for (const [to, from] of LINKS)
      for (const f of from) if (seen.has(to) && seen.has(f)) edges.push([f, to]);
    /* a graph with nothing joined up isn't worth a page yet */
    if (site.graph !== false && nodes.length > 1 && edges.length) {
    graphed = nodes.length;
    const dir = path.join(OUT, 'graph');
    fs.mkdirSync(dir, { recursive: true });
    const title = site.graph_title || 'The graph';
    const note = site.graph_note ||
      'Every note that publishes, and every link between them.';
    resetUses();
    fs.writeFileSync(path.join(dir, 'index.html'), atpl
      .replace(/\{\{SITE_TITLE\}\}/g, esc(site.title || ''))
      .replace(/\{\{TITLE\}\}/g, esc(title))
      .replace('{{DESCRIPTION}}', esc(strip(note)))
      .replace('{{SUBTITLE}}', inline(note))
      .replace('{{KICKER}}', ` · ${esc(nodes.length)} notes, ${esc(edges.length)} links`)
      .replace('{{ANCHOR}}', 'graph-page')
      .replace('{{SEED}}', esc(title))
      .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal'))
      .replace('{{SEAL}}', esc(site.seal || ''))
      .replace('{{META}}', meta({ site, url: 'graph', title, description: strip(note) }))
      .replace('{{BODY}}', `    <div id="graph" class="graph"></div>
    <p class="graph-hint apparatus">${esc(site.graph_hint ||
      'Hover to pick one out · click to read it · drag to move · scroll to come closer')}</p>
    <script type="application/json" id="graph-data">${JSON.stringify({ nodes, edges })
      .replace(/</g, '\\u003c')}</script>`)
      .replace('{{BACK}}', esc(site.back_label || 'Back'))
      .replace('{{FOOTER}}', footAt(/^footer$/i, 1))
      .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 1))
      .replace('{{SCRIPTS}}', `<script src="${upto(1)}assets/graph.js"></script>`));
    }
  }

  /* --- what the site ships --------------------------------------------- */
  if (USED_MEDIA.size) {
    fs.mkdirSync(path.join(OUT, 'assets', 'media'), { recursive: true });
    for (const name of USED_MEDIA)
      fs.copyFileSync(MEDIA.get(name), path.join(OUT, 'assets', 'media', name));
  }
  const ASSET_OK = /\.(css|js|png|jpe?g|gif|svg|webp|avif|ico|woff2?|txt|xml|webmanifest)$/i;
  const shipped = new Set(['site.css', 'og.png',
    'favicon.ico', 'apple-touch-icon.png',
    ...(wantsTerrain(site) ? ['terrain.js'] : []),
    ...(fs.existsSync(path.join(THEME, 'theme.css')) ? ['theme.css'] : []),
    ...(NEEDED.mermaid ? ['diagram.js'] : []),
    ...(graphed ? ['graph.js'] : []),
    ...(canvases || NEEDED.canvas ? ['canvas.js'] : []),
    ...String(site.extra_assets || '').split(',').map(x => x.trim()).filter(Boolean)]);
  if (NEEDED.mermaid) {
    fs.copyFileSync(path.join(HERE, 'vendor', 'mermaid.min.js'),
      path.join(OUT, 'assets', 'mermaid.min.js'));
    console.log('  · a page has a diagram, so mermaid.min.js ships with it');
  } else {
    const stale = path.join(OUT, 'assets', 'mermaid.min.js');
    if (fs.existsSync(stale)) { try { fs.unlinkSync(stale); } catch {} }
  }
  const themed = f => {
    const mine = path.join(THEME, f);
    return fs.existsSync(mine) ? mine : path.join(HERE, 'assets', f);
  };
  let skipped = 0, swapped = 0;
  const inBoth = new Set([...fs.readdirSync(path.join(HERE, 'assets')),
    ...(fs.existsSync(THEME) ? fs.readdirSync(THEME) : [])]);
  for (const f of inBoth) {
    if (!ASSET_OK.test(f)) continue;
    if (!shipped.has(f)) { skipped++; continue; }
    const from = themed(f);
    if (from.startsWith(THEME)) swapped++;
    fs.copyFileSync(from, path.join(OUT, 'assets', f));
  }
  if (swapped) console.log(`  · ${swapped} asset${swapped === 1 ? '' : 's'} taken from theme/ instead`);
  const ico = themed('favicon.ico');
  if (fs.existsSync(ico)) fs.copyFileSync(ico, path.join(OUT, 'favicon.ico'));
  if (skipped) console.log(`  · ${skipped} unreferenced asset${skipped === 1 ? '' : 's'} in site/assets not shipped`);

  /* --- the feed ---------------------------------------------------------- */
  let fed = 0;
  if (site.feed !== false && host && feed.length) {
    fs.writeFileSync(path.join(OUT, 'feed.xml'), feedXML({ site, host, items: feed, secFor }));
    fed = feed.length;
  } else {
    const stale = path.join(OUT, 'feed.xml');
    if (fs.existsSync(stale)) { try { fs.unlinkSync(stale); } catch {} }
  }

  /* --- a map, a rule for crawlers, a page for wrong turns --------------- */
  if (host) {
    const urls = ['',
      ...sections.filter(x => x.archive).map(x => archivePath(x)),
      ...live.map(n => n.href),
      ...(TAGS.size ? ['tags', ...[...TAGS.keys()].sort().map(tagHref)] : []),
      ...(graphed ? ['graph'] : [])];   /* note pages already include canvases */
    const today = (site.sitemap_date || new Date().toISOString()).slice(0, 10);
    fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map(u => `  <url><loc>${host}/${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
      `\n</urlset>\n`);
    fs.writeFileSync(path.join(OUT, 'robots.txt'),
      `User-agent: *\nAllow: /\n\nSitemap: ${host}/sitemap.xml\n`);
  }
  fs.writeFileSync(path.join(OUT, '404.html'), itpl
    .replace(/\{\{TITLE\}\}/g, esc(site.title || ''))
    .replace('{{SUBTITLE}}', esc(site.not_found || 'Nothing at this address.'))
    .replace('{{DESCRIPTION}}', '').replace('{{META}}', '<meta name="robots" content="noindex">')
    .replace('{{SEAL_LABEL}}', esc(site.seal_label || 'seal')).replace('{{SEAL}}', esc(site.seal || ''))
    .replace('{{SECTIONS}}', `  <section id="lost">\n    <p class="sec-note">` +
      `<a href="index.html">${esc(site.back_label || 'Back')}</a></p>\n  </section>`)
    .replace('{{FOOTER}}', footAt(/^footer$/i, 0))
    .replace('{{FOOTER_ASIDE}}', footAt(/^footer aside$/i, 0))
    .replace('{{SCRIPTS}}', ''));

  /* --- what the build noticed ------------------------------------------- */
  if (MISSING.size) console.log(`  · ${MISSING.size} link${MISSING.size === 1 ? '' : 's'} to nothing: ${[...MISSING].join(', ')}`);
  if (OFFSTAGE.size) console.log(`  · ${OFFSTAGE.size} link${OFFSTAGE.size === 1 ? '' : 's'} to notes that don't publish: ${[...OFFSTAGE].join(', ')}`);
  for (const [name, why] of UNBUILT)
    console.log(`  · [[${name}]] stayed plain text — ${why}`);
  for (const o of orphans)
    console.log(`  · ${o.note} looks like a note for a drawing but matches none` +
      ` — beside it: ${o.near.join(', ')}`);
  for (const why of [...new Set(withheld.map(w => w.why))]) {
    const these = withheld.filter(w => w.why === why);
    console.log(`  · ${these.length} drawing${these.length === 1 ? '' : 's'} ` +
      `not published, ${why}: ${these.map(w => w.title).join(', ')}`);
  }
  if (undated.length) {
    const few = undated.slice(0, 6).join(', ');
    console.log(`  · ${undated.length} note${undated.length === 1 ? '' : 's'} with no date, ` +
      `so out of the feed: ${few}${undated.length > 6 ? ` and ${undated.length - 6} more` : ''}`);
  }
  if (fed && fed < feedAll) console.log(`  · the feed holds the newest ${fed} of ${feedAll}`);
  const byKind = Object.keys(KINDS)
    .map(k => `${live.filter(n => n.kind === k).length}/${notes.filter(n => n.kind === k).length} ${k}`)
    .join(', ');
  const linked = [...LINKS.values()].reduce((a, s) => a + s.size, 0);
  console.log(`built  ${sections.length} sections  ·  ${byKind}  ·  ` +
    `${archives} archive${archives === 1 ? '' : 's'}, ${live.length} note page${live.length === 1 ? '' : 's'}, ` +
    `${TAGS.size} tag${TAGS.size === 1 ? '' : 's'}, ` +
    `${canvases ? `${canvases} canvas${canvases === 1 ? '' : 'es'}, ` : ''}` +
    `${bases ? `${bases} base${bases === 1 ? '' : 's'}, ` : ''}` +
    `${graphed ? `a graph of ${graphed}, ` : ''}` +
    `${fed ? `a feed of ${fed}, ` : ''}` +
    `${linked} backlink${linked === 1 ? '' : 's'}, ${USED_MEDIA.size} image${USED_MEDIA.size === 1 ? '' : 's'}  ->  ../public/`);
}

/* Rebuild whenever the vault changes. The CLI calls this; nothing else does. */
export function watch(opts = {}) {
  const vault = path.resolve(opts.vault || '.');
  let timer;
  console.log('watching the vault…');
  fs.watch(vault, { recursive: true }, (_e, f) => {
    if (f && /(^|\/)\.|\.(swp|tmp)$/.test(f)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { build(opts); } catch (e) { console.error(e.message); }
    }, 220);
  });
}
