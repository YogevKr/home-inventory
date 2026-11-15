import { writeFile } from 'node:fs/promises';
import { z } from 'zod';

const response = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=ILS,EUR,GBP', {
  redirect: 'error', signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Reference rates returned HTTP ${response.status}.`);
const positiveRate = z.number().positive().finite();
const quote = z.object({
  amount: z.literal(1), base: z.literal('USD'), date: z.iso.date(),
  rates: z.object({ EUR: positiveRate, GBP: positiveRate, ILS: positiveRate }).strict(),
}).parse(await response.json());
const reference = {
  currency: 'USD', date: quote.date,
  source: `https://api.frankfurter.dev/v1/${quote.date}?base=USD&symbols=ILS,EUR,GBP`,
  rates: { USD: 1, ...quote.rates },
};
await writeFile(new URL('../src/price-rates.json', import.meta.url), JSON.stringify(reference, null, 2) + '\n');
process.stdout.write(`Updated reference rates for ${quote.date}. Review, test, and deploy this change.\n`);
