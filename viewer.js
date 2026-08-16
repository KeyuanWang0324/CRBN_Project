/* Interactive cartoon viewer for the ternary models on this page.
 *
 * Deliberately dependency-free. The page loads no external script, font or
 * stylesheet, and a 1-2 MB molecular-graphics library to draw a cartoon and
 * thirty ligand atoms is a poor trade. There is also a hard reason: browsers
 * cap simultaneous WebGL contexts at around sixteen, and this page carries
 * twenty-seven viewers, so a WebGL library would start dropping them.
 *
 * WHAT IT DRAWS. A cartoon in the PyMOL sense: helices and strands as wide
 * ribbons, loops as thin tubes, strands finished with an arrowhead, and the
 * ligand as ball-and-stick with heteroatoms in element colours. Secondary
 * structure comes from PyMOL's own `dss` (see 15_extract_viewer_structures),
 * so the interactive cartoon and the static renders agree about what is a helix.
 *
 * HOW. Each residue contributes a C-alpha and a ribbon side-vector derived from
 * its carbonyl oxygen -- that is what stops the ribbon twisting arbitrarily, and
 * it is why the O is carried in the data at all. Helix C-alphas are smoothed to
 * flatten the corkscrew into a ribbon, the backbone is subdivided with a
 * Catmull-Rom spline so the ribbon curves rather than kinking at every residue,
 * and the resulting quads are drawn back-to-front with depth cueing.
 */
