import { describe, expect, it, vi } from 'vitest';
import { clone, completeWorkout, deleteHistoryEntry, emptyState, exportBackup, getActiveProgram, getNextWorkout, newId, parseBackup, saveDraft, validateExercises, validateState, type AppState, type Exercise } from './domain';

const exercises = (weightKg = 20): Exercise[] => [{ id: 'exercise', name: 'Приседание', sets: [{ weightKg, reps: 8 }] }];
function fixture(): AppState {
  return { ...emptyState(), activeProgramId: 'p', programs: [{ id: 'p', name: 'Программа', nextWorkoutId: 'w1', workouts: [1, 2, 3, 4].map(n => ({ id: `w${n}`, name: `Тренировка ${n}`, exercises: exercises() })) }] };
}

describe('генерация ID', () => {
  it('использует доступный crypto.randomUUID', () => {
    const uuid = '12345678-1234-4567-8123-123456789abc';
    const stub = vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid);
    try {
      expect(newId()).toBe(uuid);
      expect(stub).toHaveBeenCalledOnce();
    } finally { stub.mockRestore(); }
  });

  it('без randomUUID генерирует разные UUIDv4 через getRandomValues', () => {
    const originalCrypto = globalThis.crypto;
    const getRandomValues = vi.fn(originalCrypto.getRandomValues.bind(originalCrypto));
    vi.stubGlobal('crypto', { getRandomValues });
    try {
      const ids = Array.from({ length: 100 }, () => newId());
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
      expect(getRandomValues).toHaveBeenCalledTimes(ids.length);
    } finally { vi.unstubAllGlobals(); }
    expect(globalThis.crypto).toBe(originalCrypto);
  });
});

describe('очередь и завершение', () => {
  it('проходит полный цикл из четырёх тренировок, не изменяя исходные данные', () => {
    const original = fixture();
    let state = original;
    for (let n = 1; n <= 4; n++) {
      expect(getNextWorkout(getActiveProgram(state)!)?.id).toBe(`w${n}`);
      state = completeWorkout(state, true, `completion-${n}`);
    }
    expect(state.programs[0].nextWorkoutId).toBe('w1');
    expect(state.history.map(h => h.workoutId)).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(original).toEqual(fixture());
    expect(state.drafts).toEqual([]);
  });

  it('не сбрасывает очередь после перестановки тренировок', () => {
    const state = fixture();
    state.programs[0].workouts.reverse();
    expect(getNextWorkout(state.programs[0])?.id).toBe('w1');
    expect(completeWorkout(state, false, 'x').programs[0].nextWorkoutId).toBe('w4');
  });

  it('сохраняет очередь и черновики другой программы', () => {
    const state = fixture();
    state.programs.push({ id: 'p2', name: 'Вторая', nextWorkoutId: 'other', workouts: [{ id: 'other', name: 'Другая', exercises: exercises() }] });
    const saved = saveDraft(state, 'p2', 'other', exercises(33));
    const completed = completeWorkout(saved, true, 'x');
    expect(completed.drafts).toEqual(saved.drafts);
    expect(completed.programs[1]).toEqual(saved.programs[1]);
    completed.activeProgramId = 'p2';
    expect(completeWorkout(completed, false, 'y').history[1].exercises[0].sets[0].weightKg).toBe(33);
  });

  it('повторный ID завершения не создаёт запись и не сдвигает очередь', () => {
    const state = completeWorkout(fixture(), false, 'same');
    expect(completeWorkout(state, true, 'same')).toEqual(state);
    expect(completeWorkout(state, true, 'new').history).toHaveLength(2);
  });

  it('отклоняет отсутствие программы, тренировок и пустые упражнения', () => {
    expect(() => completeWorkout(emptyState(), true)).toThrow(/программу/);
    const state = fixture();
    state.programs[0].workouts = [];
    state.programs[0].nextWorkoutId = null;
    expect(() => completeWorkout(state, false)).toThrow(/тренировки/);
    const empty = fixture();
    empty.programs[0].workouts[0].exercises = [];
    expect(() => completeWorkout(empty, false)).toThrow(/пустую/);
    expect(() => completeWorkout(saveDraft(fixture(), 'p', 'w1', []), true)).toThrow(/пустую/);
  });
});

