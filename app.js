import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOBILE = matchMedia('(max-width: 760px)').matches;
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

/* ============================================================
   Utilities
============================================================ */
function rng(seed){ let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function tex(w, h, draw, srgb = true){
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function normalizeUV(g){
  g.computeBoundingBox(); const b = g.boundingBox, uv = g.attributes.uv, p = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getX(i) - b.min.x) / (b.max.x - b.min.x), (p.getY(i) - b.min.y) / (b.max.y - b.min.y));
  uv.needsUpdate = true; return g;
}
const _o = new THREE.Object3D();
function M(px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx){
  _o.position.set(px, py, pz); _o.rotation.set(rx, ry, rz); _o.scale.set(sx, sy, sz); _o.updateMatrix(); return _o.matrix.clone();
}
function inst(geo, mat, mats, colors){
  const m = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((x, i) => m.setMatrixAt(i, x));
  if (colors) colors.forEach((c, i) => m.setColorAt(i, c));
  m.instanceMatrix.needsUpdate = true; return m;
}
function archPath(Cls, cx, y0, w, spring){ const r = w / 2, p = new Cls(); p.moveTo(cx - r, y0); p.lineTo(cx + r, y0); p.lineTo(cx + r, spring); p.absarc(cx, spring, r, 0, Math.PI, false); p.lineTo(cx - r, y0); return p; }
function rectPath(Cls, x0, y0, x1, y1){ const p = new Cls(); p.moveTo(x0, y0); p.lineTo(x1, y0); p.lineTo(x1, y1); p.lineTo(x0, y1); p.lineTo(x0, y0); return p; }
function archFrame(cx, y0, w, spring, t){
  const R0 = w / 2, R1 = R0 + t, s = new THREE.Shape();
  s.moveTo(cx - R1, y0); s.lineTo(cx - R1, spring); s.absarc(cx, spring, R1, Math.PI, 0, true); s.lineTo(cx + R1, y0);
  s.lineTo(cx + R0, y0); s.lineTo(cx + R0, spring); s.absarc(cx, spring, R0, 0, Math.PI, false); s.lineTo(cx - R0, y0); return s;
}
const rbox = (w, h, d, r = .008) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.01, h / 2.01, d / 2.01));

