// wing3d.js
// Turns the homepage feature image into a 3D model that:
//   - turns as the visitor scrolls past, while one part (the wing) slides along an axis
//   - can be dragged to rotate, pinched / ctrl+wheel / +− buttons to zoom, Reset to hand back to scroll
//   - keeps the pink callout tags pinned to named parts of the model
// Everything model-specific lives in the JSON config in index.html (<script id="wing3d-config">).
// If WebGL, the model file, or the visitor's settings (reduced data) say no, the static image and tags stay as they are.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = t => t * t * (3 - 2 * t);
const deg = THREE.MathUtils.degToRad;

export async function mountModel(stage, cfg) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(cfg.model);
  const model = gltf.scene;

  // ---------- scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 720 ? 1.5 : 2));
  renderer.domElement.className = "m3d-canvas";
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xf4d9e1, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(2.5, 4, 3); scene.add(sun);
  const back = new THREE.DirectionalLight(0xffe8ef, 0.9); back.position.set(-3, 2, -2.5); scene.add(back);

  const root = new THREE.Group(); root.add(model); scene.add(root);
  if (cfg.rotation) root.rotation.set(...cfg.rotation.map(deg));
  root.updateMatrixWorld(true);

  const byName = re => { const rx = new RegExp(re, "i"), out = []; model.traverse(o => { if (o.name && rx.test(o.name)) out.push(o); }); return out; };
  const topMatches = re => byName(re).filter((o, _, all) => !all.some(p => p !== o && isAncestor(p, o)));
  const isAncestor = (a, o) => { for (let p = o.parent; p; p = p.parent) if (p === a) return true; return false; };

  // ---------- materials: optional recolor by part name, plus faint CAD edges ----------
  const colorRules = (cfg.colors || []).map(r => ({ rx: new RegExp(r.match, "i"), mat: new THREE.MeshStandardMaterial({ color: r.color, roughness: r.roughness ?? 0.55, metalness: r.metalness ?? 0.1, side: THREE.DoubleSide }) }));
  model.traverse(o => {
    if (!o.isMesh) return;
    let rule = null;
    for (let p = o; p && !rule; p = p.parent) rule = colorRules.find(r => p.name && r.rx.test(p.name));
    if (rule) o.material = rule.mat;
    else if (o.material) { o.material.side = THREE.DoubleSide; }
    const tris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    if (cfg.edges !== false && tris < 30000) {
      o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30), new THREE.LineBasicMaterial({ color: 0x1f1a1c, transparent: true, opacity: 0.25 })));
    }
  });

  // ---------- the moving part (e.g. the raised wing) ----------
  const mv = cfg.move;
  const movers = mv ? topMatches(mv.parts).map(o => {
    const inv = new THREE.Matrix4().copy(o.parent.matrixWorld).invert();
    const a = new THREE.Vector3().applyMatrix4(inv);
    const b = new THREE.Vector3(...mv.axis).normalize().multiplyScalar(1).applyMatrix4(inv);
    return { o, base: o.position.clone(), dir: b.sub(a) };
  }) : [];
  const setMove = t => { const off = mv ? THREE.MathUtils.lerp(mv.from, mv.to, t) : 0; movers.forEach(m => m.o.position.copy(m.base).addScaledVector(m.dir, off)); };

  // ---------- framing: fit the whole assembly in view ----------
  setMove(1); root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  // soft contact shadow under the model
  const sc = document.createElement("canvas"); sc.width = sc.height = 128;
  const g2 = sc.getContext("2d"), rg = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, "rgba(42,29,34,.28)"); rg.addColorStop(1, "rgba(42,29,34,0)"); g2.fillStyle = rg; g2.fillRect(0, 0, 128, 128);
  const foot = Math.max(size.x, size.z) * 1.6;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(foot, foot), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.set(center.x, box.min.y - radius * 0.002, center.z); scene.add(shadow);

  // ---------- tags pinned to parts ----------
  const tags = [];
  for (const t of cfg.tags || []) {
    const node = topMatches(t.part)[0];
    if (!node) { console.warn("[wing3d] no part matches", t.part); continue; }
    const b = new THREE.Box3().setFromObject(node), at = t.at || [0.5, 0.5, 0.5];
    const p = new THREE.Vector3(b.min.x + (b.max.x - b.min.x) * at[0], b.min.y + (b.max.y - b.min.y) * at[1], b.min.z + (b.max.z - b.min.z) * at[2]);
    const el = document.createElement("div"); el.className = "m3d-tag r"; el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<span class="dot"></span><span class="ln"></span><span class="lbl"></span>';
    stage.appendChild(el);
    tags.push({ t, node, local: node.worldToLocal(p), el, lbl: el.lastChild, v: new THREE.Vector3() });
  }

  // ---------- controls ----------
  const ui = document.createElement("div"); ui.className = "m3d-ui";
  ui.innerHTML = '<span class="m3d-hint">Drag to rotate</span><span class="m3d-btns"><button type="button" class="m3d-reset">Reset</button><button type="button" aria-label="Zoom out" data-z="1.25">−</button><button type="button" aria-label="Zoom in" data-z="0.8">+</button></span>';
  stage.append(renderer.domElement, ui);
  stage.tabIndex = 0;
  stage.setAttribute("role", "img");
  stage.setAttribute("aria-label", (cfg.label || "3D model") + ". Drag or use the arrow keys to rotate, plus and minus to zoom.");

  const turn = cfg.turn ?? 200, az0 = cfg.startAngle ?? -40, el0 = cfg.elevation ?? [16, 6];
  const view = { az: az0, el: el0[0], d: 1 }, want = { ...view };
  let user = false, zoom = 1;
  const takeOver = () => { if (!user) { user = true; stage.classList.add("m3d-user"); } };
  const zoomBy = f => { zoom = clamp(zoom * f, 0.4, 1.6); takeOver(); };
  ui.querySelectorAll("[data-z]").forEach(b => b.onclick = () => zoomBy(+b.dataset.z));
  ui.querySelector(".m3d-reset").onclick = () => { user = false; zoom = 1; stage.classList.remove("m3d-user"); };

  const ptrs = new Map(); let pinch0 = 0, zoom0 = 1;
  stage.addEventListener("pointerdown", e => {
    if (e.target.closest("button")) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); stage.setPointerCapture(e.pointerId);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = zoom; }
  });
  stage.addEventListener("pointermove", e => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; zoom = clamp(zoom0 * pinch0 / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), 0.4, 1.6); takeOver(); return; }
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    takeOver(); stage.classList.add("m3d-drag");
    want.az -= dx * 0.4;
    if (e.pointerType === "mouse") want.el = clamp(want.el + dy * 0.3, -20, 70);
  });
  const up = e => { ptrs.delete(e.pointerId); if (!ptrs.size) stage.classList.remove("m3d-drag"); };
  stage.addEventListener("pointerup", up); stage.addEventListener("pointercancel", up);
  // A trackpad pinch arrives as ctrl+wheel. A plain wheel keeps scrolling the page on purpose.
  stage.addEventListener("wheel", e => { if (!e.ctrlKey) return; e.preventDefault(); zoomBy(Math.exp(e.deltaY * 0.01)); }, { passive: false });
  stage.addEventListener("keydown", e => {
    const k = { ArrowLeft: () => (want.az += 12), ArrowRight: () => (want.az -= 12), ArrowUp: () => (want.el = clamp(want.el + 8, -20, 70)), ArrowDown: () => (want.el = clamp(want.el - 8, -20, 70)), "+": () => zoomBy(0.8), "=": () => zoomBy(0.8), "-": () => zoomBy(1.25) }[e.key];
    if (k) { e.preventDefault(); takeOver(); k(); }
  });

  // ---------- loop (only while on screen) ----------
  let visible = true, raf = 0, last = performance.now();
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }).observe(stage);

  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false); cam.aspect = w / h; cam.fov = w < 600 ? 38 : 30; cam.updateProjectionMatrix();
  }
  addEventListener("resize", resize); resize();

  function frame(now) {
    raf = 0; if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const r = stage.getBoundingClientRect(), vh = innerHeight;
    const p = reduce ? 0.6 : clamp((vh - r.top) / (vh + r.height), 0, 1);
    const raise = ease(clamp((p - 0.18) / 0.32, 0, 1));
    setMove(raise);
    if (!user) { want.az = az0 + p * turn; want.el = THREE.MathUtils.lerp(el0[0], el0[1], p); }
    want.d = zoom;
    const k = reduce ? 1 : 1 - Math.pow(0.002, dt);
    for (const key in view) view[key] += (want[key] - view[key]) * k;

    // distance that fits the bounding sphere in both directions
    const vfov = deg(cam.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
    const fit = radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.02;
    const d = fit * view.d, az = deg(view.az), el = deg(view.el);
    cam.position.set(center.x + Math.sin(az) * Math.cos(el) * d, center.y + Math.sin(el) * d, center.z + Math.cos(az) * Math.cos(el) * d);
    cam.near = d / 100; cam.far = d * 10; cam.updateProjectionMatrix();
    cam.lookAt(center);
    renderer.render(scene, cam);

    const W = stage.clientWidth, H = stage.clientHeight, narrow = W < 600;
    for (const tg of tags) {
      tg.v.copy(tg.local); tg.node.localToWorld(tg.v); tg.v.project(cam);
      const x = (tg.v.x * 0.5 + 0.5) * W, y = (-tg.v.y * 0.5 + 0.5) * H;
      const txt = narrow && tg.t.short ? tg.t.short : tg.t.text;
      if (tg.lbl.textContent !== txt) tg.lbl.textContent = txt;
      const need = tg.el.offsetWidth + 8;
      let left = x < W / 2;
      if (left && x - need < 0 && W - x > need) left = false; else if (!left && x + need > W && x > need) left = true;
      tg.el.classList.toggle("l", left); tg.el.classList.toggle("r", !left);
      const hide = (tg.t.whenMoved && raise < 0.6) || zoom < 0.6 || tg.v.z > 1;
      tg.el.classList.toggle("off", hide);
      tg.el.style.transform = `translate(${(left ? x - tg.el.offsetWidth + 6 : x - 6).toFixed(1)}px, ${(y - tg.el.offsetHeight / 2).toFixed(1)}px)`;
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  stage.classList.add("m3d-ready");
}