describe('черновики и независимые снимки', () => {
  it('создаёт и заменяет черновик без изменения входов и очереди', () => {
    const state = fixture();
    const edited = exercises(22.5);
    const saved = saveDraft(state, 'p', 'w1', edited);
    edited[0].sets[0].weightKg = 100;
    expect(saved.drafts[0].exercises[0].sets[0].weightKg).toBe(22.5);
    expect(state).toEqual(fixture());
    expect(saved.programs[0].nextWorkoutId).toBe('w1');
    const replaced = saveDraft(saved, 'p', 'w1', exercises(30));
    expect(replaced.drafts).toHaveLength(1);
    expect(saved.drafts[0].exercises[0].sets[0].weightKg).toBe(22.5);
    expect(() => saveDraft(state, 'p', 'missing', edited)).toThrow();
  });

  it.each([true, false])('завершение с saveTemplate=%s сохраняет результат и удаляет черновик', saveTemplate => {
    const draft = saveDraft(fixture(), 'p', 'w1', exercises(45));
    const state = completeWorkout(draft, saveTemplate, 'done');
    expect(state.history[0].exercises[0].sets[0].weightKg).toBe(45);
    expect(state.programs[0].workouts[0].exercises[0].sets[0].weightKg).toBe(45);
    expect(state.drafts).toHaveLength(0);
    expect(draft.drafts).toHaveLength(1);
    state.programs[0].workouts[0].exercises[0].sets[0].weightKg = 999;
    state.programs[0].name = 'Переименована';
    expect(state.history[0].exercises[0].sets[0].weightKg).toBe(45);
    expect(state.history[0].programName).toBe('Программа');
    expect(draft.drafts[0].exercises[0].sets[0].weightKg).toBe(45);
  });

  it('история сохраняется после удаления исходной программы', () => {
    const state = completeWorkout(fixture(), false, 'done');
    state.programs = [];
    state.activeProgramId = null;
    expect(validateState(state).history).toHaveLength(1);
  });
});

