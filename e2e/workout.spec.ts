import { readFile } from 'node:fs/promises';
import { test as base, expect, type Page } from '@playwright/test';
import type { AppState } from '../src/domain';

// Install before navigation so startup failures are included, not just interaction errors.
const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({ page, context }, use) => {
    const errors: string[] = [];
    const collectErrors = (target: Page) => {
      target.on('pageerror', error => errors.push(error.message));
      target.on('console', message => {
        if (message.type() === 'error') errors.push(message.text());
      });
    };
    collectErrors(page);
    context.on('page', collectErrors);
    await use();
    context.off('page', collectErrors);
    expect(errors, 'Unexpected browser console/page errors').toEqual([]);
  }, { auto: true }],
});

function fixture(): AppState {
  return {
    schemaVersion: 1,
    activeProgramId: 'program',
    programs: [{
      id: 'program', name: 'Силовая программа', nextWorkoutId: 'a',
      workouts: [
        { id: 'a', name: 'Тренировка А', exercises: [{ id: 'squat', name: 'Приседания со штангой', sets: [{ weightKg: 40, reps: 8 }] }] },
        { id: 'b', name: 'Тренировка Б', exercises: [{ id: 'press', name: 'Жим лёжа', sets: [{ weightKg: 30, reps: 10 }] }] },
      ],
    }],
    drafts: [], history: [],
  };
}

async function storedState(page: Page): Promise<AppState> {
  return page.evaluate(async () => {
    const path = '/src/storage.ts';
    const storage = await import(/* @vite-ignore */ path);
    return storage.loadState();
  });
}

async function seed(page: Page, state = fixture()) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Создать программу', exact: true })).toBeVisible();
  await page.evaluate(async state => {
    const path = '/src/storage.ts';
    const storage = await import(/* @vite-ignore */ path);
    // Vite may serve a separate module instance after HMR; initialize its revision before seeding.
    await storage.loadState();
    await storage.replaceState(state);
  }, state);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Тренировка А', exact: true })).toBeVisible();
}

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('button', { name, exact: true }).click();
}

async function openBackup(page: Page) {
  await navigate(page, 'Программы');
  await page.getByRole('button', { name: 'Экспорт и импорт' }).click();
  return page.getByRole('dialog', { name: 'Резервная копия', exact: true });
}

async function noOverflow(page: Page) {
  // Check element bounds too: overflow-x:hidden alone must not hide clipped controls.
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return {
      document: document.documentElement.scrollWidth - width,
      controls: [...document.querySelectorAll<HTMLElement>('button, input, article, form, dialog[open]')]
        .filter(element => element.getClientRects().length > 0)
        .filter(element => {
          const bounds = element.getBoundingClientRect();
          return bounds.left < -1 || bounds.right > width + 1;
        })
        .map(element => element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80)),
    };
  });
  expect(overflow.document, 'Document must not scroll horizontally').toBeLessThanOrEqual(1);
  expect(overflow.controls, 'Visible controls/cards must fit the viewport').toEqual([]);
}

