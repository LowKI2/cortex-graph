/* Cortex Graph – WebGL renderer with glowing nodes (three.js). */
import {
  WebGLRenderer, Scene, FogExp2, PerspectiveCamera, Group, BufferGeometry, BufferAttribute, Points, LineSegments,
  ShaderMaterial, LineDashedMaterial, AdditiveBlending, NormalBlending, Vector2, Vector3, Raycaster, Plane, Color,
  Sprite, SpriteMaterial, CanvasTexture, Mesh, DoubleSide,
} from 'three';

export const LABEL_FONTS = {
  ui: null, text: null,
  sans: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'Cascadia Mono', Consolas, 'SFMono-Regular', Menlo, monospace",
  narrow: "Bahnschrift, 'Arial Narrow', 'Roboto Condensed', sans-serif",
  round: "ui-rounded, 'SF Pro Rounded', 'Segoe UI Variable Display', 'Nunito', sans-serif",
};
const cssVarFont = (v) => { try { return getComputedStyle(document.body).getPropertyValue(v).trim() || 'system-ui, sans-serif'; } catch { return 'system-ui, sans-serif'; } };
const STYLE_DEFAULT = { nodeSize: 1, degSize: 1, glow: 1, line: 1, taper: 1, taperLen: 1, lineGlow: 0.6, nodeBright: 1, nodeOpacity: 1, font: 12, fontGrow: 0.4, boldFrom: 10, labelFrom: 6, maxLabels: 30, rotate: true };

