import { test as base, expect, type Page } from '@playwright/test';

// No development imports, storage injection, or network mocking: exercise dist as shipped.
const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await use();
    expect(errors, 'Unexpected production browser console/page errors').toEqual([]);
  }, { auto: true }],
});

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Основная навигация' })
    .getByRole('button', { name, exact: true }).click();
}

async function readyForOffline(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload();
  }
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  await expect.poll(() => page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.includes('precache'));
    const cachedPaths = new Set<string>();
    for (const name of names) {
      for (const request of await (await caches.open(name)).keys()) {
        cachedPaths.add(new URL(request.url).pathname);
      }
    }
    const assets = [
      ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'), element => new URL(element.src).pathname),
      ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'), element => new URL(element.href).pathname),
    ];
    return assets.length > 0 && assets.every(path => /^\/assets\/.+[-.].+\.(js|css)$/.test(path) && cachedPaths.has(path))
      && cachedPaths.has('/index.html');
  }), { message: 'Built HTML and hashed JS/CSS must be fully precached before disconnecting' }).toBe(true);
}

test('production manifest has install metadata, fetchable start URL/icons, and an active service worker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Большое начинается с первого подхода' })).toBeVisible();
  const metadata = await page.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) throw new Error('Missing manifest link');
    const response = await fetch(link.href);
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    const manifest = await response.json();
    const start = new URL(manifest.start_url, link.href);
    const startResponse = await fetch(start);
    const icons = [];
    for (const icon of manifest.icons) {
      const response = await fetch(new URL(icon.src, link.href));
      if (!response.ok) throw new Error(`Icon HTTP ${response.status}: ${icon.src}`);
      const bitmap = await createImageBitmap(await response.blob());
      icons.push({ ...icon, width: bitmap.width, height: bitmap.height });
      bitmap.close();
    }
    return { manifest, icons, startStatus: startResponse.status, startOrigin: start.origin, origin: location.origin };
  });
  expect(metadata.manifest).toMatchObject({
    name: expect.stringContaining('Feetnessy'), short_name: 'Feetnessy',
    start_url: '/', scope: '/', display: 'standalone', lang: 'ru',
    theme_color: expect.stringMatching(/^#[\da-f]{6}$/i),
    background_color: expect.stringMatching(/^#[\da-f]{6}$/i),
  });
  expect(metadata.startStatus).toBe(200);
  expect(metadata.startOrigin).toBe(metadata.origin);
  for (const size of [192, 512]) {
    expect(metadata.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: `${size}x${size}`, type: 'image/png', width: size, height: size }),
    ]));
  }
  expect(metadata.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ purpose: 'maskable', width: 512, height: 512 }),
  ]));
  await readyForOffline(page);
  expect(await page.evaluate(() => new URL(navigator.serviceWorker.controller!.scriptURL).pathname)).toBe('/sw.js');
});

test('production cold offline navigation retains a real program, edits, completion, and history', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Большое начинается с первого подхода' })).toBeVisible();
  await page.getByRole('button', { name: 'Создать программу', exact: true }).click();
  await page.getByRole('button', { name: 'Создать программу', exact: true }).click();
  await page.getByLabel('Название программы', { exact: true }).fill('Офлайн программа');
  await page.getByRole('button', { name: 'Добавить тренировку', exact: true }).click();
  await page.getByLabel('Название тренировки', { exact: true }).fill('Офлайн тренировка');
  await page.getByRole('button', { name: 'Добавить упражнение', exact: true }).click();
  await page.getByRole('textbox', { name: 'Упражнение 1', exact: true }).fill('Приседания');
  await page.getByLabel('Вес, кг, упражнение 1, подход 1', { exact: true }).fill('40');
  await page.getByLabel('Повторы, упражнение 1, подход 1', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Офлайн программа', exact: true })).toBeVisible();
  await navigate(page, 'Тренировка');
  await expect(page.getByRole('heading', { name: 'Офлайн тренировка', exact: true })).toBeVisible();
  await readyForOffline(page);

  await context.setOffline(true);
  // Discard the current document, so in-memory React state cannot satisfy the assertions.
  await page.goto('about:blank');
  const response = await page.goto('/');
  expect(response?.fromServiceWorker(), 'Cold offline navigation must be served by the production worker').toBe(true);
  await expect(page.getByRole('heading', { name: 'Офлайн тренировка', exact: true })).toBeVisible();
  await navigate(page, 'Программы');
  await expect(page.getByRole('heading', { name: 'Офлайн программа', exact: true })).toBeVisible();
  await navigate(page, 'Тренировка');
  await page.getByRole('button', { name: 'Изменить Приседания', exact: true }).click();
  await page.getByLabel('Вес, подход 1', { exact: true }).fill('42,5');
  await expect(page.getByText('Изменения сохранены на этом телефоне')).toBeVisible();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Изменить Приседания', exact: true })).toContainText('42,5');
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Сохранить новые значения?' });
  await confirmation.getByRole('checkbox', { name: 'Использовать изменения в следующих тренировках' }).uncheck();
  await confirmation.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await navigate(page, 'История');
  await expect(page.getByRole('button').filter({ hasText: 'Офлайн тренировка' })).toHaveCount(1);
  await page.reload();
  await navigate(page, 'История');
  const entry = page.getByRole('button').filter({ hasText: 'Офлайн тренировка' });
  await expect(entry).toHaveCount(1);
  await entry.click();
  const history = page.getByRole('dialog', { name: 'Офлайн тренировка', exact: true });
  await expect(history.getByRole('heading', { name: 'Приседания', exact: true })).toBeVisible();
  await expect(history.locator('.weight-readonly')).toHaveText('42,5 кг');
  await expect(history.getByText('1 × 8 повторов', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
});
