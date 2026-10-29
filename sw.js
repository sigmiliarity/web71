/**
 * sw.js - Self-Loading Service Worker with Bulletproof Chunk Virtualization
 */

if (typeof window !== 'undefined') {
  // ==========================================
  // 1. MAIN BROWSER THREAD (<script src="sw.js">)
  // ==========================================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
      try {
        const scriptUrl = document.currentScript ? document.currentScript.src : 'sw.js';
        const registration = await navigator.serviceWorker.register(scriptUrl);
        console.log('Self-loading Service Worker registered successfully:', registration.scope);

        if (!navigator.serviceWorker.controller) {
          let refreshing = false;
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!refreshing) {
              refreshing = true;
              window.location.reload();
            }
          });
        }
      } catch (err) {
        console.error('Service Worker self-registration failed:', err);
      }
    });
  }
} else {
  // ==========================================
  // 2. SERVICE WORKER THREAD (Background Context)
  // ==========================================
  const CHUNK_SIZE = 26214400; // 25.0 MB (26,214,400 bytes)
  const TOTAL_CHUNKS = 259;
  const TOTAL_SIZE = CHUNK_SIZE * TOTAL_CHUNKS; // ~6.78 GB

  self.addEventListener('install', (event) => {
    self.skipWaiting();
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
  });

  self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Intercept requests for game.data anywhere in the path hierarchy
    if (url.pathname.endsWith('/game.data') || url.pathname === 'game.data') {
      event.respondWith(handleGameDataRequest(event.request));
    }
  });

  async function handleGameDataRequest(request) {
    const rangeHeader = request.headers.get('Range');

    if (rangeHeader) {
      return handleRangeRequest(request, rangeHeader);
    } else {
      return handleFullRequest(request);
    }
  }

  /**
   * Handles HTTP Range requests with robust local slicing and path resolution
   */
  async function handleRangeRequest(request, rangeHeader) {
    const bytesMatch = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!bytesMatch) {
      return new Response('Invalid Range Header', { status: 416 });
    }

    const start = bytesMatch[1] ? parseInt(bytesMatch[1], 10) : 0;
    const end = bytesMatch[2] ? parseInt(bytesMatch[2], 10) : TOTAL_SIZE - 1;

    if (start >= TOTAL_SIZE || end >= TOTAL_SIZE || start > end) {
      return new Response('Requested Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${TOTAL_SIZE}` }
      });
    }

    const contentLength = (end - start) + 1;
    const startChunkIdx = Math.floor(start / CHUNK_SIZE);
    const endChunkIdx = Math.floor(end / CHUNK_SIZE);

    const slicedBuffer = new Uint8Array(contentLength);
    let offset = 0;
    const requestUrl = new URL(request.url);

    for (let i = startChunkIdx; i <= endChunkIdx; i++) {
      const chunkNumber = i + 1; // 1 to 259
      
      // Dynamically resolve chunk URL relative to the requested game.data path
      // e.g., if request is /msm/game.data, chunks will be at /msm/game/1.data
      const chunkUrl = new URL(`./game/${chunkNumber}.data`, requestUrl).href;

      const chunkGlobalStart = i * CHUNK_SIZE;
      const localStart = Math.max(0, start - chunkGlobalStart);
      const localEnd = Math.min(CHUNK_SIZE - 1, end - chunkGlobalStart);

      try {
        const chunkRes = await fetch(chunkUrl, {
          headers: {
            Range: `bytes=${localStart}-${localEnd}`
          }
        });

        if (!chunkRes.ok) {
          throw new Error(`Failed to fetch chunk ${chunkNumber}: ${chunkRes.statusText} (${chunkRes.status})`);
        }

        const chunkArrayBuffer = await chunkRes.arrayBuffer();
        let targetBytes;

        if (chunkRes.status === 206) {
          // Server properly honored the Range header
          targetBytes = new Uint8Array(chunkArrayBuffer);
        } else {
          // Server ignored Range and sent the full 25MB file (200 OK); slice it locally!
          targetBytes = new Uint8Array(chunkArrayBuffer, localStart, (localEnd - localStart) + 1);
        }

        slicedBuffer.set(targetBytes, offset);
        offset += targetBytes.byteLength;
      } catch (err) {
        console.error(`Error loading chunk ${chunkNumber} from ${chunkUrl}:`, err);
        return new Response(`Error loading game data chunk ${chunkNumber}: ${err.message}`, { status: 500 });
      }
    }

    return new Response(slicedBuffer, {
      status: 206,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${TOTAL_SIZE}`,
        'Content-Length': contentLength.toString(),
        'Accept-Ranges': 'bytes'
      }
    });
  }

  /**
   * Handles full file requests by streaming chunks sequentially.
   */
  async function handleFullRequest(request) {
    const requestUrl = new URL(request.url);

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (let i = 0; i < TOTAL_CHUNKS; i++) {
            const chunkNumber = i + 1;
            const chunkUrl = new URL(`./game/${chunkNumber}.data`, requestUrl).href;
            
            const res = await fetch(chunkUrl);
            if (!res.ok) {
              throw new Error(`Failed to fetch chunk ${chunkNumber}`);
            }

            const reader = res.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': TOTAL_SIZE.toString(),
        'Accept-Ranges': 'bytes'
      }
    });
  }
}