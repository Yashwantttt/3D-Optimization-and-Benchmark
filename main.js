/* =====================================================================
   THREE.JS FOREST PERFORMANCE BENCHMARK
   ---------------------------------------------------------------------
   A reusable framework for comparing rendering optimization techniques
   (InstancedMesh, LOD, frustum / distance culling, texture quality,
   object pooling, shadow optimization) on a procedurally generated forest.

   FILE MAP
     0. CONFIGURATION ........ every value you may want to change
     1. STATE & HELPERS
     2. UI ................... dashboard creation / wiring
     3. SCENE ................ renderer, scene, lights, ground, camera
     4. SHADOWS .............. baseline vs optimized shadow profile
     5. ASSET LOADING ........ GLB loading, LOD fallback, placeholders
     6. LAYOUT ............... deterministic (seeded) placement
     7. FOREST LAYERS ........ InstancedMesh / Mesh / LOD builders + pool
     8. OPTIMIZATIONS ........ one clearly separated section per technique
     9. PERFORMANCE MONITOR .. measurement code (no scene logic in here)
    10. BENCHMARK ............ fixed-camera, repeatable test runs
    11. MAIN LOOP & init()

   HOW TO ADD A NEW OPTIMIZATION
     1. add a key to state.opt
     2. write applyMyThing() in section 8 (it reads state.opt.myThing)
     3. add { key, label, info, apply: applyMyThing } to OPTIMIZATIONS
   The checkbox, mode badge and CSV export pick it up automatically.
   ===================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';


/* =====================================================================
   0. CONFIGURATION  (edit these - nothing else needs to change)
   ===================================================================== */

// ---- Model files. Replace these paths with your own Blender exports (.glb or .gltf).
const ASSET_PATHS = {
  tree:  "assets/tree.glb",
  grass: "assets/grass.glb",
  rock:  "assets/rock.glb"
};

// ---- Optional separate LOD models (high = LOD0, medium = LOD1, low = LOD2).
// If a file is missing, that level is generated automatically (see AUTO_LOD).
const TREE_LOD_PATHS = {
  high:   "assets/tree_LOD0.glb",
  medium: "assets/tree_LOD1.glb",
  low:    "assets/tree_LOD2.glb"
};
const LOD_PATHS = { tree: TREE_LOD_PATHS, grass: null, rock: null };

// Which asset types take part in LOD. Grass blades are tiny, so they are off by default.
// Set a type to true (and optionally give it paths above) to LOD it as well.
const LOD_ENABLED_FOR = { tree: true, grass: false, rock: false };

// LOD switch distances (world units from the camera):
//   distance <  high   -> LOD0 (high detail)
//   distance <  medium -> LOD1 (medium detail)
//   distance >= medium -> LOD2 (low detail)
//   `low` is the far end of LOD2. Objects beyond it keep using LOD2 unless
//   LOD_HIDE_BEYOND_LOW is true. (Hiding is really *culling* - use the Distance
//   Culling checkbox for experiments so the two techniques stay separate.)
const LOD_DISTANCES = {
  high: 30,
  medium: 50,
  low: 100
};
const LOD_HIDE_BEYOND_LOW = false;

// Fallback when only ONE model exists for an LOD-enabled type:
//   'simplify' -> LOD1/LOD2 are made once at load time with SimplifyModifier
//   'reuse'    -> LOD1/LOD2 share LOD0's geometry (architecture works, no triangle savings)
// Parts with more vertices than maxVerticesPerPart are not simplified (too slow in JS).
const AUTO_LOD = {
  mode: 'simplify',
  ratios: { medium: 0.5, low: 0.15 },   // fraction of vertices kept
  maxVerticesPerPart: 15000
};

// ---- Distance culling: objects farther than this from the camera are not rendered.
const MAX_RENDER_DISTANCE = 150;

// ---- Texture quality.
// For each asset type you may give three texture files. They replace the model's
// base-colour texture ("map") when that quality level is selected.
// Use `null` (or leave a file out) to fall back to automatically down-scaling the
// textures embedded in the GLB. Down-scaling happens ONCE when the setting changes.
const TEXTURE_SETTINGS = {
  tree:  { high: "assets/textures/tree_2k.jpg", medium: "assets/textures/tree_1k.jpg", low: "assets/textures/tree_512.jpg" },
  grass: null,
  rock:  null
};
// Largest texture side (pixels) for each level when auto down-scaling is used.
const TEXTURE_MAX_SIZE = { high: 2048, medium: 1024, low: 512 };
const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];

// ---- If a model fails to load, show an error and continue with a built-in placeholder.
const USE_PLACEHOLDER_ON_FAILURE = true;

// ---- Optional automatic fitting of your models (all off by default = models used as exported).
//   targetHeight  : uniformly scale the model so it is this tall (world units)
//   alignToGround : shift the model so its lowest point sits at y = 0
const ASSET_FIT = {
  tree:  { targetHeight: null, alignToGround: false },
  grass: { targetHeight: null, alignToGround: false },
  rock:  { targetHeight: null, alignToGround: false }
};

// ---- Deterministic layout. Same seed => identical forest every time and in every mode.
const RANDOM_SEED = 20240601;
const WORLD_SIZE = 400;                  // forest covers WORLD_SIZE x WORLD_SIZE units, centred on origin
const PLACEMENT = {
  //        seedOffset  minDistance  scale range    max tilt (rad)  y offset  tries
  tree:  { seedOffset: 1, minDistance: 2.5,  scale: [0.8, 1.4], tilt: 0.03, yOffset: 0,     maxTries: 30 },
  grass: { seedOffset: 2, minDistance: 0.45, scale: [0.7, 1.4], tilt: 0.12, yOffset: 0,     maxTries: 30 },
  rock:  { seedOffset: 3, minDistance: 2.0,  scale: [0.5, 2.2], tilt: 0.35, yOffset: -0.05, maxTries: 30 }
};

// ---- Sliders (key must be tree / grass / rock).
const SCENE_SLIDERS = [
  { key: 'tree',  label: 'Trees', max: 10000,  step: 100,  initial: 2500 },
  { key: 'grass', label: 'Grass', max: 100000, step: 1000, initial: 20000 },
  { key: 'rock',  label: 'Rocks', max: 5000,   step: 50,   initial: 500 }
];
const SLIDER_DEBOUNCE_MS = 200;          // wait this long after the last slider change before rebuilding

// ---- What the "Optimized" button switches on. It deliberately does NOT enable everything:
//      texture quality changes visual quality and object pooling does not change FPS.
const OPTIMIZED_PRESET = ['instancedMesh', 'lod', 'frustumCulling', 'distanceCulling', 'shadowOptimization'];

// ---- Benchmark
const BENCHMARK_DURATION_SECONDS = 10;   // measured period (also editable in the UI)
const BENCHMARK_WARMUP_SECONDS = 2;      // not measured: lets shaders compile / JIT warm up / culling settle
const BENCHMARK_CAMERA = {               // identical camera path for every run
  radius: 70, height: 28, lookAtY: 4, startAngleDeg: 0, degreesPerSecond: 12
};

// ---- Camera / renderer / look
const CAMERA_START = { position: [55, 22, 70], target: [0, 4, 0], fov: 60, near: 0.5, far: 1200 };
const RENDERER_SETTINGS = { antialias: false, maxPixelRatio: 1 };   // cheap on low-end GPUs
const FOG = { color: 0xa9c9e0, near: 60, far: 170 };
const SUN_DIRECTION = new THREE.Vector3(0.5, 0.8, 0.35).normalize();
const SUN_DISTANCE = 300;

// ---- Shadow profiles. "Shadow Optimization" switches baseline -> optimized.
const SHADOW_SETTINGS = {
  baseline: {
    mapSize: 2048, type: 'PCFSoft',
    casters: { tree: true, grass: true, rock: true },   // everything casts shadows
    followCamera: false, halfExtent: WORLD_SIZE * 0.65   // one big shadow frustum over the whole world
  },
  optimized: {
    mapSize: 1024, type: 'PCF',
    casters: { tree: true, grass: false, rock: true },  // grass blades are too small to matter
    followCamera: true, halfExtent: 100                  // shadow frustum follows the view target and is only updated when it moves
  }
};

// ---- Performance-sensitive implementation switches (document these in your paper)
// If true, scene matrices are computed once instead of every frame. The forest is static, so this
// removes pure CPU overhead from ALL modes equally. Set false to measure the naive per-frame cost.
const FREEZE_STATIC_MATRICES = true;
// If true, Three.js' built-in per-object frustum culling is switched off so the
// "Frustum Culling" checkbox is the ONLY culling that happens (clean experiments).
// Set false to leave Three.js' default culling on for normal Meshes.
const DISABLE_BUILTIN_FRUSTUM_CULLING = true;
// Culling / LOD classification runs at most this often (ms) and only when the camera moved.
// 0 = every frame while the camera moves.
const CULL_UPDATE_INTERVAL_MS = 50;
const CULL_RADIUS_MARGIN = 1.15;         // safety margin on bounding spheres

// ---- Measurement
const HUD_UPDATE_INTERVAL_MS = 250;      // DOM update rate of the performance panel
const FPS_WINDOW_MS = 1000;              // rolling-average window for "current FPS"
const FPS_HISTORY_SECONDS = 60;          // length of the FPS graph
const PAUSE_THRESHOLD_MS = 1000;         // frame gaps longer than this (background tab) are ignored


/* =====================================================================
   1. STATE & HELPERS
   ===================================================================== */

const ASSET_TYPES = ['tree', 'grass', 'rock'];

const state = {
  counts: Object.fromEntries(SCENE_SLIDERS.map(s => [s.key, s.initial])),
  opt: {
    instancedMesh: true,       // InstancedMesh is the primary rendering method
    lod: false,
    frustumCulling: false,
    distanceCulling: false,
    textureQuality: false,
    objectPooling: false,
    shadowOptimization: false
  },
  textureLevel: 'medium',
  useBenchmarkCameraPath: true,
  ready: false
};

