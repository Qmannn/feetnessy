export interface SetEntry { weightKg: number; reps: number }
export interface Exercise { id: string; name: string; description?: string; sets: SetEntry[] }
export interface Workout { id: string; name: string; description?: string; exercises: Exercise[] }
export interface Program { id: string; name: string; workouts: Workout[]; nextWorkoutId: string | null }
export interface Draft { programId: string; workoutId: string; exercises: Exercise[]; updatedAt: string }
export interface HistoryEntry {
  id: string; programId: string; workoutId: string; programName: string; workoutName: string;
  workoutDescription?: string; exercises: Exercise[]; completedAt: string;
}
export interface AppState {
  schemaVersion: 1; activeProgramId: string | null; programs: Program[]; drafts: Draft[]; history: HistoryEntry[];
}

export const emptyState = (): AppState => ({ schemaVersion: 1, activeProgramId: null, programs: [], drafts: [], history: [] });
export const newId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const clone = <T>(value: T): T => structuredClone(value);
export const getActiveProgram = (state: AppState): Program | undefined => state.programs.find(p => p.id === state.activeProgramId);
export const getNextWorkout = (program: Program): Workout | undefined => program.workouts.find(w => w.id === program.nextWorkoutId);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function record(value: unknown, keys: string[], label: string, optionalKeys: string[] = []): asserts value is Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), `${label}: ожидается объект`);
  check(keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key) || optionalKeys.includes(key)), `${label}: неверный набор полей`);
}
function optionalDescription(value: Record<string, unknown>, key: string): void {
  check(!Object.hasOwn(value, key) || typeof value[key] === 'string', 'Описание должно быть строкой');
}
function text(value: unknown, label: string): asserts value is string {
  check(typeof value === 'string' && value.trim().length > 0, `${label}: строка не должна быть пустой`);
}
function array(value: unknown, label: string): asserts value is unknown[] {
  check(Array.isArray(value), `${label}: ожидается массив`);
}
function unique(id: string, ids: Set<string>, label: string): void {
  check(!ids.has(id), `${label}: повторяющийся ID`);
  ids.add(id);
}
function timestamp(value: unknown): void {
  text(value, 'Дата');
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)), 'Некорректная дата ISO');
  // Reject normalized invalid calendar dates, e.g. February 30.
  check(new Date(value).toISOString().slice(0, 19) === value.slice(0, 19), 'Некорректная дата ISO');
}

export function validateExercises(exercises: unknown): asserts exercises is Exercise[] {
  array(exercises, 'Упражнения');
  const ids = new Set<string>();
  for (const exercise of exercises) {
    record(exercise, ['id', 'name', 'sets'], 'Упражнение', ['description']);
    optionalDescription(exercise, 'description');
    text(exercise.id, 'ID упражнения');
    unique(exercise.id, ids, 'Упражнения');
    text(exercise.name, 'Название упражнения');
    array(exercise.sets, 'Подходы');
    check(exercise.sets.length > 0, 'В упражнении нужен хотя бы один подход');
    for (const set of exercise.sets) {
      record(set, ['weightKg', 'reps'], 'Подход');
      check(typeof set.weightKg === 'number' && Number.isFinite(set.weightKg) && set.weightKg >= 0, 'Вес должен быть конечным неотрицательным числом');
      check(typeof set.reps === 'number' && Number.isSafeInteger(set.reps) && set.reps > 0, 'Повторы должны быть положительным целым числом');
    }
  }
}

