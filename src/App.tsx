import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, CalendarDays, Check, CheckCheck, ChevronRight, CircleHelp, Dumbbell, History, Layers, Leaf, LoaderCircle, Plus, RotateCcw, Trash2, WifiOff } from 'lucide-react';
import type { AppState, HistoryEntry } from './domain';
import { clone, completeWorkout, deleteHistoryEntry, exportBackup, getActiveProgram, getNextWorkout, newId, parseBackup, saveDraft } from './domain';
import { loadState, persistState, replaceState } from './storage';
import Programs from './Programs';
import WorkoutExercises from './WorkoutExercises';
import Modal from './Modal';
import { formatDate } from './format';
import { registerPwa } from './pwa';

type Tab = 'workout' | 'programs' | 'history';
const message = (e: unknown) => e instanceof Error ? e.message : 'Что-то пошло не так. Попробуй ещё раз.';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const stateRef = useRef<AppState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [tab, setTab] = useState<Tab>('workout');
  const [editors, setEditors] = useState(0);
  const [undo, setUndo] = useState<AppState | null>(null);
  const [toast, setToast] = useState('');
  const [completeOpen, setCompleteOpen] = useState(false);
  const [saveTemplate, setSaveTemplate] = useState(true);
  const [backupOpen, setBackupOpen] = useState(false);
  const [imported, setImported] = useState<AppState | null>(null);
  const [importName, setImportName] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const importRequest = useRef(0);
  const [backupError, setBackupError] = useState('');
  const [detail, setDetail] = useState<HistoryEntry | null>(null);
  const [detailError, setDetailError] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [updateReady, setUpdateReady] = useState(false);
  const applyUpdate = useRef<(() => Promise<void>) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const completionId = useRef<string | null>(null);
  const completionLatch = useRef(0);
  const [completionCooldown, setCompletionCooldown] = useState(false);

  const reportEditing = useCallback((editing: boolean) => {
    setEditors(count => Math.max(0, count + (editing ? 1 : -1)));
    if (editing) { setUndo(null); setToast(''); }
  }, []);

  useEffect(() => {
    let mounted = true;
    void loadState().then(value => {
      if (mounted) { stateRef.current = value; setState(value); }
    }).catch(e => { if (mounted) setLoadError(message(e)); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    const handleOnline = () => setOnline(navigator.onLine);
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOnline);
    applyUpdate.current = registerPwa(() => setUpdateReady(true));
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOnline); };
  }, []);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => { setUndo(null); setToast(''); }, 15000);
    return () => window.clearTimeout(timer);
  }, [undo]);
  useEffect(() => {
    if (!completionCooldown) return;
    const timer = window.setTimeout(() => setCompletionCooldown(false), 1500);
    return () => window.clearTimeout(timer);
  }, [completionCooldown]);
  useEffect(() => {
    if (!editors && !busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [editors, busy]);

  async function commit(next: AppState, options: { replacement?: boolean; keepUndo?: boolean } = {}) {
    if (locked.current) throw new Error('Подожди завершения сохранения.');
    locked.current = true; setBusy(true); setError('');
    try {
      await (options.replacement ? replaceState(next) : persistState(next));
      stateRef.current = next; setState(next);
      if (!options.keepUndo) { setUndo(null); setToast(''); }
    } catch (e) { setError(`Не удалось сохранить данные: ${message(e)}`); throw e; }
    finally { locked.current = false; setBusy(false); }
  }
  const program = state ? getActiveProgram(state) : undefined;
  const workout = program ? getNextWorkout(program) : undefined;
  const draft = state?.drafts.find(d => d.programId === program?.id && d.workoutId === workout?.id);
  const exercises = draft?.exercises ?? workout?.exercises ?? [];
  const changed = Boolean(draft && workout && JSON.stringify(draft.exercises) !== JSON.stringify(workout.exercises));

  async function finish() {
    if (!stateRef.current || locked.current || editors || Date.now() < completionLatch.current) return;
    const before = clone(stateRef.current);
    completionId.current ??= newId();
    try {
      await commit(completeWorkout(before, saveTemplate, completionId.current), { keepUndo: true });
      setUndo(before); setToast('Тренировка завершена. Отличная работа!'); setCompleteOpen(false);
      completionLatch.current = Date.now() + 1500; setCompletionCooldown(true);
      completionId.current = null;
      void navigator.storage?.persist?.().catch(() => false);
    } catch { /* Keep the same operation ID for a retry. */ }
  }
  function requestFinish() {
    if (changed) { setSaveTemplate(true); setCompleteOpen(true); }
    else { setSaveTemplate(true); void finish(); }
  }
  function navigate(next: Tab) {
    if (busy || editors) return;
    setUndo(null); setToast(''); setError(''); setTab(next); setDetail(null);
  }
  async function removeHistoryEntry(entry: HistoryEntry) {
    if (!stateRef.current || locked.current) return;
    if (!window.confirm(`Удалить тренировку «${entry.workoutName}» за ${formatDate(entry.completedAt)} из истории? Очередь тренировок не изменится. Это действие нельзя отменить.`)) return;
    setDetailError('');
    try {
      await commit(deleteHistoryEntry(stateRef.current, entry.id));
      setDetail(null);
    } catch (e) { setDetailError(`Не удалось удалить запись: ${message(e)}`); }
  }
  function downloadBackup() {
    try {
      if (!stateRef.current) return;
      const url = URL.createObjectURL(new Blob([exportBackup(stateRef.current)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `feetnessy-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { setBackupError(message(e)); }
  }

  if (loadError) return <main className="loading-screen"><Dumbbell size={36} /><h1>Не удалось открыть дневник</h1><p className="error" role="alert">{loadError}</p><p className="muted">Данные не перезаписаны. Проверь доступ к хранилищу браузера и попробуй снова.</p><button className="button primary" onClick={() => window.location.reload()}>Повторить</button></main>;
  if (!state) return <main className="loading-screen"><LoaderCircle className="spin" size={32} /><p>Открываем твой дневник…</p></main>;

  const history = [...state.history].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  return <div className="app-shell">
    <header className="app-header"><a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('workout'); }} aria-label="Feetnessy — главная"><span className="brand-icon"><Dumbbell size={22} strokeWidth={2.5} /></span>feetnessy<span className="brand-dot">.</span></a><div className="header-status">{busy ? <><LoaderCircle className="spin" size={14} /> Сохраняем</> : !online ? <><WifiOff size={14} /> Без сети</> : <><span className="status-dot" /> Твой ритм</>}</div></header>
    <main className="main-content">
      {updateReady && <div className="notice"><p>Доступно обновление. Сначала закончи редактирование.</p><button className="button secondary" disabled={busy || editors > 0} onClick={() => void applyUpdate.current?.().catch(e => setError(message(e)))}>Обновить приложение</button></div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {tab === 'workout' && <>
        <div className="page-header"><p className="eyebrow">БЕЗ СПЕШКИ. ПО ПЛАНУ.</p><h1>Твой следующий шаг<span className="accent">.</span></h1><p className="muted">Неважно, когда. Главное — продолжать.</p></div>
        {!program || !workout ? <>
          <section className="welcome-card"><div className="welcome-illustration"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><Dumbbell size={68} strokeWidth={1.4} /><span className="mini-spark">✦</span></div><span className="badge">ТВОЙ ЛИЧНЫЙ ДНЕВНИК</span><h2>{program ? 'Добавим первую тренировку?' : 'Большое начинается с первого подхода'}</h2><p>Собери свою программу один раз.<br />Дальше мы подскажем, какая тренировка следующая.</p><button className="button primary" onClick={() => navigate('programs')}><Plus size={18} />{program ? 'Добавить тренировку' : 'Создать программу'}</button><button className="button ghost" onClick={() => { setBackupError(''); setImported(null); setBackupOpen(true); }}>Уже есть резервная копия? Импортировать</button></section>
          <div className="how-it-works"><div><span>01</span><p>Открой<br /><strong>тренировку</strong></p></div><ChevronRight size={16} /><div><span>02</span><p>Занимайся<br /><strong>в своём темпе</strong></p></div><ChevronRight size={16} /><div><span>03</span><p>Заверши<br /><strong>и продолжай</strong></p></div></div>
        </> : <>
          <section className="workout-hero"><div className="row spread"><span className="hero-program"><Layers size={15} />{program.name}</span><span className="cycle-badge">{program.workouts.findIndex(w => w.id === workout.id) + 1} / {program.workouts.length}</span></div><h2>{workout.name}</h2>{workout.description?.trim() && <p className="description workout-description">{workout.description}</p>}<div className="hero-meta"><span>{exercises.length} упражнений</span><span className="separator" /><span>{exercises.reduce((n, e) => n + e.sets.length, 0)} подходов</span><span className="hero-dumbbell"><Dumbbell size={76} strokeWidth={1} /></span></div><div className="cycle-progress">{program.workouts.map(w => <span key={w.id} className={w.id === workout.id ? 'current' : ''} />)}</div></section>
          <div className="section-heading"><h2>Упражнения</h2><span className="muted small">Нажми на вес, чтобы изменить</span></div>
          {exercises.length ? <WorkoutExercises key={`${program.id}-${workout.id}`} exercises={exercises} busy={busy} onEditingChange={reportEditing} onChange={async next => {
            if (!stateRef.current) return;
            await commit(saveDraft(stateRef.current, program.id, workout.id, next));
          }} /> : <div className="card empty-state"><p>Здесь пока нет упражнений.</p><button className="button secondary" onClick={() => navigate('programs')}>Редактировать программу</button></div>}
          {draft && <p className="saved-note"><Check size={14} /> Изменения сохранены на этом телефоне</p>}
          <div className="workout-footer"><div className="tip"><CircleHelp size={17} /><p>Никаких галочек у подходов.<br />Просто заверши тренировку, когда закончишь.</p></div><button className="button primary finish-button" disabled={busy || editors > 0 || completionCooldown || !exercises.length} onClick={requestFinish}><CheckCheck size={20} /> Завершить тренировку<ArrowRight size={19} /></button>{editors > 0 && <p className="muted small">Нажми «Готово» в редакторе упражнения.</p>}<p className="muted small center">Следующая тренировка появится автоматически</p></div>
        </>}
        <div className="local-note"><Leaf size={16} /><span>Без расписания. Без лишних действий. В твоём ритме.</span></div>
      </>}
      {tab === 'programs' && <Programs state={state} busy={busy} onEditingChange={reportEditing} onChange={next => commit(next)} onBackup={() => { setBackupError(''); setImported(null); setBackupOpen(true); }} />}
      {tab === 'history' && <>
        <div className="page-header"><p className="eyebrow">КАЖДАЯ ТРЕНИРОВКА СЧИТАЕТСЯ</p><h1>Твоя история<span className="accent">.</span></h1><p className="muted">Твой путь, одна тренировка за другой.</p></div>
        {history.length > 0 && <div className="history-total"><span className="history-total-icon"><CheckCheck size={23} /></span><div><strong>{history.length}</strong><p className="muted">завершено тренировок</p></div></div>}
        {history.length ? <div className="stack">{history.map(entry => <button className="history-card" key={entry.id} onClick={() => { setDetailError(''); setDetail(entry); }}><span className="history-date-icon"><CalendarDays size={20} /></span><span className="history-info"><span className="muted small">{formatDate(entry.completedAt)}</span><strong>{entry.workoutName}</strong><span className="muted small">{entry.programName} · {entry.exercises.length} упр.</span></span><ChevronRight size={18} className="muted" /></button>)}</div> : <div className="card empty-state"><span className="empty-icon"><History size={32} /></span><h2>Здесь будет твой прогресс</h2><p className="muted">Заверши первую тренировку — мы сохраним упражнения, веса и повторы.</p><button className="button secondary" onClick={() => navigate('workout')}>К тренировке <ArrowRight size={16} /></button></div>}
      </>}
    </main>
    {toast && <div className="toast" role="status"><span><Check size={18} />{toast}</span>{undo && <button disabled={busy} onClick={() => {
      if (!undo) return;
      void commit(undo).catch(() => undefined);
    }}><RotateCcw size={16} /> Отменить</button>}</div>}
    <nav className="bottom-nav" aria-label="Основная навигация">{([
      ['workout', Dumbbell, 'Тренировка'], ['programs', Layers, 'Программы'], ['history', History, 'История'],
    ] as const).map(([id, Icon, label]) => <button key={id} className={tab === id ? 'nav-item active' : 'nav-item'} aria-current={tab === id ? 'page' : undefined} disabled={busy || editors > 0} onClick={() => navigate(id)}><Icon size={22} strokeWidth={tab === id ? 2.3 : 1.7} /><span>{label}</span></button>)}</nav>
    {completeOpen && <Modal title="Сохранить новые значения?" busy={busy} onClose={() => setCompleteOpen(false)}><p className="muted">Результат в любом случае останется в истории. Выбери, какие значения использовать в следующий раз.</p><label className="checkbox-row"><input type="checkbox" checked={saveTemplate} disabled={busy} onChange={e => setSaveTemplate(e.target.checked)} /><span>Использовать изменения в следующих тренировках</span></label><button className="button primary full-width" disabled={busy} onClick={() => void finish()}><CheckCheck size={18} /> Завершить тренировку</button></Modal>}
    {detail && <Modal title={detail.workoutName} busy={busy} onClose={() => setDetail(null)}>
      <p className="muted detail-date">{formatDate(detail.completedAt)} · {detail.programName}</p>
      {detail.workoutDescription?.trim() && <p className="description history-description">{detail.workoutDescription}</p>}
      <WorkoutExercises exercises={detail.exercises} />
      <p className="muted small">Сохранённый результат. Изменения программы на него не влияют.</p>
      <div className="history-actions">
        <p className="muted small">Удаление записи не меняет очередь тренировок.</p>
        {detailError && <p className="error" role="alert">{detailError}</p>}
        <button className="button danger full-width" disabled={busy} onClick={() => void removeHistoryEntry(detail)}><Trash2 size={18} /> Удалить из истории</button>
      </div>
    </Modal>}
    {backupOpen && <Modal title="Резервная копия" busy={busy} onClose={() => { importRequest.current++; setReadingFile(false); setBackupOpen(false); setImported(null); }}><div className="stack"><p className="muted">Данные хранятся только на этом телефоне. При очистке браузера или потере телефона история может исчезнуть. Сохраняй копию в файлы или облако.</p><button className="button primary" disabled={busy} onClick={downloadBackup}><ArrowDownToLine size={18} /> Скачать копию</button><div className="divider" /><h3>Восстановить из файла</h3><p className="muted small">Импорт заменит все текущие программы, историю и незавершённые изменения. Сначала рекомендуем скачать текущую копию.</p><input ref={fileRef} className="file-input" type="file" accept=".json,application/json" aria-label="Файл резервной копии" disabled={busy || readingFile} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = ''; setBackupError(''); setImported(null); setImportName('');
      const request = ++importRequest.current;
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { setBackupError('Файл слишком большой: максимум 20 МБ.'); return; }
      setReadingFile(true);
      void file.text().then(text => {
        if (request !== importRequest.current) return;
        setImported(parseBackup(text)); setImportName(file.name);
      }).catch(e => { if (request === importRequest.current) setBackupError(message(e)); }).finally(() => { if (request === importRequest.current) setReadingFile(false); });
    }} /><button className="button secondary" disabled={busy || readingFile} onClick={() => fileRef.current?.click()}><ArrowUpFromLine size={18} /> {readingFile ? 'Читаем копию…' : 'Выбрать файл'}</button>{backupError && <p className="error" role="alert">{backupError}</p>}{imported && <div className="import-preview"><h3>Копия готова к восстановлению</h3><p className="muted small">{importName}</p><p>{imported.programs.length} программ · {imported.history.length} тренировок в истории</p><button className="button danger" disabled={busy} onClick={() => {
      if (!window.confirm('Заменить все текущие данные этой копией? Это действие нельзя отменить.')) return;
      void commit(imported, { replacement: true }).then(() => { setImported(null); setBackupOpen(false); setTab('workout'); }).catch(e => setBackupError(message(e)));
    }}>Заменить текущие данные</button></div>}</div></Modal>}
  </div>;
}
