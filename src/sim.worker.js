/* Cortex Graph – force layout worker (2D/3D, Barnes-Hut octree, runs continuously while needed).
   Messages in:  init {n, dim, edges:Int32Array, pos:Float32Array, params, alpha}
                 params {params} | pin {i,x,y,z} | unpin {i} | reheat {alpha} | stop
   Messages out: {pos:Float32Array, done:boolean} */
let n = 0, dim = 3, x, y, z, vx, vy, vz, edges, m = 0, bias, str;
let P = { center: 0.5, repel: 10, link: 1, dist: 32 };
let alpha = 0, alphaTarget = 0, running = false;
const pin = new Map();
const alphaMin = 0.004, alphaDecay = 1 - Math.pow(0.001, 1 / 280), DECAY = 0.58, THETA2 = 0.81;

// ---------------------------------------------------------------- octree (flat typed arrays)
let cap = 0, cells = 0;
let child, body, mass, sx, sy, sz, size, ox, oy, oz;
function alloc(c) {
  cap = c;
  child = new Int32Array(cap * 8); body = new Int32Array(cap);
  mass = new Float64Array(cap); sx = new Float64Array(cap); sy = new Float64Array(cap); sz = new Float64Array(cap);
  size = new Float64Array(cap); ox = new Float64Array(cap); oy = new Float64Array(cap); oz = new Float64Array(cap);
}
function newCell(x0, y0, z0, s) {
  if (cells >= cap) {
    const o = { child, body, mass, sx, sy, sz, size, ox, oy, oz };
    alloc(cap * 2);
    child.set(o.child); body.set(o.body); mass.set(o.mass); sx.set(o.sx); sy.set(o.sy); sz.set(o.sz);
    size.set(o.size); ox.set(o.ox); oy.set(o.oy); oz.set(o.oz);
  }
  const c = cells++;
  child.fill(-1, c * 8, c * 8 + 8); body[c] = -1; mass[c] = 0; sx[c] = sy[c] = sz[c] = 0;
  ox[c] = x0; oy[c] = y0; oz[c] = z0; size[c] = s;
  return c;
}
function octant(c, i) {
  const h = size[c] / 2;
  return (x[i] >= ox[c] + h ? 1 : 0) | (y[i] >= oy[c] + h ? 2 : 0) | (dim === 3 && z[i] >= oz[c] + h ? 4 : 0);
}
function childFor(c, o) {
  let k = child[c * 8 + o];
  if (k < 0) {
    const h = size[c] / 2;
    k = newCell(ox[c] + (o & 1 ? h : 0), oy[c] + (o & 2 ? h : 0), oz[c] + (o & 4 ? h : 0), h);
    child[c * 8 + o] = k;
  }
  return k;
}
function addMass(c, i) { mass[c] += 1; sx[c] += x[i]; sy[c] += y[i]; sz[c] += z[i]; }
function insert(i) {
  let c = 0, depth = 0;
  for (;;) {
    if (mass[c] === 0 && body[c] === -1) { body[c] = i; addMass(c, i); return; }
    if (body[c] >= 0) { // leaf with one body -> split
      const b = body[c];
      if (depth > 48 || size[c] < 1e-6) { addMass(c, i); return; } // coincident: merge
      body[c] = -2;
      const kb = childFor(c, octant(c, b));
      body[kb] = b; addMass(kb, b);
    }
    addMass(c, i);
    c = childFor(c, octant(c, i));
    depth++;
  }
}
function buildTree() {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i];
    if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i];
    if (z[i] < z0) z0 = z[i]; if (z[i] > z1) z1 = z[i];
  }
  const s = Math.max(x1 - x0, y1 - y0, dim === 3 ? z1 - z0 : 0, 1) * 1.0001 + 1;
  if (cap < 2 * n + 64) alloc(4 * n + 64);
  cells = 0;
  newCell(x0, y0, dim === 3 ? z0 : 0, s);
  for (let i = 0; i < n; i++) insert(i);
}
const stack = [];
function repel(CH, MAXD2) {
  buildTree();
  const d3 = dim === 3;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i], zi = z[i];
    let fx = 0, fy = 0, fz = 0;
    stack.length = 0; stack.push(0);
    while (stack.length) {
      const c = stack.pop();
      const ms = mass[c];
      if (ms === 0 || body[c] === i) continue;
      const cx = sx[c] / ms, cy = sy[c] / ms, cz = sz[c] / ms;
      const dx = cx - xi, dy = cy - yi, dz = d3 ? cz - zi : 0;
      let d2 = dx * dx + dy * dy + dz * dz;
      const leaf = body[c] >= 0;
      if (leaf || (size[c] * size[c]) / (d2 || 1e-9) < THETA2) {
        if (d2 > MAXD2) continue;
        if (d2 < 1) d2 = 1;
        const w = CH * ms / d2;
        fx += dx * w; fy += dy * w; fz += dz * w;
        continue;
      }
      for (let o = 0; o < 8; o++) { const k = child[c * 8 + o]; if (k >= 0) stack.push(k); }
    }
    vx[i] += fx; vy[i] += fy; vz[i] += fz;
  }
}

