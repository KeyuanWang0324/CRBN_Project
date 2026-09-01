/* Interactive viewers for the ternary models on this page.
 *
 * These show PyMOL's OWN cartoon geometry. Each structure is a binary glTF
 * exported straight out of PyMOL (see 16_export_pymol_gltf) -- PyMOL's
 * triangles, PyMOL's ribbon framing, PyMOL's vertex colours -- rendered here
 * with three.js. Nothing is rebuilt from coordinates, so what you rotate is the
 * same surface PyMOL would ray-trace, not a viewer's reconstruction of it.
 *
 * three.js and its loaders are vendored under lib/ rather than loaded from a
 * CDN, so the page makes no external request and keeps working offline.
 *
 * WEBGL CONTEXTS ARE THE CONSTRAINT. Browsers allow only around sixteen live
 * contexts and this page carries twenty-seven viewers, so they cannot all
 * exist: a viewer is built when its record is opened and fully disposed when it
 * is closed, with at most MAX_LIVE kept. Geometry, materials and the renderer
 * are all released explicitly -- three.js does not free GPU memory on garbage
 * collection, so skipping that leaks until the context is lost.
 *
 * Nothing is fetched until the first record is opened: not the library, not any
 * mesh.
 */
(function () {
  'use strict';

  var TAG = document.querySelector('script[data-structures]');
  var INDEX_URL = (TAG && TAG.getAttribute('data-structures')) || 'structures.json';
  var LIB_DIR = (TAG && TAG.getAttribute('data-lib')) || 'lib';
  var LIB_V = (TAG && TAG.getAttribute('data-libv')) || '';
  var MAX_LIVE = 4;

  var index = null, indexPromise = null, libPromise = null;
  var live = [];

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

  function script(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function loadLib() {
    if (window.THREE && window.THREE.GLTFLoader && window.THREE.OrbitControls) {
      return Promise.resolve();
    }
    if (!libPromise) {
      var v = LIB_V ? '?v=' + LIB_V : '';
      // GLTFLoader and OrbitControls attach themselves to THREE, so the core
      // build has to finish first.
      libPromise = script(LIB_DIR + '/three.min.js' + v).then(function () {
        return Promise.all([
          script(LIB_DIR + '/GLTFLoader.js' + v),
          script(LIB_DIR + '/OrbitControls.js' + v)
        ]);
      });
    }
    return libPromise;
  }

  function dispose(rec) {
    if (rec.stop) rec.stop();
    if (rec.controls) rec.controls.dispose();
    if (rec.scene) {
      rec.scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
            if (m.map) m.map.dispose();
            m.dispose();
          });
        }
      });
    }
    if (rec.renderer) {
      rec.renderer.dispose();
      rec.renderer.forceContextLoss();
      if (rec.renderer.domElement && rec.renderer.domElement.parentNode) {
        rec.renderer.domElement.parentNode.removeChild(rec.renderer.domElement);
      }
    }
  }

  function release(host) {
    for (var i = 0; i < live.length; i++) {
      if (live[i].host !== host) continue;
      try { dispose(live[i]); } catch (e) { /* context may already be gone */ }
      live.splice(i, 1);
      break;
    }
    host.innerHTML = '<p class="v3d-msg">Reopen to load the 3D model.</p>';
    host.dataset.mounted = '';
  }

  function trim() {
    // Evict the oldest NON-pinned viewer. The hero is pinned: it is on screen the
    // whole time, so letting the LRU reclaim it would blank the top of the page
    // as soon as a few records were opened.
    while (live.filter(function (r) { return !r.pinned; }).length > MAX_LIVE) {
      for (var i = 0; i < live.length; i++) {
        if (!live[i].pinned) { release(live[i].host); break; }
      }
    }
  }

  function build(host, entry) {
    var THREE = window.THREE;
    return new Promise(function (resolve, reject) {
      new THREE.GLTFLoader().load(entry.mesh, resolve, null, function () {
        reject(new Error('could not load the model'));
      });
    }).then(function (gltf) {
      host.innerHTML = '';
      var width = host.clientWidth || 600;
      var height = Math.max(300, Math.round(width * 0.66));

      var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.domElement.className = 'v3d-canvas';
      host.appendChild(renderer.domElement);

      var scene = new THREE.Scene();
      var root = gltf.scene;

      // PyMOL bakes colour into COLOR_0; make sure the materials actually use it
      // and are lit from both sides, since cartoon ribbons are open surfaces.
      root.traverse(function (o) {
        if (!o.isMesh) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) {
          m.vertexColors = true;
          m.side = THREE.DoubleSide;
          m.metalness = 0.0;
          m.roughness = 0.9;
          m.flatShading = false;
        });
      });
      scene.add(root);

      // Orbit the drug. 16 records each structure's own ligand centre, so this
      // is exact for every one of them rather than approximately right: the one
      // shared translation puts only the REFERENCE structure's ligand on the
      // origin, leaving the others a few angstrom off and 9DWV's -- a different
      // molecule -- off again. Framing on the mesh's bounding box instead would
      // centre on the midpoint of a sprawling AlphaFold model and push the
      // ligand, the subject, off to one side.
      var c = entry.centre || [0, 0, 0];
      var centre = new THREE.Vector3(c[0], c[1], c[2]);
      // Larger radius = the complex sits smaller in frame. The hero asks for a
      // wider framing than the records, via data-radius.
      var radius = parseFloat(host.getAttribute('data-radius')) || 34;

      function home() {
        return new THREE.Vector3(centre.x + radius * 1.1, centre.y + radius * 0.55,
                                 centre.z + radius * 1.9);
      }
      var camera = new THREE.PerspectiveCamera(35, width / height, radius * 0.02, radius * 60);
      camera.position.copy(home());
      camera.lookAt(centre);

      scene.add(new THREE.AmbientLight(0xffffff, 0.46));
      var key = new THREE.DirectionalLight(0xffffff, 0.4);
      key.position.set(1, 1, 1.4);
      camera.add(key);
      var fill = new THREE.DirectionalLight(0xffffff, 0.14);
      fill.position.set(-1, -0.6, -1);
      camera.add(fill);
      scene.add(camera);

      var controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.target.copy(centre);
      // A slow drift makes the hero read as a live model rather than a picture.
      // It stops for good the moment the reader takes hold of it -- fighting a
      // spin you are trying to steer is worse than no spin at all.
      if (host.hasAttribute('data-autorotate')) {
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.55;
        controls.addEventListener('start', function () { controls.autoRotate = false; });
      }
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.rotateSpeed = 0.9;
      controls.zoomSpeed = 0.9;
      controls.minDistance = radius * 0.25;
      controls.maxDistance = radius * 14;
      controls.update();

      var running = true;
      function frame() {
        if (!running) return;
        controls.update();
        renderer.render(scene, camera);
        requestAnimationFrame(frame);
      }
      frame();

      function onResize() {
        var w = host.clientWidth || width;
        var h = Math.max(300, Math.round(w * 0.66));
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      }
      var ro = window.ResizeObserver ? new ResizeObserver(onResize) : null;
      if (ro) ro.observe(host); else window.addEventListener('resize', onResize);

      renderer.domElement.addEventListener('dblclick', function () {
        camera.position.copy(home());
        controls.target.copy(centre);
        controls.update();
      });

      live.push({
        host: host, renderer: renderer, scene: scene, controls: controls,
        pinned: host.hasAttribute('data-persist'),
        stop: function () { running = false; if (ro) ro.disconnect(); }
      });
      trim();
    });
  }

  function mount(host) {
    if (host.dataset.mounted) return;
    host.dataset.mounted = '1';
    host.innerHTML = '<p class="v3d-msg">Loading PyMOL model&hellip;</p>';
    Promise.all([loadIndex(), loadLib()]).then(function (both) {
      var entry = both[0][host.dataset.structure];
      if (!entry || !entry.mesh) throw new Error('no mesh for ' + host.dataset.structure);
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
      if (el.open) mount(hosts[i]); else release(hosts[i]);
    }
  }, true);

  // Viewers that are not inside a <details> -- the hero -- have no toggle to
  // wait for, so they mount once the page is ready.
  function mountStandalone() {
    var hosts = document.querySelectorAll('[data-structure]');
    for (var i = 0; i < hosts.length; i++) {
      if (!hosts[i].closest('details')) mount(hosts[i]);
    }
  }
  if (document.readyState !== 'loading') mountStandalone();
  else document.addEventListener('DOMContentLoaded', mountStandalone);
})();
