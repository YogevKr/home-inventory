import asyncio, os, re
from pathlib import Path
from uuid import uuid4
from playwright.async_api import async_playwright, expect

origin = os.environ.get('TEST_URL', 'http://127.0.0.1:8797')
if not re.fullmatch(r'http://(127\.0\.0\.1|localhost):[0-9]+', origin):
    raise ValueError('Browser checks require a local server.')
root = Path(__file__).resolve().parent.parent
output = root / 'test-results'
output.mkdir(exist_ok=True)


async def main():
    async with async_playwright() as p:
        browser = await p.webkit.launch()
        api = await p.request.new_context(base_url=origin)
        items, errors = [], []
        try:
            for device, options in [
                ('desktop', {'viewport': {'width': 1280, 'height': 1000}}),
                ('narrow', {'viewport': {'width': 320, 'height': 700}, 'is_mobile': True, 'has_touch': True}),
                ('iphone', p.devices['iPhone 13']),
            ]:
                context = await browser.new_context(**options)
                page = await context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                name = 'Reading lamp ' + uuid4().hex[:8]
                await page.goto(origin)
                await page.get_by_role('button', name='Wishlist', exact=True).click()
                await expect(page.locator('#title')).to_have_text('Your wishlist.')
                await expect(page.locator('.collection-summary')).not_to_be_visible()
                await expect(page.locator('#sort option[value="purchaseDate:desc"]')).to_have_count(0)
                await page.locator('.page-heading').get_by_role('button', name='Add to wishlist').click()
                form = page.locator('#item-form')
                await expect(form.get_by_role('combobox', name='Status', exact=True)).to_have_value('wishlist')
                await expect(form.get_by_label('Purchase date', exact=True)).not_to_be_visible()
                await form.get_by_label('Item name *', exact=True).fill(name)
                await form.get_by_label('Description', exact=True).fill('Choose the warm light version.')
                await form.get_by_label('Store', exact=True).fill('Example store')
                await form.get_by_label('Expected price per item', exact=True).fill('89.00')
                await form.get_by_role('combobox', name='Currency', exact=True).select_option('USD')
                await form.get_by_label('Product link', exact=True).fill('https://example.com/lamp')
                await form.get_by_label('Item photo', exact=True).set_input_files(root / 'tests/fixtures/safari-canvas.jpg')
                await form.get_by_role('button', name='Add to wishlist', exact=True).click()
                await expect(page.locator('#editor')).not_to_be_visible()
                result = await (await api.get('/api/items', params={'status': 'wishlist', 'q': name})).json()
                assert result['total'] == 1
                item = result['items'][0]
                items.append(item['id'])
                await page.get_by_role('searchbox', name='Search items').fill(name)
                await expect(page.locator('.item-card')).to_have_count(1)
                await expect(page.locator('.card-name')).to_have_text(name)
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                await page.screenshot(path=output / f'wishlist-{device}.png', full_page=True)
                await page.get_by_role('button', name='Open ' + name, exact=True).click()
                await expect(page.locator('#detail').get_by_text('Expected price', exact=True)).to_be_visible()
                await expect(page.locator('#detail-image')).to_be_visible()
                await page.screenshot(path=output / f'wishlist-detail-{device}.png', full_page=True)
                if device == 'desktop':
                    await page.get_by_role('button', name='Edit item', exact=True).click()
                    await form.get_by_role('combobox', name='Status', exact=True).select_option('active')
                    await expect(form.get_by_label('Price paid per item', exact=True)).to_have_value('')
                    await form.get_by_role('button', name='Cancel', exact=True).click()
                await page.get_by_role('button', name='Mark as bought', exact=True).click()
                await expect(form.get_by_label('Price paid per item', exact=True)).to_have_value('')
                await expect(form.get_by_label('Purchase date', exact=True)).not_to_have_value('')
                await form.get_by_role('button', name='Cancel', exact=True).click()
                current = await (await api.get('/api/items/' + item['id'])).json()
                assert current['data']['status'] == 'wishlist'
                assert current['data']['priceMinor'] == 8900

                if device == 'desktop':
                    await page.get_by_role('button', name='Archive this item', exact=True).click()
                    await expect(page.get_by_role('button', name='Restore to wishlist', exact=True)).to_be_visible()
                    await page.get_by_role('button', name='Restore to wishlist', exact=True).click()
                    await expect(page.get_by_role('button', name='Mark as bought', exact=True)).to_be_visible()

                await page.get_by_role('button', name='Mark as bought', exact=True).click()
                await form.get_by_label('Price paid per item', exact=True).fill('75.00')
                if device == 'iphone':
                    async def fail_update(route):
                        if route.request.method == 'PUT':
                            await route.fulfill(status=503, json={'error': 'Temporary purchase failure'})
                        else:
                            await route.continue_()
                    await page.route('**/api/items/' + item['id'], fail_update)
                    await form.get_by_role('button', name='Save purchase', exact=True).click()
                    await expect(form.get_by_role('alert')).to_have_text('Temporary purchase failure')
                    assert (await (await api.get('/api/items/' + item['id'])).json())['data']['status'] == 'wishlist'
                    await page.unroute('**/api/items/' + item['id'], fail_update)
                await form.get_by_role('button', name='Save purchase', exact=True).click()
                await expect(page.locator('#editor')).not_to_be_visible()
                current = await (await api.get('/api/items/' + item['id'])).json()
                assert current['data']['status'] == 'active'
                assert current['data']['priceMinor'] == 7500
                assert current['data']['description'] == 'Choose the warm light version.'
                assert current['attachments'][0]['kind'] == 'photo'
                await page.get_by_role('button', name='Close details', exact=True).click()
                await expect(page.locator('.item-card')).to_have_count(0)
                await page.get_by_role('button', name='Collection', exact=True).click()
                await page.get_by_role('searchbox', name='Search items').fill(name)
                await expect(page.locator('.card-name')).to_have_text(name)
                print(f'PASS {device}: create, photo, layout, purchase cancellation, conversion, and retained details', flush=True)
                await context.close()
            assert not errors, errors
        finally:
            for item_id in items:
                response = await api.get('/api/items/' + item_id)
                if response.status == 200:
                    current = await response.json()
                    deleted = await api.delete('/api/items/' + item_id, data={'revision': current['revision']})
                    assert deleted.status == 200
            await api.dispose()
            await browser.close()


asyncio.run(main())
