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
        name = 'Inbox browser check ' + uuid4().hex[:8]
        try:
            for day in ['30', '31']:
                response = await api.post('/api/items', data={'data': {
                    'name': name, 'status': 'inbox', 'purchaseDate': '2099-12-' + day,
                    'seller': 'Example store', 'priceMinor': 2500, 'currency': 'USD',
                }})
                assert response.status == 201
                items.append(await response.json())
            photo = (root / 'tests/fixtures/safari-canvas.jpg').read_bytes()
            for item in items:
                response = await api.post('/api/items/' + item['id'] + '/attachments', multipart={
                    'kind': 'photo', 'file': {'name': 'test.jpg', 'mimeType': 'image/jpeg', 'buffer': photo},
                })
                assert response.status == 201

            for device, options in [
                ('desktop', {'viewport': {'width': 1280, 'height': 1000}}),
                ('narrow', {'viewport': {'width': 320, 'height': 700}, 'is_mobile': True, 'has_touch': True}),
                ('iphone', p.devices['iPhone 13']),
            ]:
                context = await browser.new_context(**options)
                page = await context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                await page.goto(origin)
                await page.get_by_role('button', name=re.compile(r'^Inbox\s*\d*$')).click()
                await expect(page.locator('#review-name')).to_have_text(name)
                await expect(page.get_by_text('2 purchases', exact=True)).to_be_visible()
                delete = page.get_by_role('button', name='Delete purchase', exact=True)
                await expect(delete).to_be_enabled()
                await delete.scroll_into_view_if_needed()
                assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                boxes = [await page.locator(selector).bounding_box() for selector in [
                    '[data-review=undo]', '.review-secondary>span', '[data-review=archive]', '[data-review=delete]',
                ]]
                assert all(left['x'] + left['width'] <= right['x'] + 1 for left, right in zip(boxes, boxes[1:]))
                await page.screenshot(path=output / f'inbox-delete-{device}.png', full_page=True)
                await delete.click()
                dialog = page.get_by_role('dialog', name='Delete this purchase?', exact=True)
                await expect(dialog.get_by_text('Other purchases of this product will remain.', exact=True)).to_be_visible()
                await expect(dialog.get_by_role('button', name='Cancel', exact=True)).to_be_focused()
                selected = await dialog.locator('form').get_attribute('data-item-id')
                sibling = next(item['id'] for item in items if item['id'] != selected)
                await dialog.get_by_role('button', name='Cancel', exact=True).click()
                assert (await api.get('/api/items/' + selected)).status == 200
                await delete.click()
                await expect(dialog).to_be_visible()
                await page.keyboard.press('Escape')
                await expect(dialog).not_to_be_visible()
                assert (await api.get('/api/items/' + selected)).status == 200
                print(f'PASS {device}: Delete layout, confirmation, Cancel, and Escape', flush=True)

                if device == 'iphone':
                    await delete.click()
                    async def fail_delete(route):
                        if route.request.method == 'DELETE':
                            await route.fulfill(status=503, json={'error': 'Temporary delete failure'})
                        else:
                            await route.continue_()
                    await page.route('**/api/items/' + selected, fail_delete)
                    await dialog.get_by_role('button', name='Delete permanently', exact=True).click()
                    await expect(dialog.get_by_role('alert')).to_have_text('Temporary delete failure')
                    assert (await api.get('/api/items/' + selected)).status == 200
                    await expect(page.locator('#review-name')).to_have_text(name)
                    await page.unroute('**/api/items/' + selected, fail_delete)

                    current = await (await api.get('/api/items/' + selected)).json()
                    changed = await api.put('/api/items/' + selected, data={
                        'revision': current['revision'], 'data': {**current['data'], 'description': 'A newer edit'},
                    })
                    assert changed.status == 200
                    await dialog.get_by_role('button', name='Delete permanently', exact=True).click()
                    await expect(dialog.get_by_role('alert')).to_be_visible()
                    await expect(dialog.get_by_role('alert')).not_to_have_text('Temporary delete failure')
                    saved = await (await api.get('/api/items/' + selected)).json()
                    assert saved['data']['description'] == 'A newer edit'
                    await dialog.get_by_role('button', name='Cancel', exact=True).click()
                    await delete.click()
                    await dialog.get_by_role('button', name='Delete permanently', exact=True).click()
                    await expect(dialog).not_to_be_visible()
                    await expect(page.get_by_text('1 purchase', exact=True)).to_be_visible()
                    assert (await api.get('/api/items/' + selected)).status == 404
                    assert (await api.get('/api/items/' + sibling)).status == 200
                    await page.get_by_role('button', name='Delete item', exact=True).click()
                    single = page.get_by_role('dialog', name='Delete this item?', exact=True)
                    await single.get_by_role('button', name='Delete permanently', exact=True).click()
                    await expect(single).not_to_be_visible()
                    await expect(page.locator('#review-name').filter(has_text=name)).to_have_count(0)
                    assert (await api.get('/api/items/' + sibling)).status == 404
                    print('PASS iPhone: errors, revision conflict, single-purchase deletion, and inbox refresh', flush=True)
                    await page.goto(origin + '/?sample=1')
                    await page.get_by_role('button', name='Inbox', exact=True).click()
                    await expect(page.locator('.review-card')).to_be_visible()
                    await expect(page.get_by_role('button', name=re.compile(r'^Delete'))).to_have_count(0)
                await context.close()
            assert not errors, errors
        finally:
            for item in items:
                response = await api.get('/api/items/' + item['id'])
                if response.status == 200:
                    current = await response.json()
                    result = await api.delete('/api/items/' + item['id'], data={'revision': current['revision']})
                    assert result.status == 200
            await api.dispose()
            await browser.close()


asyncio.run(main())
