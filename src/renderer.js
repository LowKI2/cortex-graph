/* Cortex Graph – WebGL renderer with glowing nodes (three.js). */
import {
  WebGLRenderer, Scene, FogExp2, PerspectiveCamera, Group, BufferGeometry, BufferAttribute, Points, LineSegments,
  ShaderMaterial, AdditiveBlending, NormalBlending, Vector2, Vector3, Raycaster, Plane, Color,
} from 'three';

const STYLE_DEFAULT = { nodeSize: 1, degSize: 1, glow: 1, line: 1, font: 12, fontGrow: 0.4, boldFrom: 10, labelFrom: 6, maxLabels: 30, rotate: true };

function hexToRgb(h) {
  const v = parseInt(String(h).replace('#', '').slice(0, 6), 16) || 0;
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}
function boost(rgb) { const mx = Math.max(rgb[0], rgb[1], rgb[2]) || 1; return rgb.map((c) => Math.min(1, 0.15 + (c / mx) * 0.95)); }
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
const HEAT_RGB = [1, 0.62, 0.22];
const PATH_RGB = [1, 0.86, 0.35];

export class GraphRenderer {
  constructor(canvas, labelLayer, anchor) {
    this.canvas = canvas; this.labelLayer = labelLayer; this.anchor = anchor;
    this.active = false;
    this.onTap = null; this.onDrag = null; this.onDragEnd = null; this.onHover = null; this.onContext = null;
    this.showLabels = true;
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch { return; }
    this.active = true;
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(58, 1, 1, 30000);
    this.root = new Group(); this.scene.add(this.root);
    this.nodeMat = this.glowMaterial(0.75, true);
    this.starMat = this.glowMaterial(0.35, false);
    this.lineMat = new ShaderMaterial({
      vertexShader: `attribute float alpha; attribute vec3 color; varying vec3 vColor; varying float vAlpha;
        void main() { vColor = color; vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: 'varying vec3 vColor; varying float vAlpha; void main() { gl_FragColor = vec4(vColor, vAlpha); }',
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    this.makeStars();
    this.nodes = []; this.edges = []; this.adj = []; this.points = null; this.lines = null;
    this.sel = -1; this.dragK = -1; this.hover = -1;
    this.style = Object.assign({}, STYLE_DEFAULT);
    this.maxDeg = 1; this.baseColor = []; this.baseSize = []; this.heat = null;
    this.colorOverride = null; this.dimSet = null; this.pathSet = null; this.pathEdges = null;
    this.target = new Vector3(); this.targetGoal = new Vector3();
    this.yaw = 0.6; this.pitch = 0.35; this.dist = 900; this.distGoal = 900; this.lastInteract = 0; this.userMoved = false;
    this.labelPool = []; this.labelTick = 0; this.tmpV = new Vector3();
    this.light = false;
    this.setTheme({ space: true });
    this.bindInput();
    this.t0 = performance.now(); this.clockT = this.t0;
    this.raf = window.requestAnimationFrame(() => this.frame());
  }

  glowMaterial(coreAmt, fog) {
    return new ShaderMaterial({
      uniforms: { uScale: { value: 300 }, uCore: { value: coreAmt }, uMin: { value: fog ? 0.5 : 0.0 }, uGlow: { value: 1.0 }, uTime: { value: 0 }, uLight: { value: 0 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color; attribute float heat;
        varying vec3 vColor; varying float vAlpha; varying float vHeat;
        uniform float uScale; uniform float uMin;
        void main() {
          vColor = color; vAlpha = alpha; vHeat = heat;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float ps = size * uScale / -mv.z;
          gl_PointSize = clamp(max(ps, size * uMin), 2.0, 240.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha; varying float vHeat;
        uniform float uCore; uniform float uGlow; uniform float uTime; uniform float uLight;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          float pulse = 1.0 + vHeat * 0.55 * (0.5 + 0.5 * sin(uTime * 2.6));
          float core = smoothstep(0.32, 0.0, d);
          float halo = pow(1.0 - d, 2.6) * pulse;
          if (uLight > 0.5) {
            float disc = smoothstep(0.62, 0.5, d);
            float a = max(disc, halo * 0.45 * uGlow);
            gl_FragColor = vec4(vColor * (0.75 + 0.25 * core), a * vAlpha);
            return;
          }
          vec3 col = vColor * (halo * 0.95 * uGlow + core * 1.1) + vec3(1.0) * core * uCore;
          gl_FragColor = vec4(col, clamp(halo * 0.9 * uGlow + core, 0.0, 1.0) * vAlpha);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
  }

  makeStars() {
    const N = 1600, p = new Float32Array(N * 3), c = new Float32Array(N * 3), s = new Float32Array(N), a = new Float32Array(N), h = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const r = 3500 + Math.random() * 5000, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      p[3 * i] = r * Math.sin(ph) * Math.cos(th); p[3 * i + 1] = r * Math.sin(ph) * Math.sin(th); p[3 * i + 2] = r * Math.cos(ph);
      const t = Math.random(); c[3 * i] = 0.6 + 0.4 * t; c[3 * i + 1] = 0.65 + 0.3 * t; c[3 * i + 2] = 1;
      s[i] = 18 + Math.random() * 40; a[i] = 0.25 + Math.random() * 0.5;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(p, 3));
    g.setAttribute('color', new BufferAttribute(c, 3));
    g.setAttribute('size', new BufferAttribute(s, 1));
    g.setAttribute('alpha', new BufferAttribute(a, 1));
    g.setAttribute('heat', new BufferAttribute(h, 1));
    this.stars = new Points(g, this.starMat); this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  /* theme: {space:boolean, bg:'#rrggbb', light:boolean} */
  setTheme(th) {
    if (!this.active) return;
    const space = th.space !== false;
    const bg = space ? '#07070d' : (th.bg || '#1e1e1e');
    this.light = !space && !!th.light;
    this.renderer.setClearColor(new Color(bg), 1);
    this.scene.fog = new FogExp2(new Color(bg).getHex(), space ? 0.0009 : 0.0004);
    this.stars.visible = space;
    const blend = this.light ? NormalBlending : AdditiveBlending;
    this.nodeMat.blending = blend; this.lineMat.blending = blend;
    this.nodeMat.uniforms.uLight.value = this.light ? 1 : 0;
    this.nodeMat.needsUpdate = true; this.lineMat.needsUpdate = true;
    if (this.points) this.paint();
  }

  setGraph(nodes, edges, adj) {
    this.nodes = nodes; this.edges = edges; this.adj = adj; this.sel = -1; this.dragK = -1; this.hover = -1;
    this.pathSet = null; this.pathEdges = null;
    this.maxDeg = Math.max(1, ...nodes.map((nd) => nd.deg));
    if (this.points) { this.root.remove(this.points); this.points.geometry.dispose(); }
    if (this.lines) { this.root.remove(this.lines); this.lines.geometry.dispose(); }
    const n = nodes.length;
    const pos = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) { const nd = nodes[k]; pos[3 * k] = nd.x || 0; pos[3 * k + 1] = nd.y || 0; pos[3 * k + 2] = nd.z || 0; }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('size', new BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('alpha', new BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('heat', new BufferAttribute(new Float32Array(n), 1));
    this.points = new Points(g, this.nodeMat); this.points.frustumCulled = false; this.root.add(this.points);
    const m = edges.length;
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(m * 6), 3));
    lg.setAttribute('color', new BufferAttribute(new Float32Array(m * 6), 3));
    lg.setAttribute('alpha', new BufferAttribute(new Float32Array(m * 2), 1));
    this.lines = new LineSegments(lg, this.lineMat); this.lines.frustumCulled = false; this.root.add(this.lines);
    this.heat = new Float32Array(n);
    this.refreshColors();
    this.syncLines();
  }

  /* recompute base colors (after color/heat/problem changes) */
  refreshColors() {
    this.baseColor = []; this.baseSize = [];
    for (let k = 0; k < this.nodes.length; k++) {
      const nd = this.nodes[k];
      const hex = (this.colorOverride && this.colorOverride[k]) || (nd.note && nd.note.color) || '#9aa6c8';
      let rgb = this.light ? hexToRgb(hex) : boost(hexToRgb(hex));
      const h = this.heat ? this.heat[k] : 0;
      if (h > 0) rgb = mix(rgb, HEAT_RGB, Math.min(0.75, h * 0.8));
      this.baseColor.push(rgb);
      this.baseSize.push((14 * this.style.nodeSize + Math.sqrt(nd.deg) * 7 * this.style.degSize) * (1 + h * 0.9) * (nd.ghost ? 0.8 : 1));
    }
    this.paint();
  }

  setHeat(arr) { // Float32Array(n) or null
    if (!this.points) return;
    this.heat = arr || new Float32Array(this.nodes.length);
    const ha = this.points.geometry.attributes.heat.array;
    ha.set(this.heat.subarray(0, ha.length));
    this.points.geometry.attributes.heat.needsUpdate = true;
    this.refreshColors();
  }

  /* colors: array of hex|null per node (problem mode), dim: Set of nodes that stay bright (others dimmed) */
  setOverlay(colors, bright) { this.colorOverride = colors; this.dimSet = bright; this.refreshColors(); this.updateLabels(true); }

  setPath(path) {
    if (!path) { this.pathSet = null; this.pathEdges = null; }
    else {
      this.pathSet = new Set(path);
      this.pathEdges = new Set();
      for (let i = 0; i + 1 < path.length; i++) { const a = path[i], b = path[i + 1]; this.pathEdges.add(a < b ? a + ':' + b : b + ':' + a); }
    }
    this.paint(); this.updateLabels(true);
  }

  syncLines() {
    if (!this.lines) return;
    const lp = this.lines.geometry.attributes.position.array, nodes = this.nodes;
    for (let k = 0; k < this.edges.length; k++) {
      const a = nodes[this.edges[k][0]], b = nodes[this.edges[k][1]];
      lp[6 * k] = a.x; lp[6 * k + 1] = a.y; lp[6 * k + 2] = a.z || 0;
      lp[6 * k + 3] = b.x; lp[6 * k + 4] = b.y; lp[6 * k + 5] = b.z || 0;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }

  setPositions(p) {
    if (!this.points) return;
    const arr = this.points.geometry.attributes.position.array, nodes = this.nodes;
    const n = Math.min(nodes.length, p.length / 3);
    for (let k = 0; k < n; k++) {
      if (k === this.dragK) continue;
      nodes[k].x = p[3 * k]; nodes[k].y = p[3 * k + 1]; nodes[k].z = p[3 * k + 2];
      arr[3 * k] = p[3 * k]; arr[3 * k + 1] = p[3 * k + 1]; arr[3 * k + 2] = p[3 * k + 2];
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.syncLines();
    if (!this.userMoved && this.dragK < 0) this.fit(true);
  }

  paint() {
    if (!this.points) return;
    const sel = this.sel, path = this.pathSet;
    const nb = path ? null : (sel >= 0 ? new Set([sel, ...this.adj[sel]]) : null);
    const bright = this.dimSet;
    const ga = this.points.geometry.attributes;
    const al = ga.alpha.array, sz = ga.size.array, col = ga.color.array;
    const dimA = this.light ? 0.22 : 0.16;
    for (let k = 0; k < this.nodes.length; k++) {
      let a = 1, s = this.baseSize[k], c = this.baseColor[k];
      if (path) { if (path.has(k)) { s *= 2.1; c = mix(c, PATH_RGB, 0.7); } else a = dimA; }
      else if (nb) { if (!nb.has(k)) a = dimA; s *= k === sel ? 1.8 : (nb.has(k) ? 1.25 : 1); }
      if (bright && !bright.has(k)) a = Math.min(a, 0.22);
      else if (bright && this.colorOverride && this.colorOverride[k]) { s = Math.max(s, 26) * 1.7; }
      if (k === this.hover) s *= 1.35;
      al[k] = a; sz[k] = s; col[3 * k] = c[0]; col[3 * k + 1] = c[1]; col[3 * k + 2] = c[2];
    }
    ga.alpha.needsUpdate = true; ga.size.needsUpdate = true; ga.color.needsUpdate = true;
    const la = this.lines.geometry.attributes;
    const lc = la.color.array, lA = la.alpha.array, w = this.style.line;
    const base = this.light ? 0.35 : 0.22;
    for (let k = 0; k < this.edges.length; k++) {
      const [a, b] = this.edges[k];
      const ca = this.baseColor[a], cb = this.baseColor[b];
      let hot = false, alpha = base;
      if (path) { hot = this.pathEdges.has(a < b ? a + ':' + b : b + ':' + a); alpha = hot ? 1 : 0.03; }
      else if (sel >= 0) { hot = a === sel || b === sel; alpha = hot ? 0.95 : 0.035; }
      else if (bright) alpha = bright.has(a) && bright.has(b) ? base * 1.4 : 0.04;
      if (hot) {
        const h1 = path ? PATH_RGB : (this.light ? [0.45, 0.3, 0.9] : [1, 0.85, 1]);
        const h2 = path ? PATH_RGB : (this.light ? [0.35, 0.25, 0.8] : [0.75, 0.6, 1]);
        lc.set(h1, 6 * k); lc.set(h2, 6 * k + 3);
      } else { lc.set(ca, 6 * k); lc.set(cb, 6 * k + 3); }
      lA[2 * k] = lA[2 * k + 1] = Math.min(1, alpha * w);
    }
    la.color.needsUpdate = true; la.alpha.needsUpdate = true;
  }

  setStyle(st) {
    this.style = Object.assign(this.style, st);
    this.nodeMat.uniforms.uGlow.value = this.style.glow;
    this.refreshColors(); this.updateLabels(true);
  }

  setSelected(k) { this.sel = k; this.paint(); this.updateLabels(true); }

  focusNode(k) {
    if (k < 0 || !this.nodes[k]) return;
    const nd = this.nodes[k];
    this.targetGoal.set(nd.x, nd.y, nd.z || 0);
    this.distGoal = Math.min(this.distGoal, 260);
    this.userMoved = true; this.lastInteract = Date.now();
  }

  fit(instant) { this.fitTo(null, instant); this.userMoved = false; }
  fitDist(r) {
    const v = this.camera.fov * Math.PI / 180, h = 2 * Math.atan(Math.tan(v / 2) * this.camera.aspect);
    return Math.max(60, Math.min(9000, r / Math.sin(Math.min(v, h) / 2) * 1.04));
  }
  fitTo(list, instant) {
    const ks = list || this.nodes.map((_, k) => k);
    if (!ks.length) return;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const k of ks) {
      const nd = this.nodes[k], z = nd.z || 0;
      if (nd.x < x0) x0 = nd.x; if (nd.x > x1) x1 = nd.x; if (nd.y < y0) y0 = nd.y; if (nd.y > y1) y1 = nd.y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    let r = 30;
    for (const k of ks) { const nd = this.nodes[k]; r = Math.max(r, Math.hypot(nd.x - cx, nd.y - cy, (nd.z || 0) - cz)); }
    this.targetGoal.set(cx, cy, cz);
    this.distGoal = this.fitDist(r);
    if (instant) { this.target.copy(this.targetGoal); this.dist = this.distGoal; }
    if (list) { this.userMoved = true; this.lastInteract = Date.now(); }
  }
  resetView() { this.userMoved = false; this.fit(false); }
  zoomBy(f) { this.distGoal = Math.max(30, Math.min(12000, this.distGoal * f)); this.userMoved = true; this.lastInteract = Date.now(); }
  panBy(dx, dy) {
    this.camera.updateMatrixWorld();
    const f = this.distGoal / (this.canvas.clientHeight || 600) * 1.1;
    const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const upv = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.targetGoal.addScaledVector(right, dx * f).addScaledVector(upv, -dy * f);
    this.userMoved = true; this.lastInteract = Date.now();
  }
  orbitBy(dyaw, dpitch) {
    this.yaw += dyaw; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dpitch));
    this.userMoved = true; this.lastInteract = Date.now();
  }

  resize() {
    if (!this.active) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.nodeMat.uniforms.uScale.value = h * this.renderer.getPixelRatio() * 0.55;
    this.starMat.uniforms.uScale.value = h * this.renderer.getPixelRatio() * 0.55;
    if (!this.userMoved) this.fit(true);
  }

  project(k) {
    const nd = this.nodes[k], v = this.tmpV;
    v.set(nd.x, nd.y, nd.z || 0).applyMatrix4(this.root.matrixWorld).project(this.camera);
    return { x: (v.x + 1) / 2 * this.canvas.clientWidth, y: (1 - v.y) / 2 * this.canvas.clientHeight, z: v.z };
  }

  updateLabels(force) {
    const layer = this.labelLayer;
    if (!layer) return;
    if (!force && (this.labelTick++ % 2)) return;
    const nodes = this.nodes, st = this.style, sel = this.sel;
    let want = [];
    if (this.showLabels && nodes.length) {
      if (this.pathSet) want = [...this.pathSet];
      else if (sel >= 0) want = [sel, ...this.adj[sel]].slice(0, Math.max(28, st.maxLabels));
      else if (this.dimSet) want = [...this.dimSet].sort((a, b) => nodes[b].deg - nodes[a].deg).slice(0, Math.max(40, st.maxLabels));
      else {
        const idx = [];
        for (let k = 0; k < nodes.length; k++) if (nodes[k].deg >= st.labelFrom) idx.push(k);
        idx.sort((a, b) => nodes[b].deg - nodes[a].deg);
        want = idx.slice(0, st.maxLabels);
      }
    }
    if (this.hover >= 0 && !want.includes(this.hover)) want.unshift(this.hover);
    while (this.labelPool.length < want.length) this.labelPool.push(layer.createDiv({ cls: 'cg-label' }));
    const placed = [];
    for (let i = 0; i < this.labelPool.length; i++) {
      const el = this.labelPool[i];
      if (i >= want.length) { el.toggle(false); continue; }
      const k = want[i], p = this.project(k);
      if (p.z > 1 || p.z < -1) { el.toggle(false); continue; }
      const nm = nodes[k].label;
      const fs = st.font * (1 + st.fontGrow * Math.sqrt(nodes[k].deg / this.maxDeg)) * (k === sel ? 1.15 : 1);
      const bold = k === sel || k === this.hover || nodes[k].deg >= st.boldFrom;
      const w = Math.min(40, nm.length) * fs * 0.56 + 6;
      const r = [p.x - w / 2, p.y + 8, p.x + w / 2, p.y + 10 + fs * 1.3];
      const prio = k === sel || k === this.hover;
      if (!prio && placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) { el.toggle(false); continue; }
      placed.push(r);
      el.toggle(true);
      const txt = nm.length > 40 ? nm.slice(0, 38) + '…' : nm;
      if (el.textContent !== txt) el.setText(txt);
      el.toggleClass('is-selected', prio);
      el.toggleClass('is-ghost', !!nodes[k].ghost);
      el.setCssStyles({
        transform: 'translate(' + Math.round(p.x) + 'px,' + Math.round(p.y + 10) + 'px) translateX(-50%)',
        fontSize: fs.toFixed(1) + 'px', fontWeight: bold ? '600' : '400',
        opacity: (sel >= 0 || this.pathSet) && !prio ? '0.85' : '1',
      });
    }
  }

  // ------------------------------------------------------------ input
  bindInput() {
    const canvas = this.canvas;
    const ray = new Raycaster(), plane = new Plane();
    const ptr = new Map();
    let gest = null, lastTap = { t: 0, k: -1 }, lastMoved = 0;
    const rect = (e) => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    const moveNode = (k, X, Y, Z) => {
      const nd = this.nodes[k]; nd.x = X; nd.y = Y; nd.z = Z;
      const arr = this.points.geometry.attributes.position.array; arr[3 * k] = X; arr[3 * k + 1] = Y; arr[3 * k + 2] = Z;
      this.points.geometry.attributes.position.needsUpdate = true; this.syncLines();
    };
    const on = (t, f, o) => { canvas.addEventListener(t, f, o); (this.unbind ||= []).push(() => canvas.removeEventListener(t, f, o)); };
    on('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const [x, y] = rect(e); ptr.set(e.pointerId, { x, y });
      const panMode = e.button === 2 || e.button === 1 || e.shiftKey;
      if (ptr.size === 1) gest = { t: Date.now(), x0: x, y0: y, moved: 0, drag: panMode ? -1 : this.pick(x, y), pan: panMode, btn: e.button, ev: e };
      else if (gest) { if (this.dragK >= 0 && this.onDragEnd) this.onDragEnd(this.dragK); this.dragK = -1; gest.moved = 999; gest.drag = -1; }
      this.lastInteract = Date.now();
      this.setHover(-1);
    });
    on('pointermove', (e) => {
      const [x, y] = rect(e);
      if (!ptr.has(e.pointerId)) { // hover (mouse only)
        if (e.pointerType === 'mouse') { const k = this.pick(x, y); if (k !== this.hover) { this.setHover(k); if (this.onHover) this.onHover(k, e, x, y); } }
        return;
      }
      const p = ptr.get(e.pointerId);
      if (ptr.size === 1) {
        if (gest) gest.moved += Math.abs(x - p.x) + Math.abs(y - p.y);
        if (gest && gest.drag >= 0) {
          if (gest.moved >= 6) {
            const k = gest.drag, nd = this.nodes[k];
            this.dragK = k;
            ray.setFromCamera(new Vector2(x / canvas.clientWidth * 2 - 1, -(y / canvas.clientHeight) * 2 + 1), this.camera);
            const dir = new Vector3(); this.camera.getWorldDirection(dir);
            plane.setFromNormalAndCoplanarPoint(dir, new Vector3(nd.x, nd.y, nd.z || 0));
            const hit = new Vector3();
            if (ray.ray.intersectPlane(plane, hit)) { moveNode(k, hit.x, hit.y, hit.z); if (this.onDrag) this.onDrag(k, hit.x, hit.y, hit.z); }
          }
        } else if (gest && gest.pan) {
          const f = this.dist / canvas.clientHeight * 1.1;
          const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
          const upv = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
          this.target.addScaledVector(right, -(x - p.x) * f).addScaledVector(upv, (y - p.y) * f); this.targetGoal.copy(this.target);
        } else {
          this.yaw -= (x - p.x) * 0.006; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + (y - p.y) * 0.006));
        }
      } else if (ptr.size === 2) {
        const ids = [...ptr.keys()]; const o = ptr.get(ids[0] === e.pointerId ? ids[1] : ids[0]);
        const d0 = Math.hypot(p.x - o.x, p.y - o.y), d1 = Math.hypot(x - o.x, y - o.y);
        if (d0 > 0 && d1 > 0) { this.dist = Math.max(30, Math.min(12000, this.dist * d0 / d1)); this.distGoal = this.dist; }
        const mx = (x - p.x) / 2, my = (y - p.y) / 2, f = this.dist / canvas.clientHeight * 1.1;
        const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.target.addScaledVector(right, -mx * f).addScaledVector(up, my * f); this.targetGoal.copy(this.target);
      }
      p.x = x; p.y = y;
      this.userMoved = true; this.lastInteract = Date.now();
    });
    const up = (e) => {
      if (!ptr.has(e.pointerId)) return;
      ptr.delete(e.pointerId);
      if (ptr.size === 0 && gest) {
        if (this.dragK >= 0 && this.onDragEnd) this.onDragEnd(this.dragK);
        this.dragK = -1;
        lastMoved = gest.moved;
        if (gest.btn === 0 && gest.moved < 10 && Date.now() - gest.t < 450) {
          const k = this.pick(gest.x0, gest.y0), now = Date.now();
          const dbl = k >= 0 && lastTap.k === k && now - lastTap.t < 350;
          lastTap = dbl ? { t: 0, k: -1 } : { t: now, k };
          if (this.onTap) this.onTap(k, dbl, e);
        }
        gest = null;
      }
    };
    on('pointerup', up); on('pointercancel', up);
    on('pointerleave', (e) => { if (e.pointerType === 'mouse' && !ptr.size) { this.setHover(-1); if (this.onHover) this.onHover(-1, e, 0, 0); } });
    on('contextmenu', (e) => {
      e.preventDefault();
      if ((gest ? gest.moved : lastMoved) > 8) return;
      const [x, y] = rect(e); const k = this.pick(x, y);
      if (k >= 0 && this.onContext) this.onContext(k, e);
    });
    on('wheel', (e) => {
      e.preventDefault();
      this.distGoal = this.dist = Math.max(30, Math.min(12000, this.dist * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
      this.userMoved = true; this.lastInteract = Date.now();
    }, { passive: false });
  }

  setHover(k) {
    if (k === this.hover) return;
    this.hover = k;
    this.canvas.toggleClass('is-hovering', k >= 0);
    if (k >= 0 && this.anchor) {
      const p = this.project(k);
      this.anchor.setCssStyles({ left: Math.round(p.x - 8) + 'px', top: Math.round(p.y - 8) + 'px' });
    }
    this.paint(); this.updateLabels(true);
  }

  pick(sx, sy) {
    let best = -1, bd = Infinity;
    for (let k = 0; k < this.nodes.length; k++) {
      const p = this.project(k);
      if (p.z > 1 || p.z < -1) continue;
      const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return Math.sqrt(bd) <= 26 ? best : -1;
  }

  // ------------------------------------------------------------ loop
  frame() {
    if (this.disposed) return;
    this.raf = window.requestAnimationFrame(() => this.frame());
    if (!this.canvas.isConnected || this.canvas.offsetParent === null || document.hidden) return;
    const now = performance.now(), dt = Math.min(0.05, (now - this.clockT) / 1000); this.clockT = now;
    if (this.style.rotate && Date.now() - this.lastInteract > 4000 && this.dragK < 0 && this.hover < 0) this.yaw += dt * 0.06;
    this.target.lerp(this.targetGoal, Math.min(1, dt * 4));
    this.dist += (this.distGoal - this.dist) * Math.min(1, dt * 4);
    const c = this.camera, t = this.target;
    c.position.set(t.x + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw), t.y + this.dist * Math.sin(this.pitch), t.z + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw));
    c.lookAt(t);
    this.nodeMat.uniforms.uTime.value = (now - this.t0) / 1000;
    this.stars.rotation.y += dt * 0.004;
    this.renderer.render(this.scene, c);
    this.updateLabels(false);
  }

  dispose() {
    this.disposed = true;
    window.cancelAnimationFrame(this.raf);
    (this.unbind || []).forEach((f) => f());
    if (!this.active) return;
    for (const o of [this.points, this.lines, this.stars]) if (o) o.geometry.dispose();
    this.nodeMat.dispose(); this.lineMat.dispose(); this.starMat.dispose();
    this.renderer.dispose();
    try { this.renderer.forceContextLoss(); } catch { /* ignore */ }
  }
}
