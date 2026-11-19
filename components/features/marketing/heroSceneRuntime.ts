// components/features/marketing/heroSceneRuntime.ts — the home page's 3D
// scene (three.js). Loaded only through HeroScene.tsx's dynamic import, so
// three stays out of every page's first load (docs/design-system.md, "3D").
//
// The idea: a job search is a mess of postings; the agent sorts it. Cards
// drift in loose, then fly into a well-kept board (`board`) or one tidy
// pile beside the last call to action (`stacks`). The pointer
// lifts the cards under it, a click shuffles and re-sorts, and scrolling
// pulls the board apart in depth.
//
// Colours come from the --scene-* tokens in app/globals.css. The canvas is
// decoration: aria-hidden, pointer-events none, and still (sorted, one
// frame) under prefers-reduced-motion.

import {
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
  Euler,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export type SceneVariant = 'board' | 'stacks';

const COLS = 6;
const ROWS = 4;
const COUNT = COLS * ROWS;
const CARD_W = 1.5;
const CARD_H = 0.95;
const CARD_D = 0.09;
const GAP = 0.14;
const BOARD_W = COLS * CARD_W + (COLS - 1) * GAP;
const BOARD_H = ROWS * CARD_H + (ROWS - 1) * GAP;
const CAMERA_Z = 14;
const FOV = 32;

/** Deterministic, so the scene opens the same way on every visit. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): Color {
  const value = style.getPropertyValue(name).trim();
  const color = new Color();
  try {
    color.set(value || fallback);
  } catch {
    color.set(fallback);
  }
  return color;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

interface Card {
  loosePos: Vector3;
  looseQuat: Quaternion;
  spinAxis: Vector3;
  sortedPos: Vector3;
  sortedQuat: Quaternion;
  phase: number;
  depth: number;
  /** 0 loose … 1 sorted, eased toward its target every frame. */
  mix: number;
  lift: number;
  startAt: number;
}

