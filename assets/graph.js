/* The vault as a graph, drawn in ink on paper.
 *
 * No library. A plain force layout — springs along the links, repulsion
 * between every pair, a weak pull to the middle — settled over a couple of
 * hundred steps and then left alone. Hover to pick out a note and what it
 * touches; click to go there; drag to move the sheet; scroll to come closer.
 */
(function () {
  var host = document.getElementById('graph');
  var data = document.getElementById('graph-data');
  if (!host || !data) return;

  var G;
  try { G = JSON.parse(data.textContent); } catch (e) { return; }
  if (!G.nodes || !G.nodes.length) return;

  var INK = '#1b1917', INK2 = '#3c3833', GREY = '#7d776e',
      GREY2 = '#a29b90', PAPER = '#f2ede1', RED = '#b42718';
  var KIND = { essay: INK, weather: INK2, passage: INK2, reading: GREY };

  /* a seeded shuffle, so the same vault always draws the same picture */
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var N = G.nodes, E = G.edges || [];
  var index = {};
  N.forEach(function (n, i) { index[n.id] = i; n.deg = 0; });
  var links = [];
  E.forEach(function (e) {
    var a = index[e[0]], b = index[e[1]];
    if (a === undefined || b === undefined || a === b) return;
    links.push([a, b]);
    N[a].deg++; N[b].deg++;
  });

  var r = rng(hash(N.map(function (n) { return n.id; }).join('|')));
  N.forEach(function (n, i) {
    var t = (i / N.length) * Math.PI * 2, rad = 180 + r() * 140;
    n.x = Math.cos(t) * rad + (r() - 0.5) * 60;
    n.y = Math.sin(t) * rad + (r() - 0.5) * 60;
    n.vx = 0; n.vy = 0;
    n.r = 3.6 + Math.min(6, Math.sqrt(n.deg) * 2.1);
  });

  /* --- the layout -------------------------------------------------------- */
  var IDEAL = 96, REPEL = 9000, SPRING = 0.016, CENTRE = 0.0016, DAMP = 0.86;
  function step() {
    var i, j, a, b, dx, dy, d2, d, f;
    for (i = 0; i < N.length; i++) {
      a = N[i];
      for (j = i + 1; j < N.length; j++) {
        b = N[j];
        dx = a.x - b.x; dy = a.y - b.y;
        d2 = dx * dx + dy * dy; if (d2 < 1) { d2 = 1; dx = (r() - 0.5); dy = (r() - 0.5); }
        f = REPEL / d2;
        d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
    }
    for (i = 0; i < links.length; i++) {
      a = N[links[i][0]]; b = N[links[i][1]];
      dx = b.x - a.x; dy = b.y - a.y;
      d = Math.sqrt(dx * dx + dy * dy) || 1;
      f = (d - IDEAL) * SPRING;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    for (i = 0; i < N.length; i++) {
      a = N[i];
      a.vx -= a.x * CENTRE; a.vy -= a.y * CENTRE;
      a.vx *= DAMP; a.vy *= DAMP;
      a.x += a.vx; a.y += a.vy;
    }
  }
  for (var k = 0; k < 320; k++) step();

  /* --- the sheet --------------------------------------------------------- */
  var cv = document.createElement('canvas');
  cv.style.display = 'block'; cv.style.width = '100%';
  cv.style.cursor = 'grab';
  host.appendChild(cv);
  var ctx = cv.getContext('2d');

  var view = { x: 0, y: 0, k: 1 }, dpr = 1, W = 0, H = 0, hot = -1;
  /* a small vault can carry every name at once; a large one would go to mush */
  var SPARSE = N.length <= 45;

  function fit() {
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    N.forEach(function (n) {
      minx = Math.min(minx, n.x); maxx = Math.max(maxx, n.x);
      miny = Math.min(miny, n.y); maxy = Math.max(maxy, n.y);
    });
    var pad = 120;
    var kx = W / Math.max(1, (maxx - minx) + pad * 2);
    var ky = H / Math.max(1, (maxy - miny) + pad * 2);
    view.k = Math.max(0.35, Math.min(1.5, Math.min(kx, ky)));
    view.x = W / 2 - ((minx + maxx) / 2) * view.k;
    view.y = H / 2 - ((miny + maxy) / 2) * view.k;
  }

  function resize(refit) {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = host.clientWidth;
    H = Math.max(360, Math.min(680, Math.round(window.innerHeight * 0.68)));
    cv.style.height = H + 'px';
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    if (refit) fit();
    draw();
  }

  var sx = function (n) { return n.x * view.k + view.x; };
  var sy = function (n) { return n.y * view.k + view.y; };

  var near = {};
  links.forEach(function (l) {
    (near[l[0]] = near[l[0]] || []).push(l[1]);
    (near[l[1]] = near[l[1]] || []).push(l[0]);
  });

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var lit = hot >= 0 ? (near[hot] || []).concat([hot]) : null;
    var on = function (i) { return !lit || lit.indexOf(i) >= 0; };

    ctx.lineWidth = 1;
    links.forEach(function (l) {
      var live = !lit || (l[0] === hot || l[1] === hot);
      ctx.strokeStyle = live ? (lit ? GREY : GREY2) : 'rgba(162,155,144,.22)';
      ctx.beginPath();
      ctx.moveTo(sx(N[l[0]]), sy(N[l[0]]));
      ctx.lineTo(sx(N[l[1]]), sy(N[l[1]]));
      ctx.stroke();
    });

    N.forEach(function (n, i) {
      var x = sx(n), y = sy(n), rr = n.r * Math.max(0.75, Math.min(1.25, view.k));
      ctx.beginPath(); ctx.arc(x, y, rr + 2.4, 0, 6.2832);
      ctx.fillStyle = PAPER; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, rr, 0, 6.2832);
      ctx.fillStyle = i === hot ? RED : (on(i) ? (KIND[n.kind] || GREY) : 'rgba(125,119,110,.28)');
      ctx.fill();
    });

    ctx.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    N.forEach(function (n, i) {
      var show = i === hot || (lit && lit.indexOf(i) >= 0) ||
        (!lit && (SPARSE || n.kind === 'essay' || n.deg >= 3 || view.k > 1.05));
      if (!show) return;
      var y = sy(n) + n.r * Math.max(0.75, view.k) + 6;
      var t = n.label.length > 34 ? n.label.slice(0, 33) + '…' : n.label;
      var w = ctx.measureText(t).width;
      /* a name near the edge slides inward rather than off the sheet */
      var x = Math.max(w / 2 + 6, Math.min(W - w / 2 - 6, sx(n)));
      ctx.fillStyle = 'rgba(242,237,225,.82)';
      ctx.fillRect(x - w / 2 - 3, y - 1, w + 6, 14);
      ctx.fillStyle = i === hot ? RED : INK2;
      ctx.fillText(t, x, y);
    });
  }

  function pick(mx, my) {
    var best = -1, bd = 18 * 18;
    for (var i = 0; i < N.length; i++) {
      var dx = mx - sx(N[i]), dy = my - sy(N[i]), d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  var drag = null;
  cv.addEventListener('mousemove', function (ev) {
    var b = cv.getBoundingClientRect();
    var mx = ev.clientX - b.left, my = ev.clientY - b.top;
    if (drag) {
      view.x += mx - drag.x; view.y += my - drag.y;
      drag.x = mx; drag.y = my; drag.moved = true;
      draw(); return;
    }
    var h = pick(mx, my);
    if (h !== hot) { hot = h; cv.style.cursor = h >= 0 ? 'pointer' : 'grab'; draw(); }
  });
  cv.addEventListener('mouseleave', function () { hot = -1; drag = null; draw(); });
  cv.addEventListener('mousedown', function (ev) {
    var b = cv.getBoundingClientRect();
    drag = { x: ev.clientX - b.left, y: ev.clientY - b.top, moved: false };
    cv.style.cursor = 'grabbing';
  });
  cv.addEventListener('mouseup', function (ev) {
    var moved = drag && drag.moved; drag = null;
    cv.style.cursor = hot >= 0 ? 'pointer' : 'grab';
    if (moved) return;
    var b = cv.getBoundingClientRect();
    var i = pick(ev.clientX - b.left, ev.clientY - b.top);
    if (i >= 0 && N[i].href) location.href = N[i].href;
  });
  cv.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var b = cv.getBoundingClientRect();
    var mx = ev.clientX - b.left, my = ev.clientY - b.top;
    var f = Math.exp(-ev.deltaY * 0.0016);
    var nk = Math.max(0.3, Math.min(3, view.k * f));
    view.x = mx - (mx - view.x) * (nk / view.k);
    view.y = my - (my - view.y) * (nk / view.k);
    view.k = nk;
    draw();
  }, { passive: false });

  /* touch: one finger moves the sheet, two pinch it */
  var t0 = null;
  cv.addEventListener('touchstart', function (ev) {
    if (ev.touches.length === 1) {
      t0 = { x: ev.touches[0].clientX, y: ev.touches[0].clientY, d: 0 };
    } else if (ev.touches.length === 2) {
      var a = ev.touches[0], b2 = ev.touches[1];
      t0 = { d: Math.hypot(a.clientX - b2.clientX, a.clientY - b2.clientY), k: view.k };
    }
  }, { passive: true });
  cv.addEventListener('touchmove', function (ev) {
    if (!t0) return;
    if (ev.touches.length === 1 && !t0.k) {
      view.x += ev.touches[0].clientX - t0.x;
      view.y += ev.touches[0].clientY - t0.y;
      t0.x = ev.touches[0].clientX; t0.y = ev.touches[0].clientY;
      ev.preventDefault(); draw();
    } else if (ev.touches.length === 2 && t0.d) {
      var a = ev.touches[0], b2 = ev.touches[1];
      var d = Math.hypot(a.clientX - b2.clientX, a.clientY - b2.clientY);
      view.k = Math.max(0.3, Math.min(3, t0.k * (d / t0.d)));
      ev.preventDefault(); draw();
    }
  }, { passive: false });
  cv.addEventListener('touchend', function () { t0 = null; }, { passive: true });

  window.addEventListener('resize', function () { resize(false); });
  resize(true);
})();