/* ============================================================
   Surface textures — drawn procedurally, nothing generic
============================================================ */
// micro-surface: fine noise + polishing arcs, used as roughness map on gold
function microDraw(ctx, w, h){
  const r = rng(21), img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++){ const v = 150 + (r() - .5) * 46; img.data[i*4] = img.data[i*4+1] = img.data[i*4+2] = v; img.data[i*4+3] = 255; }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = .05;
  for (let i = 0; i < 160; i++){ ctx.strokeStyle = r() < .5 ? '#fff' : '#000'; ctx.lineWidth = .5 + r() * 1.2; ctx.beginPath(); const cx = r() * w * 2 - w / 2, cy = r() * h * 2 - h / 2, rad = 80 + r() * 600; const a = r() * TAU; ctx.arc(cx, cy, rad, a, a + .3 + r() * .8); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
const ENAMEL = ['#0a1c55', '#16348a', '#0a1c55'];
function enamelBg(ctx, w, h, seed){
  const g = ctx.createLinearGradient(0, 0, 0, h); ENAMEL.forEach((c, i) => g.addColorStop(i / (ENAMEL.length - 1), c)); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const r = rng(seed); for (let i = 0; i < w * h / 60; i++){ ctx.fillStyle = `rgba(${r() < .5 ? '70,110,220' : '0,8,40'},${r() * .14})`; const s = 1 + r() * 3; ctx.fillRect(r() * w, r() * h, s, s); }
}
// pattern painters: (ctx, w, h, G) — G is the inlay colour (gold, or white for masks)
function paintWindow(ctx, w, h, G){
  ctx.strokeStyle = G; ctx.fillStyle = G;
  const lw = w * .06; ctx.lineWidth = lw;
  const r = w / 2 - lw * 1.2, cy = h - w / 2; // arch-topped panel occupying full uv
  ctx.beginPath(); ctx.moveTo(lw * 1.2, h); ctx.lineTo(lw * 1.2, h - (h - w / 2)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(lw * .6, h); ctx.lineTo(lw * .6, w / 2); ctx.arc(w / 2, w / 2, w / 2 - lw * .6, Math.PI, 0); ctx.lineTo(w - lw * .6, h); ctx.stroke();
  ctx.lineWidth = w * .035;
  ctx.beginPath(); ctx.moveTo(w / 2, h * .98); ctx.lineTo(w / 2, h * .52); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w * .18, h * .62); ctx.lineTo(w * .82, h * .62); ctx.stroke();
  ctx.beginPath(); ctx.arc(w / 2, h * .36, w * .17, 0, TAU); ctx.stroke();
  const s = w * .1; ctx.beginPath(); for (let j = 0; j < 16; j++){ const a = j * Math.PI / 8, rad = j % 2 ? s * .45 : s; ctx.lineTo(w / 2 + Math.sin(a) * rad, h * .36 - Math.cos(a) * rad); } ctx.closePath(); ctx.fill();
  for (const yy of [.76, .9]) for (const xx of [.3, .7]){ ctx.beginPath(); ctx.moveTo(w * xx, h * (yy - .05)); ctx.lineTo(w * (xx + .07), h * yy); ctx.lineTo(w * xx, h * (yy + .05)); ctx.lineTo(w * (xx - .07), h * yy); ctx.closePath(); ctx.fill(); }
}
function paintFrieze(ctx, w, h, G){ // abstract arabesque scroll — deliberately not lettering
  ctx.strokeStyle = G; ctx.fillStyle = G; ctx.lineCap = 'round';
  ctx.lineWidth = h * .07; ctx.strokeRect(0, ctx.lineWidth / 2, w, h - ctx.lineWidth);
  const n = 9, p = w / n;
  ctx.lineWidth = h * .05;
  ctx.beginPath(); for (let x = 0; x <= w; x += 2){ const y = h / 2 + Math.sin(x / p * TAU) * h * .2; x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke();
  for (let k = 0; k < n * 2; k++){
    const x = (k + .25) * p / 2, up = k % 2 === 0, y = h / 2 + (up ? -1 : 1) * h * .2;
    ctx.lineWidth = h * .04; ctx.beginPath(); ctx.arc(x + p * .12, y + (up ? h * .1 : -h * .1), h * .12, up ? Math.PI : 0, up ? Math.PI * 2.4 : Math.PI * 1.4); ctx.stroke();
    ctx.beginPath(); ctx.arc(x + p * .3, y + (up ? h * .16 : -h * .16), h * .035, 0, TAU); ctx.fill();
  }
}
function paintDrum(ctx, w, h, G){
  ctx.strokeStyle = G; ctx.fillStyle = G;
  ctx.lineWidth = h * .04; ctx.strokeRect(w * .04, h * .05, w * .92, h * .9);
  ctx.lineWidth = h * .05;
  ctx.beginPath(); ctx.moveTo(w / 2, h * .12); ctx.lineTo(w * .78, h / 2); ctx.lineTo(w / 2, h * .88); ctx.lineTo(w * .22, h / 2); ctx.closePath(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(w / 2, h * .3); ctx.lineTo(w * .62, h / 2); ctx.lineTo(w / 2, h * .7); ctx.lineTo(w * .38, h / 2); ctx.closePath(); ctx.fill();
  for (const [x, y] of [[.12, .18], [.88, .18], [.12, .82], [.88, .82]]){ ctx.beginPath(); ctx.arc(w * x, h * y, h * .045, 0, TAU); ctx.fill(); }
  ctx.lineWidth = h * .025; for (const x of [.22, .78]){ ctx.beginPath(); ctx.moveTo(w * x, h * .2); ctx.lineTo(w * x, h * .8); ctx.stroke(); }
}
function enamelSet(w, h, painter, seed){
  const color = tex(w, h, (c, W, H) => { enamelBg(c, W, H, seed); painter(c, W, H, '#e8c27a'); });
  const mask = tex(w, h, (c, W, H) => { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); painter(c, W, H, '#fff'); }, false);
  const rough = tex(w, h, (c, W, H) => { c.fillStyle = '#262626'; c.fillRect(0, 0, W, H); painter(c, W, H, '#8a8a8a'); }, false);
  return { color, mask, rough };
}
function woodDraw(ctx, w, h){
  ctx.fillStyle = '#3a1a0e'; ctx.fillRect(0, 0, w, h);
  const r = rng(4);
  for (let x = 0; x < w; x += 2){ ctx.fillStyle = `rgba(${r() < .5 ? '90,45,25' : '20,8,4'},${r() * .35})`; ctx.fillRect(x, 0, 2, h); }
  ctx.fillStyle = 'rgba(0,0,0,.6)'; for (let k = 1; k < 4; k++) ctx.fillRect(k * w / 4 - 2, 0, 4, h);
  ctx.fillRect(0, h * .45, w, 4);
}
function sandBodyDraw(ctx, w, h){
  const r = rng(7); ctx.fillStyle = '#c9a670'; ctx.fillRect(0, 0, w, h);
  const tones = ['#9a7848', '#b8925c', '#d4b07a', '#e6cc98', '#f1e0b8', '#fbf0d6', '#86683f', '#e0c08c'];
  for (let i = 0; i < w * h * .06; i++){ const x = r() * w, y = r() * h, rad = .8 + r() * r() * 3.4; ctx.fillStyle = tones[(r() * tones.length) | 0]; ctx.globalAlpha = .55 + r() * .45; ctx.beginPath(); ctx.ellipse(x, y, rad, rad * (.6 + r() * .4), r() * 3, 0, TAU); ctx.fill(); }
  ctx.globalAlpha = 1;
}
function domeBumpDraw(ctx, w, h){ // tiles: grooves on a smooth field
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000'; const cols = 36, rows = 13;
  for (let i = 0; i < cols; i++) ctx.fillRect(i * w / cols - 1.5, 0, 3, h);
  for (let j = 0; j <= rows; j++) ctx.fillRect(0, j * h / rows - 1.5, w, 3);
}
function domeRoughDraw(ctx, w, h){
  const r = rng(13), cols = 36, rows = 13;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++){ const v = 110 + r() * 70; ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(i * w / cols, j * h / rows, w / cols, h / rows); }
  ctx.fillStyle = '#e0e0e0'; for (let i = 0; i < cols; i++) ctx.fillRect(i * w / cols - 1.5, 0, 3, h); for (let j = 0; j <= rows; j++) ctx.fillRect(0, j * h / rows - 1.5, w, 3);
}
function marbleDraw(ctx, w, h){
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * .7); g.addColorStop(0, '#16120f'); g.addColorStop(1, '#0a0908'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const r = rng(11);
  for (let v = 0; v < 70; v++){
    let x = r() * w, y = r() * h, a = r() * TAU; ctx.beginPath(); ctx.moveTo(x, y);
    const len = 150 + r() * 900; for (let i = 0; i < len; i += 5){ a += (r() - .5) * .3; x += Math.cos(a) * 5; y += Math.sin(a) * 5; ctx.lineTo(x, y); }
    const warm = v % 6 === 0; ctx.strokeStyle = warm ? `rgba(196,160,104,${.18 + r() * .25})` : `rgba(225,218,205,${.08 + r() * .16})`;
    ctx.lineWidth = .4 + r() * (warm ? 2.2 : 1.4); ctx.stroke();
  }
}
function softboxDraw(ctx, w, h){ // soft-edged light panel: highlights roll off like a real diffuser
  const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.18, '#fff'); g.addColorStop(.82, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const v = ctx.createLinearGradient(0, 0, 0, h); v.addColorStop(0, 'rgba(0,0,0,1)'); v.addColorStop(.15, 'rgba(0,0,0,0)'); v.addColorStop(.85, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
}
function plaqueDraw(ctx, w, h){
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `300 ${h * .34}px "Cormorant Garamond", Georgia, serif`; ctx.fillText('I L I Y A', w / 2, h * .42);
  ctx.font = `400 ${h * .1}px Manrope, sans-serif`; ctx.fillText('G R A N D   C O L L E C T O R   E D I T I O N', w / 2, h * .74);
}

/* ============================================================
   Materials — physically based
============================================================ */
let MATS = null;
function materials(){
  if (MATS) return MATS;
  const micro = tex(512, 512, microDraw, false); micro.repeat.set(3, 3);
  const win = enamelSet(256, 384, paintWindow, 3), friz = enamelSet(1024, 128, paintFrieze, 5), drm = enamelSet(256, 192, paintDrum, 9);
  const wood = tex(256, 512, woodDraw);
  const sand = tex(512, 512, sandBodyDraw); sand.repeat.set(4, 1);
  const sandTop = tex(512, 512, sandBodyDraw); sandTop.repeat.set(3, 3);
  const domeBump = tex(2048, 1024, domeBumpDraw, false), domeRough = tex(1024, 512, domeRoughDraw, false);
  const marble = tex(2048, 2048, marbleDraw); marble.repeat.set(1.4, 1.4);
  const plaque = tex(1024, 256, plaqueDraw, false);
  const GOLD = new THREE.Color('#ffc552');
  const gold = (rough, color = GOLD) => new THREE.MeshPhysicalMaterial({ color, metalness: 1, roughness: rough, roughnessMap: micro, envMapIntensity: 1 });
  const enamel = s => new THREE.MeshPhysicalMaterial({ map: s.color, metalnessMap: s.mask, roughnessMap: s.rough, bumpMap: s.mask, bumpScale: 1.4, metalness: 1, roughness: 1, clearcoat: 1, clearcoatRoughness: .035, envMapIntensity: 1.05 });
  MATS = {
    gold: gold(.3), satin: gold(.5), deep: gold(.62, new THREE.Color('#d9aa5c')),
    win: enamel(win), frieze: Object.assign(enamel(friz), { clearcoat: .55 }), drum: enamel(drm),
    enamelPlain: new THREE.MeshPhysicalMaterial({ color: '#13307f', roughness: .08, clearcoat: 1, clearcoatRoughness: .03 }),
    door: new THREE.MeshPhysicalMaterial({ map: wood, roughness: .45, clearcoat: .6, clearcoatRoughness: .2 }),
    dome: new THREE.MeshPhysicalMaterial({ color: GOLD, metalness: 1, roughness: .34, roughnessMap: domeRough, bumpMap: domeBump, bumpScale: 2.2, envMapIntensity: 1 }),
    recess: new THREE.MeshStandardMaterial({ color: '#0b0705', roughness: .9 }),
    glass: new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 0, roughness: .015, transmission: 1, thickness: .22, ior: 1.5, envMapIntensity: 1.15, specularIntensity: 1, attenuationColor: new THREE.Color('#f4efe4'), attenuationDistance: 3, side: THREE.DoubleSide }),
    sandBody: new THREE.MeshStandardMaterial({ map: sand, bumpMap: sand, bumpScale: 2.5, roughness: .95 }),
    sandTop: new THREE.MeshStandardMaterial({ map: sandTop, bumpMap: sandTop, bumpScale: 2.5, roughness: .95 }),
    grain: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .78, metalness: 0, flatShading: true }),
    diamond: new THREE.MeshPhysicalMaterial({ color: '#ffffff', metalness: 0, roughness: 0, ior: 2.42, specularIntensity: 1, envMapIntensity: 2.6, flatShading: true }),
    marble: new THREE.MeshPhysicalMaterial({ map: marble, roughness: .2, clearcoat: .4, clearcoatRoughness: .12, transparent: true, opacity: .74, envMapIntensity: .16 }),
    plinth: new THREE.MeshPhysicalMaterial({ map: marble, roughness: .12, clearcoat: 1, clearcoatRoughness: .05, envMapIntensity: .6 }),
    cloche: new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0, transmission: 1, thickness: .04, ior: 1.5, envMapIntensity: .9, side: THREE.DoubleSide, depthWrite: false, transparent: true }),
    plaque: new THREE.MeshPhysicalMaterial({ color: GOLD, metalness: 1, roughness: .32, bumpMap: plaque, bumpScale: 3 }),
  };
  return MATS;
}