let renderer, scene, camera, controls, hemiLight, sunLight, ground;
const assets = {};        // assets[type] -> loaded model data (see loadAssetType)
const layers = {};        // layers[type] -> THREE.Group + bookkeeping (see createLayer)
const layouts = {};       // layouts[type] -> cached deterministic placements
const ui = { stat: {} };
let perf;                 // PerformanceMonitor instance
let gpuName = 'N/A';

const $ = (id) => document.getElementById(id);
const _identity = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const _v1 = new THREE.Vector3();

function nextPow2(n) { let p = 256; while (p < n) p <<= 1; return p; }
function fileName(url) { return String(url).split('/').pop(); }
function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K';
  return String(Math.round(n));
}

// Small, fast, seedable PRNG (mulberry32). Math.random() is never used for placement.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reusable object pool. Pooling keeps released objects alive so the next rebuild can
 * reuse them instead of allocating new ones (less garbage-collector work, faster rebuilds).
 * It does NOT change steady-state FPS - it changes rebuild time and memory churn.
 */
class ObjectPool {
  constructor() { this.free = new Map(); this.created = 0; this.reused = 0; }
  acquire(key, factory, isUsable) {
    const list = this.free.get(key);
    while (list && list.length) {
      const obj = list.pop();
      if (!isUsable || isUsable(obj)) { this.reused++; return obj; }
      this._discard(obj);
    }
    this.created++;
    return factory();
  }
  release(key, obj) {
    let list = this.free.get(key);
    if (!list) this.free.set(key, list = []);
    list.push(obj);
  }
  _discard(obj) { if (obj.isInstancedMesh) obj.dispose(); }
  clear() {
    for (const list of this.free.values()) for (const o of list) this._discard(o);
    this.free.clear();
  }
  resetCounters() { this.created = 0; this.reused = 0; }
  idleCount() { let n = 0; for (const l of this.free.values()) n += l.length; return n; }
}
const pool = new ObjectPool();


/* =====================================================================
   2. UI
   ===================================================================== */

// Registry of optimization techniques. Each `apply` function lives in section 8.
const OPTIMIZATIONS = [
  { key: 'instancedMesh',      label: 'InstancedMesh',      apply: applyInstancedMesh,
    info: 'One draw call per mesh part for all copies. Off = one THREE.Mesh per object.' },
  { key: 'lod',                label: 'LOD',                apply: applyLOD,
    info: 'Distance-based model detail (LOD0/1/2) for LOD-enabled asset types.' },
  { key: 'frustumCulling',     label: 'Frustum Culling',    apply: applyFrustumCulling,
    info: 'Skips objects outside the camera view (CPU test, THREE.Frustum).' },
  { key: 'distanceCulling',    label: 'Distance Culling',   apply: applyDistanceCulling,
    info: 'Skips objects farther than MAX_RENDER_DISTANCE from the camera.' },
  { key: 'textureQuality',     label: 'Texture Quality',    apply: applyTextureOptimization,
    info: 'Uses the texture level chosen below instead of the original textures.' },
  { key: 'objectPooling',      label: 'Object Pooling',     apply: applyObjectPooling,
    info: 'Reuses objects/buffers on rebuilds. Affects rebuild time, not FPS.' },
  { key: 'shadowOptimization', label: 'Shadow Optimization', apply: applyShadowOptimization,
    info: 'Smaller shadow map, no grass shadows, cached camera-following shadow frustum.' }
];

const STAT_DEFS = [
  ['fps', 'FPS (rolling 1 s)'], ['avgFps', 'Average FPS'], ['minFps', 'Minimum FPS'],
  ['frameTime', 'Frame Time'], ['cpuTime', 'CPU Time (JS)'], ['worstFrame', 'Worst Frame'],
  ['drawCalls', 'Draw Calls'], ['triangles', 'Triangles'],
  ['geometries', 'Geometries (renderer)'], ['textures', 'Textures (renderer)'],
  ['sceneObjects', 'Scene Objects'], ['instancesDrawn', 'Instances Drawn'],
  ['texMem', 'Texture Mem (est.)'], ['jsHeap', 'JS Heap'], ['gpuMem', 'GPU Memory']
];

function createUI() {
  ui.loadingText = $('loading-text');
  ui.loadingBar = $('loading-bar');
  ui.loadingErrors = $('loading-errors');
  ui.loadingContinue = $('loading-continue');
  ui.busy = $('busy');
  ui.graph = $('fps-graph');
  ui.rebuildInfo = $('rebuild-info');
  ui.assetStatus = $('asset-status');
  ui.messages = $('messages');

  // --- performance stat rows
  for (const [id, label] of STAT_DEFS) {
    const row = document.createElement('div');
    row.className = 'stat';
    row.innerHTML = `<span class="stat-label">${label}</span><span class="stat-value">&ndash;</span>`;
    $('perf-grid').appendChild(row);
    ui.stat[id] = row.querySelector('.stat-value');
  }

  // --- scene sliders (slider + exact number box)
  for (const s of SCENE_SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML =
      `<label for="slider-${s.key}">${s.label}</label>` +
      `<input type="range" class="lockable" id="slider-${s.key}" min="0" max="${s.max}" step="${s.step}" value="${s.initial}">` +
      `<input type="number" class="lockable num" id="num-${s.key}" min="0" max="${s.max}" step="1" value="${s.initial}">`;
    $('sliders').appendChild(row);
    const slider = row.querySelector('input[type=range]');
    const number = row.querySelector('input[type=number]');
    slider.addEventListener('input', () => { number.value = slider.value; onCountChanged(s.key, +slider.value); });
    number.addEventListener('change', () => {
      const v = Math.max(0, Math.min(s.max, Math.round(+number.value || 0)));
      number.value = v; slider.value = v; onCountChanged(s.key, v);
    });
  }

  // --- optimization checkboxes (generated from the OPTIMIZATIONS registry)
  for (const o of OPTIMIZATIONS) {
    const label = document.createElement('label');
    label.className = 'opt';
    label.id = `optlabel-${o.key}`;
    label.innerHTML =
      `<input type="checkbox" class="lockable" id="opt-${o.key}" ${state.opt[o.key] ? 'checked' : ''}>` +
      `<div><span class="name">${o.label}</span><small>${o.info}</small></div>`;
    $('opt-list').appendChild(label);
    label.querySelector('input').addEventListener('change', (e) => setOptimization(o.key, e.target.checked));
  }

  $('texture-level').value = state.textureLevel;
  $('texture-level').addEventListener('change', (e) => {
    state.textureLevel = e.target.value;
    if (state.opt.textureQuality) runBusy('Changing texture quality…', () => applyTextureOptimization());
  });

  // --- Baseline / Optimized buttons
  $('btn-baseline').addEventListener('click', () => applyPreset([]));
  $('btn-optimized').addEventListener('click', () => applyPreset(OPTIMIZED_PRESET));
  $('preset-info').textContent =
    'Baseline = every technique OFF. Optimized preset = ' +
    OPTIMIZED_PRESET.map(k => OPTIMIZATIONS.find(o => o.key === k).label).join(', ') +
    ' (edit OPTIMIZED_PRESET in main.js). Texture Quality and Object Pooling are never enabled automatically.';

  // --- benchmark controls
  $('bench-duration').value = BENCHMARK_DURATION_SECONDS;
  $('bench-camera').addEventListener('change', (e) => { state.useBenchmarkCameraPath = e.target.checked; });
  $('btn-start').addEventListener('click', () => (benchmark.running ? cancelBenchmark() : startBenchmark()));
  $('btn-rebuild').addEventListener('click', resetBenchmark);
  $('btn-csv').addEventListener('click', downloadCsv);
  $('btn-clear').addEventListener('click', () => { benchmarkResults.length = 0; renderResults(); });

  $('panel-toggle').addEventListener('click', () => $('dashboard').classList.toggle('collapsed'));
  updateModeBadge();
}

function onCountChanged(type, value) {
  state.counts[type] = value;
  if (state.ready) scheduleRebuild([type], SLIDER_DEBOUNCE_MS);   // only that layer is rebuilt
}

function updateModeBadge() {
  const active = OPTIMIZATIONS.filter(o => state.opt[o.key]);
  const badge = $('mode-badge');
  badge.textContent = `Mode: ${active.length ? 'OPTIMIZED' : 'BASELINE'}`;
  badge.className = 'badge ' + (active.length ? 'optimized' : 'baseline');
  $('active-list').textContent = active.length
    ? 'Active: ' + active.map(o => o.label).join(', ')
    : 'Active: none (all optimizations OFF)';
  for (const o of OPTIMIZATIONS) $(`optlabel-${o.key}`).classList.toggle('on', !!state.opt[o.key]);
}

function addMessage(text, level = 'info') {
  for (const d of ui.messages.children) if (d.textContent === text) return;   // no duplicates
  const div = document.createElement('div');
  div.className = level;
  div.textContent = text;
  ui.messages.appendChild(div);
}

function setStat(id, text) {
  const el = ui.stat[id];
  if (el._t !== text) { el.textContent = text; el._t = text; }       // touch the DOM only when the text changed
}

/** Shows a "working" label, lets the browser paint it, then runs fn (which may block for a while). */
function runBusy(label, fn) {
  ui.busy.textContent = label;
  ui.busy.hidden = false;
  return new Promise((resolve) => {
    const done = () => { ui.busy.hidden = true; resolve(); };
    const fail = (e) => { console.error(e); addMessage(`${label} failed: ${e.message}`, 'error'); done(); };
    requestAnimationFrame(() => setTimeout(() => {
      try {
        const r = fn();
        if (r && typeof r.then === 'function') r.then(done, fail); else done();
      } catch (e) { fail(e); }
    }, 0));
  });
}

/** Disables all inputs marked "lockable" (used while a benchmark is running). */
function setControlsLocked(locked) {
  document.querySelectorAll('.lockable').forEach(el => { el.disabled = locked; });
}

function renderAssetStatus() {
  ui.assetStatus.innerHTML = '';
  for (const type of ASSET_TYPES) {
    const a = assets[type];
    const line = document.createElement('div');
    let text = `${type}: ${a.placeholder ? 'PLACEHOLDER' : fileName(ASSET_PATHS[type])} (${fmtCount(a.base.triangles)} tris)`;
    if (LOD_ENABLED_FOR[type] && a.lod) {
      text += ` | LOD tris ${a.lod.map(l => fmtCount(l.triangles)).join('/')} [${a.lodSources.join(', ')}]`;
    }
    line.textContent = text;
    if (a.placeholder) line.className = 'ph';
    ui.assetStatus.appendChild(line);
  }
}


