// Glow renderer for the live map's particles. WebGL2 with soft additive points and fading trails (two targets,
// ping-pong), a plain canvas fallback when WebGL2 is unavailable.
// Input: Float32Array of x, y, size, r, g, b, a (stride 7) in CSS pixels, plus the core's swarm ({ count, u }), whose
// particles move in the vertex shader (map-core.js SWARM_VS) from seeds uploaded once.
// The targets are half-float where the browser can draw into them, so dense additive light rolls off softly in the
// final pass instead of clipping white; otherwise 8-bit, as before.

import { STRIDE } from './map-particles.js';
import { SWARM_VS, swarmSeeds } from './map-core.js';

const VS_POINTS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in float aSize;
layout(location=2) in vec4 aCol;
uniform vec2 uRes;
uniform float uDpr;
out vec4 vCol;
void main() {
  vec2 c = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = max(1.0, aSize * uDpr * 2.2);
  vCol = aCol;
}`;

const FS_POINTS = `#version 300 es
precision mediump float;
in vec4 vCol;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float a = (exp(-r2 * 4.0) * 0.75 + exp(-r2 * 26.0) * 0.9) * vCol.a;
  o = vec4(vCol.rgb * a, a);
}`;

const VS_QUAD = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_FADE = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uFade;
out vec4 o;
void main() { o = max(texture(uTex, vUv) * uFade - vec4(1.6 / 255.0), 0.0); }`;