/* ============================================================
   Geometry — THE CREATION. One geometry for both sizes.
   1 unit = 10 mm at pendant scale. Octagon vertex Ø = 45 mm.
============================================================ */
function brilliantGeo(){ const pts = [new THREE.Vector2(0, -.43), new THREE.Vector2(.5, 0), new THREE.Vector2(.5, .03), new THREE.Vector2(.3, .16), new THREE.Vector2(0, .16)]; const g = new THREE.LatheGeometry(pts, 8); g.computeVertexNormals(); return g; }
function columnGeo(h){
  const shaftPts = []; for (let i = 0; i <= 10; i++){ const t = i / 10; shaftPts.push(new THREE.Vector2(.024 * (1 - .14 * t) * (1 + .05 * Math.sin(t * Math.PI)), t * h)); }
  const shaft = new THREE.LatheGeometry(shaftPts, 16);
  const base = new THREE.LatheGeometry([new THREE.Vector2(.0001, 0), new THREE.Vector2(.042, 0), new THREE.Vector2(.042, .012), new THREE.Vector2(.036, .018), new THREE.Vector2(.033, .026), new THREE.Vector2(.026, .034), new THREE.Vector2(.0001, .034)], 16);
  const cap = new THREE.LatheGeometry([new THREE.Vector2(.0001, h - .04), new THREE.Vector2(.022, h - .04), new THREE.Vector2(.026, h - .03), new THREE.Vector2(.034, h - .012), new THREE.Vector2(.0001, h - .012)], 16);
  const ab = rbox(.084, .02, .084, .004); ab.translate(0, h - .002, 0);
  return mergeGeometries([shaft, base, cap, ab].map(g => g.index ? g.toNonIndexed() : g));
}
function grainGeo(){ let g = new THREE.IcosahedronGeometry(1, 0); g.deleteAttribute('normal'); g.deleteAttribute('uv'); g = mergeVertices(g); const p = g.attributes.position, r = rng(17); for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (.75 + r() * .5), p.getY(i) * (.7 + r() * .5), p.getZ(i) * (.75 + r() * .5)); g.computeVertexNormals(); return g; }