/* =====================================================================
   3. SCENE  (renderer, scene, lights, ground, camera)
   ===================================================================== */

function createRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: RENDERER_SETTINGS.antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDERER_SETTINGS.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  $('canvas-container').appendChild(renderer.domElement);

  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpuName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch (e) { /* GPU name stays N/A */ }
  addMessage(`GPU: ${gpuName}`);
}

function createScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(FOG.color);
  // Fog hides the far edge and the point where distance culling removes objects.
  scene.fog = new THREE.Fog(FOG.color, FOG.near, FOG.far);
  if (FREEZE_STATIC_MATRICES) {
    // The forest never moves, so don't recompute 100k+ world matrices every frame.
    // We call scene.updateMatrixWorld(true) ourselves after each rebuild.
    scene.matrixAutoUpdate = false;
    scene.matrixWorldAutoUpdate = false;
  }
}

function createLighting() {
  // One hemisphere light (cheap ambient) + ONE directional light (the only shadow caster).
  hemiLight = new THREE.HemisphereLight(0xcfe8ff, 0x4a5d2e, 1.0);
  scene.add(hemiLight);

  sunLight = new THREE.DirectionalLight(0xfff2d6, 2.2);
  sunLight.castShadow = true;
  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.04;
  scene.add(sunLight, sunLight.target);
}

function createGround() {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE * 3, WORLD_SIZE * 3);   // big enough that fog hides the edge
  const material = new THREE.MeshStandardMaterial({ color: 0x4f7a3b, roughness: 1 });
  ground = new THREE.Mesh(geometry, material);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

function createCameraAndControls() {
  camera = new THREE.PerspectiveCamera(CAMERA_START.fov, window.innerWidth / window.innerHeight, CAMERA_START.near, CAMERA_START.far);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;     // don't go below the ground
  controls.minDistance = 2;
  controls.maxDistance = 450;
  resetCamera();
}

function resetCamera() {
  camera.position.set(...CAMERA_START.position);
  controls.target.set(...CAMERA_START.target);
  controls.update();
  visState.force = true;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  visState.force = true;
}


/* =====================================================================
   4. SHADOWS
   Shadow maps are expensive: every shadow caster is drawn a second time from the
   light's point of view. The "Shadow Optimization" profile reduces that work.
   ===================================================================== */

const shadowState = { profile: null, x: Infinity, z: Infinity };

function currentShadowProfile() {
  return state.opt.shadowOptimization ? SHADOW_SETTINGS.optimized : SHADOW_SETTINGS.baseline;
}

function applyShadowProfile(p) {
  const typeConst = { PCFSoft: THREE.PCFSoftShadowMap, PCF: THREE.PCFShadowMap, Basic: THREE.BasicShadowMap }[p.type];
  const typeChanged = renderer.shadowMap.type !== typeConst;
  renderer.shadowMap.type = typeConst;

  const sh = sunLight.shadow;
  if (sh.mapSize.x !== p.mapSize || typeChanged) {
    sh.mapSize.set(p.mapSize, p.mapSize);
    if (sh.map) { sh.map.dispose(); sh.map = null; }      // force the shadow map to be re-created
  }
  const cam = sh.camera;
  const h = p.halfExtent;
  cam.left = -h; cam.right = h; cam.top = h; cam.bottom = -h;
  cam.near = 1; cam.far = SUN_DISTANCE * 2.5;
  cam.updateProjectionMatrix();

  // Followed shadows are cached: the shadow map is only re-rendered when we ask for it.
  renderer.shadowMap.autoUpdate = !p.followCamera;
  shadowState.profile = p;
  shadowState.x = shadowState.z = Infinity;
  moveSunTo(p.followCamera ? controls.target.x : 0, p.followCamera ? controls.target.z : 0);
  renderer.shadowMap.needsUpdate = true;

  if (typeChanged) forEachAssetMaterial(m => { m.needsUpdate = true; }, true);   // shader define changed
  for (const type of Object.keys(layers)) applyObjectFlags(layers[type]);
}

function moveSunTo(x, z) {
  sunLight.target.position.set(x, 0, z);
  sunLight.position.copy(SUN_DIRECTION).multiplyScalar(SUN_DISTANCE).add(sunLight.target.position);
  sunLight.target.updateMatrixWorld();
  sunLight.updateMatrixWorld();
}

function requestShadowRefresh() { renderer.shadowMap.needsUpdate = true; }

/** Per frame: re-centre the cached shadow frustum only when the view target moved far enough. */
function updateShadowFocus() {
  const p = shadowState.profile;
  if (!p || !p.followCamera) return;
  const t = controls.target;
  const dx = t.x - shadowState.x, dz = t.z - shadowState.z;
  const threshold = p.halfExtent * 0.15;
  if (dx * dx + dz * dz > threshold * threshold) {
    shadowState.x = t.x; shadowState.z = t.z;
    moveSunTo(t.x, t.z);
    requestShadowRefresh();
  }
}

/** Sets castShadow / receiveShadow / frustumCulled on every mesh in a layer. */
function applyObjectFlags(layer) {
  const cast = !!currentShadowProfile().casters[layer.type];
  layer.group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = true;
      o.frustumCulled = !DISABLE_BUILTIN_FRUSTUM_CULLING && !o.isInstancedMesh;
    }
  });
}


/* =====================================================================
   5. ASSET LOADING
   Each model is loaded ONCE. Its geometry + material are then shared by every
   instance / mesh, whatever the rendering mode. A model may contain several
   meshes ("parts", e.g. trunk + leaves); each part keeps its own material.
   ===================================================================== */

const gltfLoader = new GLTFLoader();
const loadProgress = new Map();       // url -> 0..1
const loadingErrors = [];
const placeholderMats = {};

function updateLoadingBar() {
  let sum = 0;
  for (const v of loadProgress.values()) sum += v;
  const pct = loadProgress.size ? Math.round((100 * sum) / loadProgress.size) : 0;
  ui.loadingText.textContent = `Loading assets... ${pct}%`;
  ui.loadingBar.style.width = pct + '%';
}

function loadModel(url) {
  loadProgress.set(url, 0);
  return new Promise((resolve, reject) => {
    gltfLoader.load(
      url,
      (gltf) => { loadProgress.set(url, 1); updateLoadingBar(); resolve(gltf); },
      (evt) => { if (evt.lengthComputable && evt.total) { loadProgress.set(url, Math.min(0.99, evt.loaded / evt.total)); updateLoadingBar(); } },
      (err) => { loadProgress.set(url, 1); updateLoadingBar(); reject(err instanceof Error ? err : new Error((err && err.message) || 'request failed')); }
    );
  });
}

/** Loads every model. Returns false if the app cannot continue. */
async function loadAssets() {
  updateLoadingBar();
  await Promise.all(ASSET_TYPES.map(async (type) => { assets[type] = await loadAssetType(type); }));

  if (loadingErrors.length) {
    ui.loadingErrors.innerHTML = '';
    for (const msg of loadingErrors) {
      const li = document.createElement('li');
      li.textContent = msg;
      if (!USE_PLACEHOLDER_ON_FAILURE) li.className = 'fatal';
      ui.loadingErrors.appendChild(li);
    }
    if (!USE_PLACEHOLDER_ON_FAILURE) {
      ui.loadingText.textContent = 'Could not load all assets.';
      return false;
    }
    ui.loadingText.textContent = 'Some assets failed to load.';
    ui.loadingContinue.hidden = false;
    await new Promise((resolve) => { ui.loadingContinue.onclick = resolve; });   // make sure the user notices
  }
  return true;
}

async function loadAssetType(type) {
  const lodKeys = ['high', 'medium', 'low'];
  const lodPaths = LOD_ENABLED_FOR[type] ? LOD_PATHS[type] : null;
  const info = { type, base: null, lod: null, lodSources: [], placeholder: false, bounds: null };

  // Base model and optional LOD models load in parallel; missing LOD files are not fatal.
  const results = await Promise.allSettled([
    loadModel(ASSET_PATHS[type]),
    ...(lodPaths ? lodKeys.map(k => loadModel(lodPaths[k])) : [])
  ]);

  const baseResult = results[0];
  try {
    if (baseResult.status !== 'fulfilled') throw baseResult.reason;
    const parts = extractParts(baseResult.value.scene);
    if (!parts.length) throw new Error('the file contains no meshes');
    info.base = makeLevel(parts);
  } catch (err) {
    loadingErrors.push(`Failed to load ${fileName(ASSET_PATHS[type])} - ${err.message}${USE_PLACEHOLDER_ON_FAILURE ? ' (using a built-in placeholder)' : ''}`);
    info.placeholder = true;
    info.base = makeLevel(createPlaceholderParts(type, 0));
  }

  if (lodPaths !== null || LOD_ENABLED_FOR[type]) {
    ui.loadingText.textContent = `Preparing ${type} LOD levels...`;
    await new Promise(r => setTimeout(r, 0));                 // let the loading text paint
    buildLodLevels(info, results.slice(1));
  }
  fitAsset(info);
  return info;
}

/** Collects every mesh of a loaded glTF scene as {geometry, material, matrix}. */
function extractParts(root) {
  root.updateMatrixWorld(true);
  const parts = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry) parts.push({ geometry: o.geometry, material: o.material, matrix: o.matrixWorld.clone() });
  });
  return parts;
}

function countTriangles(parts) {
  let n = 0;
  for (const p of parts) {
    const g = p.geometry;
    n += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  }
  return Math.round(n);
}
function makeLevel(parts) { return { parts, triangles: countTriangles(parts) }; }
function sharePart(p) { return { geometry: p.geometry, material: p.material, matrix: p.matrix.clone() }; }

/**
 * Builds the three LOD levels for an asset type.
 * Order of preference per level: your LOD file -> placeholder LOD -> auto-simplified -> shared geometry.
 */
