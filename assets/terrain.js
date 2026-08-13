/* ------------------------------------------------------------------ terrain
   One landform, seeded from the page title, drawn as receding ink planes.
   Every page in the site gets a different slice of the same kind of ground. */
(function () {
  const canvas = document.getElementById('terrain');
  const PAPER = [242, 237, 225];

  function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
  function hash(str){let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}

  /* 1-D value noise with cubic interpolation */
  function noise1(rand, n){const p=new Float64Array(n);for(let i=0;i<n;i++)p[i]=rand()*2-1;
    return function(x){
      const i=Math.floor(x), f=x-i,
        a=p[((i-1)%n+n)%n], b=p[(i%n+n)%n], c=p[((i+1)%n+n)%n], d=p[((i+2)%n+n)%n];
      /* catmull-rom */
      return 0.5*((2*b)+(-a+c)*f+(2*a-5*b+4*c-d)*f*f+(-a+3*b-3*c+d)*f*f*f);};}

  function fbm1(seed){
    const rand = mulberry32(seed);
    const layers = [];
    let freq = 1.0, amp = 1, total = 0;
    for (let o = 0; o < 4; o++){
      layers.push({n: noise1(rand, 64), freq, amp});
      total += amp; freq *= 2.1; amp *= 0.46;
    }
    return function(x){
      let v = 0;
      for (const L of layers) v += L.amp * (1 - Math.abs(L.n(x * L.freq)));
      return v / total;
    };
  }

  function draw(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const seed = hash(canvas.dataset.seed || document.title || 'sinosophy');

    /* planes: far and pale at the top, near and dark at the foot */
    const planes = [
      {base:0.40, amp:0.150, val:196, floor:0.34, fade:0.34, op:0.55},
      {base:0.52, amp:0.180, val:168, floor:0.26, fade:0.28, op:0.68},
      {base:0.645,amp:0.195, val:130, floor:0.17, fade:0.22, op:0.82},
      {base:0.745,amp:0.190, val: 82, floor:0.09, fade:0.15, op:0.92},
      {base:0.895,amp:0.130, val: 32, floor:0.05, fade:0.10, op:1.00},
    ];

    planes.forEach((P, i) => {
      const prof = fbm1(seed + i * 7919);
      const crest = new Float64Array(w);
      let lo = Infinity, hi = -Infinity;
      for (let x = 0; x < w; x++){
        const v = prof(x / w * 1.45 + i * 3.1);
        crest[x] = v; if (v < lo) lo = v; if (v > hi) hi = v;
      }
      /* box-blur the crest: wet paper does not hold a jagged edge */
      const sm = new Float64Array(w), R = Math.max(2, Math.round(w * 0.006));
      for (let x = 0; x < w; x++){
        let acc = 0, n = 0;
        for (let k = -R; k <= R; k++){ const j = x + k; if (j >= 0 && j < w){ acc += crest[j]; n++; } }
        sm[x] = acc / n;
      }
      crest.set(sm);
      const fadePx = Math.max(24, h * P.fade);
      for (let x = 0; x < w; x++){
        const t = (crest[x] - lo) / (hi - lo || 1);
        const y = h * P.base - t * h * P.amp;
        const grad = g.createLinearGradient(0, y, 0, y + fadePx);
        grad.addColorStop(0,   `rgba(${P.val},${P.val},${P.val},${P.op})`);
        grad.addColorStop(1,   `rgba(${P.val},${P.val},${P.val},${P.op * P.floor})`);
        g.fillStyle = grad;
        g.fillRect(x, y, 1.02, h - y);
      }
      /* mist lifts the foot of each plane and eats the edges of the next */
      if (i < planes.length - 1){
        const N = planes[i + 1];
        const c = h * N.base - h * N.amp * 0.55;
        const band = g.createLinearGradient(0, c - h * 0.085, 0, c + h * 0.085);
        band.addColorStop(0,   `rgba(${PAPER},0)`);
        band.addColorStop(0.5, `rgba(${PAPER},${0.88 - 0.10 * i})`);
        band.addColorStop(1,   `rgba(${PAPER},0)`);
        g.fillStyle = band;
        g.fillRect(0, c - h * 0.085, w, h * 0.17);
      }
    });

    /* the foot of the sheet dissolves into the page below it */
    const foot = g.createLinearGradient(0, h * 0.86, 0, h);
    foot.addColorStop(0, `rgba(${PAPER},0)`);
    foot.addColorStop(1, `rgba(${PAPER},1)`);
    g.fillStyle = foot; g.fillRect(0, h * 0.86, w, h * 0.14 + 1);

    /* the sheet fades into its own top edge, so the title sits on paper */
    const top = g.createLinearGradient(0, 0, 0, h * 0.30);
    top.addColorStop(0, `rgba(${PAPER},1)`);
    top.addColorStop(1, `rgba(${PAPER},0)`);
    g.fillStyle = top; g.fillRect(0, 0, w, h * 0.30);

    /* paper grain, composited rather than stamped over the drawing */
    const gw = Math.ceil(w), gh = Math.ceil(h);
    const off = document.createElement('canvas');
    off.width = gw; off.height = gh;
    const og = off.getContext('2d');
    const grain = og.createImageData(gw, gh);
    const rand = mulberry32(seed ^ 0x9e3779b9);
    for (let p = 0; p < grain.data.length; p += 4){
      const v = rand() * 255;
      grain.data[p] = grain.data[p+1] = grain.data[p+2] = v;
      grain.data[p+3] = 255;
    }
    og.putImageData(grain, 0, 0);
    g.save();
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = 0.055;
    g.drawImage(off, 0, 0, w, h);
    g.restore();
  }

  draw();
  let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 180); });
})();