describe('вес следующей тренировки', () => {
  it.each([true, false])('переносит увеличение и затем уменьшение на все подходы, saveTemplate=%s', saveTemplate => {
    let state = fixture();
    state.programs[0].workouts[0].exercises[0].sets = [8, 10, 12].map(reps => ({ weightKg: 20, reps }));
    const original = clone(state);
    for (const weightKg of [25, 15, 0, 2.5]) {
      const edited = clone(state.programs[0].workouts[0].exercises);
      edited[0].sets[2].weightKg = weightKg;
      state = completeWorkout(saveDraft(state, 'p', 'w1', edited), saveTemplate, `weight-${weightKg}`);
      expect(state.programs[0].workouts[0].exercises[0].sets).toEqual([8, 10, 12].map(reps => ({ weightKg, reps })));
      expect(state.history.at(-1)!.exercises).toEqual(edited);
      expect(state.programs[0].workouts[1]).toEqual(original.programs[0].workouts[1]);
      for (let n = 0; n < 3; n++) state = completeWorkout(state, false, `${weightKg}-${n}`);
    }
    expect(original.programs[0].workouts[0].exercises[0].sets[0].weightKg).toBe(20);
  });

  it('запоминает последнее изменение, а не максимальный вес или последний подход', () => {
    const state = fixture();
    state.programs[0].workouts[0].exercises[0].sets = [20, 20, 20].map(weightKg => ({ weightKg, reps: 8 }));
    const edited = clone(state.programs[0].workouts[0].exercises);
    edited[0].sets[2].weightKg = 30;
    let saved = saveDraft(state, 'p', 'w1', edited);
    edited[0].sets[0].weightKg = 15;
    saved = parseBackup(exportBackup(saveDraft(saved, 'p', 'w1', edited)));
    edited[0].sets[1].reps = 12;
    saved = saveDraft(saved, 'p', 'w1', edited);
    const completed = completeWorkout(saved, false, 'last-change');
    expect(completed.programs[0].workouts[0].exercises[0].sets.map(s => s.weightKg)).toEqual([15, 15, 15]);
    expect(completed.history[0].exercises).toEqual(edited);
    expect(saved.programs).toEqual(state.programs);
  });

  it('не выравнивает разные веса без изменения веса и поддерживает старые черновики', () => {
    const state = fixture();
    state.programs[0].workouts[0].exercises[0].sets = [10, 20, 30].map(weightKg => ({ weightKg, reps: 8 }));
    const edited = clone(state.programs[0].workouts[0].exercises);
    edited[0].sets[0].reps = 12;
    const saved = saveDraft(state, 'p', 'w1', edited);
    expect(completeWorkout(saved, true, 'reps').programs[0].workouts[0].exercises).toEqual(edited);
    edited[0].sets[2].weightKg = 25;
    saved.drafts[0].exercises = edited;
    expect(completeWorkout(saved, false, 'legacy').programs[0].workouts[0].exercises[0].sets.map(s => s.weightKg)).toEqual([25, 25, 25]);
  });

  it('не считает добавление или удаление подхода изменением веса', () => {
    const state = fixture();
    state.programs[0].workouts[0].exercises[0].sets = [10, 20, 30].map(weightKg => ({ weightKg, reps: 8 }));
    for (const weights of [[20, 30], [10, 20, 30, 30]]) {
      const edited = clone(state.programs[0].workouts[0].exercises);
      edited[0].sets = weights.map(weightKg => ({ weightKg, reps: 8 }));
      const saved = saveDraft(state, 'p', 'w1', edited);
      expect(saved.drafts[0].nextWeights).toBeUndefined();
      expect(completeWorkout(saved, false, `structure-${weights.length}`).programs[0].workouts).toEqual(state.programs[0].workouts);
    }
  });

  it.each([null, {}, [{ exerciseId: 'missing', weightKg: 10 }], [{ exerciseId: 'exercise', weightKg: -1 }], [{ exerciseId: 'exercise', weightKg: Infinity }], [{ exerciseId: 'exercise', weightKg: 10 }, { exerciseId: 'exercise', weightKg: 20 }]])('отклоняет некорректные новые веса %j', nextWeights => {
    const saved = saveDraft(fixture(), 'p', 'w1', exercises());
    Object.assign(saved.drafts[0], { nextWeights });
    expect(() => validateState(saved)).toThrow();
  });
});