// To the screen. 8-bit: clamp, as before. Half-float: unchanged up to a knee, then a soft roll-off toward full, and the
// very hottest spots pushed to white, so the faint map stays as it was and the dense swarm never clips flat.
const FS_COPY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform int uSoft;
out vec4 o;
vec3 knee(vec3 c) { return mix(c, 0.6 + 0.4 * (1.0 - exp(-(c - 0.6) / 0.4)), step(0.6, c)); }
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 m;
  if (uSoft == 1) {
    float peak = max(c.r, max(c.g, c.b));
    m = mix(knee(c.rgb), vec3(1.0), smoothstep(1.5, 5.0, peak) * 0.5);
  } else m = min(c.rgb, vec3(1.0));
  o = vec4(m, min(max(min(c.a, 1.0), max(m.r, max(m.g, m.b))), 1.0));
}`;

export function createRenderer(canvas) {
  try {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, powerPreference: 'high-performance' });
    if (gl) return new GLRenderer(canvas, gl);
  } catch { /* fall through */ }
  return new CanvasRenderer(canvas);
}

class GLRenderer {
  constructor(canvas, gl) {
    this.kind = 'webgl2';
    this.canvas = canvas;
    this.gl = gl;
    this.soft = !!gl.getExtension('EXT_color_buffer_float');
    this.points = this.program(VS_POINTS, FS_POINTS);
    this.swarmProg = this.program(SWARM_VS, FS_POINTS);
    this.fade = this.program(VS_QUAD, FS_FADE);
    this.copy = this.program(VS_QUAD, FS_COPY);
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const B = STRIDE * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, B, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, B, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, B, 12);
    this.seedVao = gl.createVertexArray();
    this.seedBuf = gl.createBuffer();
    gl.bindVertexArray(this.seedVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    gl.bindVertexArray(null);
    this.nSeeds = 0;
    this.quadVao = gl.createVertexArray();
    this.targets = [];
    this.w = this.h = 0;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; });
  }

  program(vs, fs) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const { name } = gl.getActiveUniform(p, i); u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }

  resize(cssW, cssH, dpr) {
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    const gl = this.gl;
    for (const t of this.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    this.targets = this.makeTargets(w, h);
    if (this.soft && this.targets.some(t => !t.ok)) {   // the driver will not draw into half-float: 8-bit, as before
      for (const t of this.targets) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      this.soft = false;
      this.targets = this.makeTargets(w, h);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  makeTargets(w, h) {
    const gl = this.gl;
    return [0, 1].map(() => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (this.soft) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fb, ok };
    });
  }

  // The seeds, uploaded once at the largest count asked for (the open map's budget); later frames draw a prefix.
  seeds(n) {
    if (n <= this.nSeeds) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seedBuf);
    gl.bufferData(gl.ARRAY_BUFFER, swarmSeeds(n), gl.STATIC_DRAW);
    this.nSeeds = n;
  }

  // trail: 0 = no trails (a still), up to ~0.9 = long trails. swarms: [{ count, u, max }] from SwarmCore.swarm().
  draw(data, count, trail, swarms = []) {
    if (this.lost || !this.targets.length) return;
    const gl = this.gl;
    const [prev, next] = this.targets;
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.DEPTH_TEST);
    // 1. previous frame, faded, into the next target
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.fb);
    gl.disable(gl.BLEND);
    gl.useProgram(this.fade.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, prev.tex);
    gl.uniform1i(this.fade.u.uTex, 0);
    gl.uniform1f(this.fade.u.uFade, trail);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    // 2. the core's swarm: no upload, only its uniforms
    for (const s of swarms) {
      if (!s || !s.count) continue;
      this.seeds(Math.max(s.count, s.max || 0));
      const P = this.swarmProg;
      gl.useProgram(P.p);
      gl.uniform2f(P.u.uRes, this.cssW, this.cssH);
      gl.uniform1f(P.u.uDpr, this.dpr);
      for (const k in s.u) {
        const loc = P.u[k], v = s.u[k];
        if (loc == null) continue;
        if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
        else gl.uniform3f(loc, v[0], v[1], v[2]);
      }
      gl.bindVertexArray(this.seedVao);
      gl.drawArrays(gl.POINTS, 0, Math.min(s.count, this.nSeeds));
    }
    // 3. this frame's CPU particles, added on top
    if (count > 0) {
      gl.useProgram(this.points.p);
      gl.uniform2f(this.points.u.uRes, this.cssW, this.cssH);
      gl.uniform1f(this.points.u.uDpr, this.dpr);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * STRIDE), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.POINTS, 0, count);
    }
    // 4. to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.copy.p);
    gl.bindTexture(gl.TEXTURE_2D, next.tex);
    gl.uniform1i(this.copy.u.uTex, 0);
    gl.uniform1i(this.copy.u.uSoft, this.soft ? 1 : 0);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    this.targets = [next, prev];
  }

  clear() {
    const gl = this.gl;
    for (const t of this.targets) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
}

// Fallback: additive dots on a 2D canvas; trails by fading what is already there. It cannot run the swarm's shader:
// the map writes a CPU sample of the swarm into the data instead (SwarmCore.cpuSwarm).
class CanvasRenderer {
  constructor(canvas) {
    this.kind = 'canvas';
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }
  resize(cssW, cssH, dpr) {
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (w !== this.canvas.width || h !== this.canvas.height) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
  }
  draw(data, count, trail) {
    const c = this.ctx, d = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = `rgba(0,0,0,${1 - trail})`;
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.globalCompositeOperation = 'lighter';
    c.setTransform(d, 0, 0, d, 0, 0);
    for (let i = 0; i < count; i++) {
      const k = i * STRIDE, a = data[k + 6];
      if (a < 0.01) continue;
      const rgb = `${(data[k + 3] * 255) | 0},${(data[k + 4] * 255) | 0},${(data[k + 5] * 255) | 0}`;
      c.fillStyle = `rgba(${rgb},${a * 0.22})`;
      c.beginPath(); c.arc(data[k], data[k + 1], data[k + 2] * 1.9, 0, 6.283); c.fill();
      c.fillStyle = `rgba(${rgb},${Math.min(1, a)})`;
      c.beginPath(); c.arc(data[k], data[k + 1], data[k + 2] * 0.55, 0, 6.283); c.fill();
    }
  }
  clear() { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
}
