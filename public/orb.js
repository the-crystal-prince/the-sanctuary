// A glass orb with a liquid surface, drawn on a canvas.
// The liquid rises as the meditation timer runs: app.js calls
// window.sanctuaryOrb.setProgress(0..1) and setActive(true/false).

const canvas = document.getElementById("orb");
const fallback = document.getElementById("orbFallback");

const TAU = Math.PI * 2;
const LEVEL_START = 0.22; // waterline, in radii below the orb's centre
const LEVEL_END = -0.5; // waterline when the session is complete

function start() {
  const ctx = canvas && canvas.getContext && canvas.getContext("2d");
  if (!ctx) {
    if (fallback) fallback.hidden = false;
    return;
  }

  const SIZE = canvas.width;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const R = SIZE * 0.4; // leaves room around the orb for its glow

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  let progress = 0;
  let level = LEVEL_START;
  let active = false;
  let energy = 0.7; // how much the surface sways: calmer when idle
  let time = reduceMotion ? 2 : 0;
  let last = performance.now();

  const targetLevel = () => LEVEL_START + (LEVEL_END - LEVEL_START) * progress;

  // Height of the waterline at u (-1 left edge … 1 right edge), relative to
  // the level. The curve flips between a smile and a frown, like liquid
  // settling, on a slow breathing rhythm.
  function surfaceY(u) {
    const bend = 0.13 * energy * Math.sin((time * TAU) / 7);
    const tilt = 0.05 * energy * Math.sin((time * TAU) / 11 + 1);
    const ripple = 0.006 * Math.sin(u * 9 + time * 1.4);
    return R * (bend * (u * u - 0.33) + tilt * u + ripple);
  }

  function smudge(x, y, radius, rgb, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  // One strand of the bright edge on the waterline. Three strands in
  // slightly different colours and heights give it a prism-like fringe.
  function edge(base, offsetY, rgb, width, blur, alpha) {
    const g = ctx.createLinearGradient(cx - R * 0.92, 0, cx + R * 0.92, 0);
    g.addColorStop(0, `rgba(${rgb},0)`);
    g.addColorStop(0.3, `rgba(${rgb},${alpha * 0.55})`);
    g.addColorStop(0.5, `rgba(${rgb},${alpha})`);
    g.addColorStop(0.7, `rgba(${rgb},${alpha * 0.55})`);
    g.addColorStop(1, `rgba(${rgb},0)`);

    ctx.beginPath();
    for (let u = -0.92; u <= 0.921; u += 0.02) {
      const x = cx + u * R;
      const y = base + surfaceY(u) + offsetY;
      if (u === -0.92) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = g;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = `rgba(${rgb},0.85)`;
    ctx.shadowBlur = blur;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function ring(dx, rgb, alpha) {
    ctx.beginPath();
    ctx.arc(cx + dx, cy, R - 0.5, 0, TAU);
    ctx.strokeStyle = `rgba(${rgb},${alpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function draw() {
    ctx.clearRect(0, 0, SIZE, SIZE);

    // How bright the edge light is: a little stronger while the timer runs,
    // and swelling slowly with the breathing rhythm.
    const glow = 0.85 + 0.15 * energy + 0.08 * Math.sin((time * TAU) / 7);

    // Halo: light spilling out past the glass edge. Drawn first; the opaque
    // orb body then covers the part that falls inside the sphere.
    ctx.globalCompositeOperation = "lighter";
    const halo = ctx.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.18);
    halo.addColorStop(0, `rgba(255,190,120,${0.34 * glow})`);
    halo.addColorStop(0.37, `rgba(255,180,110,${0.28 * glow})`);
    halo.addColorStop(0.62, `rgba(255,160,90,${0.1 * glow})`);
    halo.addColorStop(1, "rgba(255,160,90,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, SIZE, SIZE);
    const cool = ctx.createRadialGradient(
      cx + R * 0.1,
      cy - R * 0.1,
      R * 0.9,
      cx + R * 0.1,
      cy - R * 0.1,
      R * 1.16,
    );
    cool.addColorStop(0, `rgba(120,170,255,${0.16 * glow})`);
    cool.addColorStop(0.4, `rgba(120,170,255,${0.1 * glow})`);
    cool.addColorStop(1, "rgba(120,170,255,0)");
    ctx.fillStyle = cool;
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.globalCompositeOperation = "source-over";

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();

    // Dark glass body, lit from the upper left.
    const body = ctx.createRadialGradient(
      cx - R * 0.3,
      cy - R * 0.4,
      R * 0.05,
      cx,
      cy,
      R,
    );
    body.addColorStop(0, "#38332b");
    body.addColorStop(0.55, "#1b1a15");
    body.addColorStop(1, "#090908");
    ctx.fillStyle = body;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // Liquid: everything below the waterline.
    const base = cy + level * R;
    ctx.beginPath();
    for (let u = -1; u <= 1.001; u += 0.02) {
      const x = cx + u * R;
      const y = base + surfaceY(u);
      if (u === -1) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(cx + R, cy + R * 1.3);
    ctx.lineTo(cx - R, cy + R * 1.3);
    ctx.closePath();

    const liquid = ctx.createLinearGradient(0, base - R * 0.1, 0, cy + R);
    liquid.addColorStop(0, "rgba(255,244,230,0.20)");
    liquid.addColorStop(0.18, "rgba(255,236,214,0.08)");
    liquid.addColorStop(0.7, "rgba(255,230,200,0.05)");
    liquid.addColorStop(1, "rgba(255,196,140,0.16)");
    ctx.fillStyle = liquid;
    ctx.fill();

    // Soft colour caught inside the liquid.
    ctx.save();
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    smudge(cx - R * 0.32, cy + R * 0.62, R * 0.55, "255,160,80", 0.16);
    smudge(cx + R * 0.34, cy + R * 0.5, R * 0.5, "90,170,210", 0.09);
    smudge(cx, cy + R * 0.95, R * 0.7, "255,210,160", 0.12);
    ctx.restore();

    // The bright, prism-edged waterline.
    ctx.globalCompositeOperation = "lighter";
    edge(base, 5, "110,160,255", 6, 22, 0.55);
    edge(base, -5, "255,165,80", 6, 22, 0.6);
    edge(base, 0, "255,250,240", 4, 16, 0.95);
    ctx.globalCompositeOperation = "source-over";

    // Glass edge: brighter toward the rim.
    const rim = ctx.createRadialGradient(cx, cy, R * 0.72, cx, cy, R);
    rim.addColorStop(0, "rgba(255,244,226,0)");
    rim.addColorStop(0.78, "rgba(255,244,226,0.05)");
    rim.addColorStop(0.95, "rgba(255,240,220,0.18)");
    rim.addColorStop(1, "rgba(255,248,236,0.34)");
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // A light that travels slowly around the glass edge, with a prism
    // fringe (amber leading, blue trailing), and a fainter one opposite.
    if (ctx.createConicGradient) {
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = 10;
      ctx.lineCap = "butt";
      const lights = [
        { angle: (time * TAU) / 16, strength: 1 },
        { angle: Math.PI - (time * TAU) / 26, strength: 0.5 },
      ];
      for (const light of lights) {
        const a = light.strength * glow;
        const g = ctx.createConicGradient(light.angle, cx, cy);
        g.addColorStop(0, "rgba(255,150,80,0)");
        g.addColorStop(0.5, "rgba(255,150,80,0)");
        g.addColorStop(0.64, `rgba(255,170,90,${0.5 * a})`);
        g.addColorStop(0.74, `rgba(255,250,240,${0.95 * a})`);
        g.addColorStop(0.84, `rgba(120,170,255,${0.55 * a})`);
        g.addColorStop(0.95, "rgba(120,170,255,0)");
        g.addColorStop(1, "rgba(120,170,255,0)");
        ctx.beginPath();
        ctx.arc(cx, cy, R - 4, 0, TAU);
        ctx.strokeStyle = g;
        ctx.shadowColor = `rgba(255,190,130,${0.7 * a})`;
        ctx.shadowBlur = 26;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";
    }

    // Highlight on the upper left, warm light through the bottom.
    ctx.lineCap = "round";
    ctx.lineWidth = 9;
    ctx.shadowBlur = 18;
    ctx.shadowColor = "rgba(255,255,255,0.35)";
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.93, Math.PI * 1.05, Math.PI * 1.42);
    ctx.stroke();
    ctx.shadowColor = "rgba(255,170,90,0.5)";
    ctx.strokeStyle = "rgba(255,180,110,0.12)";
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.94, Math.PI * 0.2, Math.PI * 0.62);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.restore();

    // Outer rim, with a faint colour split like real glass.
    ctx.globalCompositeOperation = "lighter";
    ring(-2, "110,160,255", 0.2);
    ring(2, "255,170,90", 0.2);
    ring(0, "255,246,230", 0.2);
    ctx.globalCompositeOperation = "source-over";
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    level += (targetLevel() - level) * Math.min(1, dt * 1.6);
    energy += ((active ? 1 : 0.7) - energy) * Math.min(1, dt * 1.2);
    draw();
    requestAnimationFrame(frame);
  }

  window.sanctuaryOrb = {
    setProgress(value) {
      progress = Math.max(0, Math.min(1, Number(value) || 0));
      if (reduceMotion) {
        level = targetLevel();
        draw();
      }
    },
    setActive(value) {
      active = !!value;
      if (reduceMotion) {
        energy = active ? 1 : 0.7;
        draw();
      }
    },
  };

  draw();
  // With reduced motion the orb stays still and only redraws on changes.
  if (!reduceMotion) requestAnimationFrame(frame);
}

start();
