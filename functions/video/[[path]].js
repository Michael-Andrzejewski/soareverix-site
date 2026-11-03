// Cloudflare Pages ignores Range headers on static files: it always answers 200
// with the whole file. Safari and iPhones need a 206 reply to play an MP4, so
// every request under /video/ comes through here and gets real byte ranges.
// Everything else on the site stays plain static files.

export async function onRequest(context) {
  const { request, env } = context;

  // Browsers play video with GET, so HEAD can go straight to the asset layer.
  if (request.method === 'HEAD') return env.ASSETS.fetch(request);

  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  // Ask for the whole, unencoded file so byte offsets line up with Content-Range.
  const asset = await env.ASSETS.fetch(new Request(request.url, {
    headers: { 'Accept-Encoding': 'identity' },
  }));
  if (!asset.ok) return asset;

  // A browser already holding this exact file can keep using it.
  const etag = asset.headers.get('ETag');
  if (etag && request.headers.get('If-None-Match') === etag) {
    await asset.body.cancel();
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Accept-Ranges': 'bytes', 'Cache-Control': asset.headers.get('Cache-Control') ?? 'no-cache' },
    });
  }

  // The asset layer can leave out the length. Pages caps files at 25 MiB, so
  // reading one into memory to measure it is safe.
  let size = Number(asset.headers.get('Content-Length'));
  let bytes = null;
  if (!size) {
    bytes = new Uint8Array(await asset.arrayBuffer());
    size = bytes.byteLength;
  }

  // Cache-Control stays as the asset layer sets it. On soareverix.com the CDN still
  // raises the browser lifetime to 4 hours, so browsers can mix old and new bytes
  // after a swap at the same URL, and the player fails when it seeks. To replace a
  // video, give the new one a new filename.
  const headers = new Headers(asset.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(size));

  const range = wantedRange(request, asset, size);

  if (range === 'unsatisfiable') {
    if (!bytes) await asset.body.cancel();
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
    });
  }

  if (!range) return new Response(bytes ?? asset.body, { status: 200, headers });

  const { start, end } = range;
  const length = end - start + 1;
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(length));

  if (bytes) return new Response(bytes.subarray(start, end + 1), { status: 206, headers });
  if (length === size) return new Response(asset.body, { status: 206, headers });

  const { readable, writable } = new FixedLengthStream(length);
  context.waitUntil(copyBytes(asset.body, writable, start, end));
  return new Response(readable, { status: 206, headers });
}

// Returns { start, end }, 'unsatisfiable', or null to send the whole file.
function wantedRange(request, asset, size) {
  const header = request.headers.get('Range');
  if (!header) return null;

  const ifRange = request.headers.get('If-Range');
  if (ifRange && ifRange !== asset.headers.get('ETag')) return null;

  // A multi-part range does not match this pattern, and gets the whole file.
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;

  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(match[1]);
  if (start >= size) return 'unsatisfiable';
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start > end ? null : { start, end };
}

// Streams only the requested bytes, without holding the file in memory.
async function copyBytes(body, writable, start, end) {
  const reader = body.getReader();
  const writer = writable.getWriter();
  let pos = 0;
  try {
    while (pos <= end) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = pos + value.byteLength;
      if (next > start) {
        await writer.write(value.subarray(Math.max(start - pos, 0), Math.min(end + 1 - pos, value.byteLength)));
      }
      pos = next;
    }
    await writer.close();
  } catch (err) {
    // The viewer seeked or left, which closes the stream. Nothing left to do.
    await writer.abort(err).catch(() => {});
  } finally {
    await reader.cancel().catch(() => {});
  }
}