describe('валидация и резервная копия', () => {
  it('загружает старую копию версии 1 без добавления описаний', () => {
    const state = saveDraft(completeWorkout(fixture(), false, 'old'), 'p', 'w2', exercises());
    const backup = JSON.stringify({ format: 'feetnessy', version: 1, exportedAt: '2026-01-01T00:00:00.000Z', data: state });
    expect(parseBackup(backup)).toStrictEqual(state);
    expect(validateState(state)).toStrictEqual(state);
    expect(state.history[0]).not.toHaveProperty('workoutDescription');
    expect(state.programs[0].workouts[0]).not.toHaveProperty('description');
    expect(state.history[0].exercises[0]).not.toHaveProperty('description');
  });

  it.each(['', 'Первая строка\nВторая строка\n  без нормализации  '])('сохраняет описания %j в копии версии 1', description => {
    const state = fixture();
    state.programs[0].workouts[0].description = description;
    state.programs[0].workouts[0].exercises[0].description = description;
    const completed = completeWorkout(state, true, 'described');
    const draftExercises = exercises();
    draftExercises[0].description = description;
    const saved = saveDraft(completed, 'p', 'w2', draftExercises);
    const backup = exportBackup(saved);
    expect(JSON.parse(backup)).toMatchObject({ version: 1, data: { schemaVersion: 1 } });
    expect(parseBackup(backup)).toStrictEqual(saved);
    expect(saved.history[0].workoutDescription).toBe(description);
    expect(saved.history[0].exercises[0].description).toBe(description);
    expect(saved.drafts[0].exercises[0].description).toBe(description);
  });

  it.each([undefined, null, 42, true, [], {}])('отклоняет нестроковое описание %j во всех разрешённых местах', description => {
    const state = saveDraft(completeWorkout(fixture(), false, 'done'), 'p', 'w2', exercises());
    const targets: [object, string][] = [
      [state.programs[0].workouts[0], 'description'],
      [state.programs[0].workouts[0].exercises[0], 'description'],
      [state.drafts[0].exercises[0], 'description'],
      [state.history[0], 'workoutDescription'],
      [state.history[0].exercises[0], 'description'],
    ];
    for (const [target, key] of targets) {
      Object.assign(target, { [key]: description });
      expect(() => validateState(state)).toThrow(/Описание/);
      if (description !== undefined) expect(() => parseBackup(JSON.stringify({ format: 'feetnessy', version: 1, exportedAt: '2026-01-01T00:00:00.000Z', data: state }))).toThrow(/Описание/);
      Reflect.deleteProperty(target, key);
    }
  });

  it('не разрешает неизвестные поля и описания на других уровнях', () => {
    const state = saveDraft(completeWorkout(fixture(), false, 'done'), 'p', 'w2', exercises());
    const targets = [state, state.programs[0], state.programs[0].workouts[0], state.programs[0].workouts[0].exercises[0], state.programs[0].workouts[0].exercises[0].sets[0], state.drafts[0], state.drafts[0].exercises[0], state.history[0], state.history[0].exercises[0]];
    for (const target of targets) {
      Object.assign(target, { extra: 'unknown' });
      expect(() => validateState(state)).toThrow(/набор полей/);
      Reflect.deleteProperty(target, 'extra');
    }
    for (const target of [state, state.programs[0], state.drafts[0], state.history[0], state.programs[0].workouts[0].exercises[0].sets[0]]) {
      Object.assign(target, { description: '' });
      expect(() => validateState(state)).toThrow(/набор полей/);
      Reflect.deleteProperty(target, 'description');
    }
    const envelope = JSON.parse(exportBackup(state));
    expect(() => parseBackup(JSON.stringify({ ...envelope, description: '' }))).toThrow(/набор полей/);
  });

  it('сохраняет полное состояние и возвращает независимую копию', () => {
    const state = saveDraft(completeWorkout(fixture(), true, 'one'), 'p', 'w2', exercises(35));
    expect(parseBackup(exportBackup(state))).toEqual(state);
    const validated = validateState(state);
    validated.programs[0].name = 'Другое имя';
    expect(state.programs[0].name).toBe('Программа');
  });

  it.each([-1, NaN, Infinity, '20'])('отклоняет недопустимый вес %s', weight => {
    const input = exercises() as unknown as { sets: { weightKg: unknown }[] }[];
    input[0].sets[0].weightKg = weight;
    expect(() => validateExercises(input)).toThrow(/Вес/);
  });

  it.each([0, -1, 1.5, Infinity, '8'])('отклоняет недопустимые повторы %s', reps => {
    const input = exercises() as unknown as { sets: { reps: unknown }[] }[];
    input[0].sets[0].reps = reps;
    expect(() => validateExercises(input)).toThrow(/Повторы/);
  });

  it('принимает нулевой/дробный вес, отклоняет пустые подходы и названия', () => {
    validateExercises(exercises(0));
    validateExercises(exercises(2.5));
    expect(() => validateExercises([{ ...exercises()[0], sets: [] }])).toThrow();
    expect(() => validateExercises([{ ...exercises()[0], name: '  ' }])).toThrow();
    expect(() => validateExercises([...exercises(), ...exercises()])).toThrow(/ID/);
  });

  it('отклоняет дубликаты, сломанные ссылки, схему и структуру без исправлений', () => {
    const changes: ((state: AppState) => void)[] = [
      s => { s.programs.push(clone(s.programs[0])); },
      s => { s.programs[0].workouts.push(clone(s.programs[0].workouts[0])); },
      s => { s.programs[0].nextWorkoutId = 'missing'; },
      s => { s.programs[0].nextWorkoutId = null; },
      s => { s.activeProgramId = 'missing'; },
      s => { s.drafts.push({ programId: 'p', workoutId: 'missing', exercises: [], updatedAt: new Date().toISOString() }); },
      s => { Object.assign(s, { schemaVersion: 2 }); },
      s => { Object.assign(s, { extra: true }); },
      s => { Object.assign(s.programs[0], { name: 42 }); },
    ];
    for (const change of changes) {
      const state = fixture();
      change(state);
      expect(() => validateState(state)).toThrow();
    }
    const state = saveDraft(fixture(), 'p', 'w1', exercises());
    state.drafts.push(clone(state.drafts[0]));
    expect(() => validateState(state)).toThrow(/ID/);
    const history = completeWorkout(fixture(), true, 'x');
    history.history.push(clone(history.history[0]));
    expect(() => validateState(history)).toThrow(/ID/);
  });

  it('отклоняет повреждённые копии и невозможные даты', () => {
    expect(() => parseBackup('{')).toThrow(/JSON/);
    expect(() => parseBackup('null')).toThrow();
    const envelope = JSON.parse(exportBackup(fixture()));
    for (const change of [{ format: 'other' }, { version: 2 }, { exportedAt: '2026-02-30T12:00:00.000Z' }, { data: {} }]) {
      expect(() => parseBackup(JSON.stringify({ ...envelope, ...change }))).toThrow();
    }
  });
});

