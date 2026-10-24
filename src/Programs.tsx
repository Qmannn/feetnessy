import { useEffect, useRef, useState } from 'react';
import type { AppState, Program } from './domain';
import { clone, newId, validateExercises } from './domain';

type EditableSet = { weightKg: string; reps: string };
type EditableExercise = { id: string; name: string; description?: string; sets: EditableSet[] };
type EditableWorkout = { id: string; name: string; description?: string; exercises: EditableExercise[] };
type EditableProgram = Omit<Program, 'workouts'> & { workouts: EditableWorkout[] };
type Props = {
  state: AppState;
  onChange: (next: AppState) => Promise<void>;
  onBackup: () => void;
  busy: boolean;
  onEditingChange?: (editing: boolean) => void;
};

function editable(program: Program): EditableProgram {
  return {
    ...clone(program),
    workouts: program.workouts.map(workout => ({
      ...workout,
      exercises: workout.exercises.map(exercise => ({
        ...exercise,
        sets: exercise.sets.map(set => ({ weightKg: String(set.weightKg), reps: String(set.reps) })),
      })),
    })),
  };
}

function numeric(value: string): number {
  const text = value.trim().replace(',', '.');
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : NaN;
}

function materialize(editor: EditableProgram): Program {
  if (!editor.name.trim()) throw new Error('Введите название программы.');
  return {
    ...editor,
    name: editor.name.trim(),
    workouts: editor.workouts.map(workout => {
      if (!workout.name.trim()) throw new Error('Введите название каждой тренировки.');
      const exercises = workout.exercises.map(exercise => ({
        ...exercise,
        name: exercise.name.trim(),
        sets: exercise.sets.map(set => ({ weightKg: numeric(set.weightKg), reps: numeric(set.reps) })),
      }));
      validateExercises(exercises);
      return { ...workout, name: workout.name.trim(), exercises };
    }),
  };
}

