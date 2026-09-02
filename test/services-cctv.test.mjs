import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
let caltransLoads = 0;
let privateFetches = 0;

const caltransCameras = [
  {
    index: 'stable-private',
    location: { latitude: '34.1', longitude: '-118.2', locationName: 'Private Host' },
    cctv: { imageData: { static: { currentImageURL: 'http://127.0.0.1/frame.jpg' } } },
  },
  {
    index: 'stable-large',
    location: { latitude: '34.2', longitude: '-118.3', locationName: 'Large Image' },
    cctv: { imageData: { static: { currentImageURL: 'https://images.example.test/huge.jpg' } } },
  },
  {
    index: 'stable-redirect',
    location: { latitude: '34.3', longitude: '-118.4', locationName: 'Private Redirect' },
    cctv: { imageData: { static: { currentImageURL: 'https://images.example.test/redirect.jpg' } } },
  },
];

globalThis.fetch = async (url) => {
  const href = String(url);
  if (href.includes('cctvStatusD03.json')) {
    caltransLoads += 1;
    const data = caltransLoads % 2 ? caltransCameras : [...caltransCameras].reverse();
    return Response.json({ data });
  }
  if (href.includes('cwwp2.dot.ca.gov/data/')) return Response.json({ data: [] });
  if (href.includes('youtube.com/')) {
    return new Response('<html><title>Before you continue to YouTube</title></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }
  if (href.startsWith('http://127.0.0.1/')) {
    privateFetches += 1;
    throw new Error('private host should never be fetched');
  }
  if (href === 'https://images.example.test/huge.jpg') {
    const body = new Uint8Array(5 * 1024 * 1024 + 1);
    body.set([0xff, 0xd8, 0xff]);
    return new Response(body, {
      headers: { 'content-type': 'image/jpeg' },
    });
  }
  if (href === 'https://images.example.test/redirect.jpg') {
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/redirected.jpg' } });
  }
  return Response.json([]);
};

const camerasModule = await import('../services/cctv/cctvCameras.mjs');
const { default: cctvRouter } = await import('../services/cctv/cctvRouter.mjs');

async function invokeSnapshot(id) {
  const layer = cctvRouter.stack.find((item) => item.route?.path === '/snapshot');
  const response = { statusCode: 200, headers: {}, headersSent: false };
  response.set = (key, value) => { response.headers[key] = value; return response; };
  response.status = (code) => { response.statusCode = code; return response; };
  response.json = (body) => { response.body = body; response.headersSent = true; return response; };
  response.send = (body) => { response.body = body; response.headersSent = true; return response; };
  response.end = () => { response.headersSent = true; return response; };
  await layer.route.stack[0].handle({ query: { id } }, response);
  return response;
}

after(() => { globalThis.fetch = realFetch; });

describe('CCTV assembly', () => {
  test('Caltrans ids remain stable when upstream ordering changes', async () => {
    const first = await camerasModule.fetchCamerasForRegions({ region: 'us-west' });
    const second = await camerasModule.fetchCamerasForRegions({ region: 'us-west' });
    const ids = (result) => Object.fromEntries(result.cameras.map((cam) => [cam.feed_url, cam.id]));
    assert.deepEqual(ids(first), ids(second));
    assert.ok(first.cameras.every((cam) => !/^cal-\d+$/.test(cam.id)));
  });

  test('a YouTube consent/interstitial response fails open and keeps the camera', async () => {
    const { cameras } = await camerasModule.getAllCameras();
    assert.ok(cameras.some((cam) => cam.id === 'il-jerusalem-live'));
  });
});

describe('CCTV snapshot proxy', () => {
  test('rejects private feed hosts without issuing an upstream request', async () => {
    const { cameras } = await camerasModule.getAllCameras();
    const cam = cameras.find((item) => item.feed_url === 'http://127.0.0.1/frame.jpg');
    assert.ok(cam);
    const response = await invokeSnapshot(cam.id);
    assert.equal(response.statusCode, 403);
    assert.match(response.body.error, /private/i);
    assert.equal(privateFetches, 0);
  });

  test('aborts and rejects an upstream body over 5 MB', async () => {
    const { cameras } = await camerasModule.getAllCameras();
    const cam = cameras.find((item) => item.feed_url === 'https://images.example.test/huge.jpg');
    assert.ok(cam);
    const response = await invokeSnapshot(cam.id);
    assert.equal(response.statusCode, 502);
    assert.match(response.body.detail, /exceeds/i);
  });

  test('re-checks redirect targets and rejects a redirect to a private host', async () => {
    const { cameras } = await camerasModule.getAllCameras();
    const cam = cameras.find((item) => item.feed_url === 'https://images.example.test/redirect.jpg');
    assert.ok(cam);
    const response = await invokeSnapshot(cam.id);
    assert.equal(response.statusCode, 502);
    assert.match(response.body.detail, /private/i);
    assert.equal(privateFetches, 0);
  });
});