(function () {
  'use strict';

  var DATA_URL = 'structures.json';
  var data = null, loading = null;

  /* Palette. Chain colours are chosen to be unmistakable from each other and
   * from the ligand at a glance, and to hold up on both the light and dark
   * theme -- so they are set here rather than inherited from the page accent,
   * which is close enough to the CRBN green to blur the two. */
  var COLORS = {
    crbn: '#17A67C',        // CRBN  - emerald
    ppil4: '#6C82E8',       // PPIL4 - periwinkle
    ligand: '#F2913D'       // ligand carbon - amber
  };
  var ELEMENT_COLORS = {
    N: '#3D6FE0', O: '#E0483C', S: '#D9A62E', F: '#5FBFA0',
    CL: '#4FA85F', BR: '#B06A34', I: '#8A5FC0', P: '#E07A2E'
  };
  var WIDTH = { H: 1.75, S: 1.85, L: 0.38 };   // ribbon half-width, Angstrom
  var ARROW = 2.95;                            // strand arrowhead half-width
  var SUBDIV = 4;                              // spline samples per residue

  function loadData() {
    if (data) return Promise.resolve(data);
    if (loading) return loading;
    loading = fetch(DATA_URL).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) { data = j; return j; });
    return loading;
  }

  /* --- maths ---------------------------------------------------------- */
  function multiply(a, b) {
    var o = new Float64Array(9);
    for (var i = 0; i < 3; i++)
      for (var j = 0; j < 3; j++)
        o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return o;
  }
  function rotX(t) { var c = Math.cos(t), s = Math.sin(t); return new Float64Array([1, 0, 0, 0, c, -s, 0, s, c]); }
  function rotY(t) { var c = Math.cos(t), s = Math.sin(t); return new Float64Array([c, 0, s, 0, 1, 0, -s, 0, c]); }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function norm(v) {
    var d = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / d, v[1] / d, v[2] / d];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function shade(hex, amount) {
    var h = hex.replace('#', '');
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    var t = amount < 0 ? 0 : 255, k = Math.abs(amount);
    return 'rgb(' + Math.round(r + (t - r) * k) + ',' + Math.round(g + (t - g) * k) + ',' +
      Math.round(b + (t - b) * k) + ')';
  }

  function catmull(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t, out = [0, 0, 0];
    for (var i = 0; i < 3; i++) {
      out[i] = 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t +
        (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
        (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
    }
    return out;
  }

  /* Turn one chain's {ca, o, ss} into a list of ribbon cross-sections. */
  function buildRibbon(chain) {
    var ca = chain.ca || [], ss = chain.ss || '';
    var n = ca.length / 3;
    if (n < 3) return [];

    var P = [], O = [];
    for (var i = 0; i < n; i++) {
      P.push([ca[i * 3], ca[i * 3 + 1], ca[i * 3 + 2]]);
      O.push([chain.o[i * 3], chain.o[i * 3 + 1], chain.o[i * 3 + 2]]);
    }

    // Break the chain wherever consecutive C-alphas are too far apart to be
    // bonded -- otherwise disordered tails get joined by long straight bars.
    var breaks = new Array(n).fill(false);
    for (var i2 = 0; i2 < n - 1; i2++) {
      var d = sub(P[i2 + 1], P[i2]);
      if (dot(d, d) > 26) breaks[i2] = true;
    }

    // Flatten the helical corkscrew so helices read as ribbons, not springs.
    var S = P.map(function (p) { return p.slice(); });
    for (var pass = 0; pass < 2; pass++) {
      var next = S.map(function (p) { return p.slice(); });
      for (var i3 = 1; i3 < n - 1; i3++) {
        if (ss[i3] !== 'H' || breaks[i3] || breaks[i3 - 1]) continue;
        for (var k = 0; k < 3; k++) next[i3][k] = (S[i3 - 1][k] + 2 * S[i3][k] + S[i3 + 1][k]) / 4;
      }
      S = next;
    }

    // Ribbon side vector per residue, flipped to stay continuous.
    var side = [], prev = null;
    for (var i4 = 0; i4 < n; i4++) {
      var fwd = i4 < n - 1 ? sub(S[i4 + 1], S[i4]) : sub(S[i4], S[i4 - 1]);
      var s = norm(cross(fwd, sub(O[i4], P[i4])));
      if (prev && dot(s, prev) < 0) s = [-s[0], -s[1], -s[2]];
      prev = s;
      side.push(s);
    }

    // Widths, with an arrowhead on the last two residues of each strand.
    var width = [];
    for (var i5 = 0; i5 < n; i5++) width.push(WIDTH[ss[i5]] !== undefined ? WIDTH[ss[i5]] : WIDTH.L);
    for (var i6 = 0; i6 < n; i6++) {
      if (ss[i6] === 'S' && (i6 === n - 1 || ss[i6 + 1] !== 'S' || breaks[i6])) {
        width[i6] = 0.25;
        if (i6 > 0 && ss[i6 - 1] === 'S') width[i6 - 1] = ARROW;
      }
    }

    // Subdivide so the ribbon curves instead of kinking at each residue.
    var samples = [];
    for (var i7 = 0; i7 < n - 1; i7++) {
      if (breaks[i7]) { samples.push(null); continue; }   // null = pen up
      var p0 = S[Math.max(0, i7 - 1)], p1 = S[i7], p2 = S[i7 + 1], p3 = S[Math.min(n - 1, i7 + 2)];
      for (var t = 0; t < SUBDIV; t++) {
        var u = t / SUBDIV;
        var pos = catmull(p0, p1, p2, p3, u);
        var sd = norm([
          side[i7][0] + (side[i7 + 1][0] - side[i7][0]) * u,
          side[i7][1] + (side[i7 + 1][1] - side[i7][1]) * u,
          side[i7][2] + (side[i7 + 1][2] - side[i7][2]) * u
        ]);
        var wd = width[i7] + (width[i7 + 1] - width[i7]) * u;
        samples.push({ p: pos, s: sd, w: wd, ss: ss[i7] || 'L' });
      }
    }
    samples.push({ p: S[n - 1], s: side[n - 1], w: width[n - 1], ss: ss[n - 1] || 'L' });
    return samples;
  }

  function Viewer(host, entry) {
    var canvas = document.createElement('canvas');
    canvas.className = 'v3d-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label',
      'Interactive 3D cartoon. CRBN and PPIL4 shown as ribbons with the ligand at the interface. ' +
      'Drag to rotate, scroll to zoom, double-click to reset.');
    canvas.tabIndex = 0;
    host.innerHTML = '';
    host.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    var ribbons = [
      { kind: 'crbn', s: buildRibbon(entry.a || {}) },
      { kind: 'ppil4', s: buildRibbon(entry.b || {}) }
    ];
    var lig = entry.lig || [], el = entry.el || [], bonds = entry.bonds || [];

    // Centre on the ligand -- the part of the complex the viewer is about.
    var cx = 0, cy = 0, cz = 0, cn = lig.length / 3;
    for (var i = 0; i < cn; i++) { cx += lig[i * 3]; cy += lig[i * 3 + 1]; cz += lig[i * 3 + 2]; }
    if (!cn) {
      ribbons.forEach(function (r) {
        r.s.forEach(function (x) { if (x) { cx += x.p[0]; cy += x.p[1]; cz += x.p[2]; cn++; } });
      });
    }
    cx /= cn || 1; cy /= cn || 1; cz /= cn || 1;

    var radius = 12;
    ribbons.forEach(function (r) {
      r.s.forEach(function (x) {
        if (!x) return;
        var d = Math.hypot(x.p[0] - cx, x.p[1] - cy, x.p[2] - cz);
        if (d < 60) radius = Math.max(radius, d);      // ignore far AlphaFold tails when framing
      });
    });

    var rot = multiply(rotY(0.6), rotX(-0.35));
    var zoom = 1, w = 0, h = 0, dpr = 1;

    function resize() {
      var rect = host.getBoundingClientRect();
      if (!rect.width) return false;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = Math.max(280, Math.round(rect.width * 0.66));
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return true;
    }

    function project(p, scale, ox, oy) {
      var x = p[0] - cx, y = p[1] - cy, z = p[2] - cz;
      return [
        ox + (rot[0] * x + rot[1] * y + rot[2] * z) * scale,
        oy - (rot[3] * x + rot[4] * y + rot[5] * z) * scale,
        rot[6] * x + rot[7] * y + rot[8] * z
      ];
    }

    function draw() {
      if (!w && !resize()) return;
      ctx.clearRect(0, 0, w, h);
      var scale = (Math.min(w, h) * 0.44 / radius) * zoom;
      var ox = w / 2, oy = h / 2;
      var items = [], minZ = Infinity, maxZ = -Infinity;

      ribbons.forEach(function (r) {
        for (var i = 0; i < r.s.length - 1; i++) {
          var a = r.s[i], b = r.s[i + 1];
          if (!a || !b) continue;
          var a1 = project([a.p[0] + a.s[0] * a.w, a.p[1] + a.s[1] * a.w, a.p[2] + a.s[2] * a.w], scale, ox, oy);
          var a2 = project([a.p[0] - a.s[0] * a.w, a.p[1] - a.s[1] * a.w, a.p[2] - a.s[2] * a.w], scale, ox, oy);
          var b1 = project([b.p[0] + b.s[0] * b.w, b.p[1] + b.s[1] * b.w, b.p[2] + b.s[2] * b.w], scale, ox, oy);
          var b2 = project([b.p[0] - b.s[0] * b.w, b.p[1] - b.s[1] * b.w, b.p[2] - b.s[2] * b.w], scale, ox, oy);
          var z = (a1[2] + a2[2] + b1[2] + b2[2]) / 4;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          items.push({ t: 0, kind: r.kind, ss: a.ss, quad: [a1, b1, b2, a2], z: z });
        }
      });
      for (var bi = 0; bi < bonds.length; bi++) {
        var ia = bonds[bi][0], ib = bonds[bi][1];
        var pa = project([lig[ia * 3], lig[ia * 3 + 1], lig[ia * 3 + 2]], scale, ox, oy);
        var pb = project([lig[ib * 3], lig[ib * 3 + 1], lig[ib * 3 + 2]], scale, ox, oy);
        var z2 = (pa[2] + pb[2]) / 2;
        if (z2 < minZ) minZ = z2; if (z2 > maxZ) maxZ = z2;
        items.push({ t: 1, a: pa, b: pb, z: z2 });
      }
      for (var ai = 0; ai < lig.length / 3; ai++) {
        var pp = project([lig[ai * 3], lig[ai * 3 + 1], lig[ai * 3 + 2]], scale, ox, oy);
        if (pp[2] < minZ) minZ = pp[2]; if (pp[2] > maxZ) maxZ = pp[2];
        items.push({ t: 2, a: pp, z: pp[2], el: (el[ai] || 'C').toUpperCase() });
      }
      var span = (maxZ - minZ) || 1;
      items.sort(function (p, q) { return p.z - q.z; });

      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (var it = 0; it < items.length; it++) {
        var o = items[it];
        var depth = (o.z - minZ) / span;
        var cue = -0.5 + depth * 0.62;
        if (o.t === 0) {
          var base = o.kind === 'crbn' ? COLORS.crbn : COLORS.ppil4;
          ctx.fillStyle = shade(base, cue);
          ctx.beginPath();
          ctx.moveTo(o.quad[0][0], o.quad[0][1]);
          for (var q = 1; q < 4; q++) ctx.lineTo(o.quad[q][0], o.quad[q][1]);
          ctx.closePath();
          ctx.fill();
          if (o.ss !== 'L') {                       // edge definition on ribbons only
            ctx.strokeStyle = shade(base, cue - 0.32);
            ctx.lineWidth = 0.7;
            ctx.stroke();
          }
        } else if (o.t === 1) {
          ctx.strokeStyle = shade(COLORS.ligand, cue);
          ctx.lineWidth = 3.4 * (0.7 + depth * 0.5);
          ctx.beginPath(); ctx.moveTo(o.a[0], o.a[1]); ctx.lineTo(o.b[0], o.b[1]); ctx.stroke();
        } else {
          ctx.fillStyle = shade(ELEMENT_COLORS[o.el] || COLORS.ligand, cue);
          ctx.beginPath();
          ctx.arc(o.a[0], o.a[1], 3.1 * (0.7 + depth * 0.5), 0, 6.2832);
          ctx.fill();
        }
      }
    }

    /* --- interaction --------------------------------------------------- */
    var dragging = false, lastX = 0, lastY = 0, pid = null;
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true; pid = e.pointerId; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing');
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging || e.pointerId !== pid) return;
      rot = multiply(multiply(rotY((e.clientX - lastX) * 0.008), rotX((e.clientY - lastY) * 0.008)), rot);
      lastX = e.clientX; lastY = e.clientY;
      draw();
    });
    function end(e) { if (e && e.pointerId !== pid) return; dragging = false; canvas.classList.remove('grabbing'); }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoom = Math.min(8, Math.max(0.3, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      draw();
    }, { passive: false });
    function reset() { rot = multiply(rotY(0.6), rotX(-0.35)); zoom = 1; draw(); }
    canvas.addEventListener('dblclick', reset);
    canvas.addEventListener('keydown', function (e) {
      var step = 0.12, handled = true;
      if (e.key === 'ArrowLeft') rot = multiply(rotY(-step), rot);
      else if (e.key === 'ArrowRight') rot = multiply(rotY(step), rot);
      else if (e.key === 'ArrowUp') rot = multiply(rotX(-step), rot);
      else if (e.key === 'ArrowDown') rot = multiply(rotX(step), rot);
      else if (e.key === '+' || e.key === '=') zoom = Math.min(8, zoom * 1.12);
      else if (e.key === '-') zoom = Math.max(0.3, zoom / 1.12);
      else if (e.key === '0') { reset(); return; }
      else handled = false;
      if (handled) { e.preventDefault(); draw(); }
    });

    if (window.ResizeObserver) new ResizeObserver(function () { if (resize()) draw(); }).observe(host);
    else window.addEventListener('resize', function () { if (resize()) draw(); });

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
      host.innerHTML = '<p class="v3d-msg">Could not load the 3D data (' + err.message +
        '). If you are opening this file directly from disk, serve it over http instead.</p>';
    });
  }

  function mountVisible(root) {
    var hosts = (root || document).querySelectorAll('[data-structure]');
    for (var i = 0; i < hosts.length; i++) if (hosts[i].offsetParent !== null) mount(hosts[i]);
  }

  document.addEventListener('toggle', function (e) {
    if (e.target && e.target.tagName === 'DETAILS' && e.target.open) mountVisible(e.target);
  }, true);

  if (document.readyState !== 'loading') mountVisible();
  else document.addEventListener('DOMContentLoaded', function () { mountVisible(); });
})();
