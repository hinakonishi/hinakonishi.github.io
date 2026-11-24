// tour3d.js
// Turns a project's "Design breakdown" picture into a 3D model that:
//   - glides to a chosen view for each step as the visitor scrolls through the steps
//   - can be dragged to rotate, pinched / ctrl+wheel / +- buttons to zoom, Reset to hand back to scroll
//   - pins each step's tag to its part of the model
//   - can play an "open" sequence on one step (parts swing about a pivot, then others slide out)
// Everything model-specific lives in the project's tour.model config in index.html.
// The tour's own script still decides which step is active; this only reads it.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = t => t * t * (3 - 2 * t);
const deg = THREE.MathUtils.degToRad;

export async function mountTour(frame, cfg) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tourEl = frame.closest(".tour");
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(cfg.model);
  if (!frame.isConnected) return;
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

  const isAncestor = (a, o) => { for (let p = o.parent; p; p = p.parent) if (p === a) return true; return false; };
  const byName = re => { const rx = new RegExp(re, "i"), out = []; model.traverse(o => { if (o.name && rx.test(o.name)) out.push(o); }); return out.filter((o, _, all) => !all.some(p => p !== o && isAncestor(p, o))); };
  const path = o => { const n = []; for (let p = o; p && p !== model; p = p.parent) if (p.name) n.unshift(p.name); return n.join("/"); };

  // ---------- materials: first matching rule (tested against the part's path) wins ----------
  const rules = (cfg.colors || []).map(r => ({ rx: new RegExp(r.match, "i"), mat: new THREE.MeshStandardMaterial({
    color: r.color, roughness: r.roughness ?? 0.55, metalness: r.metalness ?? 0.1, side: THREE.DoubleSide,
    transparent: r.opacity < 1, opacity: r.opacity ?? 1, depthWrite: !(r.opacity < 1) }) }));
  model.traverse(o => {
    if (!o.isMesh) return;
    const rule = rules.find(r => r.rx.test(path(o)));
    if (rule) o.material = rule.mat; else if (o.material) o.material.side = THREE.DoubleSide;
    if (o.material.transparent) { o.renderOrder = 2; return; }
    const tris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    if (cfg.edges !== false && tris < 30000) o.add(new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30), new THREE.LineBasicMaterial({ color: 0x1f1a1c, transparent: true, opacity: 0.25 })));
  });

  // ---------- the open sequence: hinges swing about a pivot, then slides move out ----------
  const box = o => new THREE.Box3().setFromObject(o, true);
  const movers = [];
  const addMover = (o, make) => { o.updateMatrixWorld(true); movers.push({ o, base: o.matrixWorld.clone(), inv: o.parent.matrixWorld.clone().invert(), make }); };
  const op = cfg.open;
  if (op) {
    for (const h of op.hinges || []) {
      const piv = byName(h.pivot)[0]; if (!piv) { console.warn("[tour3d] no pivot matches", h.pivot); continue; }
      const p = box(piv).getCenter(new THREE.Vector3()), ax = new THREE.Vector3(...h.axis).normalize();
      for (const o of byName(h.parts)) addMover(o, (hinge) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationAxis(ax, deg(h.angle) * hinge)).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z)));
    }
    for (const s of op.slides || []) {
      const d = new THREE.Vector3(...s.axis).normalize().multiplyScalar(s.dist);
      for (const o of byName(s.parts)) addMover(o, (_, slide) => new THREE.Matrix4().makeTranslation(d.x * slide, d.y * slide, d.z * slide));
    }
  }
  const tmp = new THREE.Matrix4();
  const setOpen = t => {
    const both = op.hinges && op.hinges.length && op.slides && op.slides.length;
    const hinge = ease(clamp(both ? t / 0.55 : t, 0, 1)), slide = ease(clamp(both ? (t - 0.45) / 0.55 : t, 0, 1));
    for (const m of movers) { tmp.copy(m.make(hinge, slide)).multiply(m.base).premultiply(m.inv); tmp.decompose(m.o.position, m.o.quaternion, m.o.scale); }
    root.updateMatrixWorld(true);
  };

  // framing for the closed and the open model, so nothing leaves the frame as it opens
  const fitOf = () => { const b = box(root), s = b.getSize(new THREE.Vector3()); return { c: b.getCenter(new THREE.Vector3()), r: s.length() * 0.5 }; };
  setOpen(1); const F1 = fitOf(); setOpen(0); const F0 = fitOf();
  const startC = F0.c;

  // ---------- tags: the tour's own .pt elements, one per step ----------
  const pts = [...frame.querySelectorAll(".pt")];
  const focusNodes = (cfg.steps || []).map(s => (s.focus && s.part && byName(s.part)[0]) || null);
  const tags = (cfg.steps || []).map((s, i) => {
    const el = frame.querySelector(`.pt[data-pt="${i}"]`); if (!el || !s.part) return null;
    const node = byName(s.part)[0]; if (!node) { console.warn("[tour3d] no part matches", s.part); return null; }
    const b = box(node), at = s.at || [0.5, 0.5, 0.5];
    const p = new THREE.Vector3(b.min.x + (b.max.x - b.min.x) * at[0], b.min.y + (b.max.y - b.min.y) * at[1], b.min.z + (b.max.z - b.min.z) * at[2]);
    return { el, node, local: node.worldToLocal(p), v: new THREE.Vector3() };
  });

  // ---------- controls ----------
  const ui = document.createElement("div"); ui.className = "m3d-ui";
  ui.innerHTML = '<span class="m3d-hint">Drag to rotate</span><span class="m3d-btns"><button type="button" class="m3d-reset">Reset</button><button type="button" aria-label="Zoom out" data-z="1.25">−</button><button type="button" aria-label="Zoom in" data-z="0.8">+</button></span>';
  frame.append(renderer.domElement, ui);
  frame.tabIndex = 0;
  frame.setAttribute("role", "img");
  frame.setAttribute("aria-label", (cfg.label || "3D model") + ". Drag or use the arrow keys to rotate, plus and minus to zoom.");

  const views = (cfg.steps || []).map(s => s.view || [35, 20]);
  // a step can zoom in (zoom < 1) and center the camera on its tagged part (focus: true)
  const stepZoom = i => (cfg.steps && cfg.steps[i] && cfg.steps[i].zoom) || 1;
  const view = { az: views[0][0], el: views[0][1], d: 1, s: stepZoom(0), f: 0, cx: 0, cy: 0, cz: 0 }, want = { ...view };
  const fc = new THREE.Vector3();
  view.cx = startC.x; view.cy = startC.y; view.cz = startC.z;
  let user = false, zoom = 1, uaz = 0, uel = 0;
  const takeOver = () => { if (!user) { user = true; uaz = want.az; uel = want.el; frame.classList.add("m3d-user"); } };
  const zoomBy = f => { zoom = clamp(zoom * f, 0.4, 1.6); takeOver(); };
  ui.querySelectorAll("[data-z]").forEach(b => b.onclick = () => zoomBy(+b.dataset.z));
  ui.querySelector(".m3d-reset").onclick = () => { user = false; zoom = 1; frame.classList.remove("m3d-user"); };

  const ptrs = new Map(); let pinch0 = 0, zoom0 = 1;
  frame.addEventListener("pointerdown", e => {
    if (e.target.closest("button")) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); frame.setPointerCapture(e.pointerId);
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = zoom; }
  });
  frame.addEventListener("pointermove", e => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; zoom = clamp(zoom0 * pinch0 / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), 0.4, 1.6); takeOver(); return; }
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    takeOver(); frame.classList.add("m3d-drag");
    uaz -= dx * 0.4;
    if (e.pointerType === "mouse") uel = clamp(uel + dy * 0.3, -20, 70);
  });
  const up = e => { ptrs.delete(e.pointerId); if (!ptrs.size) frame.classList.remove("m3d-drag"); };
  frame.addEventListener("pointerup", up); frame.addEventListener("pointercancel", up);
  // A trackpad pinch arrives as ctrl+wheel. A plain wheel keeps scrolling the page on purpose.
  frame.addEventListener("wheel", e => { if (!e.ctrlKey) return; e.preventDefault(); zoomBy(Math.exp(e.deltaY * 0.01)); }, { passive: false });
  frame.addEventListener("keydown", e => {
    const k = { ArrowLeft: () => (uaz += 12), ArrowRight: () => (uaz -= 12), ArrowUp: () => (uel = clamp(uel + 8, -20, 70)), ArrowDown: () => (uel = clamp(uel - 8, -20, 70)), "+": () => zoomBy(0.8), "=": () => zoomBy(0.8), "-": () => zoomBy(1.25) }[e.key];
    if (k) { e.preventDefault(); takeOver(); k(); }
  });

  // ---------- loop (only while on screen, and stops for good when the page changes) ----------
  let visible = true, raf = 0, last = performance.now(), openT = 0;
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible && !raf) { last = performance.now(); raf = requestAnimationFrame(frameFn); } });
  io.observe(frame);
  const resize = () => { const w = frame.clientWidth, h = frame.clientHeight; renderer.setSize(w, h, false); cam.aspect = w / h; cam.fov = w < 600 ? 38 : 30; cam.updateProjectionMatrix(); };
  addEventListener("resize", resize); resize();
  const stop = () => { io.disconnect(); removeEventListener("resize", resize); renderer.dispose(); };

  function frameFn(now) {
    raf = 0;
    if (!frame.isConnected) return stop();
    if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const on = tourEl.querySelector(".steps li.on"), step = on ? +on.dataset.step : 0;

    // the open sequence plays forward on its step and rewinds elsewhere
    const target = op && step === op.step ? 1 : 0;
    if (openT !== target) { openT = reduce ? target : clamp(openT + Math.sign(target - openT) * dt / (target ? op.seconds || 2.6 : 1.4), 0, 1); setOpen(openT); }

    // camera: each step's view, drifting a little with scroll, until the visitor takes over
    const r = tourEl.getBoundingClientRect(), vh = innerHeight, p = clamp((vh - r.top) / (vh + r.height), 0, 1);
    const v = views[step] || views[0];
    if (user) { want.az = uaz; want.el = uel; } else { want.az = v[0] + (p - 0.5) * (cfg.drift ?? 30); want.el = v[1]; }
    want.d = zoom;
    want.s = user ? 1 : stepZoom(step);
    const fn = focusNodes[step];
    if (fn && !user) { box(fn).getCenter(fc); want.f = 1; want.cx = fc.x; want.cy = fc.y; want.cz = fc.z; } else want.f = 0;
    const k = reduce ? 1 : 1 - Math.pow(0.004, dt);
    for (const key of ["az", "el", "d", "s"]) view[key] += (want[key] - view[key]) * k;

    const o = ease(openT), c = F0.c.clone().lerp(F1.c, o), rad = THREE.MathUtils.lerp(F0.r, F1.r, o);
    if (want.f) { view.cx += (want.cx - view.cx) * k; view.cy += (want.cy - view.cy) * k; view.cz += (want.cz - view.cz) * k; } else { view.cx = c.x + (view.cx - c.x) * (1 - k); view.cy = c.y + (view.cy - c.y) * (1 - k); view.cz = c.z + (view.cz - c.z) * (1 - k); }
    c.set(view.cx, view.cy, view.cz);
    const vfov = deg(cam.fov), hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
    const d = rad / Math.sin(Math.min(vfov, hfov) / 2) * (cfg.fit ?? 0.95) * view.d * view.s, az = deg(view.az), el = deg(view.el);
    cam.position.set(c.x + Math.sin(az) * Math.cos(el) * d, c.y + Math.sin(el) * d, c.z + Math.cos(az) * Math.cos(el) * d);
    cam.near = d / 100; cam.far = d * 10; cam.updateProjectionMatrix(); cam.lookAt(c);
    renderer.render(scene, cam);

    const W = frame.clientWidth, H = frame.clientHeight;
    tags.forEach(tg => {
      if (!tg) return;
      tg.v.copy(tg.local); tg.node.localToWorld(tg.v); tg.v.project(cam);
      const x = (tg.v.x * 0.5 + 0.5) * W, y = (-tg.v.y * 0.5 + 0.5) * H;
      // the label goes on the roomier side when it does not fit where it prefers, and wraps if it fits neither
      const lbl = tg.el.lastElementChild, spaceL = x - 34, spaceR = W - x - 34;
      lbl.classList.remove("wrap"); lbl.style.maxWidth = "";
      const need = lbl.offsetWidth;
      let left = x > W * 0.6;
      if (left && need > spaceL && spaceR > spaceL) left = false; else if (!left && need > spaceR && spaceL > spaceR) left = true;
      const room = left ? spaceL : spaceR;
      if (need > room) { lbl.classList.add("wrap"); lbl.style.maxWidth = Math.max(90, room) + "px"; }
      tg.el.classList.toggle("l", left); tg.el.classList.toggle("r", !left);
      tg.el.style.left = x.toFixed(1) + "px"; tg.el.style.top = y.toFixed(1) + "px";
    });
    raf = requestAnimationFrame(frameFn);
  }
  raf = requestAnimationFrame(frameFn);
  frame.classList.add("m3d-ready");
}
