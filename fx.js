// fx.js — drifting embers behind the page (Three.js). Purely decorative: skipped when Three.js
// fails to load, when the viewer prefers reduced motion, or when WebGL is unavailable.
(() => {
  const canvas = document.getElementById('fx');
  if (!canvas || !window.THREE || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'low-power' }); }
  catch { return; }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
  camera.position.z = 300;

  const small = innerWidth < 700;
  const COUNT = small ? 160 : 420;
  const pos = new Float32Array(COUNT * 3), col = new Float32Array(COUNT * 3), speed = new Float32Array(COUNT), phase = new Float32Array(COUNT);
  const cream = new THREE.Color('#ece6d4'), red = new THREE.Color('#ff6a4d');
  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = (Math.random() - .5) * 900;
    pos[i * 3 + 1] = (Math.random() - .5) * 700;
    pos[i * 3 + 2] = (Math.random() - .5) * 400;
    const c = Math.random() < .35 ? red : cream;
    const k = .35 + Math.random() * .65;
    col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
    speed[i] = .12 + Math.random() * .45;
    phase[i] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  // Soft round sprite drawn once on a 2D canvas.
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  const g = sprite.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(.25, 'rgba(255,255,255,.6)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const mat = new THREE.PointsMaterial({
    size: small ? 5 : 6, map: new THREE.CanvasTexture(sprite), vertexColors: true, transparent: true,
    opacity: .75, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  function resize() {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  resize();
  addEventListener('resize', resize);

  let mx = 0, my = 0;
  addEventListener('pointermove', e => { mx = e.clientX / innerWidth - .5; my = e.clientY / innerHeight - .5; }, { passive: true });

  let running = true, t = 0;
  document.addEventListener('visibilitychange', () => { running = !document.hidden; if (running) requestAnimationFrame(tick); });
  function tick() {
    if (!running) return;
    t += .006;
    const p = geo.attributes.position.array;
    for (let i = 0; i < COUNT; i++) {
      p[i * 3 + 1] += speed[i];
      p[i * 3] += Math.sin(t * 2 + phase[i]) * .12;
      if (p[i * 3 + 1] > 360) { p[i * 3 + 1] = -360; p[i * 3] = (Math.random() - .5) * 900; }
    }
    geo.attributes.position.needsUpdate = true;
    camera.position.x += (mx * 40 - camera.position.x) * .03;
    camera.position.y += (-my * 30 - camera.position.y) * .03;
    camera.lookAt(0, 0, 0);
    points.rotation.y = Math.sin(t * .3) * .08;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
