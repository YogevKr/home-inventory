import asyncio, os, re
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
from playwright.async_api import async_playwright, expect

origin = os.environ.get('TEST_URL', 'http://127.0.0.1:8806')
if not re.fullmatch(r'http://(127\.0\.0\.1|localhost):[0-9]+', origin):
    raise ValueError('Browser checks require a local server.')
output = Path(__file__).resolve().parent.parent / 'test-results'
output.mkdir(exist_ok=True)


async def main():
    async with async_playwright() as p:
        browser = await p.webkit.launch()
        api = await p.request.new_context(base_url=origin)
        ids, errors = [], []
        try:
            for device, options in [('desktop', {'viewport': {'width': 1280, 'height': 1100}}), ('narrow', {'viewport': {'width': 320, 'height': 700}, 'is_mobile': True}), ('iphone', p.devices['iPhone 13'])]:
                response = await api.post('/api/items', data={'data': {'name': 'Wishlist headphones ' + uuid4().hex[:6], 'status': 'wishlist', 'currency': 'USD', 'priceMinor': 19900, 'productUrl': 'https://www.amazon.com/dp/B000000001'}})
                assert response.status == 201
                item = await response.json()
                ids.append(item['id'])
                for price in [19900, 17900]:
                    response = await api.post('/api/items/' + item['id'] + '/prices', data={'revision': item['revision'], 'priceMinor': price, 'currency': 'USD', 'productUrl': item['data']['productUrl']})
                    assert response.status == 200
                context = await browser.new_context(**options)
                page = await context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(origin)
                await page.get_by_role('button', name='Wishlist', exact=True).click()
                await page.get_by_role('searchbox', name='Search items').fill(item['data']['name'])
                await page.get_by_role('button', name='Open ' + item['data']['name'], exact=True).click()
                panel = page.get_by_role('region', name='Price tracker')
                await expect(panel.locator('.tracked-price-value')).to_have_text('US$179')
                await expect(panel.get_by_role('button', name='Check price', exact=True)).to_be_enabled()
                await expect(panel.locator('.tracked-price-date')).to_contain_text('Recorded price')
                await expect(panel.get_by_role('img')).to_be_visible()
                await panel.get_by_text('Record a price', exact=True).click()
                await panel.get_by_role('spinbutton', name='Price (USD)', exact=True).fill('159.00')
                await panel.get_by_role('button', name='Save price', exact=True).click()
                await expect(panel.locator('.tracked-price-value')).to_have_text('US$159')
                await expect(panel.locator('.price-trend')).to_have_text('US$20 less than the previous price.')
                await expect(panel.get_by_text('Lowest recorded: US$159 · 3 records', exact=True)).to_be_visible()
                await panel.get_by_text('Price history (3)', exact=True).click()
                await expect(panel.locator('li')).to_have_count(3)
                if device != 'desktop':
                    await panel.get_by_text('Price history (3)', exact=True).click()
                await panel.evaluate("el => { const drawer=el.closest('dialog'); drawer.scrollTop += el.getBoundingClientRect().top-drawer.getBoundingClientRect().top-drawer.querySelector('.drawer-top').offsetHeight-12; }")
                assert await panel.evaluate('(el) => el.scrollWidth <= el.clientWidth')
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                await page.screenshot(path=output / ('price-tracking-' + device + '.png'), full_page=True)
                current = await (await api.get('/api/items/' + item['id'])).json()
                assert current['revision'] == item['revision']
                assert current['data']['priceMinor'] == 19900
                # A failed save keeps the value in the form and shows an inline error.
                await panel.get_by_text('Record a price', exact=True).click()
                await panel.get_by_role('spinbutton', name='Price (USD)', exact=True).fill('149.95')
                async def fail(route):
                    await route.fulfill(status=503, json={'error': 'Price save unavailable. Try again.'})
                await page.route('**/api/items/' + item['id'] + '/prices', fail)
                await panel.get_by_role('button', name='Save price', exact=True).click()
                await expect(panel.get_by_role('alert')).to_have_text('Price save unavailable. Try again.')
                await expect(panel.get_by_role('spinbutton', name='Price (USD)', exact=True)).to_have_value('149.95')
                await page.unroute('**/api/items/' + item['id'] + '/prices', fail)
                await panel.get_by_role('button', name='Save price', exact=True).click()
                await expect(panel.locator('.tracked-price-value')).to_have_text('US$149.95')
                # Simulate an external store failure without depending on its live response.
                failure = {'checked_at': datetime.now(timezone.utc).isoformat(), 'error': 'The store did not publish a readable price for this product. Open the product link and record its price.'}
                async def fail_check(route):
                    await route.fulfill(status=422, json={'error': failure['error'], 'code': 'offer_missing'})
                async def with_failed_check(route):
                    response = await route.fetch()
                    result = await response.json()
                    await route.fulfill(response=response, json={**result, 'lastCheck': failure})
                await page.route('**/api/items/' + item['id'] + '/prices/check', fail_check)
                await page.route('**/api/items/' + item['id'] + '/prices', with_failed_check)
                await panel.get_by_role('button', name='Check price', exact=True).click()
                await expect(panel.get_by_role('spinbutton', name='Price (USD)', exact=True)).to_be_visible()
                await expect(panel.locator('.price-check-note')).to_contain_text('Direct check failed')
                await expect(panel.locator('.price-check-note')).to_contain_text(failure['error'])
                await expect(panel.locator('.tracked-price-value')).to_have_text('US$149.95')
                await expect(panel.get_by_role('alert')).not_to_be_visible()
                await expect(panel.get_by_role('link', name='View product')).to_have_attribute('href', item['data']['productUrl'])
                await panel.get_by_role('spinbutton', name='Price (USD)', exact=True).fill('139.95')
                await panel.get_by_role('button', name='Save price', exact=True).click()
                await expect(panel.locator('.tracked-price-value')).to_have_text('US$139.95')
                await expect(panel.locator('.tracked-price-date')).to_contain_text('Recorded price')
                await expect(panel.locator('.price-check-note')).to_contain_text('Direct check failed')
                await panel.evaluate("el => { const drawer=el.closest('dialog'); drawer.scrollTop += el.getBoundingClientRect().top-drawer.getBoundingClientRect().top-drawer.querySelector('.drawer-top').offsetHeight-12; }")
                assert await panel.evaluate('(el) => el.scrollWidth <= el.clientWidth')
                await page.screenshot(path=output / ('price-check-recovery-' + device + '.png'), full_page=True)
                await page.unroute('**/api/items/' + item['id'] + '/prices/check', fail_check)
                await page.unroute('**/api/items/' + item['id'] + '/prices', with_failed_check)
                # Bought items retain history and stop offering checks or recording.
                await page.get_by_role('button', name='Mark as bought', exact=True).click()
                await page.locator('#item-form').get_by_label('Price paid per item', exact=True).fill('140.00')
                await page.get_by_role('button', name='Save purchase', exact=True).click()
                await expect(page.locator('#editor')).not_to_be_visible()
                await expect(panel.locator('.tracked-price-value')).to_have_text('US$139.95')
                await expect(panel.get_by_role('button', name='Check price', exact=True)).to_have_count(0)
                await expect(panel.get_by_text('Record a price', exact=True)).to_have_count(0)
                print('PASS ' + device + ': records, trend, graph, history, failed save, failed check, recovery, purchase, and layout', flush=True)
                await context.close()
            assert not errors, errors
        finally:
            for item_id in ids:
                response = await api.get('/api/items/' + item_id)
                if response.status == 200:
                    current = await response.json()
                    assert (await api.delete('/api/items/' + item_id, data={'revision': current['revision']})).status == 200
            await api.dispose()
            await browser.close()


asyncio.run(main())