// ---------------------------------------------------------------- simulation
function prep() {
  const deg = new Float64Array(n);
  for (let k = 0; k < m; k++) { deg[edges[2 * k]]++; deg[edges[2 * k + 1]]++; }
  bias = new Float64Array(m); str = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const a = edges[2 * k], b = edges[2 * k + 1];
    bias[k] = deg[a] / (deg[a] + deg[b]); str[k] = 1 / Math.min(deg[a], deg[b]);
  }
}
function step() {
  const CH = -9 * P.repel * alpha, GR = 0.06 * P.center * alpha, LK = P.link, DIST = P.dist;
  const MAXD2 = Math.pow(P.range || Math.max(400, DIST * 16), 2), d3 = dim === 3;
  repel(CH, MAXD2);
  for (let k = 0; k < m; k++) {
    const a = edges[2 * k], b = edges[2 * k + 1];
    let dx = x[b] + vx[b] - x[a] - vx[a], dy = y[b] + vy[b] - y[a] - vy[a], dz = d3 ? z[b] + vz[b] - z[a] - vz[a] : 0;
    let l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    l = (l - DIST) / l * alpha * str[k] * LK;
    dx *= l; dy *= l; dz *= l;
    const bb = bias[k];
    vx[b] -= dx * bb; vy[b] -= dy * bb; vz[b] -= dz * bb;
    vx[a] += dx * (1 - bb); vy[a] += dy * (1 - bb); vz[a] += dz * (1 - bb);
  }
  for (let i = 0; i < n; i++) {
    vx[i] -= x[i] * GR; vy[i] -= y[i] * GR; vz[i] -= z[i] * GR;
    vx[i] *= DECAY; vy[i] *= DECAY; vz[i] *= DECAY;
    x[i] += vx[i]; y[i] += vy[i]; z[i] = d3 ? z[i] + vz[i] : 0;
  }
  for (const [i, p] of pin) { x[i] = p[0]; y[i] = p[1]; z[i] = d3 ? p[2] : 0; vx[i] = vy[i] = vz[i] = 0; }
}
function send(done) {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { out[3 * i] = x[i]; out[3 * i + 1] = y[i]; out[3 * i + 2] = z[i]; }
  self.postMessage({ pos: out, done }, [out.buffer]);
}
function loop() {
  if (!running) return;
  const t0 = Date.now();
  while (Date.now() - t0 < 35) {
    step(); alpha += (alphaTarget - alpha) * alphaDecay;
    if (alpha < alphaMin && alphaTarget === 0) break;
  }
  const done = alpha < alphaMin && alphaTarget === 0 && pin.size === 0;
  send(done);
  if (done) { running = false; return; }
  setTimeout(loop, 12);
}
function kick(a) { alpha = Math.max(alpha, a); if (!running && n > 0) { running = true; loop(); } }
self.onmessage = (e) => {
  const d = e.data;
  if (d.cmd === 'init') {
    n = d.n; dim = d.dim; edges = d.edges; m = edges.length / 2;
    x = new Float64Array(n); y = new Float64Array(n); z = new Float64Array(n);
    vx = new Float64Array(n); vy = new Float64Array(n); vz = new Float64Array(n);
    for (let i = 0; i < n; i++) { x[i] = d.pos[3 * i]; y[i] = d.pos[3 * i + 1]; z[i] = dim === 3 ? d.pos[3 * i + 2] : 0; }
    P = Object.assign(P, d.params || {}); prep(); pin.clear(); alphaTarget = 0; alpha = 0; kick(d.alpha);
  } else if (d.cmd === 'params') { P = Object.assign(P, d.params); kick(0.4); }
  else if (d.cmd === 'pin') { pin.set(d.i, [d.x, d.y, d.z || 0]); x[d.i] = d.x; y[d.i] = d.y; z[d.i] = d.z || 0; alphaTarget = 0.22; kick(0.22); }
  else if (d.cmd === 'unpin') { pin.delete(d.i); if (!pin.size) alphaTarget = 0; kick(0.1); }
  else if (d.cmd === 'reheat') { kick(d.alpha || 0.5); }
  else if (d.cmd === 'stop') { running = false; }
};
