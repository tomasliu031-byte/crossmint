import 'dotenv/config';

type Point = { row: number; column: number };

interface Shape {
    points(grid: Grid): Point[];
}

class Grid {
    constructor(public readonly size: number) {
        if (!Number.isInteger(size) || size <= 0) {
            throw new Error("Grid size must be a positive integer");
        }
    }
    /** Returns true if the point falls within [0..size-1] for row/column. */
    inBounds(p: Point): boolean {
        return (
            Number.isInteger(p.row) &&
            Number.isInteger(p.column) &&
            p.row >= 0 &&
            p.row < this.size &&
            p.column >= 0 &&
            p.column < this.size
        );
    }
}

class XShape implements Shape {
    constructor(
        public readonly boxSize: number,
        public readonly center: Point
    ) {
        if (!Number.isInteger(boxSize) || boxSize <= 0 || boxSize % 2 === 0) {
            throw new Error("XShape.boxSize must be a positive odd integer");
        }
    }


    points(grid: Grid): Point[] {
        const half = Math.floor(this.boxSize / 2);
        const pts: Point[] = [];

        for (let d = -half; d <= half; d++) {
            const a: Point = { row: this.center.row + d, column: this.center.column + d };
            const b: Point = { row: this.center.row + d, column: this.center.column - d };
            if (grid.inBounds(a)) pts.push(a);
            if (grid.inBounds(b)) pts.push(b);
        }

        const key = (p: Point) => `${p.row},${p.column}`;
        const seen = new Set<string>();
        return pts.filter((p) => (seen.has(key(p)) ? false : (seen.add(key(p)), true)));
    }
}

class CrossmintClient {
    readonly baseUrl: string;
    constructor(
        private readonly candidateId: string,
       baseUrl = process.env.BASE_URL || "https://challenge.crossmint.io/api"
    ) {
        if (!candidateId) throw new Error("CANDIDATE_ID env var is required");
        this.baseUrl = baseUrl.replace(/\/$/, "");
    }


    /** POST /polyanets { candidateId, row, column } */
    async createPolyanet(p: Point): Promise<void> {
        const url = `${this.baseUrl}/polyanets`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ candidateId: this.candidateId, row: p.row, column: p.column }),
        });


        if (!res.ok) {
            const text = await safeText(res);
            const err = new Error(
                `POST /polyanets failed (${res.status} ${res.statusText}) for (${p.row},${p.column}) → ${text}`
            );
            (err as any).status = res.status;
            throw err;
        }
    }
}

async function safeText(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return "<no-body>";
    }
}

async function withRetry<T>(fn: () => Promise<T>, opts?: {
    retries?: number;
    baseMs?: number;
    onRetry?: (err: unknown, attempt: number) => void;
}): Promise<T> {
    const retries = opts?.retries ?? 5;
    const baseMs = opts?.baseMs ?? 300;
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            const status = err?.status as number | undefined;
            // Retry on transient conditions: 429/5xx/network
            const transient = status === 429 || (status && status >= 500) || status === undefined;
            if (attempt >= retries || !transient) throw err;
            const delay = Math.round(Math.random() * baseMs * Math.pow(2, attempt));
            opts?.onRetry?.(err, attempt + 1);
            await sleep(delay);
            attempt++;
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

class Limiter {
    private active = 0;
    private queue: (() => void)[] = [];
    constructor(private readonly max: number) {
        if (max < 1) throw new Error("Concurrency must be >= 1");
    }
    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) await new Promise<void>((res) => this.queue.push(res));
        this.active++;
        try {
            return await task();
        } finally {
            this.active--;
            const next = this.queue.shift();
            if (next) next();
        }
    }
}

const GRID_SIZE = 11; // 11×11 grid with indices 0..10
const X_SIZE = 7; // 7×7 box for the X inside the grid (must be odd)
const CENTER: Point = { row: 5, column: 5 }; // center of the 11×11 grid


async function main() {
    const candidateId = process.env.CANDIDATE_ID || "";
    const client = new CrossmintClient(candidateId);
    const grid = new Grid(GRID_SIZE);
    const shape = new XShape(X_SIZE, CENTER);
    const points = shape.points(grid);


    const dryRun = /^true$/i.test(process.env.DRY_RUN || "false");
    const concurrency = parseInt(process.env.CONCURRENCY || "6", 10);
    const limiter = new Limiter(concurrency);


    console.log(`Planned polyanets: ${points.length}`);
    for (const p of points) console.log(` • (${p.row}, ${p.column})`);
    if (dryRun) {
        console.log("DRY_RUN=true → no requests will be sent.");
        return;
    }


    let ok = 0;
    let fail = 0;
    await Promise.all(
        points.map((p) =>
            limiter.run(() =>
                withRetry(() => client.createPolyanet(p), {
                    retries: 6,
                    baseMs: 250,
                    onRetry: (err, attempt) =>
                        console.warn(`Retry #${attempt} for (${p.row},${p.column}) → ${(err as Error).message}`),
                })
                    .then(() => {
                        ok++;
                        process.stdout.write(".");
                    })
                    .catch((err) => {
                        fail++;
                        console.error(`\nFailed for (${p.row},${p.column}):`, (err as Error).message);
                    })
            )
        )
    );


    console.log(`\nDone. Success: ${ok}, Failed: ${fail}`);
}


// Node 18+ has global fetch; add a minimal fallback if missing
declare const global: any;
const g: any = globalThis as any;
if (typeof g.fetch !== "function") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (global as any).fetch = require("node-fetch");
}


main().catch((e) => {
    console.error("Fatal:", e);
    process.exitCode = 1;
});