/** Mounts the scene in `host` and returns its teardown. Throws when WebGL is unavailable. */
export function mountHeroScene(host: HTMLElement, variant: SceneVariant): () => void {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  host.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 80);
  camera.position.set(0, 0, CAMERA_Z);

  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  scene.environment = envMap;
  scene.environmentIntensity = 0.55;
  scene.add(new HemisphereLight(0xffffff, 0xbfc8ff, 0.9));
  const key = new DirectionalLight(0xffffff, 2.1);
  key.position.set(-5, 7, 9);
  scene.add(key);

  // Palette.
  const css = getComputedStyle(host);
  const white = token(css, '--scene-5', '#ffffff');
  const hues = [
    token(css, '--scene-1', '#a9bcff'),
    token(css, '--scene-2', '#ffd43b'),
    token(css, '--scene-3', '#ff8a3d'),
    token(css, '--scene-4', '#2ee6a6'),
  ];
  const actionBlue = token(css, '--scene-ink', '#2b4dff');
  const dark = new Color('#0b0d1a');

  // Geometry and materials (all disposed in the teardown).
  const cardGeo = new RoundedBoxGeometry(CARD_W, CARD_H, CARD_D, 4, 0.085);
  const dotGeo = new RoundedBoxGeometry(0.24, 0.24, 0.04, 4, 0.12);
  const longGeo = new RoundedBoxGeometry(0.72, 0.085, 0.04, 2, 0.04);
  const shortGeo = new RoundedBoxGeometry(0.46, 0.085, 0.04, 2, 0.04);
  const cardMat = new MeshStandardMaterial({ roughness: 0.42, metalness: 0.02 });
  const detailMat = new MeshStandardMaterial({ roughness: 0.6, metalness: 0 });

  const group = new Group();
  scene.add(group);
  const cardMesh = new InstancedMesh(cardGeo, cardMat, COUNT);
  const dotMesh = new InstancedMesh(dotGeo, detailMat, COUNT);
  const longMesh = new InstancedMesh(longGeo, detailMat, COUNT * 2);
  const shortMesh = new InstancedMesh(shortGeo, detailMat, COUNT);
  group.add(cardMesh, dotMesh, longMesh, shortMesh);

  // Where each detail sits on a card's face.
  const faceZ = CARD_D / 2 + 0.012;
  const dotOffset = new Matrix4().makeTranslation(-0.5, 0.22, faceZ);
  const long1Offset = new Matrix4().makeTranslation(0.08, 0.22, faceZ);
  const long2Offset = new Matrix4().makeTranslation(-0.26, -0.08, faceZ);
  const shortOffset = new Matrix4().makeTranslation(-0.39, -0.27, faceZ);

  const rand = prng(variant === 'board' ? 20261120 : 7);
  const cards: Card[] = [];
  const tmpColor = new Color();
  for (let i = 0; i < COUNT; i += 1) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    // About half the cards are white paper; the rest take a brand hue.
    const coloured = rand() < 0.46;
    const hue = hues[Math.floor(rand() * hues.length)] ?? white;
    const cardColor = coloured ? hue : white;
    cardMesh.setColorAt(i, cardColor);
    const accent = hues[(i + row) % hues.length] ?? actionBlue;
    dotMesh.setColorAt(i, coloured ? white : i % 3 === 0 ? actionBlue : accent);
    const bar = coloured ? tmpColor.copy(cardColor).lerp(dark, 0.2).clone() : tmpColor.copy(white).lerp(actionBlue, 0.14).clone();
    longMesh.setColorAt(i * 2, bar);
    longMesh.setColorAt(i * 2 + 1, bar);
    shortMesh.setColorAt(i, bar);

    const sortedPos = new Vector3();
    const sortedQuat = new Quaternion();
    if (variant === 'board') {
      sortedPos.set(
        -BOARD_W / 2 + CARD_W / 2 + col * (CARD_W + GAP),
        BOARD_H / 2 - CARD_H / 2 - row * (CARD_H + GAP),
        0,
      );
    } else {
      // One spiralled pile, seen from above: the prepared applications.
      sortedPos.set(Math.sin(i * 0.9) * 0.1, -1.75 + i * 0.15, 0);
      sortedQuat.setFromEuler(new Euler(-1.02, 0, (i - COUNT / 2) * 0.085));
    }
    cards.push({
      loosePos: new Vector3((rand() - 0.5) * 17, (rand() - 0.5) * 9.5, -7 + rand() * 9),
      looseQuat: new Quaternion().setFromEuler(new Euler(rand() * 6.3, rand() * 6.3, rand() * 6.3)),
      spinAxis: new Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
      sortedPos,
      sortedQuat,
      phase: rand() * 6.3,
      depth: ((i * 7) % 5) - 2,
      mix: 0,
      lift: 0,
      startAt: 0,
    });
  }
  for (const mesh of [cardMesh, dotMesh, longMesh, shortMesh]) {
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  // ── State ───────────────────────────────────────────────────────────
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let still = motionQuery.matches;
  let visible = true;
  let frame = 0;
  let last = performance.now();
  let clock = 0;
  let scroll = 0;
  let width = 0;
  let height = 0;
  let viewW = 1;
  let viewH = 1;
  let split = false;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, inside: false };
  const base = variant === 'board' ? { rx: -0.5, ry: -0.42, rz: 0.1 } : { rx: 0, ry: -0.3, rz: 0 };

  function schedule(delay: number) {
    cards.forEach((card, i) => {
      const order = variant === 'board' ? (i % COLS) + Math.floor(i / COLS) * 1.6 : i * 0.55;
      card.startAt = clock + delay + order * 0.045;
    });
  }
  schedule(0.5);
  if (still) for (const card of cards) card.mix = 1;

  function layout() {
    const rect = host.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    viewH = 2 * CAMERA_Z * Math.tan((FOV * Math.PI) / 360);
    viewW = viewH * camera.aspect;
    split = getComputedStyle(host).getPropertyValue('--scene-split').trim() !== '0';
    if (variant === 'board') {
      const fit = split
        ? Math.min((viewW * 0.45) / BOARD_W, (viewH * 0.82) / (BOARD_H * 1.25))
        : Math.min((viewW * 0.74) / BOARD_W, (viewH * 0.8) / (BOARD_H * 1.25));
      group.scale.setScalar(fit);
      group.position.set(split ? viewW * 0.2 : 0, split ? -viewH * 0.02 : 0, 0);
    } else {
      group.scale.setScalar(Math.min(1.3, viewH / 5.6));
      group.position.set(viewW * 0.27, 0, 0);
    }
  }

  function readScroll() {
    const rect = host.getBoundingClientRect();
    scroll = variant === 'board' ? Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height))) : 0;
  }

  const m = new Matrix4();
  const child = new Matrix4();
  const pos = new Vector3();
  const quat = new Quaternion();
  const spin = new Quaternion();
  const tilt = new Quaternion();
  const one = new Vector3(1, 1, 1);
  const projected = new Vector3();
  const xAxis = new Vector3(1, 0, 0);

  function render(dt: number) {
    clock += dt;
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 5);
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 5);
    group.rotation.set(
      base.rx + pointer.y * 0.07 - scroll * 0.45,
      base.ry + pointer.x * 0.12 + scroll * 0.25,
      base.rz,
    );
    group.updateMatrixWorld();

    const ease = 1 - Math.exp(-dt * 4.2);
    cards.forEach((card, i) => {
      const target = still || clock >= card.startAt ? 1 : 0;
      card.mix = still ? 1 : card.mix + (target - card.mix) * ease;
      const k = card.mix * card.mix * (3 - 2 * card.mix);

      // Loose: slow drift and tumble.
      const t = clock * 0.35 + card.phase;
      pos.copy(card.loosePos);
      pos.x += Math.sin(t) * 0.5;
      pos.y += Math.cos(t * 0.8) * 0.4;
      spin.setFromAxisAngle(card.spinAxis, clock * 0.25 + card.phase);
      quat.copy(card.looseQuat).multiply(spin);

      // Sorted: a place on the board (or in a stack), breathing a little.
      const sx = card.sortedPos.x;
      const breathe = still ? 0 : Math.sin(clock * 0.9 + card.phase) * 0.04;
      const sz = card.sortedPos.z + breathe + card.lift * 0.85 + scroll * card.depth * 1.1;
      pos.x += (sx - pos.x) * k;
      pos.y += (card.sortedPos.y - pos.y) * k;
      pos.z += (sz - pos.z) * k;
      quat.slerp(card.sortedQuat, k);

      // The pointer lifts the cards under it.
      let lift = 0;
      if (pointer.inside && !still && card.mix > 0.9) {
        projected.set(sx, card.sortedPos.y, card.sortedPos.z).applyMatrix4(group.matrixWorld).project(camera);
        const dx = (projected.x - pointer.tx) * camera.aspect;
        const dy = projected.y - pointer.ty;
        lift = 1 - smoothstep(0.08, 0.5, Math.hypot(dx, dy));
      }
      card.lift += (lift - card.lift) * Math.min(1, dt * 7);
      if (card.lift > 0.001) {
        tilt.setFromAxisAngle(xAxis, card.lift * 0.3);
        quat.multiply(tilt);
      }

      m.compose(pos, quat, one);
      cardMesh.setMatrixAt(i, m);
      dotMesh.setMatrixAt(i, child.multiplyMatrices(m, dotOffset));
      longMesh.setMatrixAt(i * 2, child.multiplyMatrices(m, long1Offset));
      longMesh.setMatrixAt(i * 2 + 1, child.multiplyMatrices(m, long2Offset));
      shortMesh.setMatrixAt(i, child.multiplyMatrices(m, shortOffset));
    });
    cardMesh.instanceMatrix.needsUpdate = true;
    dotMesh.instanceMatrix.needsUpdate = true;
    longMesh.instanceMatrix.needsUpdate = true;
    shortMesh.instanceMatrix.needsUpdate = true;
    renderer.render(scene, camera);
    if (!host.dataset.ready) host.dataset.ready = 'true';
  }

  function loop(now: number) {
    frame = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    render(dt);
    if (visible && !still && !document.hidden) frame = requestAnimationFrame(loop);
  }
  function wake() {
    if (frame) return;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }

  // ── Wiring ──────────────────────────────────────────────────────────
  const surface = host.parentElement ?? host;
  const onMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    const rect = host.getBoundingClientRect();
    pointer.tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.ty = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    pointer.inside = true;
  };
  const onLeave = () => {
    pointer.inside = false;
    pointer.tx = 0;
    pointer.ty = 0;
  };
  const onClick = (event: MouseEvent) => {
    if (still) return;
    if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea, summary')) return;
    for (const card of cards) card.startAt = Number.POSITIVE_INFINITY;
    const now = clock;
    cards.forEach((card, i) => {
      card.startAt = now + 0.7 + ((i * 5) % COUNT) * 0.03;
    });
    wake();
  };
  const onScroll = () => {
    readScroll();
    if (still) wake();
  };
  const onMotion = (event: MediaQueryListEvent) => {
    still = event.matches;
    wake();
  };
  const onVisibility = () => {
    if (!document.hidden) wake();
  };
  const resizeObserver = new ResizeObserver(() => {
    layout();
    wake();
  });
  const visibilityObserver = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (visible) wake();
  });

  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerleave', onLeave);
  surface.addEventListener('click', onClick);
  window.addEventListener('scroll', onScroll, { passive: true });
  motionQuery.addEventListener('change', onMotion);
  document.addEventListener('visibilitychange', onVisibility);
  resizeObserver.observe(host);
  visibilityObserver.observe(host);

  layout();
  readScroll();
  wake();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    surface.removeEventListener('pointermove', onMove);
    surface.removeEventListener('pointerleave', onLeave);
    surface.removeEventListener('click', onClick);
    window.removeEventListener('scroll', onScroll);
    motionQuery.removeEventListener('change', onMotion);
    document.removeEventListener('visibilitychange', onVisibility);
    resizeObserver.disconnect();
    visibilityObserver.disconnect();
    for (const mesh of [cardMesh, dotMesh, longMesh, shortMesh]) mesh.dispose();
    for (const geometry of [cardGeo, dotGeo, longGeo, shortGeo]) geometry.dispose();
    cardMat.dispose();
    detailMat.dispose();
    envMap.dispose();
    room.dispose();
    pmrem.dispose();
    renderer.dispose();
    canvas.remove();
    delete host.dataset.ready;
  };
}
