// LifeHash identicons, computed by bc-lifehash inside the WASM module.
import { lifehashRGBA } from './wasm.js';

const cache = new Map();

/** Returns a PNG data URL of the LifeHash for `input` (32×32, scaled by CSS). */
export function lifehash(input) {
  if (!input) return '';
  let url = cache.get(input);
  if (url) return url;
  const rgba = lifehashRGBA(input, 1);
  const size = Math.round(Math.sqrt(rgba.length / 4));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
  url = canvas.toDataURL('image/png');
  if (cache.size > 500) cache.clear();
  cache.set(input, url);
  return url;
}

export function lifehashImg(input, cls = '') {
  const src = lifehash(input);
  return src
    ? `<img class="lifehash ${cls}" src="${src}" alt="LifeHash" draggable="false">`
    : `<span class="lifehash lifehash--empty ${cls}"></span>`;
}
