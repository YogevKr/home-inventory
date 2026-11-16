import test from 'node:test';
import assert from 'node:assert/strict';
import { resizedPhoto } from '../public/photos.js';

function browserEncoder(t, supported) {
  for (const name of ['document', 'createImageBitmap']) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  globalThis.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
  globalThis.document = { createElement: () => ({
    getContext: () => ({ drawImage() {}, fillRect() {} }),
    toBlob: (callback, requested) => {
      const type = supported.includes(requested) ? requested : 'image/png';
      callback(new Blob([type], { type }));
    },
  }) };
}

test('photo conversion uses JPEG when the browser returns PNG for a WebP request', async t => {
  browserEncoder(t, ['image/jpeg']);
  const result = await resizedPhoto(new File(['photo'], 'camera.png', { type: 'image/png' }));
  assert.equal(result.type, 'image/jpeg');
  assert.equal(result.name, 'camera.jpg');
  assert.equal(await result.text(), 'image/jpeg');
});

test('photo conversion retains WebP when the browser supports it', async t => {
  browserEncoder(t, ['image/webp', 'image/jpeg']);
  const result = await resizedPhoto(new File(['photo'], 'camera.jpg', { type: 'image/jpeg' }));
  assert.equal(result.type, 'image/webp');
  assert.equal(result.name, 'camera.webp');
  assert.equal(await result.text(), 'image/webp');
});

test('photo conversion rejects unsupported output instead of applying a false MIME type', async t => {
  browserEncoder(t, []);
  await assert.rejects(resizedPhoto(new File(['photo'], 'camera.png')), /Could not prepare this photo/);
});
