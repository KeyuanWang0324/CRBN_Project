/* Interactive 3D viewer for the ternary models on this page.
 *
 * Deliberately dependency-free. The page loads no external script, font or
 * stylesheet, and adding a 1-2 MB molecular-graphics library to draw what is
 * essentially a backbone trace and thirty ligand atoms would trade that away
 * for capability this page does not use. What is drawn:
 *
 *   - CRBN (chain A) and PPIL4 (chain B) as C-alpha traces
 *   - the ligand as ball-and-stick, heteroatoms in element colours
 *
 * Rendering is 2D canvas with a painter's algorithm: every segment, bond and
 * atom is projected, sorted back-to-front by depth, and drawn with depth cueing
 * so the far side of the complex recedes. That is cheap enough to stay at 60fps
 * while dragging, and it avoids WebGL context limits -- this page can have
 * twenty-odd viewers on it, and browsers cap simultaneous WebGL contexts at
 * around sixteen.
 *
 * Structures arrive pre-superposed on CRBN (see 15_extract_viewer_structures),
 * so the default camera is meaningful across all of them.
 */
(function () {
  'use strict';

  var DATA_URL = 'structures.json';
  var data = null, loading = null;

  var ELEMENT_COLORS = {
    N: '#3E6FD0', O: '#C6423A', S: '#C9A227', F: '#4FA88B',
    CL: '#4E9A5A', BR: '#9C5A2C', I: '#7A4FA8', P: '#C9772A'
  };

  function loadData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch(DATA_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) { data = json; return json; });
    return loading;
  }

  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    function pick(name, fallback) {
      var v = cs.getPropertyValue(name).trim();
      return v || fallback;
    }
    return {
      crbn: pick('--accent', '#12695E'),
      ppil4: pick('--posc', '#3A579C'),
      ligand: pick('--cross', '#9C6B15'),
      bg: pick('--sunk', '#EDF0EF'),
      hint: pick('--faint', '#8D9795')
    };
  }

  /* --- small vector helpers ------------------------------------------- */
  function multiply(a, b) {
    var out = new Float64Array(9);
    for (var i = 0; i < 3; i++)
      for (var j = 0; j < 3; j++)
        out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return out;
  }
  function rotationX(t) {
    var c = Math.cos(t), s = Math.sin(t);
    return new Float64Array([1, 0, 0, 0, c, -s, 0, s, c]);
  }
  function rotationY(t) {
    var c = Math.cos(t), s = Math.sin(t);
    return new Float64Array([c, 0, s, 0, 1, 0, -s, 0, c]);
  }

  function shade(hex, amount) {
    // amount < 0 darkens toward the background, > 0 lightens.
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    var t = amount < 0 ? 0 : 255, k = Math.abs(amount);
    r = Math.round(r + (t - r) * k); g = Math.round(g + (t - g) * k); b = Math.round(b + (t - b) * k);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function Viewer(host, entry) {
    var canvas = document.createElement('canvas');
    canvas.className = 'v3d-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label',
      'Interactive 3D model. CRBN and PPIL4 backbone traces with the ligand at the interface. ' +
      'Drag to rotate, scroll to zoom.');
    canvas.tabIndex = 0;
    host.innerHTML = '';
    host.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    var rot = multiply(rotationY(0.6), rotationX(-0.35));
    var zoom = 1, panX = 0, panY = 0;
    var colors = themeColors();

    // Flatten every drawable into typed arrays once.
    var pts = [], chains = [];
    function addTrace(flat, kind) {
      var start = pts.length / 3, n = flat.length / 3;
      for (var i = 0; i < flat.length; i++) pts.push(flat[i]);
      if (n > 1) chains.push({ kind: kind, start: start, count: n });
      return start;
    }
    addTrace(entry.a || [], 'crbn');
    addTrace(entry.b || [], 'ppil4');
    var ligStart = pts.length / 3;
    for (var i = 0; i < (entry.lig || []).length; i++) pts.push(entry.lig[i]);
    var ligCount = (entry.lig || []).length / 3;

    var xyz = new Float64Array(pts);
    var n = xyz.length / 3;
    // Centre on the ligand when there is one -- that is the part of the complex
    // the viewer is about -- otherwise on everything.
    var cx = 0, cy = 0, cz = 0, cn = 0;
    var from = ligCount ? ligStart : 0, to = ligCount ? ligStart + ligCount : n;
    for (var i2 = from; i2 < to; i2++) { cx += xyz[i2 * 3]; cy += xyz[i2 * 3 + 1]; cz += xyz[i2 * 3 + 2]; cn++; }
    cx /= cn || 1; cy /= cn || 1; cz /= cn || 1;

    var radius = 1;
    for (var i3 = 0; i3 < n; i3++) {
      var dx = xyz[i3 * 3] - cx, dy = xyz[i3 * 3 + 1] - cy, dz = xyz[i3 * 3 + 2] - cz;
      radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    radius = Math.min(radius, 55); // clip the AlphaFold tails out of the default framing

    var proj = new Float64Array(n * 3);
    var w = 0, h = 0, dpr = 1;

    function resize() {
      var rect = host.getBoundingClientRect();
      if (!rect.width) return false;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = Math.max(260, Math.round(rect.width * 0.62));
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    function draw() {
      if (!w && !resize()) return;
      ctx.clearRect(0, 0, w, h);
      var scale = (Math.min(w, h) * 0.44 / radius) * zoom;
      var ox = w / 2 + panX, oy = h / 2 + panY;

      var minZ = Infinity, maxZ = -Infinity;
      for (var i = 0; i < n; i++) {
        var x = xyz[i * 3] - cx, y = xyz[i * 3 + 1] - cy, z = xyz[i * 3 + 2] - cz;
        var px = rot[0] * x + rot[1] * y + rot[2] * z;
        var py = rot[3] * x + rot[4] * y + rot[5] * z;
        var pz = rot[6] * x + rot[7] * y + rot[8] * z;
        proj[i * 3] = ox + px * scale;
        proj[i * 3 + 1] = oy - py * scale;
        proj[i * 3 + 2] = pz;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      }
      var span = (maxZ - minZ) || 1;

      var items = [];
      for (var c = 0; c < chains.length; c++) {
        var ch = chains[c];
        for (var k = 0; k < ch.count - 1; k++) {
          var a = ch.start + k, b = a + 1;
          // Skip the long jumps AlphaFold tails make; they read as stray lines.
          var dx = xyz[a * 3] - xyz[b * 3], dy = xyz[a * 3 + 1] - xyz[b * 3 + 1], dz = xyz[a * 3 + 2] - xyz[b * 3 + 2];
          if (dx * dx + dy * dy + dz * dz > 30) continue;
          items.push({ t: 0, a: a, b: b, z: (proj[a * 3 + 2] + proj[b * 3 + 2]) / 2, kind: ch.kind });
        }
      }
      var bonds = entry.bonds || [];
      for (var bi = 0; bi < bonds.length; bi++) {
        var ia = ligStart + bonds[bi][0], ib = ligStart + bonds[bi][1];
        items.push({ t: 1, a: ia, b: ib, z: (proj[ia * 3 + 2] + proj[ib * 3 + 2]) / 2 });
      }
      for (var ai = 0; ai < ligCount; ai++) {
        var idx = ligStart + ai;
        items.push({ t: 2, a: idx, z: proj[idx * 3 + 2], el: (entry.el && entry.el[ai]) || 'C' });
      }
      items.sort(function (p, q) { return p.z - q.z; });

      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (var it = 0; it < items.length; it++) {
        var o = items[it];
        var depth = (o.z - minZ) / span;          // 0 far, 1 near
        var cue = -0.55 + depth * 0.55;           // far = washed toward background
        if (o.t === 0) {
          ctx.strokeStyle = shade(o.kind === 'crbn' ? colors.crbn : colors.ppil4, cue);
          ctx.lineWidth = (o.kind === 'crbn' ? 3.4 : 2.6) * (0.65 + depth * 0.5);
          ctx.beginPath();
          ctx.moveTo(proj[o.a * 3], proj[o.a * 3 + 1]);
          ctx.lineTo(proj[o.b * 3], proj[o.b * 3 + 1]);
          ctx.stroke();
        } else if (o.t === 1) {
          ctx.strokeStyle = shade(colors.ligand, cue);
          ctx.lineWidth = 3.2 * (0.7 + depth * 0.5);
          ctx.beginPath();
          ctx.moveTo(proj[o.a * 3], proj[o.a * 3 + 1]);
          ctx.lineTo(proj[o.b * 3], proj[o.b * 3 + 1]);
          ctx.stroke();
        } else {
          var base = ELEMENT_COLORS[o.el] || colors.ligand;
          ctx.fillStyle = shade(base, cue);
          ctx.beginPath();
          ctx.arc(proj[o.a * 3], proj[o.a * 3 + 1], 2.9 * (0.7 + depth * 0.5), 0, 6.2832);
          ctx.fill();
        }
      }
    }

    /* --- interaction --------------------------------------------------- */
    var dragging = false, lastX = 0, lastY = 0, pointer = null;
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true; pointer = e.pointerId; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing');
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== pointer) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      rot = multiply(multiply(rotationY(dx * 0.008), rotationX(dy * 0.008)), rot);
      draw();
    });
    function endDrag(e) {
      if (e && e.pointerId !== pointer) return;
      dragging = false; canvas.classList.remove('grabbing');
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom = Math.min(6, Math.max(0.35, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      draw();
    }, { passive: false });
    canvas.addEventListener('dblclick', function () {
      rot = multiply(rotationY(0.6), rotationX(-0.35)); zoom = 1; panX = panY = 0; draw();
    });
    canvas.addEventListener('keydown', function (e) {
      var step = 0.12, handled = true;
      if (e.key === 'ArrowLeft') rot = multiply(rotationY(-step), rot);
      else if (e.key === 'ArrowRight') rot = multiply(rotationY(step), rot);
      else if (e.key === 'ArrowUp') rot = multiply(rotationX(-step), rot);
      else if (e.key === 'ArrowDown') rot = multiply(rotationX(step), rot);
      else if (e.key === '+' || e.key === '=') zoom = Math.min(6, zoom * 1.12);
      else if (e.key === '-') zoom = Math.max(0.35, zoom / 1.12);
      else if (e.key === '0') { rot = multiply(rotationY(0.6), rotationX(-0.35)); zoom = 1; }
      else handled = false;
      if (handled) { e.preventDefault(); draw(); }
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () { if (resize()) draw(); }).observe(host);
    } else {
      window.addEventListener('resize', function () { if (resize()) draw(); });
    }
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(
      function () { colors = themeColors(); draw(); });

    resize();
    draw();
  }

  function mount(host) {
    if (host.dataset.mounted) return;
    host.dataset.mounted = '1';
    var key = host.dataset.structure;
    loadData().then(function (all) {
      var entry = all[key];
      if (!entry) { host.innerHTML = '<p class="v3d-msg">No structure available.</p>'; return; }
      new Viewer(host, entry);
    }).catch(function (err) {
      host.dataset.mounted = '';
      host.innerHTML = '<p class="v3d-msg">Could not load the 3D data (' + err.message + ').</p>';
    });
  }

  function mountVisible(root) {
    var hosts = (root || document).querySelectorAll('[data-structure]');
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      if (host.offsetParent !== null) mount(host);
    }
  }

  document.addEventListener('toggle', function (e) {
    if (e.target && e.target.tagName === 'DETAILS' && e.target.open) mountVisible(e.target);
  }, true);

  if (document.readyState !== 'loading') mountVisible();
  else document.addEventListener('DOMContentLoaded', function () { mountVisible(); });
})();
