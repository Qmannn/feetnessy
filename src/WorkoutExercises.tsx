import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import type { Exercise, SetEntry } from './domain';
import { clone } from './domain';
import { formatNumber } from './format';

type Props = { exercises: Exercise[]; onChange?: (next: Exercise[]) => Promise<void>; busy?: boolean; onEditingChange?: (editing: boolean) => void };

export default function WorkoutExercises({ exercises, onChange, busy, onEditingChange }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  return <div className="stack exercise-list">{exercises.map((exercise, index) =>
    <ExerciseRow key={exercise.id} exercise={exercise} index={index} busy={busy || (activeId !== null && activeId !== exercise.id)} onEditingChange={onEditingChange}
      onStart={() => setActiveId(exercise.id)} onDone={() => setActiveId(null)}
      onChange={onChange ? async (sets) => {
        const next = clone(exercises);
        next[index].sets = sets;
        await onChange(next);
      } : undefined} />,
  )}</div>;
}

function ExerciseRow({ exercise, index, onChange, busy, onEditingChange, onStart, onDone }: {
  exercise: Exercise; index: number; onChange?: (sets: SetEntry[]) => Promise<void>; busy?: boolean; onEditingChange?: (editing: boolean) => void;
  onStart: () => void; onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [sets, setSets] = useState<{ weight: string; reps: string }[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const lastSaved = useRef('');
  const inFlight = useRef(false);
  const pending = useRef<SetEntry[] | null>(null);
  const flush = useRef<() => Promise<void>>(async () => {});
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  flush.current = async () => {
    if (inFlight.current || !pending.current) return;
    const values = pending.current;
    pending.current = null;
    const serialized = JSON.stringify(values);
    if (serialized === lastSaved.current) return;
    inFlight.current = true; setSaving(true);
    let succeeded = false;
    try {
      await changeRef.current?.(values);
      lastSaved.current = serialized; setError(''); succeeded = true;
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); }
    finally { inFlight.current = false; setSaving(false); }
    if (succeeded && pending.current) await flush.current();
  };
  useEffect(() => {
    if (editing) onEditingChange?.(true);
    return () => { if (editing) onEditingChange?.(false); };
  }, [editing, onEditingChange]);
  useEffect(() => {
    if (!editing) return;
    const values = sets.map(s => ({ weightKg: Number(s.weight.trim().replace(',', '.')), reps: Number(s.reps) }));
    if (sets.some((s, i) => !s.weight.trim() || !s.reps.trim() || !Number.isFinite(values[i].weightKg) || values[i].weightKg < 0 || !Number.isSafeInteger(values[i].reps) || values[i].reps <= 0)) {
      pending.current = null;
      return;
    }
    pending.current = values;
    void flush.current();
  }, [sets, editing]);
  useEffect(() => {
    if (!editing) return;
    const flushHidden = () => { if (document.visibilityState === 'hidden') void flush.current(); };
    document.addEventListener('visibilitychange', flushHidden);
    window.addEventListener('pagehide', flushHidden);
    return () => { document.removeEventListener('visibilitychange', flushHidden); window.removeEventListener('pagehide', flushHidden); };
  }, [editing]);
  const uniform = exercise.sets.every(s => s.weightKg === exercise.sets[0]?.weightKg && s.reps === exercise.sets[0]?.reps);
  function start() {
    onStart();
    setSets(exercise.sets.map(s => ({ weight: String(s.weightKg), reps: String(s.reps) })));
    lastSaved.current = JSON.stringify(exercise.sets);
    setError(''); setEditing(true);
  }
  async function save() {
    try {
      const values = sets.map(s => ({ weightKg: Number(s.weight.trim().replace(',', '.')), reps: Number(s.reps) }));
      if (sets.some((s, i) => !s.weight.trim() || !s.reps.trim() || !Number.isFinite(values[i].weightKg) || values[i].weightKg < 0 || !Number.isInteger(values[i].reps) || values[i].reps <= 0)) {
        throw new Error('Укажи вес от 0 кг и целое число повторов больше нуля.');
      }
      if (JSON.stringify(values) !== lastSaved.current) await onChange?.(values);
      setEditing(false); onDone();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); }
  }
  return <article className={`exercise-card ${editing ? 'is-editing' : ''}`}>
    <div className="exercise-top">
      <span className="exercise-index">{String(index + 1).padStart(2, '0')}</span>
      <div className="exercise-info"><h3>{exercise.name}</h3>
        <p className="muted">{uniform ? `${exercise.sets.length} × ${exercise.sets[0]?.reps} повторов` : `${exercise.sets.length} подх. · разные значения`}</p>
      </div>
      {onChange ? <button className="weight-pill" onClick={start} disabled={busy || editing} aria-label={`Изменить ${exercise.name}`}>
        {uniform ? <><strong>{formatNumber(exercise.sets[0]?.weightKg ?? 0)}</strong><span>кг</span></> : <span>Подходы</span>}<ChevronDown size={14} />
      </button> : uniform ? <div className="weight-readonly"><strong>{formatNumber(exercise.sets[0]?.weightKg ?? 0)}</strong> кг</div> : null}
    </div>
    {!uniform && !editing && <div className="set-summary">{exercise.sets.map((s, i) => <span key={i}>{i + 1}. {formatNumber(s.weightKg)} кг × {s.reps}</span>)}</div>}
    {editing && <div className="exercise-editor">
      <p className="muted small">Допустимые значения сохраняются автоматически. Закрой редактор перед завершением тренировки.</p>
      <div className="set-grid set-head"><span>Подход</span><span>Вес, кг</span><span>Повторы</span><span /></div>
      {sets.map((s, i) => <div className="set-grid" key={i}>
        <span className="muted">{i + 1}</span>
        <input className="field" aria-label={`Вес, подход ${i + 1}`} inputMode="decimal" value={s.weight} onChange={e => setSets(v => v.map((x, j) => j === i ? { ...x, weight: e.target.value } : x))} />
        <input className="field" aria-label={`Повторы, подход ${i + 1}`} inputMode="numeric" value={s.reps} onChange={e => setSets(v => v.map((x, j) => j === i ? { ...x, reps: e.target.value } : x))} />
        <button className="icon-button" aria-label={`Убрать подход ${i + 1}`} disabled={busy || sets.length === 1} onClick={() => setSets(v => v.filter((_, j) => j !== i))}><Minus size={16} /></button>
      </div>)}
      <div className="row wrap"><button className="button ghost" disabled={busy} onClick={() => setSets(v => [...v, { ...v[v.length - 1] }])}><Plus size={16} /> Подход</button>
        <button className="button ghost" disabled={busy} onClick={() => setSets(v => v.map(() => ({ ...v[0] })))}>Как первый</button></div>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row"><button className="button primary" disabled={busy || saving} onClick={() => void save()}>Готово</button><span className="muted small" role="status">{saving ? 'Сохраняем…' : error ? 'Не сохранено' : 'Автосохранение включено'}</span></div>
    </div>}
  </article>;
}
