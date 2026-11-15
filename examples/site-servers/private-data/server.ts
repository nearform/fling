// A trade price calculator. The page shows the public catalogue; the server prices a bulk order
// using costs and a margin floor that visitors never see.
//
// Two ways the server reads data, and what each means:
// - server/costs.json is imported, so esbuild puts it inside the bundle. Everything under
//   server/ is a build input: it is never published, and /server/costs.json is a 404.
// - data/products.json is a published file, read through file(). Anyone who can open the site can
//   also fetch /data/products.json, so it holds only what the page shows anyway.
import { file, viewer } from '@nearform/fling/server'
import costs from './server/costs.json' with { type: 'json' }

type Product = { sku: string; name: string; listPrice: number }

const json = (body: unknown, status = 200) => Response.json(body, { status })

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/api/health') return json({ ok: true })
    if (request.method === 'POST' && pathname === '/api/offer') return offer(request)
    return json({ error: 'No such endpoint' }, 404)
  },
}

// POST /api/offer {"sku","quantity"}: the price per unit and the total, never the cost.
async function offer(request: Request) {
  const body = await request.json().catch(() => null)
  const quantity = Number(body?.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000) {
    return json({ error: 'Order 1 to 1,000 units.' }, 400)
  }

  // The catalogue is this version's published file, so the server and the page always agree.
  const catalogue: { products: Product[] } = await (await file('data/products.json')).json()
  const product = catalogue.products.find(p => p.sku === body?.sku)
  const cost = costs.unitCost[product?.sku as keyof typeof costs.unitCost]
  if (!product || cost === undefined) return json({ error: 'No such product.' }, 404)

  const discount = costs.volumeDiscounts.find(d => quantity >= d.from)?.off ?? 0
  const floor = Math.ceil(cost * (1 + costs.marginFloor))
  const unitPrice = Math.max(Math.round(product.listPrice * (1 - discount)), floor)

  console.log('offer', viewer(request)?.id ?? 'anonymous', product.sku, quantity)
  return json({ sku: product.sku, quantity, unitPrice, total: unitPrice * quantity })
}
