import { CereusDB } from '@cereusdb/standard';

type Row = Record<string, unknown>;

const statusEl = document.getElementById('status') as HTMLDivElement;
const versionEl = document.getElementById('version') as HTMLDivElement;
const queryEl = document.getElementById('query') as HTMLTextAreaElement;
const runBtn = document.getElementById('runBtn') as HTMLButtonElement;
const clearBtn = document.getElementById('clearBtn') as HTMLButtonElement;
const remoteUrlEl = document.getElementById('remoteUrl') as HTMLInputElement;
const loadRemoteBtn = document.getElementById('loadRemoteBtn') as HTMLButtonElement;
const fileInputEl = document.getElementById('fileInput') as HTMLInputElement;
const loadFileBtn = document.getElementById('loadFileBtn') as HTMLButtonElement;
const tablesEl = document.getElementById('tables') as HTMLPreElement;
const tableHintEl = document.getElementById('tableHint') as HTMLSpanElement;
const timingEl = document.getElementById('timing') as HTMLSpanElement;
const resultsJsonEl = document.getElementById('resultsJson') as HTMLPreElement;
const resultsTableEl = document.getElementById('resultsTable') as HTMLTableElement;

let db: CereusDB | null = null;

function setStatus(kind: 'loading' | 'ready' | 'error', message: string): void {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = message;
}

function setButtonsEnabled(enabled: boolean): void {
  runBtn.disabled = !enabled;
  loadRemoteBtn.disabled = !enabled;
  loadFileBtn.disabled = !enabled;
}

function renderTables(): void {
  const tables = db?.tables() ?? [];
  tablesEl.textContent = JSON.stringify(tables, null, 2);
  tableHintEl.textContent = tables.length === 0 ? 'No tables yet' : `${tables.length} table(s) registered`;
}

function renderResultTable(rows: Row[]): void {
  resultsTableEl.innerHTML = '';

  if (rows.length === 0) {
    return;
  }

  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>()),
  );

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((column) => {
    const th = document.createElement('th');
    th.textContent = column;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  const tbody = document.createElement('tbody');
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    columns.forEach((column) => {
      const td = document.createElement('td');
      const value = row[column];
      td.textContent = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  resultsTableEl.appendChild(thead);
  resultsTableEl.appendChild(tbody);
}

function setResult(rows: Row[], elapsedMs: number): void {
  renderResultTable(rows);
  resultsJsonEl.textContent = `${JSON.stringify(rows, null, 2)}\n\n(${rows.length} row(s), ${elapsedMs.toFixed(1)}ms)`;
  timingEl.textContent = `Executed in ${elapsedMs.toFixed(1)}ms`;
}

function setError(prefix: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  resultsJsonEl.textContent = `${prefix}: ${message}`;
  resultsTableEl.innerHTML = '';
}

async function runQuery(): Promise<void> {
  if (!db) {
    return;
  }

  const query = queryEl.value.trim();
  if (!query) {
    return;
  }

  runBtn.disabled = true;
  setStatus('loading', 'Running query…');

  try {
    const start = performance.now();
    const rows = await db.sqlJSON(query);
    setResult(rows, performance.now() - start);
    setStatus('ready', 'Ready');
  } catch (error) {
    setError('Query error', error);
    setStatus('error', 'Query failed');
  } finally {
    runBtn.disabled = false;
  }
}

async function loadRemoteParquet(): Promise<void> {
  if (!db) {
    return;
  }

  const url = remoteUrlEl.value.trim();
  if (!url) {
    setError('Remote load error', 'Enter a Parquet URL first');
    return;
  }

  loadRemoteBtn.disabled = true;
  setStatus('loading', 'Loading remote Parquet…');

  try {
    const start = performance.now();
    await db.registerRemoteParquet('remote_data', url);
    renderTables();
    queryEl.value = 'SELECT * FROM remote_data LIMIT 10';
    resultsJsonEl.textContent = `Loaded remote_data from ${url}\n\n(${(performance.now() - start).toFixed(1)}ms)`;
    resultsTableEl.innerHTML = '';
    timingEl.textContent = 'Remote table registered';
    setStatus('ready', 'Remote Parquet loaded');
  } catch (error) {
    setError('Remote load error', error);
    setStatus('error', 'Remote load failed');
  } finally {
    loadRemoteBtn.disabled = false;
  }
}

async function loadLocalFile(): Promise<void> {
  if (!db) {
    return;
  }

  const file = fileInputEl.files?.[0];
  if (!file) {
    setError('Local file error', 'Choose a Parquet or GeoJSON file first');
    return;
  }

  loadFileBtn.disabled = true;
  setStatus('loading', `Registering ${file.name}…`);

  const tableName = 'local_data';

  try {
    const start = performance.now();
    await db.registerFile(tableName, file);
    renderTables();
    queryEl.value = `SELECT * FROM ${tableName} LIMIT 20`;
    resultsJsonEl.textContent = `Registered ${file.name} as ${tableName}\n\n(${(performance.now() - start).toFixed(1)}ms)`;
    resultsTableEl.innerHTML = '';
    timingEl.textContent = 'Local file registered';
    setStatus('ready', `Loaded ${file.name}`);
  } catch (error) {
    setError('Local file error', error);
    setStatus('error', 'Local file load failed');
  } finally {
    loadFileBtn.disabled = false;
  }
}

async function initialize(): Promise<void> {
  setStatus('loading', 'Initializing standard package…');
  setButtonsEnabled(false);

  try {
    db = await CereusDB.create();
    versionEl.textContent = db.version();
    renderTables();
    setButtonsEnabled(true);
    setStatus('ready', 'Ready');
  } catch (error) {
    versionEl.textContent = 'Unavailable';
    setError('Initialization error', error);
    setStatus('error', 'Initialization failed');
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-query]').forEach((button) => {
  button.addEventListener('click', () => {
    queryEl.value = button.dataset.query ?? '';
  });
});

runBtn.addEventListener('click', () => {
  void runQuery();
});

clearBtn.addEventListener('click', () => {
  resultsTableEl.innerHTML = '';
  resultsJsonEl.textContent = 'Results cleared.';
  timingEl.textContent = 'No query executed yet';
});

loadRemoteBtn.addEventListener('click', () => {
  void loadRemoteParquet();
});

loadFileBtn.addEventListener('click', () => {
  void loadLocalFile();
});

queryEl.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    void runQuery();
  }
});

void initialize();
