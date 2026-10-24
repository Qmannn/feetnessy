import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeWorkout, emptyState, exportBackup, parseBackup, saveDraft, type AppState } from './domain';
import { db, loadState, persistState, replaceState } from './storage';

const fixture = (): AppState => ({ ...emptyState(), activeProgramId: 'p', programs: [{ id: 'p', name: 'Программа', nextWorkoutId: 'w', workouts: [{ id: 'w', name: 'Тренировка', exercises: [{ id: 'e', name: 'Приседание', sets: [{ weightKg: 22.5, reps: 10 }] }] }] }] });

beforeEach(async () => {
  await db.states.clear();
  await loadState();
});
afterAll(() => { db.close(); });

describe('IndexedDB', () => {
  it('возвращает пустое состояние при первом открытии', async () => {
    expect(await loadState()).toEqual(emptyState());
    expect(await db.states.count()).toBe(0);
  });

  it('сохраняет черновик, историю и очередь одной записью после повторного открытия', async () => {
    const draft = saveDraft(fixture(), 'p', 'w', fixture().programs[0].workouts[0].exercises);
    await persistState(draft);
    db.close();
    await db.open();
    expect(await loadState()).toEqual(draft);
    const completed = completeWorkout(draft, true, 'done');
    await persistState(completed);
    expect(await loadState()).toEqual(completed);
    expect(await db.states.count()).toBe(1);
  });

  it('запись и чтение не разделяют изменяемые ссылки', async () => {
    const state = fixture();
    const pending = persistState(state);
    state.programs[0].name = 'Изменено во время записи';
    await pending;
    const loaded = await loadState();
    expect(loaded.programs[0].name).toBe('Программа');
    loaded.programs[0].name = 'Изменено после чтения';
    expect((await loadState()).programs[0].name).toBe('Программа');
  });

  it('восстанавливает экспорт в пустую базу и заменяет всё состояние', async () => {
    const state = completeWorkout(fixture(), false, 'done');
    const backup = exportBackup(state);
    await persistState(fixture());
    await replaceState(parseBackup(backup));
    expect(await loadState()).toEqual(state);
    await replaceState(emptyState());
    expect(await loadState()).toEqual(emptyState());
    await db.states.clear();
    await loadState();
    await replaceState(parseBackup(backup));
    expect(await loadState()).toEqual(state);
  });

  it('не изменяет данные при невалидном импорте или записи', async () => {
    const state = fixture();
    await persistState(state);
    const before = await db.states.get('current');
    const invalid = { ...state, activeProgramId: 'missing' };
    await expect(replaceState(invalid)).rejects.toThrow();
    await expect(persistState(invalid)).rejects.toThrow();
    expect(() => parseBackup('{"version":99}')).toThrow();
    expect(await db.states.get('current')).toEqual(before);
    expect(await loadState()).toEqual(state);
  });

  it('откатывает транзакцию и передаёт ошибку вызывающему коду', async () => {
    const state = fixture();
    await persistState(state);
    const before = await db.states.get('current');
    const originalPut = db.states.put.bind(db.states);
    const put = vi.spyOn(db.states, 'put').mockImplementationOnce((...args) =>
      originalPut(...args).then(() => { throw new Error('Ошибка записи'); }),
    );
    try {
      await expect(persistState(completeWorkout(state, true, 'done'))).rejects.toThrow('Ошибка записи');
    } finally { put.mockRestore(); }
    expect(await db.states.get('current')).toEqual(before);
    // Retrying without a load proves a failed transaction did not advance the observer.
    await persistState(state);
    expect((await db.states.get('current'))?.revision).toBe(2);
    expect(await loadState()).toEqual(state);
  });

  it('последовательно увеличивает ревизию после загрузки пустой базы и повторного открытия', async () => {
    await persistState(fixture());
    expect((await db.states.get('current'))?.revision).toBe(1);
    db.close();
    await db.open();
    expect(await loadState()).toEqual(fixture());
    await persistState(completeWorkout(fixture(), true, 'done'));
    expect((await db.states.get('current'))?.revision).toBe(2);
  });

  it('читает старую строку без ревизии как ревизию 0', async () => {
    await db.states.put({ id: 'current', state: fixture() });
    expect(await loadState()).toEqual(fixture());
    expect((await db.states.get('current'))?.revision).toBeUndefined();
    await persistState(fixture());
    expect((await db.states.get('current'))?.revision).toBe(1);
  });

  it('сохраняет старые строки и копии без описаний без миграции схемы', async () => {
    const state = saveDraft(completeWorkout(fixture(), false, 'old'), 'p', 'w', fixture().programs[0].workouts[0].exercises);
    await db.states.put({ id: 'current', state, revision: 3 });
    const row = await db.states.get('current');
    expect(await loadState()).toStrictEqual(state);
    expect(await db.states.get('current')).toStrictEqual(row);
    const backup = JSON.stringify({ format: 'feetnessy', version: 1, exportedAt: '2026-01-01T00:00:00.000Z', data: state });
    await replaceState(parseBackup(backup));
    db.close();
    await db.open();
    expect(await loadState()).toStrictEqual(state);
    expect(db.verno).toBe(1);
  });

  it.each(['', 'Разминка\nОсновная часть\n  Заминка  '])('сохраняет описания %j в строке и после импорта', async description => {
    const initial = fixture();
    initial.programs[0].workouts[0].description = description;
    initial.programs[0].workouts[0].exercises[0].description = description;
    const completed = completeWorkout(initial, true, 'described');
    const state = saveDraft(completed, 'p', 'w', initial.programs[0].workouts[0].exercises);
    await persistState(state);
    db.close();
    await db.open();
    expect(await loadState()).toStrictEqual(state);
    expect((await db.states.get('current'))?.state).toStrictEqual(state);
    await replaceState(emptyState());
    await replaceState(parseBackup(exportBackup(state)));
    expect(await loadState()).toStrictEqual(state);
    expect(db.verno).toBe(1);
  });

  it('отклоняет нестроковые описания при записи и чтении', async () => {
    const state = fixture();
    await persistState(state);
    const before = await db.states.get('current');
    Object.assign(state.programs[0].workouts[0], { description: null });
    await expect(persistState(state)).rejects.toThrow(/Описание/);
    await expect(replaceState(state)).rejects.toThrow(/Описание/);
    expect(await db.states.get('current')).toStrictEqual(before);
    await db.states.put({ id: 'current', state });
    await expect(loadState()).rejects.toThrow(/Описание/);
  });

  it.each(['persist', 'replace'])('отклоняет устаревшую операцию %s, сохраняя чужое обновление', async operation => {
    await persistState(fixture());
    await loadState();
    const external = completeWorkout(fixture(), true, 'external');
    await db.states.put({ id: 'current', state: external, revision: 2 });
    const save = operation === 'persist' ? persistState : replaceState;
    await expect(save(fixture())).rejects.toThrow(/Перезагрузите/);
    expect(await db.states.get('current')).toEqual({ id: 'current', state: external, revision: 2 });
    // A rejected save must not silently adopt the external revision.
    await expect(save(fixture())).rejects.toThrow(/Перезагрузите/);
    const loaded = await loadState();
    expect(loaded).toEqual(external);
    await save(loaded);
    expect((await db.states.get('current'))?.revision).toBe(3);
  });

  it('отклоняет конкурирующую запись с той же исходной ревизией', async () => {
    const first = fixture();
    const second = completeWorkout(fixture(), true, 'second');
    const results = await Promise.allSettled([persistState(first), persistState(second)]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    if (results[1].status === 'rejected') expect(results[1].reason.message).toMatch(/Перезагрузите/);
    expect(await db.states.get('current')).toEqual({ id: 'current', state: first, revision: 1 });
    // Successful writer's observer remains usable; rejected writer did not advance it.
    await persistState(second);
    expect((await db.states.get('current'))?.revision).toBe(2);
  });

  it('после загрузки пустой базы обнаруживает запись, созданную другой вкладкой', async () => {
    expect(await loadState()).toEqual(emptyState());
    await db.states.put({ id: 'current', state: fixture(), revision: 1 });
    await expect(persistState(emptyState())).rejects.toThrow(/Перезагрузите/);
    expect((await db.states.get('current'))?.state).toEqual(fixture());
  });

  it('не скрывает повреждение сохранённой структуры', async () => {
    await db.states.put({ id: 'current', state: { ...emptyState(), activeProgramId: 'missing' } });
    await expect(loadState()).rejects.toThrow(/программа/);
  });
});