function buildCreation({ bail = true, grains = MOBILE ? 2400 : 5200 } = {}){
  const m = materials(), root = new THREE.Group();
  const R = 2.25, A = R * Math.cos(Math.PI / 8), W = 2 * R * Math.sin(Math.PI / 8), OCT = Math.PI / 8;
  const add = (geo, mat, x = 0, y = 0, z = 0, ry = 0, parent = root) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.y = ry; parent.add(o); return o; };
  let y = 0;

  /* — gold base band, moulded */
  const lathe = (pts, seg = 160) => new THREE.LatheGeometry(pts.map(([r, h]) => new THREE.Vector2(r, h)), seg);
  add(lathe([[0.0001, 0], [2.05, 0], [2.1, .015], [2.115, .05], [2.1, .085], [2.085, .1], [2.1, .118], [2.12, .15], [2.12, .21], [2.1, .245], [2.07, .27], [1.94, .28], [0.0001, .28]]), m.gold);
  y = .28;
  /* — transparent chamber with sand */
  const CH = .95, RI = 1.94, RO = 2.04;
  const glass = add(lathe([[RI, 0], [RO, 0], [RO, CH], [RI, CH], [RI, 0]], 128), m.glass, 0, y); glass.renderOrder = 3;
  const SH = .7;
  const r1 = rng(29), heap = (x, z) => { const d = Math.hypot(x, z) / RI; return SH + .07 * (1 - d * d) + Math.sin(x * 2.3 + 1) * Math.cos(z * 1.9) * .035 + Math.sin(x * 7.1) * Math.sin(z * 6.3) * .012; };
  add(new THREE.CylinderGeometry(RI - .035, RI - .035, SH, 128, 1, true), m.sandBody, 0, y + SH / 2);
  const st = new THREE.CircleGeometry(RI - .035, 128, 0, TAU); // displace a dense ring version
  const top = new THREE.RingGeometry(.0001, RI - .035, 128, 40); const tp = top.attributes.position;
  for (let i = 0; i < tp.count; i++) tp.setZ(i, heap(tp.getX(i), -tp.getY(i)) - SH);
  top.computeVertexNormals(); const topM = add(top, m.sandTop, 0, y + SH); topM.rotation.x = -Math.PI / 2;
  // individual grains — outer layer against the glass, and the surface of the heap
  const gg = grainGeo(), gm = [], gc = [], tones = ['#f3e2b8', '#e6cc98', '#d8b680', '#c7a26c', '#a8845a', '#fff3d8', '#bf9e72', '#e9d6ae'].map(c => new THREE.Color(c));
  const nSide = Math.round(grains * .55);
  for (let i = 0; i < grains; i++){
    const s = .02 + r1() * r1() * .045; let gx, gy, gz;
    if (i < nSide){ const a = r1() * TAU, rr = RI - .012 - s - r1() * .03; gx = Math.sin(a) * rr; gz = Math.cos(a) * rr; gy = r1() * (heap(gx, gz) - .02); }
    else { const a = r1() * TAU, rr = Math.sqrt(r1()) * (RI - .05); gx = Math.sin(a) * rr; gz = Math.cos(a) * rr; gy = heap(gx, gz) - s * .3; }
    gm.push(M(gx, y + gy, gz, r1() * 6, r1() * 6, r1() * 6, s, s * (.7 + r1() * .5), s));
    gc.push(tones[(r1() * tones.length) | 0].clone().multiplyScalar(.85 + r1() * .3));
  }
  root.add(inst(gg, m.grain, gm, gc));
  y += CH;
  /* — upper gold band */
  add(lathe([[1.9, 0], [2.08, 0], [2.11, .02], [2.115, .06], [2.1, .1], [2.08, .12], [1.9, .12]]), m.gold, 0, y);
  y += .12;
  /* — octagonal podium */
  const pod = add(new THREE.CylinderGeometry(R * 1.015, R * 1.03, .06, 8), m.satin, 0, y + .03); pod.rotation.y = OCT;
  y += .06;

  /* — ARCADE: eight complete faces */
  const AH = 1.21, n = 5, bay = W / n;
  const core = add(new THREE.CylinderGeometry(R * .9, R * .9, AH, 8), m.recess, 0, y + AH / 2); core.rotation.y = OCT;
  const WIN_Y0 = .63, WIN_SPR = .80, WIN_W = .23, DOOR_W = .27, DOOR_SPR = .78;
  const LOW = [.1, .53];
  function wallGeo(door){
    const s = rectPath(THREE.Shape, -W / 2, 0, W / 2, AH);
    for (let k = 0; k < n; k++){ const cx = -W / 2 + bay * (k + .5);
      if (door && k === 2) s.holes.push(archPath(THREE.Path, cx, .06, DOOR_W, DOOR_SPR));
      else { s.holes.push(archPath(THREE.Path, cx, WIN_Y0, WIN_W, WIN_SPR)); s.holes.push(rectPath(THREE.Path, cx - .115, LOW[0], cx + .115, LOW[1])); }
    }
    return new THREE.ExtrudeGeometry(s, { depth: .06, bevelEnabled: true, bevelThickness: .006, bevelSize: .006, bevelSegments: 2, curveSegments: 14 });
  }
  const wallPlain = wallGeo(false), wallDoor = wallGeo(true);
  const framesGeo = door => { const sh = []; for (let k = 0; k < n; k++){ const cx = -W / 2 + bay * (k + .5); if (door && k === 2) sh.push(archFrame(cx, .06, DOOR_W, DOOR_SPR, .045)); else sh.push(archFrame(cx, WIN_Y0 - .03, WIN_W, WIN_SPR, .034)); } return new THREE.ExtrudeGeometry(sh, { depth: .03, bevelEnabled: true, bevelThickness: .004, bevelSize: .004, bevelSegments: 1, curveSegments: 14 }); };
  const framePlain = framesGeo(false), frameDoor = framesGeo(true);
  const winGeo = normalizeUV(new THREE.ShapeGeometry(archPath(THREE.Shape, 0, WIN_Y0, WIN_W, WIN_SPR), 14));
  const doorGeo = normalizeUV(new THREE.ShapeGeometry(archPath(THREE.Shape, 0, .06, DOOR_W, DOOR_SPR), 14));
  const panelOuter = rbox(.21, LOW[1] - LOW[0] - .02, .03, .006), panelInner = rbox(.14, LOW[1] - LOW[0] - .12, .024, .006);
  const podium = rbox(W + .02, .06, .15, .01), course = rbox(W, .032, .085, .008), friezeTop = rbox(W + .01, .04, .1, .01), friezeBot = rbox(W, .03, .08, .008);
  const frieze = new THREE.PlaneGeometry(W, .2);
  const colG = columnGeo(WIN_Y0 - .07);
  const cols = [];
  const AX = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 8; i++){
    const a = i * Math.PI / 4, door = i % 2 === 0, f = new THREE.Group(); f.rotation.y = a; f.position.y = y; root.add(f);
    add(door ? wallDoor : wallPlain, m.satin, 0, 0, A - .06, 0, f);
    add(door ? frameDoor : framePlain, m.gold, 0, 0, A + .004, 0, f);
    for (let k = 0; k < n; k++){ const cx = -W / 2 + bay * (k + .5);
      if (door && k === 2){ add(doorGeo, m.door, cx, 0, A - .05, 0, f); continue; }
      add(winGeo, m.win, cx, 0, A - .035, 0, f);
      add(panelOuter, m.deep, cx, (LOW[0] + LOW[1]) / 2, A - .05, 0, f);
      add(panelInner, m.satin, cx, (LOW[0] + LOW[1]) / 2, A - .03, 0, f);
    }
    add(podium, m.gold, 0, .03, A + .03, 0, f);
    add(course, m.gold, 0, .955, A + .01, 0, f);
    add(friezeBot, m.gold, 0, .985, A + .012, 0, f);
    add(frieze, m.frieze, 0, 1.1, A + .013, 0, f);
    add(friezeTop, m.gold, 0, AH - .02, A + .02, 0, f);
    for (let k = 0; k <= n; k++){
      const x = k === 0 ? -W / 2 + .07 : k === n ? W / 2 - .07 : -W / 2 + bay * k;
      for (const dx of (k === 0 || k === n) ? [0] : [-.03, .03]){ const v = new THREE.Vector3(x + dx, y + .06, A + .065).applyAxisAngle(AX, a); cols.push(M(v.x, v.y, v.z, 0, a, 0)); }
    }
  }
  root.add(inst(colG, m.gold, cols));
  const pil = rbox(.13, AH + .02, .13, .012);
  for (let i = 0; i < 8; i++){ const a = i * Math.PI / 4 + Math.PI / 8; add(pil, m.gold, Math.sin(a) * (R - .01), y + AH / 2, Math.cos(a) * (R - .01), a); }
  y += AH;
  /* — cornice, parapet, roof */
  const c1 = add(new THREE.CylinderGeometry(R * 1.045, R * 1.03, .06, 8), m.gold, 0, y + .03); c1.rotation.y = OCT;
  const c2 = add(new THREE.CylinderGeometry(R * 1.06, R * 1.06, .045, 8), m.satin, 0, y + .08); c2.rotation.y = OCT;
  y += .1;
  const roof = add(new THREE.CylinderGeometry(1.5, R * 1.02, .13, 8, 1), m.deep, 0, y + .065); roof.rotation.y = OCT;
  for (let i = 0; i < 8; i++){ const a = i * Math.PI / 4 + Math.PI / 8; const rib = add(rbox(.04, .04, R * 1.02 - 1.5 + .05, .01), m.gold, Math.sin(a) * (R * 1.02 + 1.5) / 2, y + .07, Math.cos(a) * (R * 1.02 + 1.5) / 2, a); rib.rotateX(Math.atan2(.13, R * 1.02 - 1.5)); }
  for (let i = 0; i < 32; i++){ const a = i / 32 * TAU; const rr = (R * .98 + 1.5) / 2; if (i % 4 === 2) continue; const rib = add(rbox(.016, .016, R * .98 - 1.5, .006), m.gold, Math.sin(a) * rr, y + .075, Math.cos(a) * rr, a); rib.rotateX(Math.atan2(.13, R - 1.5)); }
  y += .13;
  /* — DRUM: sixteen framed enamel panels */
  const DR = 1.4, DH = .46, sides = 16, ap = DR * Math.cos(Math.PI / sides), sw = 2 * DR * Math.sin(Math.PI / sides);
  add(lathe([[1.36, 0], [1.5, 0], [1.5, .03], [1.46, .05], [1.36, .05]], 96), m.gold, 0, y);
  const drum = add(new THREE.CylinderGeometry(DR, DR, DH, sides), m.satin, 0, y + .05 + DH / 2); drum.rotation.y = Math.PI / sides;
  const pw = sw * .8, ph = DH * .72;
  const frameS = rectPath(THREE.Shape, -sw / 2 + .012, -DH / 2 + .03, sw / 2 - .012, DH / 2 - .03); frameS.holes.push(rectPath(THREE.Path, -pw / 2, -ph / 2, pw / 2, ph / 2));
  const frameG = new THREE.ExtrudeGeometry(frameS, { depth: .03, bevelEnabled: true, bevelThickness: .004, bevelSize: .004, bevelSegments: 1 });
  const panelG = new THREE.PlaneGeometry(pw, ph);
  for (let k = 0; k < sides; k++){ const a = k / sides * TAU; const g = new THREE.Group(); g.rotation.y = a; g.position.y = y + .05 + DH / 2; root.add(g);
    add(frameG, m.gold, 0, 0, ap - .005, 0, g); add(panelG, m.drum, 0, 0, ap + .004, 0, g); }
  y += .05 + DH;
  add(lathe([[1.3, 0], [1.47, 0], [1.48, .02], [1.46, .05], [1.42, .06], [1.3, .06]], 128), m.gold, 0, y);
  y += .06;
  /* — DOME: tiled gold */
  const DRd = 1.36, DHd = 1.15, N = 64;
  const dp = t => { const th = t * Math.PI / 2; return new THREE.Vector2(Math.max(.0001, DRd * (1 + .06 * Math.sin(th * 2)) * Math.pow(Math.cos(th), .9)), DHd * Math.sin(th) + (t > .93 ? (t - .93) * .9 : 0)); };
  const prof = []; for (let i = 0; i <= N; i++) prof.push(dp(i / N));
  add(new THREE.LatheGeometry(prof, 160), m.dome, 0, y);
  const ribs = []; for (let k = 0; k < 36; k++){ const a = k / 36 * TAU, pts = []; for (let i = 0; i <= 30; i++){ const v = dp(i / 30 * .9); pts.push(new THREE.Vector3(Math.sin(a) * (v.x + .006), v.y, Math.cos(a) * (v.x + .006))); } ribs.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, .0075, 4, false)); }
  add(mergeGeometries(ribs), m.gold, 0, y);
  const apex = dp(1).y; y += apex;
  /* — finial */
  add(lathe([[.0001, -.02], [.13, -.02], [.12, .02], [.07, .04], [.05, .08], [.085, .13], [.095, .17], [.085, .21], [.045, .25], [.03, .3], [.0001, .32]], 32), m.gold, 0, y);
  y += .32;
  root.userData.top = y;
  /* — bail: restrained diamonds on the attachment only */
  if (bail){
    const b = new THREE.Group(); b.position.y = y; root.add(b);
    const jr = add(new THREE.TorusGeometry(.085, .026, 16, 40), m.gold, 0, .08, 0, 0, b);
    const loop = new THREE.TorusGeometry(.2, .065, 24, 64); loop.scale(1, 1.55, .85);
    add(loop, m.gold, 0, .44, 0, Math.PI / 2, b);
    const bd = []; for (let j = 0; j < 3; j++) bd.push(M(0, .26 + j * .13, .2, -Math.PI / 2, 0, 0, .085));
    b.add(inst(brilliantGeo(), m.diamond, bd));
    const cups = []; for (let j = 0; j < 3; j++) cups.push(M(0, .26 + j * .13, .175, Math.PI / 2, 0, 0)); b.add(inst(new THREE.CylinderGeometry(.052, .045, .03, 20), m.gold, cups));
    root.userData.bailTop = y + .7;
  }
  root.traverse(o => { if (o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });
  glass.castShadow = false;
  return root;
}