describe('описания в независимых снимках', () => {
  it.each([true, false])('история не меняется после редактирования и удаления шаблона, saveTemplate=%s', saveTemplate => {
    const original = fixture();
    original.programs[0].workouts[0].description = 'План\nтренировки';
    original.programs[0].workouts[0].exercises[0].description = 'Шаблон';
    const edited = exercises(35);
    edited[0].description = 'Фактическое\nупражнение';
    const draft = saveDraft(original, 'p', 'w1', edited);
    const state = completeWorkout(draft, saveTemplate, 'snapshot');
    const snapshot = clone(state.history[0]);
    expect(snapshot.workoutDescription).toBe('План\nтренировки');
    expect(snapshot.exercises[0].description).toBe('Фактическое\nупражнение');
    expect(state.history[0].exercises).not.toBe(state.programs[0].workouts[0].exercises);
    state.programs[0].workouts[0].description = 'Изменено';
    state.programs[0].workouts[0].exercises[0].description = 'Изменено';
    state.programs[0].workouts[0].exercises[0].sets[0].reps = 99;
    expect(state.history[0]).toStrictEqual(snapshot);
    state.programs[0].workouts.shift();
    expect(validateState(state).history[0]).toStrictEqual(snapshot);
    state.programs = [];
    state.activeProgramId = null;
    expect(validateState(state).history[0]).toStrictEqual(snapshot);
    expect(draft.programs[0].workouts[0].description).toBe('План\nтренировки');
    expect(draft.drafts).toHaveLength(1);
  });
});

describe('удаление записи истории', () => {
  it('удаляет только выбранную запись, не меняя исходное состояние, очередь, шаблоны и черновики', () => {
    let state = fixture();
    for (const id of ['first', 'middle', 'last']) state = completeWorkout(state, false, id);
    state = saveDraft(state, 'p', 'w4', exercises(45));
    const before = clone(state);
    const result = deleteHistoryEntry(state, 'middle');
    expect(result).toStrictEqual({ ...before, history: [before.history[0], before.history[2]] });
    expect(state).toStrictEqual(before);
    result.programs[0].workouts[0].exercises[0].sets[0].weightKg = 999;
    result.drafts[0].exercises[0].sets[0].reps = 99;
    result.history[0].exercises[0].name = 'Изменено';
    expect(state).toStrictEqual(before);
  });

  it('может удалить последнюю запись и отклоняет отсутствующий ID с русской ошибкой', () => {
    const state = completeWorkout(fixture(), false, 'only');
    expect(deleteHistoryEntry(state, 'only').history).toEqual([]);
    for (const id of ['missing', '']) expect(() => deleteHistoryEntry(state, id)).toThrow('Запись истории не найдена');
    expect(state.history).toHaveLength(1);
    expect(() => deleteHistoryEntry({ ...state, activeProgramId: 'missing' }, 'only')).toThrow(/программа/);
  });
});
