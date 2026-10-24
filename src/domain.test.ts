import { describe, expect, it, vi } from 'vitest';
import { clone, completeWorkout, emptyState, exportBackup, getActiveProgram, getNextWorkout, newId, parseBackup, saveDraft, validateExercises, validateState, type AppState, type Exercise } from './domain';

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
    expect(state.programs[0].workouts[0].exercises[0].sets[0].weightKg).toBe(saveTemplate ? 45 : 20);
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

describe('валидация и резервная копия', () => {
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