function buildChain(from, links = 44){
  const m = materials(), g = new THREE.Group(); const lg = new THREE.TorusGeometry(.15, .043, 12, 32); lg.scale(1.5, 1, 1);
  const mats = [], st = [], dm = [];
  for (const side of [-1, 1]){
    const ang = .17, dir = new THREE.Vector3(side * Math.sin(ang), Math.cos(ang), 0);
    for (let i = 0; i < links; i++){
      const p = from.clone().addScaledVector(dir, .1 + i * .34);
      const rz = Math.PI / 2 - side * ang;
      if (i > 0 && i % 12 === 0){ st.push(M(p.x, p.y, p.z, Math.PI / 2, 0, 0)); dm.push(M(p.x, p.y, p.z + .07, -Math.PI / 2, 0, 0, .1)); continue; }
      const mm = M(p.x, p.y, p.z, 0, 0, rz); if (i % 2) mm.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)); mats.push(mm);
    }
  }
  g.add(inst(lg, m.gold, mats)); g.add(inst(new THREE.CylinderGeometry(.085, .085, .13, 24), m.gold, st)); g.add(inst(brilliantGeo(), m.diamond, dm));
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function buildDisplay(){
  const m = materials(), g = new THREE.Group();
  const pR = 8, pH = 2.6;
  const oct = (r1, r2, h, mat, y) => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, 8), mat); o.rotation.y = Math.PI / 8; o.position.y = y; o.castShadow = o.receiveShadow = true; g.add(o); return o; };
  oct(pR, pR, pH, m.plinth, -pH / 2);
  oct(pR * 1.012, pR * 1.012, .07, m.gold, -.035);
  oct(pR * 1.05, pR * 1.07, .3, m.plinth, -pH - .15);
  oct(pR * 1.03, pR * 1.03, .05, m.gold, -pH + .01);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 6.7, .16, 128), m.satin); disc.position.y = .08; disc.receiveShadow = true; g.add(disc);
  const Ap = pR * Math.cos(Math.PI / 8); const pl = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.15), m.plaque); pl.position.set(0, -pH / 2, Ap + .012); g.add(pl);
  const cr = 7, ch = 11, pts = [new THREE.Vector2(cr, 0), new THREE.Vector2(cr, ch)];
  for (let i = 1; i <= 28; i++){ const a = i / 28 * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(.001, Math.cos(a) * cr), ch + Math.sin(a) * cr * .82)); }
  const cl = new THREE.Mesh(new THREE.LatheGeometry(pts, 128), m.cloche); cl.position.y = .16; cl.renderOrder = 6; cl.name = 'cloche'; g.add(cl);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(cr + .03, .08, 12, 160), m.gold); ring.rotation.x = Math.PI / 2; ring.position.y = .18; g.add(ring);
  return g;
}