test('create two workouts, autosave a comma decimal, and carry the weight into the next workout', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Большое начинается с первого подхода' })).toBeVisible();
  await page.getByRole('button', { name: 'Создать программу', exact: true }).click();
  await page.getByRole('button', { name: 'Создать программу', exact: true }).click();
  await page.getByLabel('Название программы', { exact: true }).fill('Мой план');

  for (const workout of [
    { name: 'Тренировка А', exercise: 'Приседания', weight: '40', reps: '8' },
    { name: 'Тренировка Б', exercise: 'Жим лёжа', weight: '30', reps: '10' },
  ]) {
    await page.getByRole('button', { name: 'Добавить тренировку', exact: true }).click();
    await page.getByLabel('Название тренировки', { exact: true }).fill(workout.name);
    await page.getByRole('button', { name: 'Добавить упражнение', exact: true }).click();
    await page.getByRole('textbox', { name: 'Упражнение 1', exact: true }).fill(workout.exercise);
    await page.getByLabel('Вес, кг, упражнение 1, подход 1', { exact: true }).fill(workout.weight);
    await page.getByLabel('Повторы, упражнение 1, подход 1', { exact: true }).fill(workout.reps);
  }
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Мой план', exact: true })).toBeVisible();
  await navigate(page, 'Тренировка');
  await expect(page.getByRole('heading', { name: 'Тренировка А', exact: true })).toBeVisible();
  const before = await storedState(page);
  const original = before.programs[0].workouts[0];

  await page.getByRole('button', { name: 'Изменить Приседания', exact: true }).click();
  await page.getByLabel('Вес, подход 1', { exact: true }).fill('42,5');
  await expect.poll(async () => (await storedState(page)).drafts[0]?.exercises[0].sets[0].weightKg).toBe(42.5);
  await expect(page.getByText('Изменения сохранены на этом телефоне')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Завершить тренировку', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Изменить Приседания', exact: true })).toContainText('42,5');
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить новые значения?' });
  await dialog.getByRole('checkbox', { name: 'Также сохранить изменения повторов и количества подходов' }).uncheck();
  await dialog.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();

  const completed = await storedState(page);
  expect(completed.programs[0].workouts[0]).toEqual({ ...original, exercises: [{ ...original.exercises[0], sets: [{ weightKg: 42.5, reps: 8 }] }] });
  expect(completed.drafts).toEqual([]);
  expect(completed.history).toHaveLength(1);
  expect(completed.history[0]).toMatchObject({
    programId: before.programs[0].id, workoutId: original.id,
    programName: 'Мой план', workoutName: 'Тренировка А',
    exercises: [{ ...original.exercises[0], sets: [{ weightKg: 42.5, reps: 8 }] }],
  });
  await navigate(page, 'История');
  await page.getByRole('button').filter({ hasText: 'Тренировка А' }).click();
  const history = page.getByRole('dialog', { name: 'Тренировка А', exact: true });
  await expect(history.getByRole('heading', { name: 'Приседания', exact: true })).toBeVisible();
  await expect(history.locator('.weight-readonly')).toHaveText('42,5 кг');
  await expect(history.getByText('1 × 8 повторов', { exact: true })).toBeVisible();
  await expect(history.getByRole('button', { name: /^Изменить/ })).toHaveCount(0);
  await history.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await navigate(page, 'Тренировка');
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка А', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Изменить Приседания', exact: true })).toContainText('42,5');
  expect((await storedState(page)).history.find(entry => entry.workoutId === original.id)).toEqual(completed.history[0]);
});

test('last edited weight applies to every set next time, including a decrease after an increase', async ({ page }) => {
  const initial = fixture();
  initial.programs[0].workouts = [initial.programs[0].workouts[0]];
  initial.programs[0].workouts[0].exercises[0].sets = [8, 10, 12].map(reps => ({ weightKg: 40, reps }));
  await seed(page, initial);
  for (const [index, weightKg] of [45, 35].entries()) {
    await page.getByRole('button', { name: 'Изменить Приседания со штангой', exact: true }).click();
    // The decrease is edited in the first set: the last set still has the higher weight.
    await page.getByLabel(`Вес, подход ${index === 0 ? 3 : 1}`, { exact: true }).fill(String(weightKg));
    await expect.poll(async () => (await storedState(page)).drafts[0]?.nextWeights?.[0]?.weightKg).toBe(weightKg);
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Сохранить новые значения?' });
    await dialog.getByRole('checkbox').uncheck();
    await dialog.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const completed = await storedState(page);
    expect(completed.programs[0].workouts[0].exercises[0].sets).toEqual([8, 10, 12].map(reps => ({ weightKg, reps })));
    expect(completed.history.at(-1)!.exercises[0].sets.map(s => s.weightKg)).toEqual(index === 0 ? [40, 40, 45] : [35, 45, 45]);
    await page.reload();
  }
});

test('undo restores the exact queue, draft, and history and survives reload', async ({ page }) => {
  const initial = fixture();
  initial.drafts = [{ programId: 'program', workoutId: 'a', exercises: [{ ...initial.programs[0].workouts[0].exercises[0], sets: [{ weightKg: 45, reps: 6 }] }], updatedAt: '2026-01-01T00:00:00.000Z' }];
  await seed(page, initial);
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  await page.getByRole('status').getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка А', exact: true })).toBeVisible();
  expect(await storedState(page)).toEqual(initial);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Изменить Приседания со штангой', exact: true })).toContainText('45');
  expect(await storedState(page)).toEqual(initial);
});

