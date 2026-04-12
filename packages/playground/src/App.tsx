import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CereusDB } from '@cereusdb/minimal';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  Eraser,
  FileJson,
  Loader2,
  Play,
  Table as TableIcon,
  Upload,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type Row = Record<string, unknown>;
type StatusKind = 'loading' | 'ready' | 'error';
type Status = { kind: StatusKind; message: string };

const DEFAULT_QUERY = `SELECT
  ST_AsText(ST_Buffer(ST_Point(0, 0), 1.0)) AS buffered,
  ST_Distance(ST_Point(0, 0), ST_Point(3, 4)) AS distance`;

const PRESETS: Array<{ label: string; query: string }> = [
  { label: 'ST_Point', query: 'SELECT ST_AsText(ST_Point(30, 10)) AS geom' },
  {
    label: 'ST_Distance',
    query: 'SELECT ST_Distance(ST_Point(0,0), ST_Point(3,4)) AS distance',
  },
  {
    label: 'ST_Area',
    query:
      "SELECT ST_Area(ST_GeomFromWKT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))')) AS area",
  },
  {
    label: 'ST_Centroid',
    query:
      "SELECT ST_AsText(ST_Centroid(ST_GeomFromWKT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))'))) AS centroid",
  },
  {
    label: 'ST_Buffer',
    query: 'SELECT ST_AsText(ST_Buffer(ST_Point(0,0), 1.0)) AS buffered',
  },
  {
    label: 'ST_Intersects',
    query:
      "SELECT ST_Intersects(ST_GeomFromWKT('POLYGON((0 0, 10 0, 10 10, 0 10, 0 0))'), ST_Point(5, 5)) AS intersects",
  },
  { label: 'Remote parquet', query: 'SELECT * FROM remote_data LIMIT 10' },
];

const DEFAULT_REMOTE_URL =
  'https://raw.githubusercontent.com/tobilg/aws-edge-locations/main/data/aws-edge-locations.parquet';

// Module-level singleton: wasm-bindgen's generated `init()` is not reentrant,
// so concurrent callers (e.g. React 19 StrictMode double-mounting the effect)
// would race two WASM instantiations and leave the module in a corrupted state.
let dbPromise: Promise<CereusDB> | null = null;
function getDb(): Promise<CereusDB> {
  if (!dbPromise) {
    dbPromise = CereusDB.create();
  }
  return dbPromise;
}