/* ============================================================
   Photographic studio — HDR softboxes, marble, shadows, lens
============================================================ */
function studioEnv(renderer, mood){
  const s = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(40, 30, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(mood === 'dusk' ? '#2a1a0e' : '#2a2119'), side: THREE.BackSide })); s.add(room);
  const sb = tex(256, 256, softboxDraw, false);
  const box = (w, h, col, k, pos) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(k), alphaMap: sb, transparent: true, side: THREE.DoubleSide })); p.position.set(...pos); p.lookAt(0, 1, 0); s.add(p); };
  if (mood === 'dusk'){
    box(14, 5, '#ff9b52', 3.4, [-9, 3, 7]); box(9, 2.5, '#7d93ff', 1.2, [9, 6, -5]); box(2.5, 11, '#ffd2a0', 2.6, [7, 1, 8]); box(10, 3, '#ffc690', 2.2, [0, 11, 0]);
  } else {
    box(16, 8, '#fff3e2', 5.5, [0, 12, 2]);       // overhead diffuser
    box(4, 14, '#fff6ea', 6.5, [-10, 2, 4]);   // key strip
    box(3.5, 13, '#ffe6c6', 4.5, [10, 3, -2]);     // second strip
    box(14, 3, '#fff1dc', 3.2, [0, 1.5, 11]); box(6, 10, '#fff4e6', 3.5, [7, 3, 8]);    // front fill card — lights the bands
    box(7, 1.6, '#c8d4ff', 1.1, [0, 5, -11]);    // cool rim
    box(4, 4, '#ffffff', 2.6, [-6, 7, 9]);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: '#1a120a' })); floor.rotation.x = -Math.PI / 2; floor.position.y = -6; s.add(floor);
  const pm = new THREE.PMREMGenerator(renderer); const t = pm.fromScene(s, .02).texture; pm.dispose(); return t;
}

function makeStudio(canvas, { dof = !MOBILE, floorSize = 34 } = {}){
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false }); } catch (e) { return null; }
  if (!renderer.getContext()) return null;
  renderer.setPixelRatio(Math.min(devicePixelRatio, MOBILE ? 1.6 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const BG = new THREE.Color('#070605'); scene.background = BG; scene.fog = new THREE.Fog(BG, 24, 70);
  const envs = { gallery: studioEnv(renderer, 'gallery'), dusk: studioEnv(renderer, 'dusk') };
  scene.environment = envs.gallery;
  const cam = new THREE.PerspectiveCamera(17, 1, .1, 400); // ≈ 85 mm lens
  // key light with soft shadow; the environment does most of the work
  const key = new THREE.DirectionalLight('#fff0dc', 1.6); key.position.set(-6, 14, 7); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 6; key.shadow.bias = -.0004; key.shadow.normalBias = .02;
  Object.assign(key.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 40 });
  scene.add(key);
  const rim = new THREE.DirectionalLight('#b9c8ff', .5); rim.position.set(6, 5, -9); scene.add(rim);
  // polished dark marble, with a true mirrored reflection beneath it
  const m = materials();
  const fade = tex(512, 512, (c, w, h) => { const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); g.addColorStop(0, '#fff'); g.addColorStop(.28, '#fff'); g.addColorStop(.75, '#222'); g.addColorStop(1, '#000'); c.fillStyle = g; c.fillRect(0, 0, w, h); }, false);
  const floorMat = m.marble.clone(); floorMat.alphaMap = fade; floorMat.map = m.marble.map.clone(); floorMat.map.repeat.set(1, 1);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(floorSize, 96), floorMat); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.renderOrder = 1; scene.add(floor);
  const shadowCatcher = new THREE.Mesh(new THREE.CircleGeometry(floorSize, 64), new THREE.ShadowMaterial({ opacity: .55 })); shadowCatcher.rotation.x = -Math.PI / 2; shadowCatcher.position.y = .002; shadowCatcher.receiveShadow = true; shadowCatcher.renderOrder = 2; scene.add(shadowCatcher);
  let composer = null, bokeh = null;
  if (dof){
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, cam));
    bokeh = new BokehPass(scene, cam, { focus: 20, aperture: .00012, maxblur: .006 });
    composer.addPass(bokeh); composer.addPass(new OutputPass());
  }
  return { renderer, scene, cam, envs, key, rim, floor, composer, bokeh, canvas, aperture: .00012 };
}
function addWithReflection(st, obj){
  st.scene.add(obj);
  const mirror = obj.clone(true); mirror.scale.y *= -1; mirror.userData.isMirror = true; st.scene.add(mirror);
  mirror.traverse(o => { if (o.isMesh) o.castShadow = false; });
  return mirror;
}
function sizeStudio(st, w, h, pr){
  const r = st.renderer; if (pr) r.setPixelRatio(pr);
  r.setSize(w, h, false); st.cam.aspect = w / h; st.cam.updateProjectionMatrix();
  if (st.composer){ st.composer.setPixelRatio(r.getPixelRatio()); st.composer.setSize(w, h); }
}
function autoSize(st){
  const c = st.canvas, w = c.clientWidth, h = c.clientHeight, pr = st.renderer.getPixelRatio();
  if (c.width !== Math.floor(w * pr) || c.height !== Math.floor(h * pr)) sizeStudio(st, w, h);
}
function renderStudio(st, target){
  const dist = st.cam.position.distanceTo(target); st.scene.fog.near = dist * 1.3; st.scene.fog.far = dist * 3.6;
  if (st.bokeh){ st.bokeh.uniforms.focus.value = st.cam.position.distanceTo(target); st.bokeh.uniforms.aperture.value = st.aperture; st.composer.render(); }
  else st.renderer.render(st.scene, st.cam);
}
// lens-aware framing: distances are authored for a 32° lens and converted to the 85 mm camera
const LENS = Math.tan(16 * D2R) / Math.tan(8.5 * D2R);
function camFrom(v, k = 1){ const d = v.d * LENS * k; return { pos: new THREE.Vector3(Math.sin(v.az) * Math.cos(v.el) * d, v.ty + Math.sin(v.el) * d, Math.cos(v.az) * Math.cos(v.el) * d), tgt: new THREE.Vector3(0, v.ty, 0) }; }