test('backup download contains all saved data; malformed and invalid imports preserve it', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  const before = await storedState(page);
  const dialog = await openBackup(page);
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать копию', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^feetnessy-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await download.path();
  expect(path).not.toBeNull();
  const backup = JSON.parse(await readFile(path!, 'utf8'));
  expect(backup).toEqual({ format: 'feetnessy', version: 1, exportedAt: expect.any(String), data: before });
  expect(Number.isFinite(Date.parse(backup.exportedAt))).toBe(true);

  for (const contents of ['{broken JSON', JSON.stringify({ ...backup, data: { ...before, activeProgramId: 'missing' } })]) {
    await dialog.getByLabel('Файл резервной копии').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(contents) });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Заменить текущие данные', exact: true })).toHaveCount(0);
    expect(await storedState(page)).toEqual(before);
  }
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  expect(await storedState(page)).toEqual(before);
});

test('rapid repeated completion gestures save only one history entry with fast storage', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).evaluate(async button => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Model the second event in one gesture, not a second deliberate workout completion.
    await new Promise<void>(resolve => window.setTimeout(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      resolve();
    }, 50));
  });
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  // Wait until the app permits another deliberate completion before inspecting the final state.
  await expect(page.getByRole('button', { name: 'Завершить тренировку', exact: true })).toBeEnabled();
  const completed = await storedState(page);
  expect(completed.history).toHaveLength(1);
  expect(completed.history[0]).toMatchObject({ workoutId: 'a', workoutName: 'Тренировка А' });
  expect(completed.programs[0].nextWorkoutId).toBe('b');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  expect(await storedState(page)).toEqual(completed);
});