function hexToRgb(h) {
  const v = parseInt(String(h).replace('#', '').slice(0, 6), 16) || 0;
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}
function boost(rgb) { const mx = Math.max(rgb[0], rgb[1], rgb[2]) || 1; return rgb.map((c) => Math.min(1, 0.15 + (c / mx) * 0.95)); }
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
const HEAT_RGB = [1, 0.62, 0.22];
const rk = (nd) => (nd.rank != null ? nd.rank : nd.deg) * (nd.w || 1); // label rank: importance (or connections) x folder weight
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
    this.nodeMat = this.nodeBaseMaterial();
    this.nodeGlowMat = this.nodeGlowMaterial();
    this.starMat = this.glowMaterial(0.35, false);
    this.lineMat = new ShaderMaterial({
      vertexShader: `attribute float alpha; attribute vec3 color; varying vec3 vColor; varying float vAlpha;
        void main() { vColor = color; vAlpha = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: 'varying vec3 vColor; varying float vAlpha; void main() { gl_FragColor = vec4(vColor, vAlpha); }',
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    /* edges as screen-space ribbons: a solid line (Linienstärke) that widens into a wedge at the nodes,
       plus a separate additive glow pass on top (Leuchten der Linien) */
    this.edgeBaseMat = this.edgeMaterial(false);
    this.edgeGlowMat = this.edgeMaterial(true);
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

  edgeMaterial(glow) {
    return new ShaderMaterial({
      uniforms: { uScale: { value: 300 }, uRes: { value: new Vector2(800, 600) }, uLineW: { value: 1 }, uTaper: { value: 1 }, uLen: { value: 1 },
        uGlowW: { value: 6 }, uGlow: { value: 0.6 }, uOpacity: { value: 1 } },
      vertexShader: `
        attribute vec3 aB; attribute float aU; attribute float aEnd; attribute float aSide; attribute float aSizeA; attribute float aSizeB;
        attribute vec3 color; attribute float alpha;
        uniform float uScale; uniform vec2 uRes; uniform float uLineW; uniform float uTaper; uniform float uLen; uniform float uGlowW;
        varying vec3 vColor; varying float vAlpha; varying float vAcross;
        const float GLOW = ${glow ? '1.0' : '0.0'};
        void main() {
          vColor = color; vAlpha = alpha; vAcross = aSide;
          vec4 mA = modelViewMatrix * vec4(position, 1.0), mB = modelViewMatrix * vec4(aB, 1.0);
          // keep both ends in front of the camera
          if (mA.z > -1.0 && mB.z > -1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
          if (mA.z > -1.0) mA = mix(mB, mA, (-1.0 - mB.z) / (mA.z - mB.z));
          if (mB.z > -1.0) mB = mix(mA, mB, (-1.0 - mA.z) / (mB.z - mA.z));
          vec4 cA = projectionMatrix * mA, cB = projectionMatrix * mB;
          vec2 sA = cA.xy / cA.w * 0.5 * uRes, sB = cB.xy / cB.w * 0.5 * uRes;
          vec2 d = sB - sA; float segLen = length(d);
          if (segLen < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
          d /= segLen; vec2 nrm = vec2(-d.y, d.x);
          float pxA = aSizeA * uScale / -mA.z, pxB = aSizeB * uScale / -mB.z;
          float zA = clamp(-mA.z / 700.0, 0.2, 1.0), zB = clamp(-mB.z / 700.0, 0.2, 1.0);
          float along, taper = 0.0;
          if (aEnd < 0.25) {
            float L = min(pxA * 0.8 * uLen * zA, segLen * 0.48);
            along = aU * L; taper = pxA * 0.06 * uTaper * zA * pow(1.0 - aU, 1.7);
          } else if (aEnd > 0.75) {
            float L = min(pxB * 0.8 * uLen * zB, segLen * 0.48);
            along = segLen - aU * L; taper = pxB * 0.06 * uTaper * zB * pow(1.0 - aU, 1.7);
          } else along = segLen * 0.5;
          float hw = max(0.6, 0.5 * uLineW + taper);
          if (GLOW > 0.5) hw = hw * 1.6 + uGlowW;
          vec2 sP = sA + d * along + nrm * aSide * hw;
          vec4 cP = mix(cA, cB, along / segLen);
          gl_Position = vec4(sP / (0.5 * uRes) * cP.w, cP.z, cP.w);
        }`,
      fragmentShader: glow
        ? 'varying vec3 vColor; varying float vAlpha; varying float vAcross; uniform float uGlow; void main() { float g = pow(1.0 - abs(vAcross), 2.0); gl_FragColor = vec4(vColor * g * uGlow, vAlpha); }'
        : 'varying vec3 vColor; varying float vAlpha; varying float vAcross; uniform float uOpacity; void main() { float a = 1.0 - smoothstep(0.55, 1.0, abs(vAcross)); gl_FragColor = vec4(vColor, a * vAlpha * uOpacity); }',
      transparent: true, depthWrite: false, blending: glow ? AdditiveBlending : NormalBlending, side: DoubleSide,
    });
  }

  /* shared vertex shader for nodes (base + glow use the same geometry) */
  static nodeVertex() {
    return `
        attribute float size; attribute float alpha; attribute vec3 color; attribute float heat; attribute float shape;
        varying vec3 vColor; varying float vAlpha; varying float vHeat; varying float vShape;
        uniform float uScale;
        void main() {
          vColor = color; vAlpha = alpha; vHeat = heat; vShape = shape;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float ps = size * uScale / -mv.z;
          gl_PointSize = clamp(max(ps, size * 0.5), 2.0, 240.0);
          gl_Position = projectionMatrix * mv;
        }`;
  }

  /* the node itself: a solid shape in its own color (circle, ring, star, diamond, square) */
  nodeBaseMaterial() {
    return new ShaderMaterial({
      uniforms: { uScale: { value: 300 }, uBright: { value: 1.0 }, uOpacity: { value: 1.0 } },
      vertexShader: GraphRenderer.nodeVertex(),
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha; varying float vHeat; varying float vShape;
        uniform float uBright; uniform float uOpacity;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          float dc = d;
          if (vShape > 3.5) dc = max(abs(c.x), abs(c.y)) * 2.0 * 1.12;
          else if (vShape > 2.5) dc = (abs(c.x) + abs(c.y)) * 2.0 * 0.86;
          else if (vShape > 1.5) { float an = atan(c.y, c.x); dc = d / (0.5 + 0.5 * pow(abs(cos(2.5 * an)), 3.0)) * 0.62; }
          float R0 = 0.42, aa = 0.035;
          float fill = vShape > 0.5 && vShape < 1.5
            ? 1.0 - smoothstep(0.075 - aa, 0.075, abs(d - 0.34))
            : 1.0 - smoothstep(R0 - aa, R0, dc);
          if (fill <= 0.0) discard;
          float shade = 0.82 + 0.3 * (1.0 - clamp(dc / R0, 0.0, 1.0));   // slight depth, keeps the color saturated
          gl_FragColor = vec4(vColor * uBright * shade, fill * vAlpha * uOpacity);
        }`,
      transparent: true, depthWrite: false, blending: NormalBlending,
    });
  }

  /* glow drawn underneath the node, additive; strength = Leuchtstärke */
  nodeGlowMaterial() {
    return new ShaderMaterial({
      uniforms: { uScale: { value: 300 }, uGlow: { value: 1.0 }, uSizeK: { value: 1.0 }, uTime: { value: 0 } },
      vertexShader: GraphRenderer.nodeVertex(),
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha; varying float vHeat; varying float vShape;
        uniform float uGlow; uniform float uSizeK; uniform float uTime;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          float pulse = 1.0 + vHeat * 0.8 * (0.5 + 0.5 * sin(uTime * 2.6));
          float halo = pow(1.0 - d, 2.2) * pulse;
          gl_FragColor = vec4(vColor * halo * 0.9 * uGlow * uSizeK, vAlpha);
        }`,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
  }

  glowMaterial(coreAmt, fog) {
    return new ShaderMaterial({
      uniforms: { uScale: { value: 300 }, uCore: { value: coreAmt }, uMin: { value: fog ? 0.5 : 0.0 }, uGlow: { value: 1.0 }, uSizeK: { value: 1.0 }, uBright: { value: 1.0 }, uOpacity: { value: -1.0 }, uTime: { value: 0 }, uLight: { value: 0 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color; attribute float heat; attribute float shape;
        varying vec3 vColor; varying float vAlpha; varying float vHeat; varying float vShape;
        uniform float uScale; uniform float uMin;
        void main() {
          vColor = color; vAlpha = alpha; vHeat = heat; vShape = shape;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float ps = size * uScale / -mv.z;
          gl_PointSize = clamp(max(ps, size * uMin), 2.0, 240.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vAlpha; varying float vHeat; varying float vShape;
        uniform float uCore; uniform float uGlow; uniform float uSizeK; uniform float uBright; uniform float uOpacity; uniform float uTime; uniform float uLight;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          float pulse = 1.0 + vHeat * 0.55 * (0.5 + 0.5 * sin(uTime * 2.6));
          // node shapes: 0 circle, 1 ring, 2 star, 3 diamond, 4 square
          float dc = d;
          if (vShape > 3.5) dc = max(abs(c.x), abs(c.y)) * 2.6;
          else if (vShape > 2.5) dc = (abs(c.x) + abs(c.y)) * 2.2;
          else if (vShape > 1.5) { float an = atan(c.y, c.x); dc = d / (0.45 + 0.55 * pow(abs(cos(2.5 * an)), 4.0)) * 0.75; }
          float core = vShape > 0.5 && vShape < 1.5 ? smoothstep(0.1, 0.0, abs(d - 0.3)) : smoothstep(0.32, 0.0, dc);
          float halo = pow(1.0 - d, 2.6) * pulse;
          if (uLight > 0.5) {
            float disc = vShape > 0.5 && vShape < 1.5 ? smoothstep(0.14, 0.06, abs(d - 0.45)) : smoothstep(0.62, 0.5, vShape > 0.5 ? dc * 1.6 : d);
            float a = max(disc, halo * 0.45 * uGlow);
            gl_FragColor = vec4(vColor * (0.75 + 0.25 * core) * min(1.0, uBright + 0.25), a * vAlpha * (uOpacity < 0.0 ? 1.0 : 0.25 + 0.75 * uOpacity));
            return;
          }
          // bigger nodes overlap more under additive blending – keep their brightness constant
          float hk = uGlow * uSizeK;
          vec3 col = vColor * (halo * 0.95 * hk + core * 1.1) + vec3(1.0) * core * uCore;
          float a = clamp(halo * 0.9 * hk + core, 0.0, 1.0) * vAlpha;
          if (uOpacity < 0.0) { gl_FragColor = vec4(col * uBright, a); return; }
          // premultiplied: the glow adds light, the core covers what lies behind it (opacity slider)
          gl_FragColor = vec4(col * uBright * a, clamp(core * 1.4, 0.0, 1.0) * vAlpha * uOpacity);
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
    g.setAttribute('shape', new BufferAttribute(new Float32Array(N), 1));
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
    this.lineMat.blending = blend;
    if (this.glowPoints) this.glowPoints.visible = !this.light;
    if (this.edgeGlow) this.edgeGlow.visible = !this.light && (this.style.lineGlow == null ? 0.6 : this.style.lineGlow) > 0;
    this.nodeMat.needsUpdate = true; this.lineMat.needsUpdate = true;
    if (this.points) this.paint();
  }

  setGraph(nodes, edges, adj) {
    this.nodes = nodes; this.edges = edges; this.adj = adj; this.sel = -1; this.dragK = -1; this.hover = -1;
    this.pathSet = null; this.pathEdges = null;
    this.maxDeg = Math.max(1, ...nodes.filter((nd) => !nd.hidden && !nd.anchor).map(rk));
    if (this.points) { this.root.remove(this.points); this.points.geometry.dispose(); }
    if (this.glowPoints) { this.root.remove(this.glowPoints); this.glowPoints = null; }
    if (this.lines) { this.root.remove(this.lines); this.lines.geometry.dispose(); }
    if (this.edgeBase) { this.root.remove(this.edgeBase); this.root.remove(this.edgeGlow); this.edgeBase.geometry.dispose(); this.edgeBase = this.edgeGlow = null; }
    const n = nodes.length;
    const pos = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) { const nd = nodes[k]; pos[3 * k] = nd.x || 0; pos[3 * k + 1] = nd.y || 0; pos[3 * k + 2] = nd.z || 0; }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('size', new BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('alpha', new BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('heat', new BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('shape', new BufferAttribute(new Float32Array(n), 1));
    this.glowPoints = new Points(g, this.nodeGlowMat); this.glowPoints.frustumCulled = false; this.glowPoints.renderOrder = 5; this.glowPoints.visible = !this.light; this.root.add(this.glowPoints);
    this.points = new Points(g, this.nodeMat); this.points.frustumCulled = false; this.points.renderOrder = 10; this.root.add(this.points);
    const m = edges.length;
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(m * 6), 3));
    lg.setAttribute('color', new BufferAttribute(new Float32Array(m * 6), 3));
    lg.setAttribute('alpha', new BufferAttribute(new Float32Array(m * 2), 1));
    this.lines = new LineSegments(lg, this.lineMat); this.lines.frustumCulled = false; this.lines.visible = false; this.root.add(this.lines); // data store; drawn as edge meshes
    this.buildEdges(m);
    this.heat = new Float32Array(n);
    this.flashes = new Map();
    this.applyShapes();
    this.refreshColors();
    this.syncLines();
    this.setSuggestions(this.suggest || null);
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
      const st = nd.stale || 0;
      if (st > 0) rgb = mix(rgb, this.light ? [0.6, 0.6, 0.6] : [0.35, 0.35, 0.42], st * 0.75);
      this.baseColor.push(rgb);
      this.baseSize.push((14 * this.style.nodeSize + Math.sqrt(nd.deg) * 7 * this.style.degSize) * (1 + h * 0.9) * (nd.ghost ? 0.8 : 1) * (nd.w || 1) * (1 - 0.35 * (nd.stale || 0)));
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

  /* node is not drawn: filtered out (hidden) or outside the time/tag mask, unless highlighted from the explorer */
  isOff(k) {
    if (this.hl && this.hl.has(k)) return false;
    const nd = this.nodes[k];
    return !!nd.anchor || !!nd.hidden || (this.mask != null && !this.mask.has(k));
  }
  /* glowing cloud behind a group of nodes (hovered/opened folder) */
  setGalaxy(g) {
    this.galaxy = g && g.set && g.set.size ? g : null;
    if (!this.galaxySprite) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const x = cv.getContext('2d');
      const gr = x.createRadialGradient(128, 128, 0, 128, 128, 128);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
      this.galaxyMat = new SpriteMaterial({ map: new CanvasTexture(cv), transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, opacity: 0 });
      this.galaxySprite = new Sprite(this.galaxyMat); this.galaxySprite.renderOrder = -1;
      this.root.add(this.galaxySprite);
      this.galaxyLabel = this.labelLayer.createDiv({ cls: 'cg-galaxy-label' }); this.galaxyLabel.toggle(false);
    }
    if (this.galaxy) {
      this.galaxyMat.color.set(this.galaxy.color || '#a882ff');
      this.galaxyMat.blending = this.light ? NormalBlending : AdditiveBlending; this.galaxyMat.needsUpdate = true;
      this.galaxyLabel.setText(this.galaxy.name || '');
      this.galaxyLabel.setCssProps({ '--cg-gal': this.galaxy.color || '#a882ff' });
    }
  }

  updateGalaxy(dt) {
    if (!this.galaxySprite) return;
    const g = this.galaxy, mat = this.galaxyMat;
    const goal = g ? (this.light ? 0.35 : 0.8) : 0;
    mat.opacity += (goal - mat.opacity) * Math.min(1, dt * 6);
    this.galaxySprite.visible = mat.opacity > 0.01;
    if (!g) { this.galaxyLabel.toggle(false); return; }
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const k of g.set) { const nd = this.nodes[k]; if (!nd) continue; cx += nd.x; cy += nd.y; cz += nd.z || 0; n++; }
    if (!n) return;
    cx /= n; cy /= n; cz /= n;
    const d = [];
    for (const k of g.set) { const nd = this.nodes[k]; if (nd) d.push(Math.hypot(nd.x - cx, nd.y - cy, (nd.z || 0) - cz)); }
    d.sort((a, b) => a - b);
    const r = Math.max(40, d[Math.floor(d.length * 0.85)] || 40);
    this.galaxySprite.position.set(cx, cy, cz);
    this.galaxySprite.scale.set(r * 3, r * 3, 1);
    const v = this.tmpV.set(cx, cy + r * 1.1, cz).applyMatrix4(this.root.matrixWorld).project(this.camera);
    if (v.z > 1 || v.z < -1) { this.galaxyLabel.toggle(false); return; }
    this.galaxyLabel.toggle(true);
    this.galaxyLabel.setCssStyles({ transform: 'translate(' + Math.round((v.x + 1) / 2 * this.canvas.clientWidth) + 'px,' + Math.round((1 - v.y) / 2 * this.canvas.clientHeight) + 'px) translate(-50%, -100%)' });
  }

  /* camera state for saved views */
  getCamera() { return { t: this.targetGoal.toArray(), yaw: this.yaw, pitch: this.pitch, dist: this.distGoal }; }
  setCamera(c) {
    if (!c) return;
    this.targetGoal.fromArray(c.t); this.yaw = c.yaw; this.pitch = c.pitch; this.distGoal = c.dist;
    this.userMoved = true; this.lastInteract = Date.now();
  }

  setMask(set) { this.mask = set || null; this.paint(); this.updateLabels(true); }

  applyShapes() {
    if (!this.points) return;
    const sh = this.points.geometry.attributes.shape;
    for (let k = 0; k < this.nodes.length; k++) sh.array[k] = this.nodes[k].shape || 0;
    sh.needsUpdate = true;
  }

  /* short flash on a node, e.g. Claude reading (cyan) or writing (orange) it */
  flash(k, kind) {
    if (!this.points || k == null || k < 0) return;
    this.flashes.set(k, { t: performance.now(), c: kind === 'write' ? [1, 0.55, 0.2] : [0.35, 0.9, 1], f: 1 });
    this.flashLabel = { k, until: performance.now() + 2500 };
  }

  updateFlashes() {
    if (!this.flashes || !this.flashes.size) return;
    const now = performance.now();
    for (const [k, fl] of this.flashes) { fl.f = Math.max(0, 1 - (now - fl.t) / 2500); if (fl.f <= 0) this.flashes.delete(k); }
    this.paint();
  }

  /* dashed lines for link suggestions: [[a, b], ...] */
  setSuggestions(pairs) {
    this.suggest = pairs;
    if (this.sugLines) { this.root.remove(this.sugLines); this.sugLines.geometry.dispose(); this.sugLines = null; }
    if (!pairs || !pairs.length || !this.points) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pairs.length * 6), 3));
    if (!this.sugMat) this.sugMat = new LineDashedMaterial({ color: 0xffc04d, dashSize: 5, gapSize: 4, transparent: true, opacity: 0.85, depthWrite: false });
    this.sugLines = new LineSegments(g, this.sugMat); this.sugLines.frustumCulled = false; this.root.add(this.sugLines);
    this.syncSuggest();
  }

  syncSuggest() {
    if (!this.sugLines) return;
    const lp = this.sugLines.geometry.attributes.position.array, nodes = this.nodes;
    this.suggest.forEach(([ka, kb], i) => {
      const a = nodes[ka], b = nodes[kb]; if (!a || !b) return;
      lp[6 * i] = a.x; lp[6 * i + 1] = a.y; lp[6 * i + 2] = a.z || 0; lp[6 * i + 3] = b.x; lp[6 * i + 4] = b.y; lp[6 * i + 5] = b.z || 0;
    });
    this.sugLines.geometry.attributes.position.needsUpdate = true;
    this.sugLines.computeLineDistances();
  }

  /* remember / restore the camera around a focus on a node */
  saveCamera() { if (!this.camBefore) this.camBefore = { ...this.getCamera(), moved: this.userMoved }; }
  restoreCamera() {
    if (!this.camBefore) return false;
    const c = this.camBefore; this.camBefore = null;
    this.setCamera(c); this.userMoved = c.moved;
    return true;
  }

  /* external highlight (e.g. hovering a file or folder in the file explorer) */
  setHighlight(set) {
    this.hl = set || null;
    this.paint(); this.updateLabels(true);
  }

  setPath(path) {
    if (!path) { this.pathSet = null; this.pathEdges = null; }
    else {
      this.pathSet = new Set(path);
      this.pathEdges = new Set();
      for (let i = 0; i + 1 < path.length; i++) { const a = path[i], b = path[i + 1]; this.pathEdges.add(a < b ? a + ':' + b : b + ':' + a); }
    }
    this.paint(); this.updateLabels(true);
  }

  buildEdges(m) {
    // samples along one edge: 5 from end A (u = 0..1 of the wedge), the middle, 5 from end B
    const U = [0, 0.15, 0.35, 0.6, 1], NS = 2 * U.length + 1, V = 2 * NS, nv = m * V;
    const g = new BufferGeometry();
    const u = new Float32Array(nv), end = new Float32Array(nv), side = new Float32Array(nv);
    for (let e = 0; e < m; e++) for (let i = 0; i < NS; i++) for (let j = 0; j < 2; j++) {
      const v = e * V + 2 * i + j;
      if (i < U.length) { u[v] = U[i]; end[v] = 0; } else if (i === U.length) { u[v] = 1; end[v] = 0.5; } else { u[v] = U[NS - 1 - i]; end[v] = 1; }
      side[v] = j ? 1 : -1;
    }
    const idx = new Uint32Array(m * (NS - 1) * 6);
    let q = 0;
    for (let e = 0; e < m; e++) for (let i = 0; i < NS - 1; i++) {
      const v = e * V + 2 * i;
      idx[q++] = v; idx[q++] = v + 1; idx[q++] = v + 2; idx[q++] = v + 1; idx[q++] = v + 3; idx[q++] = v + 2;
    }
    g.setIndex(new BufferAttribute(idx, 1));
    g.setAttribute('position', new BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('aB', new BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('aU', new BufferAttribute(u, 1));
    g.setAttribute('aEnd', new BufferAttribute(end, 1));
    g.setAttribute('aSide', new BufferAttribute(side, 1));
    g.setAttribute('aSizeA', new BufferAttribute(new Float32Array(nv), 1));
    g.setAttribute('aSizeB', new BufferAttribute(new Float32Array(nv), 1));
    g.setAttribute('color', new BufferAttribute(new Float32Array(nv * 3), 3));
    g.setAttribute('alpha', new BufferAttribute(new Float32Array(nv), 1));
    this.edgeV = V; this.edgeNS = NS;
    this.edgeBase = new Mesh(g, this.edgeBaseMat); this.edgeBase.frustumCulled = false; this.edgeBase.renderOrder = 1;
    this.edgeGlow = new Mesh(g, this.edgeGlowMat); this.edgeGlow.frustumCulled = false; this.edgeGlow.renderOrder = 2;
    this.edgeGlow.visible = !this.light && (this.style.lineGlow == null ? 0.6 : this.style.lineGlow) > 0;
    this.root.add(this.edgeBase); this.root.add(this.edgeGlow);
  }

  syncEdges() {
    if (!this.edgeBase) return;
    const ga = this.edgeBase.geometry.attributes, P = ga.position.array, B = ga.aB.array, nodes = this.nodes, V = this.edgeV;
    for (let k = 0; k < this.edges.length; k++) {
      const a = nodes[this.edges[k][0]], b = nodes[this.edges[k][1]];
      const ax = a.x, ay = a.y, az = a.z || 0, bx = b.x, by = b.y, bz = b.z || 0;
      for (let v = k * V, o = 3 * v; v < (k + 1) * V; v++, o += 3) { P[o] = ax; P[o + 1] = ay; P[o + 2] = az; B[o] = bx; B[o + 1] = by; B[o + 2] = bz; }
    }
    ga.position.needsUpdate = true; ga.aB.needsUpdate = true;
  }

  paintEdges() {
    if (!this.edgeBase) return;
    const ga = this.edgeBase.geometry.attributes, C = ga.color.array, A = ga.alpha.array, SA = ga.aSizeA.array, SB = ga.aSizeB.array;
    const la = this.lines.geometry.attributes, lc = la.color.array, lA = la.alpha.array, sz = this.points.geometry.attributes.size.array;
    const V = this.edgeV, NS = this.edgeNS, half = (NS - 1) / 2;
    for (let k = 0; k < this.edges.length; k++) {
      const [a, b] = this.edges[k];
      const sa = this.nodes[a].anchor ? 0 : sz[a], sb = this.nodes[b].anchor ? 0 : sz[b];
      const al = Math.min(1, lA[2 * k] * 2.6);
      for (let i = 0; i < NS; i++) {
        const t = i < half ? 0 : i > half ? 1 : 0.5;
        const r = lc[6 * k] * (1 - t) + lc[6 * k + 3] * t, g = lc[6 * k + 1] * (1 - t) + lc[6 * k + 4] * t, bl = lc[6 * k + 2] * (1 - t) + lc[6 * k + 5] * t;
        for (let j = 0; j < 2; j++) {
          const v = k * V + 2 * i + j;
          C[3 * v] = r; C[3 * v + 1] = g; C[3 * v + 2] = bl; A[v] = al; SA[v] = sa; SB[v] = sb;
        }
      }
    }
    ga.color.needsUpdate = true; ga.alpha.needsUpdate = true; ga.aSizeA.needsUpdate = true; ga.aSizeB.needsUpdate = true;
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
    this.syncEdges();
    if (this.sugLines && (this.sugTick = (this.sugTick || 0) + 1) % 3 === 0) this.syncSuggest();
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
      if (this.hl) { if (this.hl.has(k)) { s = Math.max(s, 22) * 1.7; c = mix(c, [1, 1, 1], 0.35); a = 1; } else a = this.style.dimOthers != null ? this.style.dimOthers : 0.04; }
      if (this.isOff(k)) { a = 0; s = 0; } else if (this.fresh && this.fresh.has(k)) { s *= 1.9; c = mix(c, [1, 1, 1], 0.5); }
      if (!this.hl && this.nodes[k].stale) a *= 1 - 0.55 * this.nodes[k].stale;
      const fl = this.flashes && this.flashes.get(k);
      if (fl) { const f = fl.f; s = Math.max(s, 20) * (1 + 1.6 * f); c = mix(c, fl.c, Math.min(1, f * 1.3)); a = Math.max(a, f); }
      if (k === this.hover) s *= 1.35;
      al[k] = a; sz[k] = s; col[3 * k] = c[0]; col[3 * k + 1] = c[1]; col[3 * k + 2] = c[2];
    }
    ga.alpha.needsUpdate = true; ga.size.needsUpdate = true; ga.color.needsUpdate = true;
    const la = this.lines.geometry.attributes;
    const lc = la.color.array, lA = la.alpha.array;
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
      if (this.hl) alpha = this.hl.has(a) && this.hl.has(b) ? 0.6 : (this.hl.has(a) || this.hl.has(b) ? 0.25 : 0.01 + (this.style.dimOthers || 0) * 0.3);
      const na = this.nodes[a], nb2 = this.nodes[b];
      if (na.anchor || nb2.anchor) {
        const other = na.anchor ? b : a;
        alpha = this.anchorLines && !this.isOff(other) && !(na.anchor && nb2.anchor && !this.anchorLines) ? (this.hl ? (this.hl.has(other) ? 0.18 : 0.01) : 0.07) : 0;
        if (na.anchor && nb2.anchor) alpha = this.anchorLines && !this.hl ? 0.05 : 0;
      } else if (this.isOff(a) || this.isOff(b)) alpha = 0;
      lA[2 * k] = lA[2 * k + 1] = Math.min(1, alpha);
    }
    la.color.needsUpdate = true; la.alpha.needsUpdate = true;
    this.paintEdges();
  }

  setStyle(upd) {
    this.style = Object.assign(this.style, upd);
    const lf = this.style.labelFont || 'ui';
    this.fontStack = LABEL_FONTS[lf] || cssVarFont(lf === 'text' ? '--font-text' : '--font-interface');
    this.labelLayer.setCssProps({ '--cg-lf': this.fontStack });
    for (const c of ['glow', 'shadow', 'pill', 'none']) this.labelLayer.toggleClass('cg-ls-' + c, (this.style.labelStyle || 'glow') === c);
    const st = this.style;
    this.nodeGlowMat.uniforms.uGlow.value = st.glow;
    this.nodeGlowMat.uniforms.uSizeK.value = 1 / Math.sqrt(Math.max(1, st.nodeSize));
    this.nodeMat.uniforms.uBright.value = st.nodeBright != null ? st.nodeBright : 1;
    this.nodeMat.uniforms.uOpacity.value = st.nodeOpacity != null ? st.nodeOpacity : 1;
    for (const m of [this.edgeBaseMat, this.edgeGlowMat]) {
      m.uniforms.uLineW.value = (st.line != null ? st.line : 1) * this.renderer.getPixelRatio();
      m.uniforms.uTaper.value = st.taper || 0;
      m.uniforms.uLen.value = st.taperLen != null ? st.taperLen : 1;
    }
    const lg = st.lineGlow != null ? st.lineGlow : 0.6;
    this.edgeGlowMat.uniforms.uGlow.value = lg;
    this.edgeGlowMat.uniforms.uGlowW.value = 5 * this.renderer.getPixelRatio();
    if (this.edgeGlow) this.edgeGlow.visible = !this.light && lg > 0;
    this.refreshColors(); this.updateLabels(true);
  }

  setSelected(k) { this.sel = k; this.paint(); this.updateLabels(true); }

  focusNode(k) {
    if (k < 0 || !this.nodes[k]) return;
    this.saveCamera();
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
    const ks = list || this.nodes.map((_, k) => k).filter((k) => !this.isOff(k));
    if (!ks.length) return;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const k of ks) {
      const nd = this.nodes[k], z = nd.z || 0;
      if (nd.x < x0) x0 = nd.x; if (nd.x > x1) x1 = nd.x; if (nd.y < y0) y0 = nd.y; if (nd.y > y1) y1 = nd.y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    if (!list && ks.length > 3) { // whole graph: aim at the weighted core (hubs), not the middle of the bounding box
      let sw = 0, ax = 0, ay = 0, az = 0;
      for (const k of ks) { const nd = this.nodes[k]; const w = 1 + 3 * Math.sqrt(Math.max(0, rk(nd)) / (this.maxDeg || 1)); sw += w; ax += nd.x * w; ay += nd.y * w; az += (nd.z || 0) * w; }
      cx = ax / sw; cy = ay / sw; cz = az / sw;
    }
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
    this.nodeGlowMat.uniforms.uScale.value = h * this.renderer.getPixelRatio() * 0.55;
    for (const m of [this.edgeBaseMat, this.edgeGlowMat]) {
      m.uniforms.uScale.value = h * this.renderer.getPixelRatio() * 0.55;
      m.uniforms.uRes.value.set(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
    }
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
      else if (sel >= 0) want = [sel, ...this.adj[sel].filter((j) => !this.isOff(j))].slice(0, Math.max(28, st.maxLabels));
      else if (this.dimSet) want = [...this.dimSet].sort((a, b) => rk(nodes[b]) - rk(nodes[a])).slice(0, Math.max(40, st.maxLabels));
      else {
        const idx = [];
        for (let k = 0; k < nodes.length; k++) if (!this.isOff(k) && rk(nodes[k]) >= st.labelFrom) idx.push(k);
        idx.sort((a, b) => rk(nodes[b]) - rk(nodes[a]));
        want = idx.slice(0, st.maxLabels);
      }
    }
    if (this.hl) want = [...this.hl].sort((a, b) => rk(nodes[b]) - rk(nodes[a])).slice(0, Math.max(40, st.maxLabels)); // only the hovered folder/file
    if (this.flashLabel && performance.now() < this.flashLabel.until && !want.includes(this.flashLabel.k)) want.unshift(this.flashLabel.k);
    if (this.hover >= 0 && !want.includes(this.hover)) want.unshift(this.hover);
    while (this.labelPool.length < want.length) this.labelPool.push(layer.createDiv({ cls: 'cg-label' }));
    const placed = [];
    this.drawn = [];
    for (let i = 0; i < this.labelPool.length; i++) {
      const el = this.labelPool[i];
      if (i >= want.length) { el.toggle(false); continue; }
      const k = want[i], p = this.project(k);
      if (p.z > 1 || p.z < -1) { el.toggle(false); continue; }
      const nm = nodes[k].label;
      // log scale: spreads the many small notes apart from the hubs instead of squeezing them together
      const fs = st.font * (1 + st.fontGrow * 2.5 * Math.log1p(rk(nodes[k])) / Math.log1p(this.maxDeg)) * (k === sel ? 1.15 : 1);
      const bold = k === sel || k === this.hover || rk(nodes[k]) >= st.boldFrom;
      const w = Math.min(40, nm.length) * fs * 0.56 + 6;
      const r = [p.x - w / 2, p.y + 8, p.x + w / 2, p.y + 10 + fs * 1.3];
      const prio = k === sel || k === this.hover || (this.hl && this.hl.size === 1 && this.hl.has(k));
      if (!prio && placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) { el.toggle(false); continue; }
      placed.push(r);
      el.toggle(true);
      const txt = nm.length > 40 ? nm.slice(0, 38) + '…' : nm;
      this.drawn.push({ txt, x: p.x, y: p.y + 10, fs, bold, prio });
      if (el.textContent !== txt) el.setText(txt);
      el.toggleClass('is-selected', prio);
      el.toggleClass('is-ghost', !!nodes[k].ghost);
      const bc = this.baseColor[k] || [0.6, 0.65, 0.8];
      const lc = 'rgb(' + Math.round(Math.min(1, bc[0]) * 255) + ',' + Math.round(Math.min(1, bc[1]) * 255) + ',' + Math.round(Math.min(1, bc[2]) * 255) + ')';
      if (el.cgLc !== lc) { el.cgLc = lc; el.setCssProps({ '--cg-lc': lc }); }
      this.drawn[this.drawn.length - 1].c = lc;
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
      const under = this.pick(x, y);
      const m = this.mouse || {};
      const shiftAct = m.shift || 'link';
      const linkMode = e.shiftKey && e.button === 0 && shiftAct === 'link' && under >= 0 && !!this.nodes[under].note && !!this.onLink;
      const nodeDrag = !e.shiftKey && e.button === 0 && e.pointerType !== 'touch' ? under : e.pointerType === 'touch' ? under : -1;
      const act = e.button === 0 ? m.left || 'rotate' : e.button === 2 ? m.right || 'pan' : m.middle || 'pan';
      const panMode = !linkMode && (e.shiftKey && e.button === 0 ? true : act === 'pan');
      if (ptr.size === 1) gest = { t: Date.now(), x0: x, y0: y, moved: 0, drag: linkMode || nodeDrag < 0 ? -1 : nodeDrag, pan: panMode, link: linkMode ? under : -1, btn: e.button, ev: e };
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
        if (gest && gest.link >= 0) { this.drawLinkLine(gest.link, x, y); p.x = x; p.y = y; return; }
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
          const rs = 0.006 * ((this.mouse && this.mouse.rotSpeed) || 1); this.yaw -= (x - p.x) * rs; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + (y - p.y) * rs));
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
        if (gest.link >= 0) {
          this.drawLinkLine(-1);
          const [ux, uy] = rect(e); const tk = this.pick(ux, uy);
          if (tk >= 0 && tk !== gest.link && this.nodes[tk].note) this.onLink(gest.link, tk);
          gest = null; return;
        }
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
      else if (k < 0 && this.onContextEmpty) this.onContextEmpty(e);
    });
    on('wheel', (e) => {
      e.preventDefault();
      this.distGoal = this.dist = Math.max(30, Math.min(12000, this.dist * ((e.deltaY > 0) !== !!(this.mouse && this.mouse.invert) ? 1.12 : 1 / 1.12)));
      this.userMoved = true; this.lastInteract = Date.now();
    }, { passive: false });
  }

  drawLinkLine(k, x, y) {
    if (!this.linkSvg) {
      const ns = 'http://www.w3.org/2000/svg';
      this.linkSvg = document.createElementNS(ns, 'svg'); this.linkSvg.setAttribute('class', 'cg-linkline');
      this.linkPath = document.createElementNS(ns, 'line'); this.linkSvg.appendChild(this.linkPath);
      this.labelLayer.appendChild(this.linkSvg);
    }
    if (k < 0) { this.linkSvg.classList.remove('is-on'); return; }
    const p = this.project(k);
    this.linkSvg.classList.add('is-on');
    this.linkPath.setAttribute('x1', String(p.x)); this.linkPath.setAttribute('y1', String(p.y));
    this.linkPath.setAttribute('x2', String(x)); this.linkPath.setAttribute('y2', String(y));
    const t = this.pick(x, y); this.setHover(t >= 0 && t !== k ? t : -1);
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
      if (this.isOff(k)) continue;
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
    if (this.style.rotate && Date.now() - this.lastInteract > 1000 * ((this.mouse && this.mouse.rotPause != null) ? this.mouse.rotPause : 1) && this.dragK < 0 && this.hover < 0) this.yaw += dt * 0.06;
    this.target.lerp(this.targetGoal, Math.min(1, dt * 4));
    this.dist += (this.distGoal - this.dist) * Math.min(1, dt * 4);
    const c = this.camera, t = this.target;
    c.position.set(t.x + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw), t.y + this.dist * Math.sin(this.pitch), t.z + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw));
    c.lookAt(t);
    this.nodeGlowMat.uniforms.uTime.value = (now - this.t0) / 1000;
    this.stars.rotation.y += dt * 0.004;
    this.updateFlashes();
    this.updateGalaxy(dt);
    this.renderer.render(this.scene, c);
    this.updateLabels(false);
    if (this.rec) this.composite();
  }

  // ------------------------------------------------------------ video capture (graph + names + caption)
  startCapture(caption) {
    const W = this.canvas.width, H = this.canvas.height, dpr = W / (this.canvas.clientWidth || W);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    const type = types.find((x) => window.MediaRecorder && MediaRecorder.isTypeSupported(x));
    if (!type) return false;
    const stream = cv.captureStream(30);
    const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8000000 });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    this.rec = { cv, ctx: cv.getContext('2d'), mr, chunks, dpr, caption, type };
    mr.start(500);
    return true;
  }

  stopCapture() {
    const rec = this.rec; this.rec = null;
    if (!rec) return Promise.resolve(null);
    return new Promise((res) => {
      rec.mr.onstop = () => res(new Blob(rec.chunks, { type: rec.type.split(';')[0] }));
      rec.mr.stop();
    });
  }

  composite() {
    const { cv, ctx, dpr } = this.rec;
    ctx.drawImage(this.renderer.domElement, 0, 0, cv.width, cv.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const light = this.light;
    for (const d of this.drawn || []) {
      const ls = this.style.labelStyle || 'glow';
      ctx.font = (d.bold ? '600 ' : '400 ') + (d.fs * dpr).toFixed(1) + 'px ' + (this.fontStack || 'system-ui, sans-serif');
      if (ls === 'pill' && d.c) {
        const tw = ctx.measureText(d.txt).width, h = d.fs * 1.3 * dpr;
        ctx.shadowBlur = 0; ctx.globalAlpha = 0.45; ctx.fillStyle = d.c;
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(d.x * dpr - tw / 2 - 5 * dpr, d.y * dpr - 1 * dpr, tw + 10 * dpr, h, h / 2); else ctx.rect(d.x * dpr - tw / 2 - 5 * dpr, d.y * dpr - 1 * dpr, tw + 10 * dpr, h);
        ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.shadowColor = ls === 'shadow' && d.c ? d.c : ls === 'none' || ls === 'pill' ? 'rgba(0,0,0,.8)' : (light ? 'rgba(255,255,255,.9)' : 'rgba(168,130,255,.9)');
      ctx.shadowBlur = (ls === 'none' || ls === 'pill' ? 2 : 6) * dpr;
      ctx.fillStyle = light ? '#222' : (d.prio ? '#fff' : '#e8e6ff');
      ctx.fillText(d.txt, d.x * dpr, d.y * dpr);
    }
    ctx.shadowBlur = 0;
    const cap = this.rec.caption && this.rec.caption();
    if (cap) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.font = '600 ' + (22 * dpr) + 'px system-ui, sans-serif';
      ctx.fillStyle = light ? 'rgba(0,0,0,.75)' : 'rgba(255,255,255,.9)';
      ctx.fillText(cap, 20 * dpr, cv.height - 20 * dpr);
    }
  }

  dispose() {
    if (this.rec) { try { this.rec.mr.stop(); } catch { /* ignore */ } this.rec = null; }
    this.disposed = true;
    window.cancelAnimationFrame(this.raf);
    (this.unbind || []).forEach((f) => f());
    if (!this.active) return;
    for (const o of [this.points, this.lines, this.stars, this.edgeBase]) if (o) o.geometry.dispose();
    for (const m of [this.nodeMat, this.nodeGlowMat, this.lineMat, this.starMat, this.edgeBaseMat, this.edgeGlowMat]) m.dispose();
    if (this.galaxyMat) { this.galaxyMat.map.dispose(); this.galaxyMat.dispose(); }
    if (this.sugLines) this.sugLines.geometry.dispose();
    if (this.sugMat) this.sugMat.dispose();
    this.renderer.dispose();
    try { this.renderer.forceContextLoss(); } catch { /* ignore */ }
  }
}