/* ============================================================
   HERO STAGE — scroll-driven camera on rails
============================================================ */
const beats = [...document.querySelectorAll('.beat')], progEls = [...document.querySelectorAll('.progress span')];
const stage = document.getElementById('stage');
const ss = t => t * t * (3 - 2 * t);
function stageProgress(){ if (!stage) return 0; const r = stage.getBoundingClientRect(); return Math.min(1, Math.max(0, -r.top / (r.height - innerHeight))); }
function updateBeats(p){
  const seg = p * 4;
  beats.forEach((el, i) => {
    let o = Math.max(0, 1 - Math.abs(seg - i) / .42); o = ss(o);
    el.style.opacity = o.toFixed(3);
    el.style.transform = MOBILE ? `translateY(${(1 - o) * 20}px)` : `translateY(calc(-50% + ${(1 - o) * 24}px))`;
    el.classList.toggle('on', o > .5);
  });
  progEls.forEach((e, i) => e.classList.toggle('on', Math.round(seg) === i));
}

let hero = null;
const heroCanvas = document.getElementById('heroCanvas');
if (heroCanvas){
  hero = makeStudio(heroCanvas);
  if (!hero) document.getElementById('heroFallback').style.display = 'flex';
  else {
    const piece = new THREE.Group();
    const c = buildCreation({ bail: true }); piece.add(c);
    piece.add(buildChain(new THREE.Vector3(0, c.userData.bailTop - .1, 0)));
    const mirror = addWithReflection(hero, piece);
    hero.piece = piece; hero.mirror = mirror;
    hero.BEATS = [
      { az: .0, el: .07, d: 14.2, ty: 2.35, ox: .17 },
      { az: .62, el: .04, d: 9.2, ty: 2.0, ox: -.2 },
      { az: -.42, el: .5, d: 8.6, ty: 3.7, ox: .2 },
      { az: .3, el: .02, d: 8.6, ty: 1.0, ox: -.2 },
      { az: .0, el: .09, d: 13.8, ty: 2.4, ox: .17 },
    ];
    hero.cur = { ...hero.BEATS[0] }; hero.visible = false; hero.t0 = performance.now();
  }
}

/* ============================================================
   STUDIO — interactive 360° inspection
============================================================ */
let studio = null;
const studioCanvas = document.getElementById('studioCanvas');
if (studioCanvas){
  studio = makeStudio(studioCanvas);
  if (studio){
    const S = studio;
    const controls = new OrbitControls(S.cam, studioCanvas);
    Object.assign(controls, { enableDamping: true, dampingFactor: .06, rotateSpeed: .5, zoomSpeed: .7, enablePan: false, autoRotate: !REDUCED, autoRotateSpeed: .4 });
    S.controls = controls;
    S.pend = new THREE.Group(); const c1 = buildCreation({ bail: true }); S.pend.add(c1); S.chain = buildChain(new THREE.Vector3(0, c1.userData.bailTop - .1, 0), 30); S.pend.add(S.chain);
    S.pendMirror = addWithReflection(S, S.pend);
    S.GRAND = 114 / 45;
    S.grand = new THREE.Group(); const c2 = buildCreation({ bail: false, grains: MOBILE ? 3000 : 7000 }); c2.scale.setScalar(S.GRAND); c2.position.y = .16; S.grand.add(c2);
    S.display = buildDisplay(); S.grand.add(S.display); S.grand.position.y = 2.75; // plinth stands on the floor
    S.scene.add(S.grand);
    S.mode = 'pendant'; S.tween = null; S.visible = false;
  }
}