function move<T>(items: T[], index: number, direction: number): T[] {
  const result = [...items];
  const target = index + direction;
  if (target >= 0 && target < result.length) {
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export default function Programs({ state, onChange, onBackup, busy, onEditingChange }: Props) {
  const [editor, setEditor] = useState<EditableProgram | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [expandedWorkout, setExpandedWorkout] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const disabled = busy || saving;
  const editingCallback = useRef(onEditingChange);
  const editing = editor !== null;

  useEffect(() => {
    editingCallback.current = onEditingChange;
  }, [onEditingChange]);

  useEffect(() => {
    editingCallback.current?.(editing);
  }, [editing]);

  useEffect(() => () => {
    editingCallback.current?.(false);
  }, []);

  async function persist(next: AppState, closeEditor = false) {
    if (busy || lock.current) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      await onChange(next);
      if (closeEditor) setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить изменения. Попробуйте ещё раз.');
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  function start(program?: Program) {
    setError('');
    setOriginal(program ? JSON.stringify(program) : null);
    setEditor(program ? editable(program) : { id: newId(), name: '', workouts: [], nextWorkoutId: null });
    setExpandedWorkout(null);
  }

  function update(change: (value: EditableProgram) => void) {
    setEditor(current => {
      if (!current) return current;
      const next = clone(current);
      change(next);
      return next;
    });
  }

  function confirmDraftReset(programId: string): boolean {
    return !state.drafts.some(draft => draft.programId === programId)
      || window.confirm('В этой программе есть незавершённые изменения тренировки. Сохранение сбросит её черновики. Продолжить?');
  }

  async function save() {
    if (!editor || disabled || lock.current) return;
    setError('');
    try {
      const program = materialize(editor);
      const current = state.programs.find(item => item.id === program.id);
      if (original !== null && JSON.stringify(current) !== original) {
        throw new Error('Программа изменилась, пока открыт редактор. Отмените редактирование и откройте её заново.');
      }
      if (original !== null && JSON.stringify(program) === original) {
        setEditor(null);
        return;
      }
      if (!confirmDraftReset(program.id)) return;
      const next = clone(state);
      next.programs = current
        ? next.programs.map(item => item.id === program.id ? program : item)
        : [...next.programs, program];
      if (next.activeProgramId === null) next.activeProgramId = program.id;
      next.drafts = next.drafts.filter(draft => draft.programId !== program.id);
      await persist(next, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Проверьте введённые значения.');
    }
  }

  async function deleteProgram(program: Program) {
    if (disabled || lock.current) return;
    if (!window.confirm(`Удалить программу «${program.name}» и все её тренировки? История сохранится.`)) return;
    if (!confirmDraftReset(program.id)) return;
    const next = clone(state);
    next.programs = next.programs.filter(item => item.id !== program.id);
    next.drafts = next.drafts.filter(draft => draft.programId !== program.id);
    if (next.activeProgramId === program.id) next.activeProgramId = next.programs[0]?.id ?? null;
    await persist(next);
  }

  function deleteWorkout(index: number) {
    if (!editor) return;
    const workout = editor.workouts[index];
    if (!window.confirm(`Удалить тренировку «${workout.name || 'Без названия'}»?`)) return;
    update(value => {
      if (value.nextWorkoutId === workout.id) {
        value.nextWorkoutId = value.workouts.length > 1
          ? value.workouts[(index + 1) % value.workouts.length].id : null;
      }
      value.workouts.splice(index, 1);
    });
    if (expandedWorkout === workout.id) setExpandedWorkout(null);
  }

  return <section className="stack" aria-labelledby="programs-heading">
    <header className="page-header">
      <p className="eyebrow">Feetnessy · ваш план</p>
      <h1 id="programs-heading">Программы</h1>
      <p className="muted">Свой ритм, своя очередь тренировок. Без привязки к календарю.</p>
    </header>
    {error && <p className="error" role="alert">{error}</p>}

    {editor ? <form className="card editor stack" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="section-heading">
        <h2>{original === null ? 'Новая программа' : 'Редактирование программы'}</h2>
        <p className="muted">Изменения применятся только после сохранения всей программы.</p>
      </div>
      <fieldset disabled={disabled} className="stack" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className="field"><span className="field-label">Название программы</span>
          <input autoFocus value={editor.name} onChange={event => update(value => { value.name = event.target.value; })} />
        </label>
        <h3>Тренировки <span className="badge">{editor.workouts.length}</span></h3>
        {editor.workouts.length === 0 && <p className="empty-state">Пока нет тренировок. Можно добавить их сейчас или сохранить программу пустой.</p>}
        {editor.workouts.map((workout, wi) => <section key={workout.id} className="card stack">
          <div className="row spread">
            <button type="button" className="button ghost" aria-expanded={expandedWorkout === workout.id}
              aria-controls={`workout-${workout.id}`} onClick={() => setExpandedWorkout(expandedWorkout === workout.id ? null : workout.id)}>
              {wi + 1}. {workout.name || 'Новая тренировка'} {expandedWorkout === workout.id ? '−' : '+'}
            </button>
            {editor.nextWorkoutId === workout.id && <span className="badge">Следующая</span>}
          </div>
          <div className="row">
            <button type="button" className="icon-button" disabled={wi === 0} aria-label={`Поднять тренировку ${wi + 1}`} onClick={() => update(value => { value.workouts = move(value.workouts, wi, -1); })}>↑</button>
            <button type="button" className="icon-button" disabled={wi === editor.workouts.length - 1} aria-label={`Опустить тренировку ${wi + 1}`} onClick={() => update(value => { value.workouts = move(value.workouts, wi, 1); })}>↓</button>
            <button type="button" className="button danger" onClick={() => deleteWorkout(wi)}>Удалить тренировку</button>
          </div>
          {expandedWorkout === workout.id && <div id={`workout-${workout.id}`} className="stack">
            <label className="field"><span className="field-label">Название тренировки</span>
              <input value={workout.name} onChange={event => update(value => { value.workouts[wi].name = event.target.value; })} />
            </label>
            <label className="field"><span className="field-label">Описание тренировки <span aria-hidden="true">(необязательно)</span></span>
              <textarea aria-label="Описание тренировки" rows={3} value={workout.description ?? ''} placeholder="Особенности тренировки, техника и отдых"
                onChange={event => update(value => { value.workouts[wi].description = event.target.value; })} />
            </label>
            {workout.exercises.length === 0 && <p className="muted">Нет упражнений. Пустой шаблон можно сохранить, но нельзя завершить как тренировку.</p>}
            {workout.exercises.map((exercise, ei) => <section className="exercise-card stack" key={exercise.id} aria-label={`Упражнение ${ei + 1}`}>
              <label className="field"><span className="field-label">Упражнение {ei + 1}</span>
                <input value={exercise.name} onChange={event => update(value => { value.workouts[wi].exercises[ei].name = event.target.value; })} />
              </label>
              <label className="field"><span className="field-label">Описание упражнения <span aria-hidden="true">(необязательно)</span></span>
                <textarea aria-label="Описание упражнения" rows={3} value={exercise.description ?? ''} placeholder="Подсказки по технике и отдых между подходами"
                  onChange={event => update(value => { value.workouts[wi].exercises[ei].description = event.target.value; })} />
              </label>
              <div className="row">
                <button type="button" className="icon-button" disabled={ei === 0} aria-label={`Поднять упражнение ${ei + 1}`} onClick={() => update(value => { value.workouts[wi].exercises = move(value.workouts[wi].exercises, ei, -1); })}>↑</button>
                <button type="button" className="icon-button" disabled={ei === workout.exercises.length - 1} aria-label={`Опустить упражнение ${ei + 1}`} onClick={() => update(value => { value.workouts[wi].exercises = move(value.workouts[wi].exercises, ei, 1); })}>↓</button>
                <button type="button" className="button danger" onClick={() => {
                  if (window.confirm(`Удалить упражнение «${exercise.name || 'Без названия'}»?`)) update(value => { value.workouts[wi].exercises.splice(ei, 1); });
                }}>Удалить упражнение</button>
              </div>
              {exercise.sets.map((set, si) => <div className="set-grid" key={si}>
                <span className="muted">{si + 1}</span>
                <label className="field"><span className="field-label">Вес, кг · подход {si + 1}</span>
                  <input type="text" inputMode="decimal" value={set.weightKg} aria-label={`Вес, кг, упражнение ${ei + 1}, подход ${si + 1}`}
                    onChange={event => update(value => { value.workouts[wi].exercises[ei].sets[si].weightKg = event.target.value; })} />
                </label>
                <label className="field"><span className="field-label">Повторы · подход {si + 1}</span>
                  <input type="text" inputMode="numeric" value={set.reps} aria-label={`Повторы, упражнение ${ei + 1}, подход ${si + 1}`}
                    onChange={event => update(value => { value.workouts[wi].exercises[ei].sets[si].reps = event.target.value; })} />
                </label>
                <button type="button" className="icon-button" disabled={exercise.sets.length === 1} aria-label={`Удалить подход ${si + 1} упражнения ${ei + 1}`} onClick={() => {
                  if (window.confirm(`Удалить подход ${si + 1}?`)) update(value => { value.workouts[wi].exercises[ei].sets.splice(si, 1); });
                }}>×</button>
              </div>)}
              <button type="button" className="button secondary" onClick={() => update(value => {
                const sets = value.workouts[wi].exercises[ei].sets;
                sets.push({ ...sets[sets.length - 1] });
              })}>Добавить подход</button>
            </section>)}
            <button type="button" className="button secondary" onClick={() => update(value => {
              value.workouts[wi].exercises.push({ id: newId(), name: '', sets: [{ weightKg: '0', reps: '10' }] });
            })}>Добавить упражнение</button>
          </div>}
        </section>)}
        <button type="button" className="button secondary" onClick={() => {
          const id = newId();
          update(value => {
            value.workouts.push({ id, name: '', exercises: [] });
            if (value.nextWorkoutId === null) value.nextWorkoutId = id;
          });
          setExpandedWorkout(id);
        }}>Добавить тренировку</button>
        <div className="row">
          <button type="submit" className="button primary">{saving ? 'Сохранение…' : 'Сохранить программу'}</button>
          <button type="button" className="button ghost" onClick={() => { setEditor(null); setError(''); }}>Отмена</button>
        </div>
      </fieldset>
    </form> : <>
      <button type="button" className="button primary" disabled={disabled} onClick={() => start()}>Создать программу</button>
      {state.programs.length === 0 && <div className="card empty-state">
        <h2>Ваш план начинается здесь</h2>
        <p className="muted">Создайте первую программу или импортируйте свою резервную копию. Упражнения добавляете только вы.</p>
        <button type="button" className="button secondary" disabled={disabled} onClick={onBackup}>Импортировать копию</button>
      </div>}
      {state.programs.map(program => <article className="card program-card stack" key={program.id}>
        <div className="row spread"><h2>{program.name}</h2>{program.id === state.activeProgramId && <span className="badge">Активна</span>}</div>
        <p className="muted">Тренировок: {program.workouts.length}</p>
        {program.workouts.length > 0 && <ol className="stack">{program.workouts.map(workout => <li key={workout.id}>
          {workout.name}{workout.id === program.nextWorkoutId && <span className="badge"> Следующая</span>}
        </li>)}</ol>}
        <div className="row">
          {program.id !== state.activeProgramId && <button type="button" className="button primary" disabled={disabled} onClick={() => { void persist({ ...clone(state), activeProgramId: program.id }); }}>Сделать активной</button>}
          <button type="button" className="button secondary" disabled={disabled} onClick={() => start(program)}>Редактировать</button>
          <button type="button" className="button danger" disabled={disabled} onClick={() => { void deleteProgram(program); }}>Удалить</button>
        </div>
      </article>)}
    </>}
    <aside className="card stack">
      <h2>Резервная копия</h2>
      <p className="muted">Данные хранятся только на этом устройстве. Очистка браузера или потеря телефона может удалить их. Регулярно сохраняйте копию.</p>
      <button type="button" className="button secondary" disabled={disabled || editor !== null} onClick={onBackup}>Экспорт и импорт</button>
    </aside>
  </section>;
}