function buildLodLevels(info, lodResults) {
  const levels = [];
  const sources = [];
  const ratios = [1, AUTO_LOD.ratios.medium, AUTO_LOD.ratios.low];

  for (let i = 0; i < 3; i++) {
    const r = lodResults[i];
    if (r && r.status === 'fulfilled') {
      const parts = extractParts(r.value.scene);
      if (parts.length) { levels[i] = makeLevel(parts); sources[i] = 'file'; continue; }
    }
    if (i === 0) { levels[0] = info.base; sources[0] = info.placeholder ? 'placeholder' : 'base model'; continue; }
    if (info.placeholder && info.type === 'tree') { levels[i] = makeLevel(createPlaceholderParts('tree', i)); sources[i] = 'placeholder'; continue; }
    const fallback = simplifyLevel(levels[0], ratios[i]);
    levels[i] = fallback.level;
    sources[i] = fallback.simplified ? 'auto-simplified' : 'shared geometry';
  }
  info.lod = levels;
  info.lodSources = sources;

  if (sources.some(s => s !== 'file')) {
    addMessage(`${info.type} LOD levels: ${sources.join(' / ')}. Put real LOD models at ` +
      (LOD_PATHS[info.type] ? Object.values(LOD_PATHS[info.type]).map(fileName).join(', ') : 'a path set in LOD_PATHS') + ' for publishable results.', 'warn');
  }
  if (sources.includes('shared geometry')) {
    addMessage(`${info.type}: LOD1/LOD2 reuse the same geometry (too many vertices to auto-simplify), so LOD gives no triangle savings until you supply real LOD models.`, 'warn');
  }
}

function simplifyLevel(baseLevel, keepRatio) {
  const simplifier = new SimplifyModifier();
  let simplifiedAny = false;
  const parts = baseLevel.parts.map((part) => {
    const g = part.geometry;
    const vcount = g.attributes.position.count;
    if (AUTO_LOD.mode !== 'simplify' || vcount > AUTO_LOD.maxVerticesPerPart || vcount < 40) return sharePart(part);
    try {
      const simplified = simplifier.modify(g, Math.floor(vcount * (1 - keepRatio)));
      if (!simplified.attributes.normal) simplified.computeVertexNormals();
      simplifiedAny = true;
      return { geometry: simplified, material: part.material, matrix: part.matrix.clone() };
    } catch (e) {
      console.warn('SimplifyModifier failed, sharing geometry instead', e);
      return sharePart(part);
    }
  });
  return { level: makeLevel(parts), simplified: simplifiedAny };
}

function computeLevelBox(parts) {
  const box = new THREE.Box3();
  for (const p of parts) {
    if (p.geometry.boundingBox === null) p.geometry.computeBoundingBox();
    box.union(p.geometry.boundingBox.clone().applyMatrix4(p.matrix));
  }
  return box;
}

/** Optional scale / ground alignment, then the bounding sphere data used by culling. */
function fitAsset(info) {
  const fit = ASSET_FIT[info.type];
  let box = computeLevelBox(info.base.parts);
  if (fit.targetHeight || fit.alignToGround) {
    const size = box.getSize(_v1);
    const s = fit.targetHeight && size.y > 0 ? fit.targetHeight / size.y : 1;
    const F = new THREE.Matrix4().makeScale(s, s, s);
    F.setPosition(0, fit.alignToGround ? -box.min.y * s : 0, 0);
    const seen = new Set();
    for (const lvl of [info.base, ...(info.lod || [])]) {
      for (const p of lvl.parts) if (!seen.has(p)) { seen.add(p); p.matrix.premultiply(F); }
    }
    box = computeLevelBox(info.base.parts);
  }
  const c = box.getCenter(new THREE.Vector3());
  info.bounds = { cx: c.x, cy: c.y, cz: c.z, radius: box.getSize(new THREE.Vector3()).length() / 2 };
}

/** Calls cb(material) once for every distinct material of every asset (and optionally the ground). */
function forEachAssetMaterial(cb, includeGround = false) {
  const seen = new Set();
  const visit = (m) => { if (m && !seen.has(m)) { seen.add(m); cb(m); } };
  for (const type of ASSET_TYPES) {
    const a = assets[type];
    if (!a) continue;
    for (const lvl of [a.base, ...(a.lod || [])]) {
      for (const p of lvl.parts) (Array.isArray(p.material) ? p.material : [p.material]).forEach(visit);
    }
  }
  if (includeGround && ground) visit(ground.material);
}

// ---------- Built-in placeholder models (used only if a GLB fails to load) ----------

function placeholderMaterial(name) {
  if (!placeholderMats[name]) {
    const colors = { treeTrunk: 0x6b4a2b, treeLeaves: 0x2f7d32, grass: 0x78b43c, rock: 0x8a8d91 };
    placeholderMats[name] = new THREE.MeshStandardMaterial({
      color: colors[name], roughness: 0.95,
      flatShading: name === 'rock' || name === 'treeLeaves',
      side: name === 'grass' ? THREE.DoubleSide : THREE.FrontSide
    });
  }
  return placeholderMats[name];
}

function createPlaceholderParts(type, lodIndex) {
  if (type === 'tree') return placeholderTree(lodIndex);
  if (type === 'grass') return placeholderGrass();
  return placeholderRock(3);
}

function placeholderTree(lod) {
  // Real LOD: the same tree built with fewer segments at each level.
  const seg = [{ r: 32, h: 6 }, { r: 12, h: 2 }, { r: 6, h: 1 }][lod];
  const trunk = new THREE.CylinderGeometry(0.22, 0.34, 2.2, seg.r, seg.h);
  trunk.translate(0, 1.1, 0);
  const cones = [[2.0, 2.8, 3.0], [1.6, 2.4, 4.1], [1.1, 2.0, 5.1]].map(([r, h, y]) => {
    const g = new THREE.ConeGeometry(r, h, seg.r, seg.h);
    g.translate(0, y, 0);
    return g;
  });
  return [
    { geometry: trunk, material: placeholderMaterial('treeTrunk'), matrix: new THREE.Matrix4() },
    { geometry: mergeGeometries(cones), material: placeholderMaterial('treeLeaves'), matrix: new THREE.Matrix4() }
  ];
}

function placeholderGrass() {
  const rng = mulberry32(7);
  const blades = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.ConeGeometry(0.05, 0.7, 3, 1);
    g.translate(0, 0.35, 0);
    g.rotateZ((rng() - 0.5) * 0.6);
    g.rotateX((rng() - 0.5) * 0.6);
    g.translate((rng() - 0.5) * 0.3, 0, (rng() - 0.5) * 0.3);
    blades.push(g);
  }
  return [{ geometry: mergeGeometries(blades), material: placeholderMaterial('grass'), matrix: new THREE.Matrix4() }];
}

function placeholderRock(detail) {
  const g = new THREE.IcosahedronGeometry(0.6, detail);
  const pos = g.attributes.position;
  const hash = (x, y, z) => {
    const s = Math.sin(Math.round(x * 1000) * 12.9898 + Math.round(y * 1000) * 78.233 + Math.round(z * 1000) * 37.719) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 1 + (hash(x, y, z) - 0.5) * 0.4;          // same position -> same offset, so no cracks
    pos.setXYZ(i, x * k, y * k * 0.7, z * k);
  }
  g.computeBoundingBox();
  g.translate(0, -g.boundingBox.min.y, 0);               // sit on the ground
  g.computeVertexNormals();
  return [{ geometry: g, material: placeholderMaterial('rock'), matrix: new THREE.Matrix4() }];
}


/* =====================================================================
   6. LAYOUT  (deterministic placement)
   Positions come from a seeded PRNG, one stream per asset type. The i-th object
   is always the same, so raising the slider only ADDS objects and changing a
   technique never moves anything. A spatial hash rejects spots that are too
   close to an existing object (no overlaps, no grid pattern).
   ===================================================================== */

function ensureLayout(type, count) {
  let L = layouts[type];
  if (!L) {
    L = layouts[type] = { cfg: PLACEMENT[type], rng: mulberry32(RANDOM_SEED + PLACEMENT[type].seedOffset), data: [], n: 0, hash: new Map() };
  }
  while (L.n < count) addPlacement(L);
  return L;
}

function cellKey(cx, cz) { return (cx + 4096) * 8192 + (cz + 4096); }

function isTooClose(L, x, z, cell, min2) {
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      const bucket = L.hash.get(cellKey(cx + ox, cz + oz));
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k++) {
        const j = bucket[k] * 6;
        const dx = L.data[j] - x, dz = L.data[j + 1] - z;
        if (dx * dx + dz * dz < min2) return true;
      }
    }
  }
  return false;
}

/** Appends one placement: [x, z, yaw, tiltX, tiltZ, scale]. */
function addPlacement(L) {
  const { cfg, rng } = L;
  const half = WORLD_SIZE / 2;
  const cell = cfg.minDistance;
  let x = 0, z = 0;
  for (let t = 0; t < cfg.maxTries; t++) {
    x = (rng() * 2 - 1) * half;
    z = (rng() * 2 - 1) * half;
    if (!isTooClose(L, x, z, cell, cell * cell)) break;
  }
  const yaw = rng() * Math.PI * 2;
  const tiltX = (rng() * 2 - 1) * cfg.tilt;
  const tiltZ = (rng() * 2 - 1) * cfg.tilt;
  const scale = cfg.scale[0] + rng() * (cfg.scale[1] - cfg.scale[0]);
  const idx = L.n++;
  L.data.push(x, z, yaw, tiltX, tiltZ, scale);
  const key = cellKey(Math.floor(x / cell), Math.floor(z / cell));
  let bucket = L.hash.get(key);
  if (!bucket) L.hash.set(key, bucket = []);
  bucket.push(idx);
}


/* =====================================================================
   7. FOREST LAYERS
   One "layer" per asset type. A layer is built either as
     - 'instanced': InstancedMesh objects (one per mesh part, per LOD level), or
     - 'mesh'     : one THREE.Mesh / Group / LOD per placement.
   Both use the same placement matrices, so the forest looks identical.
   ===================================================================== */

function createForest() {
  for (const type of ASSET_TYPES) layers[type] = createLayer(type);
}

