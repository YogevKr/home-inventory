import asyncio, json, os, re
from uuid import uuid4
from pathlib import Path
from zipfile import ZipFile
from playwright.async_api import async_playwright, expect

origin=os.environ.get('TEST_URL','http://127.0.0.1:8797')
if not re.fullmatch(r'http://(127\.0\.0\.1|localhost):[0-9]+',origin):
    raise ValueError('Browser checks require a local server.')
root=Path(__file__).resolve().parent.parent
output=root/'test-results'
output.mkdir(exist_ok=True)
marker='Browser check '+uuid4().hex[:8]
async def main():
    async with async_playwright() as p:
        browser=await p.webkit.launch(headless=True)
        context=await browser.new_context(**p.devices['iPhone 13'])
        api=context.request
        items=[]; links=[]; errors=[]
        try:
            for i in range(125):
                r=await api.post(origin+'/api/items',data={'data':{'name':f'{marker} {i:03}', 'brand':'Example', 'model':f'Model {i}', 'description':'PRIVATE_TEST_NOTE','priceMinor':1000+i,'currency':'USD'}})
                assert r.status==201
                items.append(await r.json())
            image=(root/'tests/fixtures/safari-canvas.jpg').read_bytes()
            for item in items[:2]:
                r=await api.post(origin+'/api/items/'+item['id']+'/attachments',multipart={'kind':'photo','file':{'name':'test.jpg','mimeType':'image/jpeg','buffer':image}})
                assert r.status==201
            page=await context.new_page(); page.on('pageerror',lambda error:errors.append(str(error)))
            await page.goto(origin+'/?collection-iphone=1')
            await page.get_by_role('searchbox').fill(marker)
            await page.get_by_label('Sort items',exact=True).select_option('name:asc')
            await expect(page.locator('.item-card')).to_have_count(120)
            for index,has_photo in [(0,True),(2,False)]:
                await page.get_by_role('button',name=f'Open {marker} {index:03}',exact=True).click()
                await page.get_by_role('button',name='Edit item',exact=True).click()
                editor=page.get_by_role('dialog',name='Edit item',exact=True)
                if has_photo:
                    photo=editor.get_by_role('img',name=f'Current photo of {marker} {index:03}',exact=True)
                    await expect(photo).to_be_visible()
                    await photo.evaluate('image=>image.decode()')
                    await expect(editor.get_by_text('Add another photo',exact=True)).to_be_visible()
                else:
                    assert not await editor.get_by_role('img').count()
                    await expect(editor.get_by_text('Add a photo',exact=True)).to_be_visible()
                await expect(editor.get_by_label('Item photo',exact=True)).to_be_enabled()
                await page.get_by_role('button',name='Close editor',exact=True).click()
                await page.get_by_role('button',name='Close details',exact=True).click()
            print('PASS iPhone editor shows the current photo and clears it for items without photos',flush=True)
            await page.get_by_role('button',name='Filters',exact=True).click()
            await page.get_by_role('button',name='No photo',exact=True).click()
            await expect(page.locator('.result-count')).to_have_text('123 products · 123 purchases')
            assert not await page.locator('.card-photo img').count()
            await page.get_by_role('button',name='Filters · 1',exact=True).click()
            await expect(page.locator('#collection-filters')).to_be_hidden()
            await page.get_by_role('button',name='Remove no photo filter',exact=True).click()
            await expect(page.locator('.result-count')).to_have_text('125 products · 125 purchases')
            await page.get_by_role('button',name='List view',exact=True).click()
            await page.get_by_role('button',name=f'Share {marker} 000',exact=True).click()
            await page.get_by_role('button',name='Create share link').wait_for()
            assert not await page.locator('#detail').is_visible()
            await page.get_by_role('button',name='Close sharing',exact=True).click()
            await page.get_by_role('button',name='Grid view',exact=True).click()
            await page.get_by_role('button',name=f'Share {marker} 000',exact=True).click()
            await page.get_by_role('button',name='Preview',exact=True).click()
            await page.get_by_text('Only these details will appear',exact=True).wait_for()
            assert not await page.locator('#detail').is_visible()
            await page.get_by_role('button',name='Create share link').click()
            await page.get_by_text('Your page is ready',exact=True).wait_for()
            single=await page.locator('#share-url').input_value(); links.append(single)
            html=await (await api.get(single)).text()
            assert f'<meta property="og:image" content="{single}/photo">' in html
            await page.get_by_role('button',name='Revoke link',exact=True).click()
            await page.get_by_role('button',name='Create share link').wait_for()
            await page.get_by_role('button',name='Close sharing',exact=True).click()
            print('PASS iPhone card Share creates a photo page without opening details',flush=True)
            await page.get_by_label('Collection actions',exact=True).click()
            await page.keyboard.press('Escape')
            await expect(page.get_by_role('button',name='Select items',exact=True)).to_be_hidden()
            await page.get_by_label('Collection actions',exact=True).click()
            await page.get_by_role('button',name='Select items',exact=True).click()
            for i in range(25):
                await page.get_by_role('button',name=f'Select {marker} {i:03}',exact=True).last.click()
            assert await page.locator('.card-select[aria-pressed=true]').count()==25
            await expect(page.locator('.selection-bar [role=status]')).to_have_text('25 selected')
            await page.screenshot(path=output/'collection-selection-iphone.png',full_page=False)
            # Start loading before the manual paging button enters the viewport.
            await page.evaluate("document.documentElement.style.scrollBehavior='auto'; window.scrollTo(0,document.querySelector('.load-more').getBoundingClientRect().top+scrollY-innerHeight-500)")
            await expect(page.locator('.item-card')).to_have_count(125,timeout=10000)
            assert await page.locator('.card-select[aria-pressed=true]').count()==25
            ids=await page.locator('.card-open').evaluate_all('(nodes)=>nodes.map(node=>node.dataset.item)')
            assert len(set(ids))==125
            assert ids==[item['id'] for item in items]
            assert await page.locator('.load-more').count()==0
            print('PASS iPhone automatic pagination loads 125 unique ordered items and preserves selection',flush=True)
            await page.get_by_role('button',name='Share selected',exact=False).click()
            await page.get_by_label('Collection title',exact=True).fill('')
            await page.get_by_role('button',name='Preview',exact=True).click()
            await page.get_by_role('button',name='Create share link').click()
            await expect(page.get_by_label('Collection title',exact=True)).to_be_visible()
            await page.get_by_label('Collection title',exact=True).fill('Weekend camera kit')
            await page.get_by_role('button',name='Preview',exact=True).click()
            await page.get_by_text('Only these details will appear',exact=True).wait_for()
            preview=page.frame_locator('#share-preview')
            await preview.get_by_role('heading',name='Weekend camera kit',exact=True).wait_for()
            assert await preview.locator('.collection-entry').count()==25
            await page.get_by_role('button',name='Create share link').click()
            await page.get_by_text('Your page is ready',exact=True).wait_for()
            shared=await page.locator('#share-url').input_value(); links.append(shared)
            public=await context.new_page(); await public.goto(shared)
            assert await public.locator('img').evaluate_all("images=>images.every(image=>image.complete&&image.naturalWidth>0)")
            assert await public.locator('.collection-entry').count()==25
            assert not await public.get_by_text('Details selected by the owner.',exact=True).count()
            assert 'PRIVATE_' not in await public.content()
            assert await public.evaluate('document.documentElement.scrollWidth<=innerWidth')
            await public.screenshot(path=output/'collection-public-iphone.png',full_page=True)
            await public.close()
            await page.get_by_role('button',name='Close sharing',exact=True).click()
            await page.get_by_label('Collection actions',exact=True).click()
            await page.get_by_role('button',name='Shared collections',exact=True).click()
            await page.get_by_role('button',name='Weekend camera kit Manage link',exact=False).click()
            assert await page.locator('#share-url').input_value()==shared
            await page.get_by_role('button',name='Revoke link',exact=True).click()
            await page.get_by_role('heading',name='Shared collections',exact=True).wait_for()
            assert (await api.get(shared)).status==404
            assert (await api.get(shared+'/photo/0')).status==404
            print('PASS iPhone sharing 25 items, preview, JPEG photos, saved link management, and revocation',flush=True)
            await page.get_by_role('button',name='Close sharing',exact=True).click()
            failures=[]
            async def fail_once(route):
                failures.append(route.request.url)
                if len(failures)==1: await route.fulfill(status=503,content_type='application/json',body='{"error":"Temporary test failure"}')
                else: await route.continue_()
            await page.route('**/api/items?*offset=120*',fail_once)
            await page.reload()
            await page.get_by_role('searchbox').fill(marker)
            await page.get_by_label('Sort items',exact=True).select_option('name:asc')
            await expect(page.locator('.item-card')).to_have_count(120)
            await page.evaluate("document.documentElement.style.scrollBehavior='auto'; window.scrollTo(0,document.querySelector('.load-more').getBoundingClientRect().top+scrollY-innerHeight-500)")
            await page.get_by_text('Temporary test failure',exact=True).wait_for()
            await page.wait_for_timeout(1000)
            assert len(failures)==1,failures
            assert await page.evaluate('scrollY')>10000, 'Paging moved the scroll position'
            await expect(page.get_by_role('button',name='Load more items',exact=True)).to_be_enabled()
            await page.get_by_role('button',name='Load more items',exact=True).scroll_into_view_if_needed()
            await page.get_by_role('button',name='Load more items',exact=True).click(timeout=5000)
            await expect(page.locator('.item-card')).to_have_count(125)
            print('PASS iPhone pagination stops after errors and supports manual retry',flush=True)

            async with page.expect_download() as pending:
                await page.get_by_role('button',name=re.compile(r'^Export collection')).click()
            download=await pending.value
            assert re.fullmatch(r'home-inventory-\d{4}-\d{2}-\d{2}\.zip',download.suggested_filename)
            with ZipFile(await download.path()) as archive:
                exported=json.loads(archive.read('inventory.json'))
                assert exported['format']=='home-inventory-v1'
                assert all(item['id'] in {record['id'] for record in exported['items']} for item in items)
                for item in items[:2]:
                    attachment=next(file for file in exported['attachments'] if file['item_id']==item['id'])
                    assert archive.read(f"files/{attachment['id']}/test.jpg")==image
            print('PASS iPhone ZIP uses project names and preserves records and photo bytes',flush=True)

            print('PASS iPhone filters, list sharing, menu dismissal, and mobile form validation',flush=True)
            assert not errors,errors
        except Exception:
            print('Failure page',await page.evaluate("({y:scrollY,active:document.activeElement?.id,count:document.querySelectorAll('.item-card').length,button:document.querySelector('.load-more')?.getBoundingClientRect().top})"),flush=True)
            await page.screenshot(path=output/'paging-error.png')
            raise
        finally:
            for item in items:
                await api.delete(origin+'/api/items/'+item['id'],data={'revision':1})
            await browser.close()
asyncio.run(main())
