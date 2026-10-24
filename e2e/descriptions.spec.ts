import { readFile } from 'node:fs/promises';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { AppState } from '../src/domain';
import { formatDate } from '../src/format';

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

async function storedState(page: Page): Promise<AppState> {
  return page.evaluate(async () => {
    const path = '/src/storage.ts';
    const storage = await import(/* @vite-ignore */ path);
    return storage.loadState();
  });
}

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('button', { name, exact: true }).click();
}

async function description(locator: Locator, text: string) {
  await expect(locator).toBeVisible();
  expect(await locator.textContent()).toBe(text);
  await expect(locator).toHaveCSS('white-space', 'pre-wrap');
}

function fixture(): AppState {
  const workouts = [
    { id: 'a', name: 'Тренировка А', exercises: [{ id: 'squat', name: 'Приседания', sets: [{ weightKg: 40, reps: 8 }] }] },
    { id: 'b', name: 'Тренировка Б', exercises: [{ id: 'press', name: 'Жим лёжа', sets: [{ weightKg: 30, reps: 10 }] }] },
  ];
  return {
    schemaVersion: 1, activeProgramId: 'program',
    programs: [{ id: 'program', name: 'Мой план', nextWorkoutId: 'b', workouts }],
    drafts: [{ programId: 'program', workoutId: 'b', exercises: [{ ...workouts[1].exercises[0], sets: [{ weightKg: 35, reps: 9 }] }], updatedAt: '2026-01-03T12:00:00.000Z' }],
    history: workouts.map((workout, index) => ({
      id: `history-${workout.id}`, programId: 'program', workoutId: workout.id,
      programName: 'Мой план', workoutName: workout.name, exercises: structuredClone(workout.exercises),
      completedAt: `2026-01-0${index + 1}T12:00:00.000Z`,
    })),
  };
}

async function seed(page: Page, state = fixture()) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Создать программу', exact: true })).toBeVisible();
  await page.evaluate(async state => {
    const path = '/src/storage.ts';
    const storage = await import(/* @vite-ignore */ path);
    await storage.loadState();
    await storage.replaceState(state);
  }, state);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
}