function createLayer(type) {
  const group = new THREE.Group();
  group.name = `layer-${type}`;
  group.matrixAutoUpdate = !FREEZE_STATIC_MATRICES;
  scene.add(group);
  return {
    type, group, count: 0, mode: null, lodActive: false,
    objects: [],            // 'mesh' mode: root object per placement
    instLevels: [],         // 'instanced' mode: [level][part] -> {mesh, master}
    placementMatrices: null, pos: null, sphere: null,
    buckets: null, bucketCounts: null,
    visibleInstances: 0, sceneObjectCount: 0, fullDirty: false, poolKey: ''
  };
}

function isLodActive(type) { return state.opt.lod && LOD_ENABLED_FOR[type] && !!assets[type].lod; }
function getLevels(type, lodActive) { return lodActive ? assets[type].lod : [assets[type].base]; }

/** Placement matrices, origin positions and culling spheres for every instance of a layer. */
function computeLayerData(layer) {
  const { type, count } = layer;
  const L = layouts[type];
  const cfg = PLACEMENT[type];
  const b = assets[type].bounds;
  const M = new Float32Array(count * 16), pos = new Float32Array(count * 3), sph = new Float32Array(count * 4);
  const q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), m = new THREE.Matrix4();
  const horizontalOffset = Math.hypot(b.cx, b.cz);

  for (let i = 0; i < count; i++) {
    const j = i * 6;
    const x = L.data[j], z = L.data[j + 1], sc = L.data[j + 5];
    e.set(L.data[j + 3], L.data[j + 2], L.data[j + 4], 'YXZ');   // tilt X, yaw, tilt Z
    q.setFromEuler(e);
    p.set(x, cfg.yOffset, z);
    s.setScalar(sc);
    m.compose(p, q, s).toArray(M, i * 16);

    pos[i * 3] = x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = z;
    // Conservative bounding sphere: model sphere + its horizontal offset, scaled.
    sph[i * 4] = x; sph[i * 4 + 1] = p.y + b.cy * sc; sph[i * 4 + 2] = z;
    sph[i * 4 + 3] = (b.radius + horizontalOffset) * sc * CULL_RADIUS_MARGIN;
  }
  layer.placementMatrices = M; layer.pos = pos; layer.sphere = sph;
}

/** Writes a local matrix into an object. Static objects skip per-frame matrix updates. */
function setLocalMatrix(obj, matrix) {
  if (FREEZE_STATIC_MATRICES) {
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(matrix);
  } else {
    obj.matrixAutoUpdate = true;
    matrix.decompose(obj.position, obj.quaternion, obj.scale);
    obj.updateMatrix();
  }
  obj.matrixWorldNeedsUpdate = true;
}

function markInstanceMatrixDirty(mesh, count) {
  const attr = mesh.instanceMatrix;
  if (attr.clearUpdateRanges) { attr.clearUpdateRanges(); attr.addUpdateRange(0, count * 16); }   // upload only what changed
  attr.needsUpdate = true;
}

function clearLayer(layer) {
  const pooling = state.opt.objectPooling;
  if (layer.mode === 'instanced') {
    for (const parts of layer.instLevels) {
      for (const { mesh } of parts) {
        layer.group.remove(mesh);
        if (pooling) pool.release(mesh.userData.poolKey, mesh); else mesh.dispose();   // dispose frees GPU buffers
      }
    }
  } else if (layer.mode === 'mesh') {
    if (pooling) for (const obj of layer.objects) pool.release(layer.poolKey, obj);
  }
  layer.group.clear();
  layer.objects = [];
  layer.instLevels = [];
  layer.buckets = null;
  layer.bucketCounts = null;
  layer.placementMatrices = layer.pos = layer.sphere = null;
}

function rebuildLayer(type) {
  const layer = layers[type];
  clearLayer(layer);
  layer.count = state.counts[type];
  layer.mode = state.opt.instancedMesh ? 'instanced' : 'mesh';
  layer.lodActive = isLodActive(type);
  layer.sceneObjectCount = 0;
  if (layer.count > 0) {
    ensureLayout(type, layer.count);
    computeLayerData(layer);
    if (layer.mode === 'instanced') buildInstancedLayer(layer); else buildMeshLayer(layer);
    applyObjectFlags(layer);
  }
  layer.visibleInstances = layer.count;
  layer.fullDirty = false;
}

// ---------- A. InstancedMesh layers ----------

/**
 * One InstancedMesh per mesh part per LOD level. All copies are drawn in ONE draw call
 * per InstancedMesh, which is where the big CPU saving comes from.
 */
function buildInstancedLayer(layer) {
  const { type, count } = layer;
  const levels = getLevels(type, layer.lodActive);
  const pooling = state.opt.objectPooling;
  const capacity = pooling ? nextPow2(count) : count;      // pooled buffers get headroom so they can be reused

  layer.instLevels = levels.map((lvl, li) => lvl.parts.map((part, pi) => {
    const key = `${type}:L${li}:P${pi}`;
    const create = () => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.poolKey = key;
      return mesh;
    };
    const mesh = pooling ? pool.acquire(key, create, (m) => m.instanceMatrix.count >= count) : create();
    const master = composeMasterMatrices(layer, part.matrix);
    mesh.instanceMatrix.array.set(master);
    mesh.count = count;
    mesh.visible = true;
    mesh.frustumCulled = false;      // we cull per instance ourselves; Three.js can only cull the whole batch
    markInstanceMatrixDirty(mesh, count);
    layer.group.add(mesh);
    return { mesh, master };
  }));
  layer.sceneObjectCount = layer.instLevels.reduce((n, parts) => n + parts.length, 0);
}

/** Instance matrix = placement x part matrix. If the part matrix is identity, the placement array is shared. */
function composeMasterMatrices(layer, partMatrix) {
  if (partMatrix.equals(_identity)) return layer.placementMatrices;
  const out = new Float32Array(layer.count * 16);
  for (let i = 0; i < layer.count; i++) {
    _m1.fromArray(layer.placementMatrices, i * 16).multiply(partMatrix).toArray(out, i * 16);
  }
  return out;
}

// ---------- B. Normal Mesh layers ----------

/** A single-part model becomes one Mesh; a multi-part model becomes a Group of Meshes. */
function createPlainObject(parts) {
  if (parts.length === 1) {
    const mesh = new THREE.Mesh(parts[0].geometry, parts[0].material);
    mesh.userData.baseMatrix = parts[0].matrix;
    setLocalMatrix(mesh, parts[0].matrix);
    return mesh;
  }
  const group = new THREE.Group();
  for (const p of parts) {
    const m = new THREE.Mesh(p.geometry, p.material);
    setLocalMatrix(m, p.matrix);
    group.add(m);
  }
  group.userData.baseMatrix = null;
  setLocalMatrix(group, _identity);
  return group;
}

/**
 * THREE.LOD holds one child per detail level and switches between them by camera
 * distance (the renderer calls lod.update(camera) for every visible LOD each frame).
 */
function createLODObject(levels) {
  const lod = new THREE.LOD();
  const switchDistances = [0, LOD_DISTANCES.high, LOD_DISTANCES.medium];
  levels.forEach((lvl, i) => lod.addLevel(createPlainObject(lvl.parts), switchDistances[i]));
  if (LOD_HIDE_BEYOND_LOW) lod.addLevel(new THREE.Object3D(), LOD_DISTANCES.low);
  lod.userData.baseMatrix = null;
  setLocalMatrix(lod, _identity);
  return lod;
}

function setPlacement(obj, layer, i) {
  _m1.fromArray(layer.placementMatrices, i * 16);
  const base = obj.userData.baseMatrix;
  if (base) _m1.multiply(base);
  setLocalMatrix(obj, _m1);
}

function buildMeshLayer(layer) {
  const { type, count } = layer;
  const levels = getLevels(type, layer.lodActive);
  const key = `${type}:${layer.lodActive ? 'lod' : 'plain'}`;
  layer.poolKey = key;
  const factory = layer.lodActive ? () => createLODObject(levels) : () => createPlainObject(levels[0].parts);
  const pooling = state.opt.objectPooling;

  const objects = new Array(count);
  for (let i = 0; i < count; i++) {
    const obj = pooling ? pool.acquire(key, factory) : factory();
    obj.visible = true;
    setPlacement(obj, layer, i);
    layer.group.add(obj);
    objects[i] = obj;
  }
  layer.objects = objects;
  const meshesPerObject = levels.reduce((n, l) => n + l.parts.length, 0) * (layer.lodActive ? 1 : 0) || levels[0].parts.length;
  layer.sceneObjectCount = count * meshesPerObject;
}

// ---------- Rebuild orchestration ----------

const pendingRebuild = new Set();
let rebuildTimer = null;
let rebuildChain = Promise.resolve();

/** Queue layers for rebuilding. Calls in the same tick are batched into one rebuild. */
function scheduleRebuild(types, delay = 0) {
  types.forEach(t => pendingRebuild.add(t));
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    const list = ASSET_TYPES.filter(t => pendingRebuild.has(t));
    pendingRebuild.clear();
    if (list.length) rebuildNow(list);
  }, delay);
}

function rebuildNow(types) {
  rebuildChain = rebuildChain.then(() => runBusy('Rebuilding scene…', () => {
    const t0 = performance.now();
    pool.resetCounters();
    types.forEach(rebuildLayer);
    finishRebuild();
    const ms = performance.now() - t0;
    ui.rebuildInfo.textContent = `Last rebuild: ${ms.toFixed(0)} ms (${types.join(', ')})` +
      (state.opt.objectPooling ? ` | pool: reused ${pool.reused}, created ${pool.created}, idle ${pool.idleCount()}` : '');
    if (perf) perf.reset();                      // statistics always describe the current scene
  }));
  return rebuildChain;
}

function rebuildScene() { return rebuildNow(ASSET_TYPES); }

function finishRebuild() {
  if (FREEZE_STATIC_MATRICES) scene.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  updateVisibility(performance.now(), true);
  requestShadowRefresh();
  updateTextureMemoryEstimate();
}


/* =====================================================================
   8. OPTIMIZATIONS
   Each technique has its own apply function (called when its checkbox changes)
   and, where it runs every frame, its own update function.
   ===================================================================== */

