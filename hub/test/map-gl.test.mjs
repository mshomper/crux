// The live map's renderer (map-gl.js) against a pretend WebGL2: the fallbacks and the recovery after a lost context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, withPower } from '../public/map-gl.js';
import { SwarmCore } from '../public/map-core.js';
import { STRIDE } from '../public/map-particles.js';

// A WebGL2 context that records what it is asked to do. compile: whether shaders build; halfFloat: whether a half-float
// target is complete.
function fakeGl({ compile = true, halfFloat = true } = {}) {
  const calls = { drawArrays: 0, texImage: [], bufferData: 0, lost: 0 };
  let lastFormat = null, n = 0;
  const consts = new Map();
  const gl = new Proxy({}, {
    get(_, k) {
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z0-9_]+$/.test(k)) { if (!consts.has(k)) consts.set(k, 1000 + consts.size); return consts.get(k); }
      switch (k) {
        case 'calls': return calls;
        case 'getExtension': return name => name === 'WEBGL_lose_context' ? { loseContext: () => calls.lost++ } : /color_buffer/.test(name) ? {} : null;
        case 'getShaderParameter': return () => compile;
        case 'getProgramParameter': return (p, which) => which === gl.ACTIVE_UNIFORMS ? 0 : true;
        case 'texImage2D': return (t, l, fmt) => { lastFormat = fmt; calls.texImage.push(fmt); };
        case 'checkFramebufferStatus': return () => (lastFormat === gl.RGBA16F && !halfFloat) ? 0 : gl.FRAMEBUFFER_COMPLETE;
        case 'drawArrays': return () => { calls.drawArrays++; };
        case 'bufferData': return () => { calls.bufferData++; };
        default: return k.startsWith('create') ? () => ({ id: ++n }) : () => {};
      }
    }
  });
  return gl;
}
// A canvas that hands out one context: webgl2 (the fake) or 2D, never both, as browsers do.
function fakeCanvas(glOpts, parent) {
  const listeners = {}, ctx2d = { setTransform() {}, fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {} };
  let taken = null;
  const c = {
    width: 0, height: 0, style: {}, replaced: null,
    getContext(kind) {
      if (taken && taken !== kind) return null;
      taken = kind;
      return kind === 'webgl2' ? (c.gl ||= glOpts ? fakeGl(glOpts) : null) : ctx2d;
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of listeners[type] || []) fn({ preventDefault() {} }); },
    cloneNode() { return fakeCanvas(glOpts, c); },
    replaceWith(other) { c.replaced = other; }
  };
  return c;
}
const frame = (r, core) => {
  const out = new Float32Array(core.capacity * STRIDE), o = core.project(100, 100, 104, out, 0);
  r.draw(out, o, 0.6, [core.swarm()]);
};

test('a WebGL2 context gives the GPU renderer with half-float targets', () => {
  const c = fakeCanvas({}), r = createRenderer(c);
  r.resize(800, 600, 2);
  assert.equal(r.kind, 'webgl2');
  assert.equal(r.soft, true);
  assert.ok(c.gl.calls.texImage.every(f => f === c.gl.RGBA16F));
});

test('an incomplete half-float target falls back to 8-bit, once, and stays there', () => {
  const c = fakeCanvas({ halfFloat: false }), r = createRenderer(c);
  r.resize(800, 600, 2);
  assert.equal(r.soft, false);
  assert.equal(r.broken, false, 'the 8-bit targets work');
  const before = c.gl.calls.texImage.length;
  r.resize(1600, 1200, 2);   // growing reallocates, straight at 8-bit
  assert.ok(c.gl.calls.texImage.slice(before).every(f => f === c.gl.RGBA8));
});

test('the targets are not reallocated on every frame of the zoom', () => {
  const c = fakeCanvas({}), r = createRenderer(c);
  r.resize(1000, 600, 1);
  const n = c.gl.calls.texImage.length;
  for (let w = 1000; w >= 400; w -= 7) r.resize(w, w * 0.6, 1);   // shrinking: no new targets
  assert.equal(c.gl.calls.texImage.length, n);
  for (let w = 400; w <= 1020; w += 7) r.resize(w, w * 0.6, 1);   // growing inside the 256 px step: none either
  assert.equal(c.gl.calls.texImage.length, n);
});

test('after a lost context the renderer draws nothing, and draws again once it is restored', () => {
  const c = fakeCanvas({}), r = createRenderer(c), core = new SwarmCore();
  core.setMood({ state: 'working', ctx: 30 });
  let restored = 0;
  r.onRestored = () => restored++;
  r.resize(800, 600, 1);
  frame(r, core);
  const drawn = c.gl.calls.drawArrays;
  assert.ok(drawn > 0);
  c.fire('webglcontextlost');
  frame(r, core);
  assert.equal(c.gl.calls.drawArrays, drawn, 'nothing while lost');
  c.fire('webglcontextrestored');
  assert.equal(restored, 1, 'the map is asked to redraw');
  assert.equal(r.nSeeds, 0, 'the seeds go up again');
  frame(r, core);
  assert.ok(c.gl.calls.drawArrays > drawn && r.nSeeds > 0, 'drawing again, seeds uploaded');
});

test('shaders that do not compile give a working plain-canvas renderer on a fresh canvas', () => {
  const c = fakeCanvas({ compile: false }), r = createRenderer(c);
  assert.equal(r.kind, 'canvas');
  assert.notEqual(r.canvas, c, 'not the canvas that already holds a WebGL2 context');
  assert.equal(c.replaced, r.canvas, 'the fresh canvas takes its place in the page');
  r.resize(200, 100, 1);
  r.draw(new Float32Array(STRIDE * 2).fill(0.5), 2, 0.6, []);   // does not throw
});

test('switching the GPU preference builds a new renderer on a fresh canvas and frees the old one', () => {
  const c = fakeCanvas({}), r = createRenderer(c, { power: 'low-power' });
  r.resize(800, 600, 1);
  const hi = withPower(r, 'high-performance');
  assert.notEqual(hi, r);
  assert.equal(hi.power, 'high-performance');
  assert.equal(c.replaced, hi.canvas);
  assert.equal(c.gl.calls.lost, 1, 'the old context is let go');
  assert.equal(withPower(hi, 'high-performance'), hi, 'no switch when it already has it');
});
