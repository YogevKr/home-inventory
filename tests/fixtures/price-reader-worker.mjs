import { readPrice, PriceError } from '../../src/price-reader.ts';

export default {
  async fetch(request) {
    const { html, url, chunkSize = 65_536 } = await request.json();
    const data = new TextEncoder().encode(html);
    let offset = 0, cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        if (offset >= data.length) return controller.close();
        controller.enqueue(data.slice(offset, offset += chunkSize));
      },
      cancel() { cancelled = true; },
    });
    try {
      const result = await readPrice(url, 'USD', '', async () => new Response(body, { headers: { 'Content-Type': 'text/html' } }));
      return Response.json({ ...result, cancelled });
    } catch (error) {
      return Response.json({ error: error.message, code: error.code, cancelled }, { status: error instanceof PriceError ? error.status : 500 });
    }
  },
};
