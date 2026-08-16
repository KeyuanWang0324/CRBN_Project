/* Interactive cartoon viewers for the ternary models on this page.
 *
 * This is a thin wrapper around 3Dmol.js, which is vendored alongside this file
 * rather than loaded from a CDN -- the page makes no external requests, so it
 * keeps working offline and cannot break because someone else's host went down.
 *
 * WHY A REAL VIEWER. An earlier version drew the cartoon by hand from C-alpha
 * coordinates. Reproducing what PyMOL does -- ribbon framing, helix smoothing,
 * strand arrows, sheet twist -- by hand produces something recognisably not a
 * cartoon. The structures are now shipped as ordinary PDB files carrying
 * PyMOL's own HELIX/SHEET assignment (see 15_extract_viewer_structures), and a
 * real molecular viewer renders them, so the interactive view matches the
 * static PyMOL renders instead of approximating them.
 *
 * WEBGL CONTEXTS ARE THE CONSTRAINT. Browsers allow only around sixteen live
 * WebGL contexts and this page carries twenty-seven viewers, so they cannot all
 * exist at once: a viewer is created when its record is opened and destroyed
 * when it is closed, and at most MAX_LIVE are kept. Neither 3Dmol.js nor any
 * structure is fetched until the first record is opened.
 */
(function () {
  'use strict';

  var TAG = document.querySelector('script[data-structures]');
  var INDEX_URL = (TAG && TAG.getAttribute('data-structures')) || 'structures.json';
  var LIB_URL = (TAG && TAG.getAttribute('data-lib')) || '3Dmol-min.js';
  var MAX_LIVE = 6;

  var COLORS = { crbn: '#17A67C', ppil4: '#6C82E8' };

  var index = null, indexPromise = null, libPromise = null;
  var live = [];   // [{host, viewer}], oldest first

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (!indexPromise) {
      indexPromise = fetch(INDEX_URL).then(function (r) {
        if (!r.ok) throw new Error('index HTTP ' + r.status);
        return r.json();
      }).then(function (j) { index = j; return j; });
    }
    return indexPromise;
  }

  function loadLib() {
    if (window.$3Dmol) return Promise.resolve(window.$3Dmol);
    if (!libPromise) {
      libPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = LIB_URL;
        s.onload = function () {
          window.$3Dmol ? resolve(window.$3Dmol) : reject(new Error('3Dmol did not initialise'));
        };
        s.onerror = function () { reject(new Error('could not load the 3D library')); };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  function release(host) {
    for (var i = 0; i < live.length; i++) {
      if (live[i].host !== host) continue;
      try {
        live[i].viewer.clear();
        if (live[i].viewer.removeAllModels) live[i].viewer.removeAllModels();
      } catch (e) { /* the context may already be gone */ }
      live.splice(i, 1);
      break;
    }
    host.innerHTML = '<p class="v3d-msg">Reopen to load the 3D model.</p>';
    host.dataset.mounted = '';
  }

  function trim() {
    while (live.length > MAX_LIVE) release(live[0].host);
  }

  function build(host, entry) {
    return fetch(entry.pdb).then(function (r) {
      if (!r.ok) throw new Error('structure HTTP ' + r.status);
      return r.text();
    }).then(function (pdb) {
      host.innerHTML = '';
      var viewer = window.$3Dmol.createViewer(host, {
        backgroundAlpha: 0,
        antialias: true
      });
      viewer.addModel(pdb, 'pdb');

      // Cartoon for the two proteins, ball-and-stick for the ligand. Ligand
      // carbons are amber and heteroatoms keep their element colours, matching
      // the static renders and the legend.
      viewer.setStyle({ chain: 'A' }, { cartoon: { color: COLORS.crbn, arrows: true } });
      viewer.setStyle({ chain: 'B' }, { cartoon: { color: COLORS.ppil4, arrows: true } });
      viewer.setStyle({ chain: 'C' }, {
        stick: { radius: 0.17, colorscheme: 'orangeCarbon' },
        sphere: { scale: 0.21, colorscheme: 'orangeCarbon' }
      });

      // Frame on the ligand -- the interface is what these images are about --
      // then pull back so both proteins stay in shot.
      var ligand = viewer.selectedAtoms({ chain: 'C' });
      if (ligand && ligand.length) {
        viewer.zoomTo({ chain: 'C' });
        viewer.zoom(0.22);
      } else {
        viewer.zoomTo();
      }
      viewer.render();

      live.push({ host: host, viewer: viewer });
      trim();
      return viewer;
    });
  }

  function mount(host) {
    if (host.dataset.mounted) return;
    host.dataset.mounted = '1';
    host.innerHTML = '<p class="v3d-msg">Loading 3D model&hellip;</p>';
    Promise.all([loadIndex(), loadLib()]).then(function (both) {
      var entry = both[0][host.dataset.structure];
      if (!entry) throw new Error('no structure for ' + host.dataset.structure);
      return build(host, entry);
    }).catch(function (err) {
      host.dataset.mounted = '';
      host.innerHTML = '<p class="v3d-msg">Could not load the 3D model (' + err.message +
        '). If you opened this file directly from disk, serve it over http instead.</p>';
    });
  }

  document.addEventListener('toggle', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'DETAILS') return;
    var hosts = el.querySelectorAll('[data-structure]');
    for (var i = 0; i < hosts.length; i++) {
      if (el.open) mount(hosts[i]);
      else release(hosts[i]);
    }
  }, true);
})();