async function setOptimization(key, value) {
  state.opt[key] = value;
  const def = OPTIMIZATIONS.find(o => o.key === key);
  await runBusy(`Applying ${def.label}…`, () => def.apply());
  updateModeBadge();
}

/** Baseline = [] (everything off). Applies all changes together so the scene is rebuilt only once. */
async function applyPreset(keys) {
  await runBusy('Applying preset…', async () => {
    for (const def of OPTIMIZATIONS) {
      const wanted = keys.includes(def.key);
      if (state.opt[def.key] === wanted) continue;
      state.opt[def.key] = wanted;
      $(`opt-${def.key}`).checked = wanted;
      await def.apply();
    }
  });
  updateModeBadge();
}

// ---------- 8.1 InstancedMesh ----------
function applyInstancedMesh() {
  // Switching mode changes how every layer is built (same placements, same models).
  scheduleRebuild(ASSET_TYPES);
}

// ---------- 8.2 LOD ----------
// Instanced mode: instances are sorted into per-level InstancedMeshes by distance (selectLODLevel).
// Mesh mode: every object is a THREE.LOD that Three.js updates by itself.
const lodCtx = { high2: 0, medium2: 0, low2: 0 };

function applyLOD() {
  scheduleRebuild(ASSET_TYPES.filter(t => LOD_ENABLED_FOR[t] && assets[t] && assets[t].lod));
  markVisibilityDirty();
}

/** Per classification pass: refresh squared distance thresholds. */
function updateLOD() {
  lodCtx.high2 = LOD_DISTANCES.high ** 2;
  lodCtx.medium2 = LOD_DISTANCES.medium ** 2;
  lodCtx.low2 = LOD_DISTANCES.low ** 2;
}

/** Returns 0, 1, 2 (detail level) or -1 (hidden beyond LOD range). */
function selectLODLevel(d2) {
  if (LOD_HIDE_BEYOND_LOW && d2 >= lodCtx.low2) return -1;
  if (d2 < lodCtx.high2) return 0;
  if (d2 < lodCtx.medium2) return 1;
  return 2;
}

// ---------- 8.3 Frustum culling ----------
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const cullCtx = { useFrustum: false, useDistance: false, camX: 0, camY: 0, camZ: 0, maxDist2: 0 };

function applyFrustumCulling() { markVisibilityDirty(); }

/** Per classification pass: rebuild the six frustum planes from the camera. */
function updateFrustumCulling() {
  cullCtx.useFrustum = state.opt.frustumCulling;
  if (!cullCtx.useFrustum) return;
  _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projScreen);
}

/** True if an instance's bounding sphere touches the view frustum. */
function passesFrustumCulling(cx, cy, cz, r) {
  _sphere.center.set(cx, cy, cz);
  _sphere.radius = r;
  return _frustum.intersectsSphere(_sphere);
}

// ---------- 8.4 Distance culling ----------
function applyDistanceCulling() { markVisibilityDirty(); }

function updateDistanceCulling() {
  cullCtx.useDistance = state.opt.distanceCulling;
  cullCtx.maxDist2 = MAX_RENDER_DISTANCE * MAX_RENDER_DISTANCE;
  cullCtx.camX = camera.position.x; cullCtx.camY = camera.position.y; cullCtx.camZ = camera.position.z;
}

function passesDistanceCulling(d2) { return d2 <= cullCtx.maxDist2; }

// ---------- Shared visibility pass (runs only when culling/LOD needs it) ----------
const visState = { force: true, lastUpdate: 0, camMatrix: new Float32Array(16) };

function markVisibilityDirty() {
  visState.force = true;
  for (const l of Object.values(layers)) l.fullDirty = true;
}

function layerNeedsPass(layer) {
  if (!layer.count) return false;
  const o = state.opt;
  // Mesh-mode LOD is handled by THREE.LOD itself, so it needs no pass of ours.
  return o.frustumCulling || o.distanceCulling || (layer.mode === 'instanced' && layer.lodActive);
}

function cameraMoved() {
  const e = camera.matrixWorld.elements, c = visState.camMatrix;
  for (let i = 0; i < 16; i++) if (Math.abs(e[i] - c[i]) > 1e-6) return true;
  return false;
}
function rememberCamera() {
  const e = camera.matrixWorld.elements;
  for (let i = 0; i < 16; i++) visState.camMatrix[i] = e[i];
}

/**
 * Re-classifies instances (visible? which LOD level?). It is skipped while the camera is
 * still, and throttled by CULL_UPDATE_INTERVAL_MS while it moves. This CPU work is a real
 * cost of culling/LOD and is included in the measured frame times.
 */
function updateVisibility(now, force = false) {
  const layerList = ASSET_TYPES.map(t => layers[t]).filter(Boolean);
  if (!layerList.length) return;
  const needPass = layerList.some(layerNeedsPass);
  const dirty = force || visState.force || layerList.some(l => l.fullDirty);
  if (!dirty) {
    if (!needPass) return;
    if (now - visState.lastUpdate < CULL_UPDATE_INTERVAL_MS) return;
    if (!cameraMoved()) return;
  }
  visState.force = false;
  visState.lastUpdate = now;
  camera.updateMatrixWorld();
  rememberCamera();

  updateFrustumCulling();
  updateDistanceCulling();
  updateLOD();

  for (const layer of layerList) {
    if (!layer.count) continue;
    if (layerNeedsPass(layer)) {
      if (layer.mode === 'instanced') updateInstancedLayerVisibility(layer); else updateMeshLayerVisibility(layer);
      layer.fullDirty = false;
    } else if (layer.fullDirty) {
      restoreFullVisibility(layer);
    }
  }
  requestShadowRefresh();
}

function updateInstancedLayerVisibility(layer) {
  const N = layer.count;
  const nLevels = layer.instLevels.length;
  if (!layer.buckets || layer.buckets.length !== nLevels || layer.buckets[0].length !== N) {
    layer.buckets = Array.from({ length: nLevels }, () => new Uint32Array(N));
    layer.bucketCounts = new Uint32Array(nLevels);
  }
  const counts = layer.bucketCounts.fill(0);
  const buckets = layer.buckets;
  const pos = layer.pos, sph = layer.sphere;
  const useD = cullCtx.useDistance, useF = cullCtx.useFrustum, useL = layer.lodActive;

  for (let i = 0; i < N; i++) {
    let d2 = 0;
    if (useD || useL) {
      const dx = pos[i * 3] - cullCtx.camX, dy = pos[i * 3 + 1] - cullCtx.camY, dz = pos[i * 3 + 2] - cullCtx.camZ;
      d2 = dx * dx + dy * dy + dz * dz;
    }
    if (useD && !passesDistanceCulling(d2)) continue;
    if (useF && !passesFrustumCulling(sph[i * 4], sph[i * 4 + 1], sph[i * 4 + 2], sph[i * 4 + 3])) continue;
    const lvl = useL ? selectLODLevel(d2) : 0;
    if (lvl < 0) continue;
    buckets[lvl][counts[lvl]++] = i;
  }

  // Compact the surviving matrices to the front of each InstancedMesh and shrink its draw count.
  let visible = 0;
  layer.instLevels.forEach((parts, li) => {
    const idx = buckets[li], cnt = counts[li];
    visible += cnt;
    for (const { mesh, master } of parts) {
      const arr = mesh.instanceMatrix.array;
      for (let k = 0; k < cnt; k++) {
        const s = idx[k] * 16, d = k * 16;
        for (let j = 0; j < 16; j++) arr[d + j] = master[s + j];
      }
      mesh.count = cnt;
      mesh.visible = cnt > 0;                     // empty buckets cost no draw call
      if (cnt > 0) markInstanceMatrixDirty(mesh, cnt);
    }
  });
  layer.visibleInstances = visible;
}

function updateMeshLayerVisibility(layer) {
  const objs = layer.objects;
  const pos = layer.pos, sph = layer.sphere;
  const useD = cullCtx.useDistance, useF = cullCtx.useFrustum;
  let visible = 0;
  for (let i = 0; i < objs.length; i++) {
    let vis = true;
    if (useD) {
      const dx = pos[i * 3] - cullCtx.camX, dy = pos[i * 3 + 1] - cullCtx.camY, dz = pos[i * 3 + 2] - cullCtx.camZ;
      vis = passesDistanceCulling(dx * dx + dy * dy + dz * dz);
    }
    if (vis && useF) vis = passesFrustumCulling(sph[i * 4], sph[i * 4 + 1], sph[i * 4 + 2], sph[i * 4 + 3]);
    if (objs[i].visible !== vis) objs[i].visible = vis;
    if (vis) visible++;
  }
  layer.visibleInstances = visible;
}

function restoreFullVisibility(layer) {
  layer.fullDirty = false;
  if (!layer.count) return;
  if (layer.mode === 'instanced') {
    layer.instLevels.forEach((parts, li) => {
      for (const { mesh, master } of parts) {
        if (li === 0) {
          mesh.instanceMatrix.array.set(master);
          mesh.count = layer.count;
          mesh.visible = true;
          markInstanceMatrixDirty(mesh, layer.count);
        } else mesh.visible = false;
      }
    });
  } else {
    for (const o of layer.objects) o.visible = true;
  }
  layer.visibleInstances = layer.count;
}

// ---------- 8.5 Texture quality ----------
// Textures are swapped / down-scaled ONLY when the setting changes, never per frame.
const originalTextures = new Map();     // `${material.uuid}:${slot}` -> original THREE.Texture
const resizedCache = new Map();         // `${texture.uuid}:${maxSize}` -> resized THREE.Texture
const externalTextureCache = new Map(); // url -> Promise<Texture|null>
let texMemBytes = 0;

function applyTextureOptimization() {
  return state.opt.textureQuality ? setTextureQuality(state.textureLevel) : restoreOriginalTextures();
}