test('editor descriptions preserve newlines, completion snapshots, and backup roundtrip', async ({ page }) => {
  const workoutDescription = 'Разминка перед тренировкой.\nОтдых между упражнениями — две минуты.';
  const exerciseDescription = 'Спина прямая.\nОпускайся медленно, без рывков.';
  await page.goto('/');
  await page.getByRole('button', { name: 'Создать программу', exact: true }).click();
  await page.getByRole('button', { name: 'Создать программу', exact: true }).click();
  await page.getByLabel('Название программы', { exact: true }).fill('Мой план');
  await page.getByRole('button', { name: 'Добавить тренировку', exact: true }).click();
  await page.getByLabel('Название тренировки', { exact: true }).fill('Тренировка А');
  await page.getByLabel(/^Описание тренировки/).fill(workoutDescription);
  await page.getByRole('button', { name: 'Добавить упражнение', exact: true }).click();
  await page.getByRole('textbox', { name: 'Упражнение 1', exact: true }).fill('Приседания');
  await page.getByLabel(/^Описание упражнения/).fill(exerciseDescription);
  await page.getByLabel('Вес, кг, упражнение 1, подход 1', { exact: true }).fill('40');
  await page.getByLabel('Повторы, упражнение 1, подход 1', { exact: true }).fill('8');
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Мой план', exact: true })).toBeVisible();
  await page.reload();
  await description(page.locator('.workout-hero .description'), workoutDescription);
  await description(page.locator('.exercise-card .description'), exerciseDescription);
  const original = await storedState(page);
  expect(original.programs[0].workouts[0]).toMatchObject({
    description: workoutDescription, exercises: [{ description: exerciseDescription }],
  });
  await page.getByRole('button', { name: 'Завершить тренировку', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Тренировка завершена');
  const completed = await storedState(page);
  expect(completed.history).toHaveLength(1);
  expect(completed.history[0]).toMatchObject({
    workoutDescription, exercises: [{ description: exerciseDescription }],
  });

  await navigate(page, 'Программы');
  await page.getByRole('button', { name: 'Редактировать', exact: true }).click();
  await page.getByRole('button', { name: /^1\. Тренировка А/ }).click();
  await expect(page.getByLabel(/^Описание тренировки/)).toHaveValue(workoutDescription);
  await expect(page.getByLabel(/^Описание упражнения/)).toHaveValue(exerciseDescription);
  await page.getByLabel(/^Описание тренировки/).fill('Новая разминка.\nНовый отдых.');
  await page.getByLabel(/^Описание упражнения/).fill('Новая техника.\nНовый темп.');
  await page.getByRole('button', { name: 'Сохранить программу', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Мой план', exact: true })).toBeVisible();
  await page.reload();
  await description(page.locator('.workout-hero .description'), 'Новая разминка.\nНовый отдых.');
  await description(page.locator('.exercise-card .description'), 'Новая техника.\nНовый темп.');
  await navigate(page, 'История');
  await page.locator('.history-card').filter({ hasText: 'Тренировка А' }).click();
  const detail = page.getByRole('dialog', { name: 'Тренировка А', exact: true });
  await description(detail.locator('.history-description'), workoutDescription);
  await description(detail.locator('.exercise-card .description'), exerciseDescription);
  expect((await storedState(page)).history).toEqual(completed.history);
  await detail.getByRole('button', { name: 'Закрыть', exact: true }).click();

  const snapshot = await storedState(page);
  await navigate(page, 'Программы');
  await page.getByRole('button', { name: 'Экспорт и импорт', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('dialog', { name: 'Резервная копия', exact: true }).getByRole('button', { name: 'Скачать копию', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const contents = await readFile(path!, 'utf8');
  expect(JSON.parse(contents)).toMatchObject({ format: 'feetnessy', version: 1, data: snapshot });
  const parsed = await page.evaluate(async contents => {
    const path = '/src/domain.ts';
    const domain = await import(/* @vite-ignore */ path);
    return domain.parseBackup(contents);
  }, contents);
  expect(parsed).toEqual(snapshot);
});

test('history deletion cancels safely, removes only the selected entry, and persists the last-entry empty state', async ({ page }) => {
  const initial = fixture();
  await seed(page, initial);
  await navigate(page, 'История');
  await expect(page.locator('.history-card')).toHaveCount(2);
  await page.locator('.history-card').filter({ hasText: 'Тренировка А' }).click();
  const detail = page.getByRole('dialog', { name: 'Тренировка А', exact: true });
  const confirmation = page.waitForEvent('dialog');
  const cancelClick = detail.getByRole('button', { name: 'Удалить из истории', exact: true }).click();
  const prompt = await confirmation;
  expect(prompt.type()).toBe('confirm');
  expect(prompt.message()).toContain('Тренировка А');
  expect(prompt.message()).toContain(formatDate(initial.history[0].completedAt));
  expect(prompt.message()).toMatch(/Очередь тренировок не изменится/i);
  await prompt.dismiss();
  await cancelClick;
  await expect(detail).toBeVisible();
  expect(await storedState(page)).toEqual(initial);
  await expect(page.locator('.history-card')).toHaveCount(2);

  page.once('dialog', dialog => dialog.accept());
  await detail.getByRole('button', { name: 'Удалить из истории', exact: true }).click();
  await expect(detail).not.toBeVisible();
  await expect(page.locator('.history-card')).toHaveCount(1);
  await expect(page.locator('.history-card')).toContainText('Тренировка Б');
  const remaining = { ...initial, history: [initial.history[1]] };
  expect(await storedState(page)).toEqual(remaining);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Изменить Жим лёжа', exact: true })).toContainText('35');
  expect(await storedState(page)).toEqual(remaining);
  await navigate(page, 'История');
  await expect(page.locator('.history-card')).toHaveCount(1);
  await page.locator('.history-card').click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('dialog', { name: 'Тренировка Б', exact: true }).getByRole('button', { name: 'Удалить из истории', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Здесь будет твой прогресс', exact: true })).toBeVisible();
  const empty = { ...initial, history: [] };
  expect(await storedState(page)).toEqual(empty);
  await page.reload();
  await navigate(page, 'История');
  await expect(page.getByRole('heading', { name: 'Здесь будет твой прогресс', exact: true })).toBeVisible();
  expect(await storedState(page)).toEqual(empty);
});

test('stale-tab deletion keeps the entry and detail open with a local save error', async ({ page, context }) => {
  const initial = fixture();
  await seed(page, initial);
  await navigate(page, 'История');
  await page.locator('.history-card').filter({ hasText: 'Тренировка А' }).click();
  const detail = page.getByRole('dialog', { name: 'Тренировка А', exact: true });
  await expect(detail).toBeVisible();
  const writer = await context.newPage();
  await writer.goto('/');
  await expect(writer.getByRole('heading', { name: 'Тренировка Б', exact: true })).toBeVisible();
  // Persist from another module instance to advance IndexedDB's revision without refreshing the stale tab.
  await writer.evaluate(async () => {
    const path = '/src/storage.ts';
    const storage = await import(/* @vite-ignore */ path);
    const state = await storage.loadState();
    await storage.persistState(state);
  });
  page.once('dialog', dialog => dialog.accept());
  await detail.getByRole('button', { name: 'Удалить из истории', exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('alert')).toContainText('Перезагрузите приложение перед сохранением');
  await expect(detail.getByRole('button', { name: 'Удалить из истории', exact: true })).toBeEnabled();
  await expect(page.locator('.history-card')).toHaveCount(2);
  expect(await storedState(writer)).toEqual(initial);
  await detail.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.reload();
  await navigate(page, 'История');
  await expect(page.locator('.history-card')).toHaveCount(2);
  expect(await storedState(page)).toEqual(initial);
  await writer.close();
});
