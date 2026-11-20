// components/features/marketing/heroSceneRuntime.ts — the home page's 3D
// scene (three.js). Loaded only through HeroScene.tsx's dynamic import, so
// three stays out of every page's first load (docs/design-system.md, "3D").
//
// The idea: a job search is a mess of postings; the agent sorts it. Cards
// drift in loose, then fly into a well-kept board (`board`) or one tidy
// pile beside the last call to action (`stacks`). The pointer
// lifts the cards under it, a click on the tile's open field shuffles and
// re-sorts, and scrolling pulls the board apart in depth.
//
// Colours come from the --scene-1…5 tokens in app/globals.css and from
// --scene-ink (set on .scene to var(--action), so the marks follow the action
// colour). Lighting is a white-to-periwinkle hemisphere fill, one key light
// and a room environment: no shadows, no bloom. The canvas is decoration:
// aria-hidden, pointer-events none, and still (sorted, one frame, deaf to the
// pointer and the scroll) under prefers-reduced-motion.

import {
  Color,
  CylinderGeometry,
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
  // Decoration: never wake a discrete GPU for it.
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  const pixelRatio = () => Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio());
  const canvas = renderer.domElement;
  host.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 80);
  camera.position.set(0, 0, CAMERA_Z);

  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = pmrem.fromScene(room, 0.04);
  scene.environment = envTarget.texture;
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

  // Geometry and materials (all disposed in the teardown). RoundedBoxGeometry
  // clamps its radius to half the depth, so the card and the bars are built
  // deep enough for their radius and then flattened; the mark is a disc.
  const cardGeo = new RoundedBoxGeometry(CARD_W, CARD_H, 0.17, 4, 0.085).scale(1, 1, CARD_D / 0.17);
  const dotGeo = new CylinderGeometry(0.12, 0.12, 0.04, 32).rotateX(Math.PI / 2);
  const longGeo = new RoundedBoxGeometry(0.72, 0.085, 0.085, 2, 0.0425).scale(1, 1, 0.04 / 0.085);
  const shortGeo = new RoundedBoxGeometry(0.46, 0.085, 0.085, 2, 0.0425).scale(1, 1, 0.04 / 0.085);
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
    const ratio = pixelRatio();
    if (ratio !== renderer.getPixelRatio()) renderer.setPixelRatio(ratio);
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
      if (split) {
        fitBesideCopy();
      } else {
        group.scale.setScalar(Math.min((viewW * 0.64) / BOARD_W, (viewH * 0.65) / (BOARD_H * 1.25)));
        group.position.set(0, 0, 0);
      }
    } else {
      group.scale.setScalar(Math.min(1.3, viewH / 5.6));
      group.position.set(viewW * 0.27, 0, 0);
    }
  }

  // ── Fitting the board beside the copy ───────────────────────────────
  // The board takes the space to the right of the copy's text (measured, so a
  // longer headline in any locale pushes it, not under it) and is scaled so
  // its tilted, projected outline — lifted cards included — stays inside the
  // tile with a margin.
  const corner = new Vector3();
  const box = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  function projectBoard(scale: number, x: number, y: number) {
    // The camera's inverse matrix is only refreshed by a render; layout can run first.
    camera.updateMatrixWorld();
    group.position.set(x, y, 0);
    group.scale.setScalar(scale);
    group.rotation.set(base.rx, base.ry, base.rz);
    group.updateMatrixWorld();
    box.minX = Infinity;
    box.minY = Infinity;
    box.maxX = -Infinity;
    box.maxY = -Infinity;
    for (const cx of [-BOARD_W / 2, BOARD_W / 2]) {
      for (const cy of [-BOARD_H / 2, BOARD_H / 2]) {
        for (const cz of [0, 0.9]) {
          corner.set(cx, cy, cz).applyMatrix4(group.matrixWorld).project(camera);
          const px = ((corner.x + 1) / 2) * width;
          const py = ((1 - corner.y) / 2) * height;
          box.minX = Math.min(box.minX, px);
          box.maxX = Math.max(box.maxX, px);
          box.minY = Math.min(box.minY, py);
          box.maxY = Math.max(box.maxY, py);
        }
      }
    }
    return { ...box };
  }
  /** The right edge of the copy's text (not its boxes), in host pixels. */
  function copyRight(): number {
    const tile = host.parentElement;
    if (!tile) return 0;
    const hostLeft = host.getBoundingClientRect().left;
    const range = document.createRange();
    let right = 0;
    for (const child of Array.from(tile.children)) {
      if (child === host || !(child instanceof HTMLElement) || child.offsetParent === null) continue;
      range.selectNodeContents(child);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0) right = Math.max(right, rect.right - hostLeft);
      }
    }
    return right;
  }
  function fitBesideCopy() {
    const margin = 32;
    const left = Math.max(width * 0.45, copyRight() + 48);
    const right = width - margin;
    const top = margin;
    const bottom = height - margin;
    if (right - left < 40 || bottom - top < 40) {
      group.scale.setScalar(0.0001);
      return;
    }
    // Perspective makes the near side grow as the board moves, so fit by a
    // few rounds of project, rescale and recentre (it settles in three or four).
    const perUnit = width / viewW;
    let scale = 1;
    let x = 0;
    let y = 0;
    for (let round = 0; round < 5; round += 1) {
      const b = projectBoard(scale, x, y);
      scale = Math.min(scale * Math.min((right - left) / (b.maxX - b.minX), (bottom - top) / (b.maxY - b.minY)), 1.2);
      const c = projectBoard(scale, x, y);
      x += ((left + right) / 2 - (c.minX + c.maxX) / 2) / perUnit;
      y -= ((top + bottom) / 2 - (c.minY + c.maxY) / 2) / perUnit;
    }
    const last = projectBoard(scale, x, y);
    const overflow = Math.max(last.maxX - right, left - last.minX, last.maxY - bottom, top - last.minY, 0);
    if (overflow > 0) scale *= Math.max(0.5, 1 - overflow / Math.max(1, right - left));
    group.scale.setScalar(scale);
    group.position.set(x, y, 0);
  }

  function readScroll() {
    if (still || variant !== 'board') {
      scroll = 0;
      return;
    }
    const rect = host.getBoundingClientRect();
    scroll = Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height)));
  }
  /** Reduced motion: the board neither follows the pointer nor the scroll. */
  function settle() {
    pointer.inside = false;
    pointer.tx = 0;
    pointer.ty = 0;
    pointer.x = 0;
    pointer.y = 0;
    scroll = 0;
    for (const card of cards) {
      card.lift = 0;
      card.mix = 1;
    }
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
    if (still || event.pointerType === 'touch') return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    // Over the copy (outside the scene's own box) nothing lifts.
    pointer.inside = Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
    pointer.tx = Math.max(-1, Math.min(1, nx));
    pointer.ty = Math.max(-1, Math.min(1, ny));
  };
  const onLeave = () => {
    pointer.inside = false;
    pointer.tx = 0;
    pointer.ty = 0;
  };
  // A click on the tile's open field (where the cards are; the canvas itself
  // takes no pointer) reshuffles. Clicks on the copy, on links, and the
  // second click of a double-click do nothing, so selecting text never does.
  const onClick = (event: MouseEvent) => {
    if (still || event.target !== surface || event.detail > 1) return;
    const now = clock;
    cards.forEach((card, i) => {
      card.startAt = now + 0.7 + ((i * 5) % COUNT) * 0.03;
    });
    wake();
  };
  const onScroll = () => {
    readScroll();
  };
  const onMotion = (event: MediaQueryListEvent) => {
    still = event.matches;
    if (still) settle();
    wake();
  };
  const onVisibility = () => {
    if (!document.hidden) wake();
  };
  // Resizing clears the canvas, so draw the new size at once.
  const resizeObserver = new ResizeObserver(() => {
    layout();
    render(0);
    wake();
  });
  // A move to a screen with another pixel density (or a zoom) changes the ratio.
  let dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  const onDpr = () => {
    dprQuery.removeEventListener('change', onDpr);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener('change', onDpr);
    layout();
    render(0);
    wake();
  };
  const visibilityObserver = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (visible) wake();
  });

  surface.addEventListener('pointermove', onMove);
  surface.addEventListener('pointerleave', onLeave);
  surface.addEventListener('click', onClick);
  window.addEventListener('scroll', onScroll, { passive: true });
  motionQuery.addEventListener('change', onMotion);
  dprQuery.addEventListener('change', onDpr);
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
    dprQuery.removeEventListener('change', onDpr);
    document.removeEventListener('visibilitychange', onVisibility);
    resizeObserver.disconnect();
    visibilityObserver.disconnect();
    for (const mesh of [cardMesh, dotMesh, longMesh, shortMesh]) mesh.dispose();
    for (const geometry of [cardGeo, dotGeo, longGeo, shortGeo]) geometry.dispose();
    cardMat.dispose();
    detailMat.dispose();
    envTarget.dispose();
    room.dispose();
    pmrem.dispose();
    renderer.dispose();
    // dispose() frees three's objects but keeps the context; release it too,
    // so remounts (client navigation back to the home page) never pile up.
    renderer.forceContextLoss();
    canvas.remove();
    delete host.dataset.ready;
  };
}