/** level: "high" | "medium" | "low". Uses TEXTURE_SETTINGS files if they load, otherwise down-scales the embedded textures. */
async function setTextureQuality(level) {
  if (!TEXTURE_MAX_SIZE[level]) { addMessage(`Unknown texture level "${level}"`, 'error'); return; }
  state.textureLevel = level;
  let touched = 0;
  for (const type of ASSET_TYPES) {
    const external = await loadExternalTexture(type, level);
    const mats = [];
    forEachAssetMaterialOfType(type, m => mats.push(m));
    for (const mat of mats) {
      for (const slot of TEXTURE_SLOTS) {
        const orig = getOriginalTexture(mat, slot);
        if (!orig) continue;
        const tex = (slot === 'map' && external) ? external : getResizedTexture(orig, TEXTURE_MAX_SIZE[level]);
        if (swapTexture(mat, slot, tex)) touched++;
      }
    }
  }
  updateTextureMemoryEstimate();
  if (!originalTextures.size) addMessage('Texture Quality: none of the loaded materials has textures, so this setting has no effect (placeholder models are untextured).', 'warn');
  else addMessage(`Texture level "${level}" applied (${TEXTURE_MAX_SIZE[level]} px max).`);
  return touched;
}

function restoreOriginalTextures() {
  for (const [key, orig] of originalTextures) {
    const uuid = key.slice(0, key.lastIndexOf(':'));
    const slot = key.slice(key.lastIndexOf(':') + 1);
    forEachAssetMaterial((mat) => { if (mat.uuid === uuid) swapTexture(mat, slot, orig); });
  }
  updateTextureMemoryEstimate();
}

function forEachAssetMaterialOfType(type, cb) {
  const a = assets[type];
  const seen = new Set();
  for (const lvl of [a.base, ...(a.lod || [])]) {
    for (const p of lvl.parts) (Array.isArray(p.material) ? p.material : [p.material]).forEach(m => { if (!seen.has(m)) { seen.add(m); cb(m); } });
  }
}

function getOriginalTexture(mat, slot) {
  const key = `${mat.uuid}:${slot}`;
  if (!originalTextures.has(key)) {
    if (!mat[slot]) return null;
    originalTextures.set(key, mat[slot]);
  }
  return originalTextures.get(key);
}

function swapTexture(mat, slot, tex) {
  const old = mat[slot];
  if (old === tex) return false;
  mat[slot] = tex;
  mat.needsUpdate = true;
  if (old) old.dispose();                  // free the GPU copy of the texture we no longer use
  return true;
}

function getResizedTexture(orig, maxSize) {
  const img = orig.image;
  if (!img || !img.width) return orig;
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  if (scale >= 1) return orig;
  const key = `${orig.uuid}:${maxSize}`;
  if (resizedCache.has(key)) return resizedCache.get(key);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const t = new THREE.Texture(canvas);
    t.colorSpace = orig.colorSpace; t.flipY = orig.flipY;
    t.wrapS = orig.wrapS; t.wrapT = orig.wrapT;
    t.magFilter = orig.magFilter; t.minFilter = orig.minFilter;
    t.anisotropy = orig.anisotropy; t.generateMipmaps = orig.generateMipmaps;
    t.channel = orig.channel;
    t.needsUpdate = true;
    resizedCache.set(key, t);
    return t;
  } catch (e) {
    console.warn('Could not down-scale texture (compressed?)', e);
    return orig;
  }
}

function loadExternalTexture(type, level) {
  const url = TEXTURE_SETTINGS[type] && TEXTURE_SETTINGS[type][level];
  if (!url) return Promise.resolve(null);
  if (!externalTextureCache.has(url)) {
    externalTextureCache.set(url, new THREE.TextureLoader().loadAsync(url).then((t) => {
      t.flipY = false;                                  // glTF UV convention
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    }).catch(() => {
      addMessage(`Texture file ${url} not found - using the model's own texture, down-scaled instead.`, 'warn');
      return null;
    }));
  }
  return externalTextureCache.get(url);
}

/** Rough VRAM estimate for the textures currently assigned (w x h x 4 bytes, +33% for mipmaps). */
function updateTextureMemoryEstimate() {
  const seen = new Set();
  let bytes = 0;
  forEachAssetMaterial((m) => {
    for (const slot of TEXTURE_SLOTS) {
      const t = m[slot];
      if (t && t.image && !seen.has(t)) { seen.add(t); bytes += t.image.width * t.image.height * 4 * (t.generateMipmaps ? 1.33 : 1); }
    }
  });
  texMemBytes = bytes;
}

// ---------- 8.6 Object pooling ----------
function applyObjectPooling() {
  // Pooling takes effect on the next rebuild. Turning it off frees everything held in the pool.
  if (!state.opt.objectPooling) pool.clear();
}

// ---------- 8.7 Shadow optimization ----------
function applyShadowOptimization() {
  applyShadowProfile(currentShadowProfile());
}


/* =====================================================================
   9. PERFORMANCE MONITOR
   Pure measurement: it knows nothing about the scene. It only receives
   frame timestamps and reads renderer.info.
   ===================================================================== */

class PerformanceMonitor {
  constructor() {
    this.cap = 4096;
    this.ring = new Float64Array(this.cap);     // recent frame durations (ms) for the rolling window
    this.history = [];                          // FPS samples for the graph
    this.historyMax = Math.round((FPS_HISTORY_SECONDS * 1000) / HUD_UPDATE_INTERVAL_MS);
    this.reset();
  }

  /** Starts a fresh test: clears average / minimum / worst values. The graph history is kept. */
  reset() {
    this.head = 0; this.count = 0; this.windowSum = 0;
    this.frames = 0; this.elapsed = 0;
    this.minFps = Infinity; this.worstFrame = 0; this.cpuEma = 0;
    this.lastT = null;
  }

  /** Call once per frame. Returns the frame duration in ms, or null if the frame was ignored. */
  recordFrame(now, cpuMs) {
    if (this.lastT === null) { this.lastT = now; return null; }
    const dt = now - this.lastT;
    this.lastT = now;
    if (dt > PAUSE_THRESHOLD_MS) return null;                    // tab was in the background

    if (this.count === this.cap) this._dropOldest();
    this.ring[(this.head + this.count) % this.cap] = dt;
    this.count++; this.windowSum += dt;
    while (this.windowSum > FPS_WINDOW_MS && this.count > 1) this._dropOldest();

    this.frames++; this.elapsed += dt;
    if (dt > this.worstFrame) this.worstFrame = dt;
    this.cpuEma = this.cpuEma ? this.cpuEma * 0.9 + cpuMs * 0.1 : cpuMs;
    return dt;
  }

  _dropOldest() {
    this.windowSum -= this.ring[this.head];
    this.head = (this.head + 1) % this.cap;
    this.count--;
  }

  /** Called at the HUD rate (4x per second). */
  sample() {
    const fps = this.windowSum > 0 ? (this.count * 1000) / this.windowSum : 0;
    // The minimum is the lowest rolling-1-second FPS, only counted once a full window exists.
    if (this.elapsed >= FPS_WINDOW_MS) this.minFps = Math.min(this.minFps, fps);
    this.history.push(fps);
    if (this.history.length > this.historyMax) this.history.shift();
    return {
      fps,
      avgFps: this.elapsed > 0 ? (this.frames * 1000) / this.elapsed : 0,
      minFps: this.minFps,
      frameMs: this.count ? this.windowSum / this.count : 0,
      cpuMs: this.cpuEma,
      worst: this.worstFrame
    };
  }
}

let lastHudT = 0;

/** Updates the dashboard. Runs at most HUD_UPDATE_INTERVAL_MS apart, so DOM work is negligible. */
function updatePerformanceMonitor(now) {
  if (now - lastHudT < HUD_UPDATE_INTERVAL_MS) return;
  lastHudT = now;
  const s = perf.sample();
  const info = renderer.info;

  setStat('fps', s.fps.toFixed(0));
  setStat('avgFps', s.avgFps.toFixed(1));
  setStat('minFps', Number.isFinite(s.minFps) ? s.minFps.toFixed(1) : '–');
  setStat('frameTime', s.frameMs.toFixed(1) + ' ms');
  setStat('cpuTime', s.cpuMs.toFixed(1) + ' ms');
  setStat('worstFrame', s.worst.toFixed(1) + ' ms');
  setStat('drawCalls', String(info.render.calls));
  setStat('triangles', fmtCount(info.render.triangles));
  setStat('geometries', String(info.memory.geometries));
  setStat('textures', String(info.memory.textures));

  let objects = 0, drawn = 0, total = 0;
  for (const t of ASSET_TYPES) {
    const l = layers[t];
    if (!l) continue;
    objects += l.sceneObjectCount; drawn += l.visibleInstances; total += l.count;
  }
  setStat('sceneObjects', fmtCount(objects));
  setStat('instancesDrawn', `${fmtCount(drawn)} / ${fmtCount(total)}`);
  setStat('texMem', texMemBytes ? (texMemBytes / 1048576).toFixed(1) + ' MB' : 'N/A');
  setStat('jsHeap', performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : 'N/A');
  setStat('gpuMem', 'N/A');        // WebGL does not expose GPU memory usage
  drawFpsGraph();
}

