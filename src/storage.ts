import Dexie, { type Table } from 'dexie';
import { emptyState, validateState, type AppState } from './domain';

interface StateRow { id: 'current'; state: AppState; revision?: number }

class FeetnessyDatabase extends Dexie {
  states!: Table<StateRow, string>;

  constructor() {
    super('feetnessy');
    this.version(1).stores({ states: 'id' });
  }
}

export const db = new FeetnessyDatabase();
let expectedRevision: number | undefined;

const reloadMessage = 'Данные изменились в другой вкладке. Перезагрузите приложение перед сохранением.';

export async function loadState(): Promise<AppState> {
  const row = await db.states.get('current');
  const state = row ? validateState(row.state) : emptyState();
  expectedRevision = row?.revision ?? 0;
  return state;
}

/** One versioned row makes completion and full replacement atomic. Errors propagate. */
export async function persistState(state: AppState): Promise<void> {
  // Capture before yielding: concurrent callers must not adopt each other's revision.
  const observedRevision = expectedRevision;
  const snapshot = validateState(state);
  if (observedRevision === undefined) throw new Error('Сначала загрузите данные. Перезагрузите приложение перед сохранением.');
  await db.transaction('rw', db.states, async () => {
    const row = await db.states.get('current');
    if ((row?.revision ?? 0) !== observedRevision) throw new Error(reloadMessage);
    await db.states.put({ id: 'current', state: snapshot, revision: observedRevision + 1 });
  });
  expectedRevision = observedRevision + 1;
}

export async function replaceState(state: AppState): Promise<void> {
  await persistState(state);
}
