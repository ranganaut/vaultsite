/* An Obsidian canvas, read by moving over it rather than by shrinking it.
   The sheet is laid out at its own size and the whole layer is transformed,
   so the text stays vector-sharp at any zoom and links keep working. */
(function () {
  var stages = document.querySelectorAll('.cv-stage');
  for (var s = 0; s < stages.length; s++) wire(stages[s]);

  function wire(stage) {
    var layer = stage.querySelector('.cv-layer');
    if (!layer) return;
    var W = Number(stage.dataset.w) || layer.offsetWidth;
    var H = Number(stage.dataset.h) || layer.offsetHeight;
    var v = { x: 0, y: 0, k: 1 };

    function put() {
      layer.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.k + ')';
    }
    function fit() {
      /* An embed with no height of its own takes the height the drawing needs
         at the width it has been given, within reason. */
      if (stage.dataset.snug) {
        var kk = Math.max(0.2, Math.min(1, stage.clientWidth / W));
        var cap = Math.min(window.innerHeight * 0.6, 460);
        stage.style.height = Math.max(180, Math.min(Math.round(H * kk), cap)) + 'px';
      }
      var w = stage.clientWidth, h = stage.clientHeight;
      v.k = Math.max(0.2, Math.min(1, Math.min(w / W, h / H)));
      v.x = (w - W * v.k) / 2;
      v.y = (h - H * v.k) / 2;
      put();
    }

    var drag = null;
    stage.addEventListener('mousedown', function (ev) {
      if (ev.target.closest('a')) return;
      drag = { x: ev.clientX - v.x, y: ev.clientY - v.y };
      stage.classList.add('cv-moving');
      ev.preventDefault();
    });
    window.addEventListener('mousemove', function (ev) {
      if (!drag) return;
      v.x = ev.clientX - drag.x; v.y = ev.clientY - drag.y; put();
    });
    window.addEventListener('mouseup', function () {
      drag = null; stage.classList.remove('cv-moving');
    });
    stage.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var b = stage.getBoundingClientRect();
      var mx = ev.clientX - b.left, my = ev.clientY - b.top;
      var nk = Math.max(0.15, Math.min(2.5, v.k * Math.exp(-ev.deltaY * 0.0016)));
      v.x = mx - (mx - v.x) * (nk / v.k);
      v.y = my - (my - v.y) * (nk / v.k);
      v.k = nk; put();
    }, { passive: false });
    stage.addEventListener('dblclick', function (ev) {
      if (ev.target.closest('a')) return;
      fit();
    });

    /* touch: one finger moves, two pinch */
    var t = null;
    stage.addEventListener('touchstart', function (ev) {
      if (ev.touches.length === 1) t = { x: ev.touches[0].clientX - v.x, y: ev.touches[0].clientY - v.y };
      else if (ev.touches.length === 2) {
        var a = ev.touches[0], b = ev.touches[1];
        t = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), k: v.k };
      }
    }, { passive: true });
    stage.addEventListener('touchmove', function (ev) {
      if (!t) return;
      if (ev.touches.length === 1 && !t.k) {
        v.x = ev.touches[0].clientX - t.x; v.y = ev.touches[0].clientY - t.y;
        ev.preventDefault(); put();
      } else if (ev.touches.length === 2 && t.d) {
        var a = ev.touches[0], b = ev.touches[1];
        v.k = Math.max(0.15, Math.min(2.5,
          t.k * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / t.d)));
        ev.preventDefault(); put();
      }
    }, { passive: false });
    stage.addEventListener('touchend', function () { t = null; }, { passive: true });

    window.addEventListener('resize', fit);
    fit();
  }
})();