/** Validate without repairing or normalizing data; return a detached snapshot. */
export function validateState(input: unknown): AppState {
  record(input, ['schemaVersion', 'activeProgramId', 'programs', 'drafts', 'history'], 'Состояние');
  check(input.schemaVersion === 1, 'Неподдерживаемая версия схемы');
  check(input.activeProgramId === null || typeof input.activeProgramId === 'string', 'Некорректная активная программа');
  array(input.programs, 'Программы');
  array(input.drafts, 'Черновики');
  array(input.history, 'История');
  const programs = new Map<string, Set<string>>();
  const workouts = new Set<string>();
  for (const program of input.programs) {
    record(program, ['id', 'name', 'workouts', 'nextWorkoutId'], 'Программа');
    text(program.id, 'ID программы');
    text(program.name, 'Название программы');
    check(!programs.has(program.id), 'Программы: повторяющийся ID');
    array(program.workouts, 'Тренировки');
    const ownWorkouts = new Set<string>();
    programs.set(program.id, ownWorkouts);
    for (const workout of program.workouts) {
      record(workout, ['id', 'name', 'exercises'], 'Тренировка', ['description']);
      optionalDescription(workout, 'description');
      text(workout.id, 'ID тренировки');
      text(workout.name, 'Название тренировки');
      unique(workout.id, workouts, 'Тренировки');
      ownWorkouts.add(workout.id);
      validateExercises(workout.exercises);
    }
    check(ownWorkouts.size === 0 ? program.nextWorkoutId === null : typeof program.nextWorkoutId === 'string' && ownWorkouts.has(program.nextWorkoutId), 'Очередь ссылается на отсутствующую тренировку');
  }
  check(input.activeProgramId === null || programs.has(input.activeProgramId as string), 'Активная программа не найдена');
  const drafts = new Set<string>();
  for (const draft of input.drafts) {
    record(draft, ['programId', 'workoutId', 'exercises', 'updatedAt'], 'Черновик');
    text(draft.programId, 'ID программы черновика');
    text(draft.workoutId, 'ID тренировки черновика');
    check(programs.get(draft.programId)?.has(draft.workoutId), 'Черновик ссылается на отсутствующую тренировку');
    unique(JSON.stringify([draft.programId, draft.workoutId]), drafts, 'Черновики');
    validateExercises(draft.exercises);
    timestamp(draft.updatedAt);
  }
  const history = new Set<string>();
  for (const entry of input.history) {
    record(entry, ['id', 'programId', 'workoutId', 'programName', 'workoutName', 'exercises', 'completedAt'], 'Запись истории', ['workoutDescription']);
    optionalDescription(entry, 'workoutDescription');
    text(entry.id, 'ID записи истории');
    unique(entry.id, history, 'История');
    text(entry.programId, 'ID программы истории');
    text(entry.workoutId, 'ID тренировки истории');
    text(entry.programName, 'Название программы истории');
    text(entry.workoutName, 'Название тренировки истории');
    validateExercises(entry.exercises);
    check(entry.exercises.length > 0, 'История не может содержать пустую тренировку');
    timestamp(entry.completedAt);
    // Historical references intentionally survive template/program deletion.
  }
  return clone(input as unknown as AppState);
}

export function saveDraft(state: AppState, programId: string, workoutId: string, exercises: Exercise[]): AppState {
  const next = validateState(state);
  check(next.programs.find(p => p.id === programId)?.workouts.some(w => w.id === workoutId), 'Тренировка для черновика не найдена');
  validateExercises(exercises);
  next.drafts = next.drafts.filter(d => d.programId !== programId || d.workoutId !== workoutId);
  next.drafts.push({ programId, workoutId, exercises: clone(exercises), updatedAt: new Date().toISOString() });
  return next;
}

export function completeWorkout(state: AppState, saveTemplate: boolean, completionId = newId()): AppState {
  const next = validateState(state);
  text(completionId, 'ID завершения');
  if (next.history.some(entry => entry.id === completionId)) return next;
  const program = getActiveProgram(next);
  check(program, 'Выберите активную программу');
  const workout = getNextWorkout(program);
  check(workout, 'Нет следующей тренировки');
  const draft = next.drafts.find(d => d.programId === program.id && d.workoutId === workout.id);
  const exercises = clone(draft?.exercises ?? workout.exercises);
  validateExercises(exercises);
  check(exercises.length > 0, 'Нельзя завершить пустую тренировку');
  next.history.push({ id: completionId, programId: program.id, workoutId: workout.id, programName: program.name, workoutName: workout.name, ...(Object.hasOwn(workout, 'description') ? { workoutDescription: workout.description } : {}), exercises, completedAt: new Date().toISOString() });
  if (saveTemplate && draft) workout.exercises = clone(exercises);
  program.nextWorkoutId = program.workouts[(program.workouts.indexOf(workout) + 1) % program.workouts.length].id;
  next.drafts = next.drafts.filter(d => d.programId !== program.id || d.workoutId !== workout.id);
  return next;
}

export function deleteHistoryEntry(state: AppState, entryId: string): AppState {
  const next = validateState(state);
  const index = next.history.findIndex(entry => entry.id === entryId);
  check(index !== -1, 'Запись истории не найдена');
  next.history.splice(index, 1);
  return next;
}

export function exportBackup(state: AppState): string {
  return JSON.stringify({ format: 'feetnessy', version: 1, exportedAt: new Date().toISOString(), data: validateState(state) }, null, 2);
}

export function parseBackup(json: string): AppState {
  let envelope: unknown;
  try { envelope = JSON.parse(json); } catch { throw new Error('Резервная копия содержит некорректный JSON'); }
  record(envelope, ['format', 'version', 'exportedAt', 'data'], 'Резервная копия');
  check(envelope.format === 'feetnessy', 'Неизвестный формат резервной копии');
  check(envelope.version === 1, 'Неподдерживаемая версия резервной копии');
  timestamp(envelope.exportedAt);
  return validateState(envelope.data);
}