export default function App(): React.ReactElement {
  const dbRef = useRef<CereusDB | null>(null);
  const [status, setStatus] = useState<Status>({
    kind: 'loading',
    message: 'Initializing',
  });
  const [version, setVersion] = useState<string>('loading…');
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState<string>(DEFAULT_QUERY);
  const [remoteUrl, setRemoteUrl] = useState<string>(DEFAULT_REMOTE_URL);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [timing, setTiming] = useState<string>('awaiting query');
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const refreshTables = useCallback(() => {
    const db = dbRef.current;
    if (!db) return;
    try {
      setTables(db.tables());
    } catch {
      setTables([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    getDb()
      .then((db) => {
        if (cancelled) return;
        dbRef.current = db;
        setVersion(db.version());
        setReady(true);
        setStatus({ kind: 'ready', message: 'ready' });
        try {
          setTables(db.tables());
        } catch {
          /* ignore */
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setVersion('unavailable');
        setError({
          title: 'Initialization failed',
          message: e instanceof Error ? e.message : String(e),
        });
        setStatus({ kind: 'error', message: 'init failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runQuery = useCallback(async () => {
    const db = dbRef.current;
    if (!db || !query.trim()) return;
    setRunning(true);
    setError(null);
    setStatus({ kind: 'loading', message: 'running' });
    try {
      const start = performance.now();
      const result = (await db.sqlJSON(query)) as Row[];
      const elapsed = performance.now() - start;
      setRows(result);
      setTiming(`${result.length} row${result.length === 1 ? '' : 's'} · ${elapsed.toFixed(1)}ms`);
      setStatus({ kind: 'ready', message: 'ready' });
    } catch (e) {
      setRows(null);
      setError({
        title: 'Query error',
        message: e instanceof Error ? e.message : String(e),
      });
      setStatus({ kind: 'error', message: 'query failed' });
    } finally {
      setRunning(false);
    }
  }, [query]);

  const loadRemote = useCallback(async () => {
    const db = dbRef.current;
    if (!db) return;
    const url = remoteUrl.trim();
    if (!url) {
      setError({ title: 'Remote load error', message: 'Enter a Parquet URL first.' });
      return;
    }
    setError(null);
    setStatus({ kind: 'loading', message: 'fetching parquet' });
    try {
      const start = performance.now();
      await db.registerRemoteParquet('remote_data', url);
      refreshTables();
      setQuery('SELECT * FROM remote_data LIMIT 10');
      setTiming(`remote_data registered · ${(performance.now() - start).toFixed(1)}ms`);
      setStatus({ kind: 'ready', message: 'remote loaded' });
    } catch (e) {
      setError({
        title: 'Remote load error',
        message: e instanceof Error ? e.message : String(e),
      });
      setStatus({ kind: 'error', message: 'remote load failed' });
    }
  }, [remoteUrl, refreshTables]);

  const loadLocal = useCallback(async () => {
    const db = dbRef.current;
    if (!db || !file) {
      setError({
        title: 'Local file error',
        message: 'Choose a Parquet or GeoJSON file first.',
      });
      return;
    }
    setError(null);
    setStatus({ kind: 'loading', message: `registering ${file.name}` });
    try {
      const start = performance.now();
      await db.registerFile('local_data', file);
      refreshTables();
      setQuery('SELECT * FROM local_data LIMIT 20');
      setTiming(`local_data registered · ${(performance.now() - start).toFixed(1)}ms`);
      setStatus({ kind: 'ready', message: `loaded ${file.name}` });
    } catch (e) {
      setError({
        title: 'Local file error',
        message: e instanceof Error ? e.message : String(e),
      });
      setStatus({ kind: 'error', message: 'local load failed' });
    }
  }, [file, refreshTables]);

  const clearResults = useCallback(() => {
    setRows(null);
    setError(null);
    setTiming('awaiting query');
  }, []);

  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void runQuery();
      }
    },
    [runQuery],
  );

  const columns = useMemo(() => {
    if (!rows || rows.length === 0) return [] as string[];
    const set = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) set.add(key);
    }
    return Array.from(set);
  }, [rows]);

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <AmbientBackdrop />

      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <Mark />
            <div className="flex flex-col leading-tight">
              <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                cereus / playground
              </span>
              <span className="font-semibold tracking-tight">CereusDB Minimal</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusPill status={status} />
            <Badge
              variant="outline"
              className="hidden md:inline-flex font-mono text-[10px] lowercase tracking-wider"
            >
              {version}
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 pb-24 pt-12">
        <section className="mb-12">
          <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
            </span>
            @cereusdb/minimal
          </span>
          <h1 className="text-4xl font-semibold leading-[1.02] tracking-tight sm:text-5xl md:text-[3.75rem]">
            Query{' '}
            <span className="font-display text-[1.15em] italic text-primary">
              spatial&nbsp;data
            </span>
            , in the browser.
          </h1>
          <p className="mt-6 text-base leading-relaxed text-muted-foreground sm:text-lg">
            Core spatial SQL, GEOS, relation joins, distance joins, and{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground">
              ST_KNN
            </code>{' '}
            — served from a WebAssembly runtime that never leaves the tab.
          </p>
        </section>

        <section className="grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>SQL Editor</CardTitle>
                  <CardDescription>
                    Write ad hoc spatial SQL. Results stream back as Arrow or JSON.
                  </CardDescription>
                </div>
                <kbd className="hidden shrink-0 items-center gap-1 rounded border border-border bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground sm:inline-flex">
                  <span>⌘</span>
                  <span>↵</span>
                </kbd>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="relative">
                <Textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  spellCheck={false}
                  rows={10}
                  className="min-h-[220px] font-mono text-[13px]"
                />
                <div className="pointer-events-none absolute right-3 top-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
                  sql
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void runQuery()} disabled={!ready || running}>
                  {running ? <Loader2 className="animate-spin" /> : <Play />}
                  Run query
                </Button>
                <Button variant="outline" onClick={clearResults}>
                  <Eraser /> Clear
                </Button>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {timing}
                </span>
              </div>

              <Separator />

              <div>
                <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Presets
                </p>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((preset) => (
                    <Button
                      key={preset.label}
                      variant="secondary"
                      size="sm"
                      onClick={() => setQuery(preset.query)}
                      className="font-mono text-[11px]"
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Data Loaders</CardTitle>
                <CardDescription>
                  Pull remote Parquet or register a local file in the browser.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-3">
                  <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Remote Parquet URL
                  </label>
                  <Input
                    value={remoteUrl}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                    placeholder="https://.../data.parquet"
                    className="font-mono text-[11px]"
                  />
                  <Button
                    onClick={() => void loadRemote()}
                    disabled={!ready}
                    className="w-full"
                  >
                    <Download /> Fetch & register
                  </Button>
                </div>

                <Separator />

                <div className="space-y-3">
                  <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    Local Parquet / GeoJSON
                  </label>
                  <Input
                    type="file"
                    accept=".parquet,.geoparquet,.geojson,.json,application/json"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    className="cursor-pointer p-2 text-xs file:mr-3 file:rounded-sm file:border file:border-border file:bg-muted file:px-2 file:py-1 file:font-mono file:text-[11px] file:text-muted-foreground hover:file:bg-muted/80"
                  />
                  <Button
                    variant="secondary"
                    onClick={() => void loadLocal()}
                    disabled={!ready || !file}
                    className="w-full"
                  >
                    <Upload /> Register file
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Database className="size-4 text-primary" /> Tables
                    </CardTitle>
                    <CardDescription>
                      {tables.length === 0
                        ? 'Nothing registered yet.'
                        : `${tables.length} table${tables.length === 1 ? '' : 's'} in session`}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {tables.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border/70 px-4 py-8 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    empty
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {tables.map((name) => (
                      <li
                        key={name}
                        className="group flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs"
                      >
                        <span className="flex items-center gap-2">
                          <span className="size-1.5 rounded-full bg-primary" /> {name}
                        </span>
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                          ready
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="mt-6">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>Results</CardTitle>
                  <CardDescription className="font-mono text-xs">{timing}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertTitle>{error.title}</AlertTitle>
                  <AlertDescription className="font-mono text-[11px]">
                    {error.message}
                  </AlertDescription>
                </Alert>
              )}

              <Tabs defaultValue="table">
                <TabsList>
                  <TabsTrigger value="table">
                    <TableIcon className="mr-1.5 size-3.5" /> Table
                  </TabsTrigger>
                  <TabsTrigger value="json">
                    <FileJson className="mr-1.5 size-3.5" /> JSON
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="table" className="mt-4">
                  {rows === null ? (
                    <EmptyState label="Run a query to see results." />
                  ) : rows.length === 0 ? (
                    <EmptyState label="Query returned no rows." />
                  ) : (
                    <div className="max-h-[520px] overflow-auto rounded-md border border-border bg-card/40">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {columns.map((column) => (
                              <TableHead
                                key={column}
                                className="font-mono text-[10px] uppercase tracking-[0.14em]"
                              >
                                {column}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((row, i) => (
                            <TableRow key={i}>
                              {columns.map((column) => (
                                <TableCell
                                  key={column}
                                  className="max-w-[360px] truncate font-mono text-[12px]"
                                  title={formatCell(row[column])}
                                >
                                  {formatCell(row[column])}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="json" className="mt-4">
                  <pre className="max-h-[520px] overflow-auto rounded-md border border-border bg-muted/20 p-4 font-mono text-[12px] leading-relaxed">
                    {rows === null
                      ? 'Run a query to see results.'
                      : JSON.stringify(rows, null, 2)}
                  </pre>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </section>

        <footer className="mt-16 flex flex-col items-start justify-between gap-2 border-t border-border/60 pt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground sm:flex-row sm:items-center">
          <span>cereus / playground</span>
          <span>built on @cereusdb/minimal</span>
        </footer>
      </main>
    </div>
  );
}

function AmbientBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute -left-40 -top-56 size-[620px] rounded-full bg-primary/20 blur-[140px]" />
      <div className="absolute bottom-[-20%] right-[-10%] size-[580px] rounded-full bg-primary/10 blur-[160px]" />
      <div
        className="absolute inset-0 opacity-[0.045]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(0,0,0,0.15) 1px, transparent 0)',
          backgroundSize: '30px 30px',
        }}
      />
      <div
        className="absolute inset-x-0 top-0 h-px"
        style={{
          backgroundImage:
            'linear-gradient(to right, transparent, color-mix(in oklch, var(--primary) 50%, transparent), transparent)',
        }}
      />
    </div>
  );
}

function Mark() {
  return (
    <div className="relative flex size-10 items-center justify-center">
      <div className="absolute inset-0 rounded-md border border-border bg-card/80 shadow-[0_10px_30px_-10px_oklch(0.60_0.15_52/0.35)]" />
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="relative size-5 text-primary"
        strokeWidth="1.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3v18" />
        <path d="M8 6c0 2 1.2 3 4 3s4-1 4-3" />
        <path d="M7 11c0 2 1.4 3 5 3s5-1 5-3" />
        <path d="M6 17c0 2 1.6 3 6 3s6-1 6-3" />
      </svg>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const config: Record<
    StatusKind,
    { icon: React.ReactElement; classes: string }
  > = {
    loading: {
      icon: <Loader2 className="size-3.5 animate-spin" />,
      classes: 'text-amber-700 border-amber-600/30 bg-amber-500/10',
    },
    ready: {
      icon: <CheckCircle2 className="size-3.5" />,
      classes: 'text-emerald-700 border-emerald-600/30 bg-emerald-500/10',
    },
    error: {
      icon: <AlertCircle className="size-3.5" />,
      classes: 'text-red-700 border-red-600/30 bg-red-500/10',
    },
  };
  const cfg = config[status.kind];
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em]',
        cfg.classes,
      )}
    >
      {cfg.icon}
      <span>{status.message}</span>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border/70 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
      {label}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
