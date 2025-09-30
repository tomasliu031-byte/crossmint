import 'dotenv/config';

declare const global: any;
const g: any = globalThis as any;
if (typeof g.fetch !== 'function') {
  (global as any).fetch = require('node-fetch');
}


type Point = { row: number; column: number };

enum CellKind {
  SPACE = 'SPACE',
  POLYANET = 'POLYANET',
  SOLOON = 'SOLOON',
  COMETH = 'COMETH',
}

type Color = 'blue' | 'red' | 'purple' | 'white';

type Direction = 'up' | 'down' | 'left' | 'right';

interface CellSpace { kind: CellKind.SPACE; }
interface CellPolyanet { kind: CellKind.POLYANET; }
interface CellSoloon { kind: CellKind.SOLOON; color: Color; }
interface CellCometh { kind: CellKind.COMETH; direction: Direction; }

type Cell = CellSpace | CellPolyanet | CellSoloon | CellCometh;

class Grid {
  constructor(public readonly height: number, public readonly width: number) {
    if (height <= 0 || width <= 0 || !Number.isInteger(height) || !Number.isInteger(width)) {
      throw new Error('Grid dimensions must be positive integers');
    }
  }
  inBounds(p: Point): boolean {
    return p.row >= 0 && p.row < this.height && p.column >= 0 && p.column < this.width;
  }
}

// ------------------------------ Parsing ------------------------------

function parseToken(token: string): Cell {
  if (token === 'SPACE') return { kind: CellKind.SPACE };
  if (token === 'POLYANET') return { kind: CellKind.POLYANET };

  // e.g., "BLUE_SOLOON"
  const soloonMatch = token.match(/^(BLUE|RED|PURPLE|WHITE)_SOLOON$/);
  if (soloonMatch) {
    const color = soloonMatch[1].toLowerCase() as Color;
    return { kind: CellKind.SOLOON, color };
  }

  // e.g., "LEFT_COMETH"
  const comethMatch = token.match(/^(UP|DOWN|LEFT|RIGHT)_COMETH$/);
  if (comethMatch) {
    const dirMap: Record<string, Direction> = {
      UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right',
    };
    return { kind: CellKind.COMETH, direction: dirMap[comethMatch[1]] };
  }

  throw new Error(`Unknown token: ${token}`);
}