test('fast multi-character weight input autosaves the final value without pressing Done', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Изменить Приседания со штангой', exact: true }).click();
  const weight = page.getByRole('textbox', { name: 'Вес, подход 1', exact: true });
  await weight.fill('');
  // Individual keyboard events exercise intermediate valid/invalid values and overlapping saves.
  await weight.pressSequentially('127,5', { delay: 0 });
  await expect(weight).toHaveValue('127,5');
  await expect.poll(async () => (await storedState(page)).drafts[0]?.exercises[0].sets).toEqual([{ weightKg: 127.5, reps: 8 }]);
  await expect(page.getByRole('button', { name: 'Готово', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // Reload while the editor remains open: Done must not be needed to persist the final keystroke.
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Изменить Приседания со штангой', exact: true })).toContainText('127,5');
  const saved = await storedState(page);
  expect(saved.drafts[0].exercises[0].sets).toEqual([{ weightKg: 127.5, reps: 8 }]);
  expect(saved.programs[0].workouts[0].exercises[0].sets).toEqual([{ weightKg: 40, reps: 8 }]);
  expect(saved.history).toEqual([]);
});

test('valid downloaded backup replaces changed data and roundtrips history, drafts, and queue', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Изменить Жим лёжа', exact: true }).click();
  await page.getByRole('textbox', { name: 'Вес, подход 1', exact: true }).fill('33,5');
  await expect.poll(async () => (await storedState(page)).drafts[0]?.exercises[0].sets[0].weightKg).toBe(33.5);
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  const snapshot = await storedState(page);
  const backupDialog = await openBackup(page);
  const downloadPromise = page.waitForEvent('download');
  await backupDialog.getByRole('button', { name: 'Скачать копию', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const contents = await readFile(path!, 'utf8');
  expect(JSON.parse(contents).data).toEqual(snapshot);
  await backupDialog.getByRole('button', { name: 'Закрыть', exact: true }).click();

  await navigate(page, 'Тренировка');
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка А', exact: true })).toBeVisible();
  const changed = await storedState(page);
  expect(changed.history).toHaveLength(2);
  expect(changed.drafts).toEqual([]);
  expect(changed).not.toEqual(snapshot);

  const importDialog = await openBackup(page);
  await importDialog.getByLabel('Файл резервной копии').setInputFiles({
    name: download.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(contents),
  });
  await expect(importDialog.getByRole('heading', { name: 'Копия готова к восстановлению', exact: true })).toBeVisible();
  expect(await storedState(page)).toEqual(changed);
  const confirmation = page.waitForEvent('dialog');
  const replace = importDialog.getByRole('button', { name: 'Заменить текущие данные', exact: true }).click();
  const prompt = await confirmation;
  expect(prompt.type()).toBe('confirm');
  await prompt.accept();
  await replace;
  await expect(importDialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  expect(await storedState(page)).toEqual(snapshot);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Изменить Жим лёжа', exact: true })).toContainText('33,5');
  expect(await storedState(page)).toEqual(snapshot);
});

test('a stale tab cannot overwrite completed history and asks the user to reload', async ({ page, context }) => {
  await seed(page);
  const stale = await context.newPage();
  await stale.goto('/');
  await expect(stale.getByRole('heading', { name: 'Тренировка А', exact: true })).toBeVisible();
  await navigate(stale, 'Программы');
  await stale.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await stale.getByRole('textbox', { name: 'Название программы', exact: true }).fill('Устаревшие изменения');

  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  const completed = await storedState(page);
  expect(completed.history).toHaveLength(1);
  // Do not call loadState in the stale tab: doing so would refresh its expected revision.
  await stale.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(stale.getByRole('alert').first()).toContainText('Перезагрузите приложение перед сохранением');
  await expect(stale.getByRole('heading', { name: 'Редактирование программы', exact: true })).toBeVisible();
  expect(await storedState(page)).toEqual(completed);
  await stale.getByRole('button', { name: 'Отмена', exact: true }).click();
  await stale.reload();
  await expect(stale.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  expect(await storedState(stale)).toEqual(completed);
  await stale.close();
});

test('editor reordering retains the next workout ID and deletion selects its old-order successor', async ({ page }) => {
  const initial = fixture();
  initial.programs[0].workouts.push({
    id: 'c', name: 'Тренировка В',
    exercises: [{ id: 'row', name: 'Тяга гантели', sets: [{ weightKg: 20, reps: 12 }] }],
  });
  await seed(page, initial);
  await navigate(page, 'Программы');
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.getByRole('button', { name: 'Опустить тренировку 1', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Силовая программа', exact: true })).toBeVisible();
  let program = (await storedState(page)).programs[0];
  expect(program.workouts.map(workout => workout.id)).toEqual(['b', 'a', 'c']);
  expect(program.nextWorkoutId).toBe('a');
  await navigate(page, 'Тренировка');
  await expect(page.getByRole('heading', { name: 'Тренировка А', exact: true })).toBeVisible();

  await navigate(page, 'Программы');
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  const nextWorkout = page.locator('form section.card').filter({
    has: page.getByRole('button', { name: /^2\. Тренировка А/ }),
  });
  page.once('dialog', dialog => dialog.accept());
  await nextWorkout.getByRole('button', { name: 'Удалить тренировку', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Силовая программа', exact: true })).toBeVisible();
  program = (await storedState(page)).programs[0];
  expect(program.workouts.map(workout => workout.id)).toEqual(['b', 'c']);
  // The successor was c before deletion; choosing the first remaining workout would incorrectly pick b.
  expect(program.nextWorkoutId).toBe('c');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Тренировка В', exact: true })).toBeVisible();
});

test('switching programs preserves separate queues and drafts; template confirmation resets only its own draft', async ({ page }) => {
  const initial = fixture();
  initial.programs.push({
    id: 'second', name: 'Вторая программа', nextWorkoutId: 'y',
    workouts: [
      { id: 'x', name: 'Вторая А', exercises: [{ id: 'pull', name: 'Подтягивания', sets: [{ weightKg: 0, reps: 8 }] }] },
      { id: 'y', name: 'Вторая Б', exercises: [{ id: 'lunge', name: 'Выпады', sets: [{ weightKg: 10, reps: 12 }] }] },
    ],
  });
  initial.drafts = initial.programs.map(program => {
    const workout = program.workouts.find(workout => workout.id === program.nextWorkoutId)!;
    return {
      programId: program.id, workoutId: workout.id, updatedAt: '2026-01-01T00:00:00.000Z',
      exercises: [{ ...workout.exercises[0], sets: [{ weightKg: program.id === 'program' ? 47.5 : 12.5, reps: 9 }] }],
    };
  });
  const card = (name: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await seed(page, initial);
  await navigate(page, 'Программы');
  await card('Вторая программа').getByRole('button', { name: 'Сделать активной', exact: true }).click();
  await navigate(page, 'Тренировка');
  await expect(page.getByRole('heading', { name: 'Вторая Б', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Изменить Выпады', exact: true })).toContainText('12,5');
  expect(await storedState(page)).toEqual({ ...initial, activeProgramId: 'second' });

  await navigate(page, 'Программы');
  await card('Силовая программа').getByRole('button', { name: 'Сделать активной', exact: true }).click();
  await navigate(page, 'Тренировка');
  await expect(page.getByRole('heading', { name: 'Тренировка А', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Изменить Приседания со штангой', exact: true })).toContainText('47,5');
  expect(await storedState(page)).toEqual(initial);

  await navigate(page, 'Программы');
  await card('Силовая программа').getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.getByRole('textbox', { name: 'Название программы', exact: true }).fill('Обновлённая программа');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Редактирование программы', exact: true })).toBeVisible();
  expect(await storedState(page)).toEqual(initial);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Обновлённая программа', exact: true })).toBeVisible();
  const expected = structuredClone(initial);
  expected.programs[0].name = 'Обновлённая программа';
  expected.drafts = expected.drafts.filter(draft => draft.programId !== 'program');
  expect(await storedState(page)).toEqual(expected);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Изменить Приседания со штангой', exact: true })).toContainText('40');
  expect(await storedState(page)).toEqual(expected);
});

test('history retains original names and sets after template rename and program deletion', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  const history = (await storedState(page)).history;
  expect(history).toHaveLength(1);
  await navigate(page, 'Программы');
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.getByRole('textbox', { name: 'Название программы', exact: true }).fill('Новый план');
  await page.getByRole('button', { name: /^1\. Тренировка А/ }).click();
  await page.getByRole('textbox', { name: 'Название тренировки', exact: true }).fill('Новая тренировка');
  await page.getByRole('textbox', { name: 'Упражнение 1', exact: true }).fill('Новое упражнение');
  await page.getByRole('textbox', { name: 'Вес, кг, упражнение 1, подход 1', exact: true }).fill('99');
  await page.getByRole('textbox', { name: 'Повторы, упражнение 1, подход 1', exact: true }).fill('3');
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Новый план', exact: true })).toBeVisible();
  const renamed = await storedState(page);
  expect(renamed.programs[0].workouts[0]).toMatchObject({
    name: 'Новая тренировка', exercises: [{ name: 'Новое упражнение', sets: [{ weightKg: 99, reps: 3 }] }],
  });
  expect(renamed.history).toEqual(history);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Новый план', exact: true }) })
    .getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ваш план начинается здесь', exact: true })).toBeVisible();
  const deleted = await storedState(page);
  expect(deleted.programs).toEqual([]);
  expect(deleted.history).toEqual(history);
  await page.reload();
  await navigate(page, 'История');
  await page.getByRole('button').filter({ hasText: 'Тренировка А' }).click();
  const detail = page.getByRole('dialog', { name: 'Тренировка А', exact: true });
  await expect(detail.getByText(/Силовая программа/)).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Приседания со штангой', exact: true })).toBeVisible();
  await expect(detail.locator('.weight-readonly')).toHaveText('40 кг');
  await expect(detail.getByText('1 × 8 повторов', { exact: true })).toBeVisible();
  expect((await storedState(page)).history).toEqual(history);
});

for (const width of [360, 320]) {
  test(`mobile layout fits ${width}px in workout, editors, history, and backup`, async ({ page }) => {
    await page.setViewportSize({ width, height: 851 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Создать программу', exact: true })).toBeVisible();
    await noOverflow(page);
    await seed(page);
    await noOverflow(page);
    await page.getByRole('button', { name: 'Изменить Приседания со штангой', exact: true }).click();
    await expect(page.getByLabel('Вес, подход 1', { exact: true })).toBeVisible();
    await noOverflow(page);
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
    await navigate(page, 'История');
    await page.getByRole('button').filter({ hasText: 'Тренировка А' }).click();
    await noOverflow(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await navigate(page, 'Программы');
    await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
    await page.getByRole('button', { name: /^1\. Тренировка А/ }).click();
    await expect(page.getByLabel('Вес, кг, упражнение 1, подход 1', { exact: true })).toBeVisible();
    await noOverflow(page);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await openBackup(page);
    await noOverflow(page);
  });
}