function drawFpsGraph() {
  const c = ui.graph, g = c.getContext('2d'), w = c.width, h = c.height, hist = perf.history;
  g.fillStyle = '#0b0e13';
  g.fillRect(0, 0, w, h);
  let peak = 0;
  for (const v of hist) if (v > peak) peak = v;
  const maxV = Math.max(60, Math.ceil(peak / 30) * 30);

  g.strokeStyle = '#232b3a'; g.fillStyle = '#6b7588'; g.font = '9px monospace'; g.lineWidth = 1;
  for (let v = 30; v < maxV; v += 30) {
    const y = h - (v / maxV) * h;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    g.fillText(String(v), 2, y - 2);
  }
  g.fillText(String(maxV), 2, 9);

  g.strokeStyle = '#4cc38a'; g.lineWidth = 1.5;
  g.beginPath();
  const step = w / (perf.historyMax - 1);
  for (let i = 0; i < hist.length; i++) {
    const x = w - (hist.length - 1 - i) * step;
    const y = h - (Math.min(hist[i], maxV) / maxV) * h;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}


/* =====================================================================
   10. BENCHMARK
   A run = warm-up (not recorded) + measured period, on a fixed camera path,
   with all controls locked so nothing else can change mid-test.
   ===================================================================== */

const benchmark = {
  running: false, phase: 'idle', startT: null, measureT0: 0,
  frameTimes: [], cpuTimes: [], calls: [], tris: [], saved: null
};
const benchmarkResults = [];

function readDuration() {
  const v = Math.round(+$('bench-duration').value) || BENCHMARK_DURATION_SECONDS;
  return Math.max(1, Math.min(600, v));
}

function startBenchmark() {
  if (benchmark.running || !state.ready) return;
  Object.assign(benchmark, { running: true, startT: null, measureT0: 0, frameTimes: [], cpuTimes: [], calls: [], tris: [] });
  benchmark.duration = readDuration();
  benchmark.phase = BENCHMARK_WARMUP_SECONDS > 0 ? 'warmup' : 'measure';
  benchmark.saved = { pos: camera.position.clone(), target: controls.target.clone() };
  $('bench-duration').value = benchmark.duration;

  setControlsLocked(true);
  $('btn-start').textContent = 'Cancel Benchmark';
  $('bench-progress').hidden = false;
  controls.enabled = false;
  if (state.useBenchmarkCameraPath) controls.target.set(0, BENCHMARK_CAMERA.lookAtY, 0);
  perf.reset();
  markVisibilityDirty();
  $('bench-status').textContent = BENCHMARK_WARMUP_SECONDS > 0 ? 'Warming up…' : 'Measuring…';
}

/** Called every frame while a benchmark runs (after perf.recordFrame). */
function benchmarkOnFrame(now, dt, cpuMs) {
  const b = benchmark;
  if (!b.running) return;
  if (b.startT === null) b.startT = now;

  if (b.phase === 'warmup') {
    const elapsed = (now - b.startT) / 1000;
    $('bench-status').textContent = `Warming up… ${Math.max(0, BENCHMARK_WARMUP_SECONDS - elapsed).toFixed(1)} s`;
    if (elapsed >= BENCHMARK_WARMUP_SECONDS) {
      b.phase = 'measure'; b.measureT0 = now;
      perf.reset();                                   // measurement starts from zero
      $('bench-status').textContent = 'Measuring…';
    }
    return;
  }

  if (dt !== null) {
    b.frameTimes.push(dt);
    b.cpuTimes.push(cpuMs);
    b.calls.push(renderer.info.render.calls);
    b.tris.push(renderer.info.render.triangles);
  }
  const measured = (now - b.measureT0) / 1000;
  $('bench-bar').style.width = Math.min(100, (measured / b.duration) * 100) + '%';
  $('bench-status').textContent = `Measuring… ${Math.max(0, b.duration - measured).toFixed(1)} s left`;
  if (measured >= b.duration) finishBenchmark();
}

function endBenchmarkCommon() {
  benchmark.running = false;
  benchmark.phase = 'idle';
  controls.enabled = true;
  if (benchmark.saved) {
    camera.position.copy(benchmark.saved.pos);
    controls.target.copy(benchmark.saved.target);
    controls.update();
  }
  setControlsLocked(false);
  $('btn-start').textContent = 'Start Benchmark';
  $('bench-progress').hidden = true;
  $('bench-bar').style.width = '0';
  markVisibilityDirty();
}

function cancelBenchmark() {
  endBenchmarkCommon();
  $('bench-status').textContent = 'Benchmark cancelled.';
}

function finishBenchmark() {
  const b = benchmark;
  const s = perf.sample();
  const n = b.frameTimes.length;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sorted = Float64Array.from(b.frameTimes).sort();
  const maxFrame = n ? sorted[n - 1] : 0;
  const active = OPTIMIZATIONS.filter(o => state.opt[o.key]).map(o => o.label);

  benchmarkResults.push({
    id: benchmarkResults.length + 1,
    mode: active.length ? 'OPTIMIZED' : 'BASELINE',
    active,
    counts: { ...state.counts },
    textureLevel: state.opt.textureQuality ? state.textureLevel : 'original',
    duration: b.duration,
    frames: n,
    avgFps: s.avgFps,
    minFps: Number.isFinite(s.minFps) ? s.minFps : (maxFrame ? 1000 / maxFrame : 0),
    avgFrameMs: mean(b.frameTimes),
    p95FrameMs: n ? sorted[Math.min(n - 1, Math.floor(0.95 * n))] : 0,
    maxFrameMs: maxFrame,
    avgCpuMs: mean(b.cpuTimes),
    avgCalls: mean(b.calls),
    avgTris: mean(b.tris)
  });

  endBenchmarkCommon();
  $('bench-status').textContent = 'Benchmark finished.';
  renderResults();
}

/** "Reset / Rebuild Scene": same seed, same layout, fresh statistics, default camera. */
async function resetBenchmark() {
  if (benchmark.running) return;
  resetCamera();
  await rebuildScene();
  perf.reset();
  $('bench-status').textContent = 'Scene rebuilt, statistics reset.';
}

function renderResults() {
  const wrap = $('results');
  wrap.innerHTML = '';
  for (const r of [...benchmarkResults].reverse()) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML =
      `<div class="rc-head">#${r.id} ${r.mode}</div>` +
      `<div class="rc-sub">${r.counts.tree} trees / ${r.counts.grass} grass / ${r.counts.rock} rocks - ` +
      `${r.active.length ? r.active.join(', ') : 'no optimizations'} - textures: ${r.textureLevel} - ${r.duration}s, ${r.frames} frames</div>` +
      `<div class="rc-grid">` +
      `<span>Avg FPS</span><span>${r.avgFps.toFixed(1)}</span>` +
      `<span>Min FPS</span><span>${r.minFps.toFixed(1)}</span>` +
      `<span>Avg frame</span><span>${r.avgFrameMs.toFixed(2)} ms</span>` +
      `<span>P95 frame</span><span>${r.p95FrameMs.toFixed(2)} ms</span>` +
      `<span>Max frame</span><span>${r.maxFrameMs.toFixed(1)} ms</span>` +
      `<span>Avg CPU</span><span>${r.avgCpuMs.toFixed(2)} ms</span>` +
      `<span>Draw calls</span><span>${Math.round(r.avgCalls)}</span>` +
      `<span>Triangles</span><span>${fmtCount(r.avgTris)}</span>` +
      `</div>`;
    wrap.appendChild(card);
  }
  $('btn-csv').disabled = $('btn-clear').disabled = benchmarkResults.length === 0;
}

function downloadCsv() {
  const header = ['run', 'mode', 'trees', 'grass', 'rocks', 'optimizations', 'texture_level', 'duration_s', 'frames',
    'avg_fps', 'min_fps', 'avg_frame_ms', 'p95_frame_ms', 'max_frame_ms', 'avg_cpu_ms', 'avg_draw_calls', 'avg_triangles', 'gpu'];
  const rows = benchmarkResults.map(r => [
    r.id, r.mode, r.counts.tree, r.counts.grass, r.counts.rock, r.active.join('+') || 'none', r.textureLevel, r.duration, r.frames,
    r.avgFps.toFixed(2), r.minFps.toFixed(2), r.avgFrameMs.toFixed(3), r.p95FrameMs.toFixed(3), r.maxFrameMs.toFixed(3),
    r.avgCpuMs.toFixed(3), Math.round(r.avgCalls), Math.round(r.avgTris), `"${gpuName.replace(/"/g, '""')}"`
  ]);
  const csv = [header, ...rows].map(row => row.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'forest-benchmark-results.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}


/* =====================================================================
   11. MAIN LOOP & init()
   ===================================================================== */

/** Camera: free OrbitControls normally, a fixed repeatable orbit during a benchmark. */
function updateCamera(now) {
  if (benchmark.running) {
    if (state.useBenchmarkCameraPath) {
      const t = benchmark.startT === null ? 0 : (now - benchmark.startT) / 1000;
      const a = THREE.MathUtils.degToRad(BENCHMARK_CAMERA.startAngleDeg + BENCHMARK_CAMERA.degreesPerSecond * t);
      camera.position.set(Math.cos(a) * BENCHMARK_CAMERA.radius, BENCHMARK_CAMERA.height, Math.sin(a) * BENCHMARK_CAMERA.radius);
      camera.lookAt(0, BENCHMARK_CAMERA.lookAtY, 0);
    }
    return;
  }
  controls.update();
}

function animate(now) {
  requestAnimationFrame(animate);

  // --- everything between cpuStart and cpuEnd is "CPU time (JS)": camera, culling/LOD pass, render submission
  const cpuStart = performance.now();
  updateCamera(now);
  camera.updateMatrixWorld();
  updateVisibility(now);
  updateShadowFocus();
  renderer.render(scene, camera);
  const cpuMs = performance.now() - cpuStart;

  // --- measurement (separate from scene code)
  const dt = perf.recordFrame(now, cpuMs);
  benchmarkOnFrame(now, dt, cpuMs);
  updatePerformanceMonitor(now);
}

function showFatalError(err) {
  console.error(err);
  ui.loadingText.textContent = 'Initialization failed.';
  const li = document.createElement('li');
  li.className = 'fatal';
  li.textContent = err && err.message ? err.message : String(err);
  ui.loadingErrors.appendChild(li);
  $('loading-screen').classList.remove('hidden');
}

async function init() {
  perf = new PerformanceMonitor();
  createUI();
  try {
    createRenderer();
    createScene();
    createLighting();
    createGround();
    createCameraAndControls();
    window.addEventListener('resize', onResize);

    const ok = await loadAssets();
    if (!ok) return;
    renderAssetStatus();

    createForest();
    applyShadowProfile(currentShadowProfile());
    await rebuildScene();                       // builds trees, grass and rocks with the current settings

    state.ready = true;
    updateModeBadge();
    $('loading-screen').classList.add('hidden');
    requestAnimationFrame(animate);
  } catch (err) {
    showFatalError(err);
  }
}

// Handy for experiments from the browser console, e.g. forestBenchmark.setTextureQuality('low')
window.forestBenchmark = { state, layers, assets, pool, setTextureQuality, startBenchmark, rebuildScene, resetBenchmark,
  get renderer() { return renderer; }, get benchmarkResults() { return benchmarkResults; } };

init();
