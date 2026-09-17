(() => {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;

  // ---------------------------------------------------------------------
  // Scroll reveal
  // ---------------------------------------------------------------------
  const revealTargets = document.querySelectorAll("[data-reveal]");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealTargets.forEach((el) => el.classList.add("is-visible"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealTargets.forEach((el) => io.observe(el));
  }

  // ---------------------------------------------------------------------
  // 3D tilt on the hero mock frame and screenshot cards
  // ---------------------------------------------------------------------
  if (!reduceMotion && !isCoarsePointer) {
    const tiltEls = document.querySelectorAll("#tilt-hero, .tilt-card");
    tiltEls.forEach((el) => {
      const strength = el.id === "tilt-hero" ? 10 : 6;
      let raf = null;

      const onMove = (e) => {
        const rect = el.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          el.style.transform = `rotateX(${(-py * strength).toFixed(2)}deg) rotateY(${(px * strength).toFixed(2)}deg)`;
        });
      };
      const onLeave = () => {
        if (raf) cancelAnimationFrame(raf);
        el.style.transform = "rotateX(0deg) rotateY(0deg)";
      };

      el.addEventListener("mousemove", onMove);
      el.addEventListener("mouseleave", onLeave);
    });
  }

  // ---------------------------------------------------------------------
  // Hero background: a rotating wireframe icosahedron, hand-rolled (no
  // dependency) so the page has zero third-party runtime script and never
  // depends on a CDN being reachable. Frozen on a single static frame when
  // the viewer prefers reduced motion.
  // ---------------------------------------------------------------------
  const canvas = document.getElementById("orb-canvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // Icosahedron vertices, generated from the golden ratio -- the standard
    // construction (3 orthogonal golden rectangles), then scaled to unit radius.
    const phi = (1 + Math.sqrt(5)) / 2;
    const rawVerts = [
      [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
      [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
      [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
    ];
    const vlen = Math.hypot(1, phi, 0);
    const verts = rawVerts.map(([x, y, z]) => [x / vlen, y / vlen, z / vlen]);
    const edges = [
      [0, 1], [0, 5], [0, 7], [0, 10], [0, 11],
      [1, 5], [1, 7], [1, 8], [1, 9],
      [2, 3], [2, 4], [2, 6], [2, 10], [2, 11],
      [3, 4], [3, 6], [3, 8], [3, 9],
      [4, 5], [4, 9], [4, 11],
      [5, 9], [5, 11],
      [6, 7], [6, 8], [6, 10],
      [7, 8], [7, 10],
      [8, 9],
      [10, 11],
    ];

    let width = 0, height = 0;
    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    function rotate([x, y, z], ax, ay) {
      // Rotate around Y then X.
      let cosA = Math.cos(ay), sinA = Math.sin(ay);
      let x1 = x * cosA + z * sinA;
      let z1 = -x * sinA + z * cosA;
      let cosB = Math.cos(ax), sinB = Math.sin(ax);
      let y2 = y * cosB - z1 * sinB;
      let z2 = y * sinB + z1 * cosB;
      return [x1, y2, z2];
    }

    function project(x, y, z, scale, cx, cy) {
      const perspective = 3.6;
      const factor = perspective / (perspective + z);
      return [cx + x * scale * factor, cy + y * scale * factor, factor];
    }

    let angleX = 0.4;
    let angleY = 0;
    let lastT = null;

    function draw(t) {
      if (lastT === null) lastT = t;
      const dt = Math.min((t - lastT) / 1000, 0.05);
      lastT = t;
      if (!reduceMotion) {
        angleY += dt * 0.28;
        angleX = 0.4 + Math.sin(t / 4000) * 0.15;
      }

      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const scale = Math.min(width, height) * 0.34;

      const projected = verts.map((v) => {
        const [rx, ry, rz] = rotate(v, angleX, angleY);
        return project(rx, ry, rz, scale, cx, cy);
      });

      for (const [a, b] of edges) {
        const [ax, ay, af] = projected[a];
        const [bx, by, bf] = projected[b];
        const depth = (af + bf) / 2; // ~0.6..1.3, front edges brighter
        const alpha = Math.max(0.08, Math.min(0.85, (depth - 0.55) * 1.3));
        const grad = ctx.createLinearGradient(ax, ay, bx, by);
        grad.addColorStop(0, `rgba(252, 114, 255, ${alpha})`);
        grad.addColorStop(1, `rgba(162, 89, 255, ${alpha})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }

      for (const [x, y, f] of projected) {
        const r = 1.6 * f;
        ctx.beginPath();
        ctx.fillStyle = `rgba(255, 244, 255, ${Math.min(0.9, f * 0.7)})`;
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!reduceMotion) requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
  }

  // -------------------------------------------------------------------
  // Copy-to-clipboard for the donation address
  // -------------------------------------------------------------------
  const copyBtn = document.getElementById("copyDonateAddress");
  if (copyBtn) {
    const addressEl = document.querySelector("#donateAddress code");
    const fallbackCopy = (text) => {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      try {
        document.execCommand("copy");
      } catch {
        // Nothing more to try; the address is still visible and selectable by hand.
      }
      document.body.removeChild(helper);
    };
    copyBtn.addEventListener("click", () => {
      const text = addressEl ? addressEl.textContent.trim() : "";
      // navigator.clipboard.writeText can hang indefinitely if the permission prompt is
      // never resolved (seen under some automation contexts) -- race it against a short
      // timeout and fall back to the always-synchronous execCommand path either way, so the
      // button never gets stuck on "Copy" waiting for a promise that may never settle.
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        const label = copyBtn.querySelector("span");
        const original = label.textContent;
        copyBtn.classList.add("copied");
        label.textContent = "Copied";
        setTimeout(() => {
          copyBtn.classList.remove("copied");
          label.textContent = original;
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(finish).catch(() => {
          fallbackCopy(text);
          finish();
        });
        setTimeout(() => {
          if (!settled) {
            fallbackCopy(text);
            finish();
          }
        }, 600);
      } else {
        fallbackCopy(text);
        finish();
      }
    });
  }
})();