class CrossmintClient {
  readonly baseUrl: string;
  constructor(private readonly candidateId: string, baseUrl = process.env.BASE_URL || 'https://challenge.crossmint.io/api') {
    if (!candidateId) throw new Error('CANDIDATE_ID env var is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getGoal(): Promise<string[][]> {
    const url = `${this.baseUrl}/map/${this.candidateId}/goal`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET /map/{id}/goal failed: ${res.status} ${res.statusText}`);
    const data: any = await res.json();
    if (!Array.isArray(data?.goal)) throw new Error('Goal payload malformed: missing goal[]');
    return data.goal as string[][];
  }

  async createPolyanet(p: Point): Promise<void> {
    await this.post('/polyanets', { row: p.row, column: p.column });
  }

  async deletePolyanet(p: Point): Promise<void> {
    await this.del('/polyanets', { row: p.row, column: p.column });
  }

  async createSoloon(p: Point, color: Color): Promise<void> {
    await this.post('/soloons', { row: p.row, column: p.column, color });
  }

  async deleteSoloon(p: Point): Promise<void> {
    await this.del('/soloons', { row: p.row, column: p.column });
  }

  async createCometh(p: Point, direction: Direction): Promise<void> {
    await this.post('/comeths', { row: p.row, column: p.column, direction });
  }

  async deleteCometh(p: Point): Promise<void> {
    await this.del('/comeths', { row: p.row, column: p.column });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: this.candidateId, ...body }),
    });
    if (!res.ok) {
      const text = await safeText(res);
      const err: any = new Error(`POST ${path} failed: ${res.status} ${res.statusText} → ${text}`);
      err.status = res.status; throw err;
    }
  }

  private async del(path: string, body: Record<string, unknown>): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidateId: this.candidateId, ...body }),
    });
    if (!res.ok) {
      const text = await safeText(res);
      const err: any = new Error(`DELETE ${path} failed: ${res.status} ${res.statusText} → ${text}`);
      err.status = res.status; throw err;
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return '<no-body>'; }
}



async function withRetry<T>(fn: () => Promise<T>, opts?: { retries?: number; baseMs?: number; onRetry?: (err: unknown, attempt: number) => void; }): Promise<T> {
  const retries = opts?.retries ?? 6;
  const baseMs = opts?.baseMs ?? 250;
  let attempt = 0;
  while (true) {
    try { return await fn(); }
    catch (err: any) {
      const status = err?.status as number | undefined;
      const transient = status === 429 || (status != null && status >= 500) || status === undefined;
      if (attempt >= retries || !transient) throw err;
      const delay = Math.round(Math.random() * baseMs * 2 ** attempt);
      opts?.onRetry?.(err, attempt + 1);
      await sleep(delay);
      attempt++;
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

class Limiter {
  private active = 0; private queue: (() => void)[] = [];
  constructor(private readonly max: number) { if (max < 1) throw new Error('Concurrency must be >= 1'); }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((res) => this.queue.push(res));
    this.active++;
    try { return await task(); }
    finally { this.active--; const next = this.queue.shift(); if (next) next(); }
  }
}



type Action = { kind: 'create'; run: () => Promise<void>; describe: string };

function planActions(goal: string[][], client: CrossmintClient): { grid: Grid; actions: Action[] } {
  const height = goal.length;
  const width = goal[0]?.length ?? 0;
  const grid = new Grid(height, width);
  const actions: Action[] = [];

  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const raw = goal[r][c];
      const cell = parseToken(raw);
      const p: Point = { row: r, column: c };
      if (!grid.inBounds(p)) continue;
      switch (cell.kind) {
        case CellKind.SPACE:
          break;
        case CellKind.POLYANET:
          actions.push({
            kind: 'create',
            run: () => client.createPolyanet(p),
            describe: `POLYANET @ (${r},${c})`,
          });
          break;
        case CellKind.SOLOON:
          actions.push({
            kind: 'create',
            run: () => client.createSoloon(p, cell.color),
            describe: `${cell.color.toUpperCase()}_SOLOON @ (${r},${c})`,
          });
          break;
        case CellKind.COMETH:
          actions.push({
            kind: 'create',
            run: () => client.createCometh(p, cell.direction),
            describe: `${cell.direction.toUpperCase()}_COMETH @ (${r},${c})`,
          });
          break;
      }
    }
  }
  return { grid, actions };
}



async function main() {
  const candidateId = process.env.CANDIDATE_ID || '';
  const client = new CrossmintClient(candidateId);
  const concurrency = parseInt(process.env.CONCURRENCY || '8', 10);
  const dryRun = /^true$/i.test(process.env.DRY_RUN || 'false');

  console.log('Fetching goal map...');
  const goal = await withRetry(() => client.getGoal(), { retries: 4, baseMs: 800, onRetry: (e, a) => console.warn(`Retry #${a} goal map:`, (e as Error).message) });

  const { grid, actions } = planActions(goal, client);
  console.log(`Goal size: ${grid.height}×${grid.width}`);
  console.log(`Objects to create: ${actions.length}`);
  for (const a of actions) console.log(' •', a.describe);

  if (dryRun) {
    console.log('DRY_RUN=true → no requests will be sent.');
    return;
  }

  const limiter = new Limiter(concurrency);
  let ok = 0; let fail = 0;
  await Promise.all(
    actions.map((a) =>
      limiter.run(() =>
        withRetry(a.run, {
          retries: 6,
          baseMs: 900,
          onRetry: (err, attempt) => console.warn(`Retry #${attempt} ${a.describe}:`, (err as Error).message),
        })
          .then(() => { ok++; process.stdout.write('.'); })
          .catch((err) => { fail++; console.error(`\nFailed ${a.describe}:`, (err as Error).message); })
      )
    )
  );

  console.log(`\nDone. Success: ${ok}, Failed: ${fail}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exitCode = 1; });