const MODES = {
  pendant: { title: 'The Pendant', dims: [['45 mm', 'Width'], ['47.16 mm', 'Height'], ['≈ 50 g', '18K gold · target']], flag: 'Preliminary targets — certified on completion.',
    details: [['Full view', { az: .38, el: .14, d: 15.5, ty: 2.5 }], ['The dome', { az: -.5, el: .62, d: 6.4, ty: 3.95 }], ['The arcade', { az: .42, el: .04, d: 5.8, ty: 2.0 }], ['Enamel drum', { az: .9, el: .28, d: 5.0, ty: 3.15 }], ['Sand chamber', { az: .2, el: .02, d: 5.6, ty: .8 }], ['The rear', { az: Math.PI + .3, el: .12, d: 13, ty: 2.4 }], ['Bail & chain', { az: .3, el: .1, d: 4.8, ty: 5.4 }]] },
  grand: { title: 'Grand Collector Edition', dims: [['114 mm', 'Width*'], ['120 mm', 'Height*'], ['×2.53', 'Same geometry']], flag: '*Per reference board. The brief also describes "two 1.5 L bottles" (~180 × 300 mm). Awaiting confirmation.',
    details: [['Full view', { az: .35, el: .14, d: 44, ty: 9 }], ['Within the cloche', { az: -.3, el: .1, d: 26, ty: 9 }], ['The dome', { az: -.5, el: .55, d: 15, ty: 13.2 }], ['Sand chamber', { az: .25, el: .02, d: 14, ty: 4.9 }], ['The plinth', { az: 0, el: .06, d: 22, ty: 1.5 }], ['The rear', { az: Math.PI + .35, el: .14, d: 40, ty: 8 }]] },
  compare: { title: 'Side by side', dims: [['1 : 2.53', 'Scale'], ['One', 'Geometry']], flag: 'True relative scale. Cloche removed for clarity.',
    details: [['Both creations', { az: .25, el: .1, d: 50, ty: 6 }], ['From above', { az: .25, el: .85, d: 46, ty: 4 }], ['The rear', { az: Math.PI + .25, el: .1, d: 50, ty: 6 }]] },
};
const vinfo = document.getElementById('vinfo'), detailsEl = document.getElementById('details'), labP = document.getElementById('labP'), labG = document.getElementById('labG');
function goTo(v, instant){
  if (!studio) return; const S = studio, k = MOBILE ? (S.mode === 'compare' ? 2.0 : 1.3) : 1, c = camFrom(v, k);
  S.aperture = v.d < 8 ? .00032 : v.d < 20 ? .0002 : .00012;
  if (instant || REDUCED){ S.cam.position.copy(c.pos); S.controls.target.copy(c.tgt); S.tween = null; S.controls.update(); return; }
  S.tween = { p0: S.cam.position.clone(), t0: S.controls.target.clone(), p1: c.pos, t1: c.tgt, start: performance.now(), dur: 1900 };
}
function setMode(mode, instant){
  const md = MODES[mode];
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === mode));
  if (vinfo) vinfo.innerHTML = `<div class="eyebrow" style="margin-bottom:10px">${mode === 'compare' ? 'Two sizes · one architecture' : 'Visual prototype'}</div><h3>${md.title}</h3><div class="dims">${md.dims.map(d => `<span><b>${d[0]}</b>${d[1]}</span>`).join('')}</div><div class="flag">${md.flag}</div>`;
  if (detailsEl){
    detailsEl.innerHTML = md.details.map((d, i) => `<button data-i="${i}" class="${i === 0 ? 'on' : ''}">${d[0]}</button>`).join('');
    detailsEl.querySelectorAll('button').forEach(b => b.onclick = () => { detailsEl.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); if (studio) studio.controls.autoRotate = false; goTo(md.details[+b.dataset.i][1]); });
  }
  if (!studio) return;
  const S = studio; S.mode = mode;
  S.pend.visible = S.pendMirror.visible = mode !== 'grand';
  S.grand.visible = mode !== 'pendant';
  S.display.getObjectByName('cloche').visible = mode === 'grand';
  if (mode === 'compare'){ S.pend.position.set(-8, 0, 5); S.grand.position.set(6, 2.75, 0); } else { S.pend.position.set(0, 0, 0); S.grand.position.set(0, 2.75, 0); }
  S.pendMirror.position.copy(S.pend.position);
  S.controls.minDistance = (mode === 'pendant' ? 3 : 8) * LENS; S.controls.maxDistance = (mode === 'pendant' ? 26 : 90) * LENS;
  S.controls.minPolarAngle = .15; S.controls.maxPolarAngle = Math.PI * .5 - .02;
  if (labP) labP.style.opacity = labG.style.opacity = mode === 'compare' ? 1 : 0;
  goTo(md.details[0][1], instant);
}
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
document.querySelectorAll('[data-light]').forEach(b => b.onclick = () => { document.querySelectorAll('[data-light]').forEach(x => x.setAttribute('aria-pressed', x === b)); if (studio){ studio.scene.environment = studio.envs[b.dataset.light]; studio.key.color.set(b.dataset.light === 'dusk' ? '#ffb27a' : '#fff0dc'); } });
if (studio){ setMode('pendant', true); const stop = () => { studio.controls.autoRotate = false; const h = document.getElementById('hint'); if (h) h.style.opacity = 0; }; studioCanvas.addEventListener('pointerdown', stop); studioCanvas.addEventListener('wheel', stop, { passive: true }); }

/* ============================================================
   Loop
============================================================ */
const io = new IntersectionObserver(es => es.forEach(e => { if (hero && e.target === heroCanvas) hero.visible = e.isIntersecting; if (studio && e.target === studioCanvas) studio.visible = e.isIntersecting; }), { rootMargin: '150px' });
if (heroCanvas) io.observe(heroCanvas); if (studioCanvas) io.observe(studioCanvas);
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
let paused = false;
function frame(now){
  requestAnimationFrame(frame);
  if (paused) return;
  const p = stageProgress(); updateBeats(p);
  if (hero && hero.visible){
    const H = hero, t = (now - H.t0) / 1000; autoSize(H);
    const seg = Math.min(3.999, p * 4), i = Math.floor(seg), f = ss(seg - i), a = H.BEATS[i], b = H.BEATS[i + 1];
    const k = REDUCED ? 1 : .06; for (const key of ['az', 'el', 'd', 'ty', 'ox']) H.cur[key] += (a[key] + (b[key] - a[key]) * f - H.cur[key]) * k;
    const narrow = H.cam.aspect < 1 ? .8 / Math.max(.5, H.cam.aspect) : 1;
    const c = camFrom(H.cur, narrow);
    { const w = heroCanvas.clientWidth, h = heroCanvas.clientHeight; const ox = MOBILE ? 0 : H.cur.ox, oy = MOBILE ? .16 : 0; H.cam.setViewOffset(w, h, -ox * w, oy * h, w, h); }
    H.cam.position.copy(c.pos); if (!REDUCED) H.cam.position.x += Math.sin(t * .22) * .08; H.cam.lookAt(c.tgt);
    const ry = p * Math.PI * 1.1 + (REDUCED ? 0 : t * .03); H.piece.rotation.y = ry; H.mirror.rotation.y = ry;
    H.aperture = H.cur.d < 8 ? .0003 : .00012;
    renderStudio(H, c.tgt);
  }
  if (studio && studio.visible){
    const S = studio; autoSize(S);
    if (S.tween){ const q = Math.min(1, (now - S.tween.start) / S.tween.dur), e = ease(q); S.cam.position.lerpVectors(S.tween.p0, S.tween.p1, e); S.controls.target.lerpVectors(S.tween.t0, S.tween.t1, e); if (q >= 1) S.tween = null; }
    S.controls.update();
    S.pendMirror.rotation.y = S.pend.rotation.y;
    if (S.mode === 'compare' && labP){
      const proj = (o, yy) => { const v = o.position.clone(); v.y = yy; v.project(S.cam); return [(v.x * .5 + .5) * studioCanvas.clientWidth, (-v.y * .5 + .5) * studioCanvas.clientHeight]; };
      const a = proj(S.pend, -1), b = proj(S.grand, -1); labP.style.left = a[0] + 'px'; labP.style.top = a[1] + 'px'; labG.style.left = b[0] + 'px'; labG.style.top = b[1] + 'px';
    }
    renderStudio(S, S.controls.target);
  }
}
requestAnimationFrame(frame);

/* still-render API — used to produce the gallery images from the same model */
window.__still = (mode, view, w, h) => {
  if (!studio) return null; paused = true;
  const S = studio; setMode(mode, true); S.controls.autoRotate = false;
  const c = camFrom(view); S.cam.position.copy(c.pos); S.controls.target.copy(c.tgt); S.cam.lookAt(c.tgt);
  if (view.ap) S.aperture = view.ap;
  if (view.hideChain !== undefined) S.chain.visible = !view.hideChain;
  sizeStudio(S, w, h, 1); S.cam.lookAt(c.tgt);
  renderStudio(S, c.tgt); renderStudio(S, c.tgt);
  const url = S.renderer.domElement.toDataURL('image/jpeg', .93);
  S.chain.visible = true;
  return url;
};
window.__pause = v => { paused = v; };
window.__ready = true;
