/**
 * Generic measurement helpers shared by the specs.
 *
 * These know nothing about the application's internals — they measure what is
 * actually on screen (canvas pixels, scroll extents, positions). Anything that
 * needs an engine probe lives in `seam.mjs` instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sel } from './locators.mjs';

/**
 * Number of distinct sampled colours on a canvas.
 *
 * A canvas that failed to paint is uniformly one colour; a drawn treemap has
 * many. Sampling every `step` bytes keeps this cheap on a 1600x900 buffer.
 */
export async function distinctCanvasColors(page, step = 4000) {
  return page.evaluate(({ selector, step }) => {
    const cv = document.querySelector(selector);
    const ctx = cv.getContext('2d');
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += step) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return seen.size;
  }, { selector: sel.canvas, step });
}

/** Raw count of lit pixels — the dependency graph draws on a dark field. */
export async function litCanvasSamples(page, step = 400) {
  return page.evaluate(({ selector, step }) => {
    const cv = document.querySelector(selector);
    const ctx = cv.getContext('2d');
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    let lit = 0;
    for (let i = 0; i < data.length; i += step) if (data[i] > 40 || data[i + 1] > 40) lit++;
    return lit;
  }, { selector: sel.canvas, step });
}

/** The canvas's page-space box, for converting probe coordinates to clicks. */
export async function canvasBox(page) {
  return page.evaluate((selector) => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, sel.canvas);
}

/** Base64 PNG of the canvas, for comparing one render against another. */
export async function canvasSnapshot(page) {
  return (await page.locator(sel.canvas).screenshot()).toString('base64');
}

/** Visual-language of a view: the canvas pixels, ignoring any DOM overlay. */
export async function canvasSignature(page) {
  return page.evaluate((selector) => {
    const cv = document.querySelector(selector);
    const ctx = cv.getContext('2d');
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    let h = 2166136261;
    for (let i = 0; i < data.length; i += 97) {
      h ^= data[i];
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }, sel.canvas);
}

/**
 * Scroll a container to its maximum and report whether every pixel of overflow
 * was actually reachable.
 *
 * The invariant is "overflow implies reachability", not a fixed amount: the
 * regression this guards against had `overflow > 0` with nothing scrollable.
 */
export async function canScroll(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = el.scrollHeight; // the browser clamps to the maximum
    const reached = Math.round(el.scrollTop);
    el.scrollTop = 0;
    return { overflow: max, reached, bottom: Math.abs(reached - max) <= 1 };
  }, selector);
}

/** True when a container's overflow is fully reachable (or absent entirely). */
export const overflowReachable = (r) => !!r && (r.overflow <= 0 || r.bottom);

/** Whether the page itself has no clipped overflow. */
export async function fitsViewport(page, selector = sel.app) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    return el.scrollHeight <= window.innerHeight + 1;
  }, selector);
}

/** Write a screenshot, if the run asked for them. */
export async function screenshot(page, dir, name, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), ...opts });
}

/** Drain pending animation frames and short async work before measuring. */
export async function settle(page, ms = 450) {
  await page.waitForTimeout(ms);
}
