// SPDX-License-Identifier: AGPL-3.0-only
// Live-tick parity harness: drives a live session over a synthetic market whose forming bar
// fills in steps (with price spikes that come back, and bar closes along the way) and compares
// every plot point and drawing with a from-scratch run after each tick.

import { vi } from 'vitest';
import { PineTS } from '../../src/PineTS.class';
import { Indicator } from '../../src/Indicator';

const MIN = 60_000;
const DAY = 1440 * MIN;

function mulberry32(seed: number) {
    return () => {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const bucketOf = (tf: string, t: number) => {
    if (tf === 'D') return Math.floor(t / DAY) * DAY;
    if (tf === 'W') {
        const d = Math.floor(t / DAY) * DAY;
        return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;
    }
    if (tf === 'M') {
        const d = new Date(t);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    const ms = Number(tf) * MIN;
    return Math.floor(t / ms) * ms;
};
const nextBucket = (tf: string, b: number) => {
    if (tf === 'D') return b + DAY;
    if (tf === 'W') return b + 7 * DAY;
    if (tf === 'M') {
        const d = new Date(b);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return b + Number(tf) * MIN;
};

/**
 * A synthetic 24x7 market of 5-minute base bars. Every timeframe is aggregated from the base
 * bars visible "now"; the last base bar can be pushed away by `spike` (a tick that moves price
 * and a later one that brings it back). Like some hosts, the bar still forming has no close time.
 */
export class LiveMarket {
    base: any[] = [];
    visibleUntil: number;
    spike = 0;
    now: number;

    constructor(
        public end: number,
        days: number,
        seed = 7,
    ) {
        const rnd = mulberry32(seed);
        for (let t = end - days * DAY, p = 20000; t < end; t += 5 * MIN) {
            const o = p;
            const c = Math.max(1, o + (rnd() - 0.5) * 0.004 * p + Math.sin(t / (6 * 3600_000)) * 0.0004 * p);
            this.base.push({
                openTime: t,
                open: o,
                close: c,
                high: Math.max(o, c) + rnd() * 0.0015 * p,
                low: Math.min(o, c) - rnd() * 0.0015 * p,
                volume: 100 + rnd() * 900,
            });
            p = c;
        }
        this.visibleUntil = end;
        this.now = end;
    }

    series(tf: string) {
        const out: any[] = [];
        let cur: any = null;
        for (let i = 0; i < this.base.length && this.base[i].openTime < this.visibleUntil; i++) {
            let b = this.base[i];
            if (this.spike && (i + 1 === this.base.length || this.base[i + 1].openTime >= this.visibleUntil)) {
                const close = b.close * (1 + this.spike);
                b = { ...b, close, high: Math.max(b.high, close), low: Math.min(b.low, close) };
            }
            const k = bucketOf(tf, b.openTime);
            if (!cur || cur.openTime !== k) {
                cur = { openTime: k, closeTime: nextBucket(tf, k), open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 };
                out.push(cur);
            }
            cur.high = Math.max(cur.high, b.high);
            cur.low = Math.min(cur.low, b.low);
            cur.close = b.close;
            cur.volume += b.volume;
        }
        if (out.length) delete out[out.length - 1].closeTime;
        return out;
    }

    provider() {
        return {
            getMarketData: async (_ticker: string, tf: string, limit?: number, sDate?: number, eDate?: number) => {
                // Each fetch takes a (simulated) second, so the live loop does not throttle.
                this.now += 1000;
                let rows = this.series(tf);
                if (sDate != null) rows = rows.filter((r) => r.openTime >= sDate);
                if (eDate != null) rows = rows.filter((r) => r.openTime < eDate);
                if (limit) rows = rows.slice(-limit);
                return rows.map((r) => ({ ...r }));
            },
            getSymbolInfo: async () => ({
                ticker: 'LIVE',
                tickerid: 'SYN:LIVE',
                prefix: 'SYN',
                root: 'LIVE',
                description: 'Synthetic',
                type: 'crypto',
                currency: 'USD',
                basecurrency: 'BTC',
                timezone: 'Etc/UTC',
                session: '24x7',
                mintick: 0.01,
                pricescale: 100,
                minmove: 1,
                pointvalue: 1,
                volumetype: 'base',
            }),
        };
    }
}

// Drawing ids come from a process-wide counter, so they differ between runs.
const norm = (v: any) =>
    JSON.stringify(v, (k, x) => (k === 'id' ? undefined : typeof x === 'number' ? (Number.isFinite(x) ? +x.toPrecision(12) : String(x)) : x));

function outputs(plots: any) {
    const out = new Map<string, string[]>();
    for (const [key, plot] of Object.entries<any>(plots ?? {})) {
        const data = plot?.data ?? [];
        // Drawing containers hold one point: the current set of objects.
        if (key.startsWith('__')) out.set(key, (data.at(-1)?.value ?? []).map(norm));
        else
            out.set(
                key,
                data.map((p: any) => norm([p.time, p.value, p.options ?? null])),
            );
    }
    return out;
}

/** Outputs that differ between a live session and a from-scratch run, as readable lines. */
function differences(live: Map<string, string[]>, fresh: Map<string, string[]>) {
    const problems: string[] = [];
    for (const key of new Set([...live.keys(), ...fresh.keys()])) {
        const a = live.get(key);
        const b = fresh.get(key);
        if (!a || !b) {
            problems.push(`${key}: only in ${a ? 'live' : 'fresh'}`);
            continue;
        }
        if (a.length !== b.length) {
            problems.push(`${key}: live ${a.length} entries, fresh ${b.length}`);
            continue;
        }
        const i = a.findIndex((x, j) => x !== b[j]);
        if (i >= 0) problems.push(`${key}: entry ${i}: live ${a[i].slice(0, 120)} / fresh ${b[i].slice(0, 120)}`);
    }
    return problems;
}

/**
 * Runs `source` as a live session over `market` and, after every tick, compares every plot point
 * and drawing with a from-scratch run over the same data. Returns the first tick's differences.
 */
export async function liveParity(source: string, opts: { tf: string; bars: number; ticks: number; stepMin: number; market: LiveMarket }) {
    const { tf, bars, ticks, stepMin, market } = opts;
    const tfMs = Number(tf) * MIN;
    const liveStart = bucketOf(tf, market.end - ticks * stepMin * MIN - 2 * tfMs);
    const firstBar = liveStart - bars * tfMs;
    market.visibleUntil = liveStart + stepMin * MIN;
    market.now = market.visibleUntil;
    market.spike = 0;
    const spikes = [0, 0.03, -0.03, 0, 0.05, 0];
    const provider = market.provider();
    vi.spyOn(Date, 'now').mockImplementation(() => market.now);

    const fresh = async () => {
        const pine = new PineTS(provider as any, 'LIVE', tf, undefined, firstBar);
        return outputs((await pine.run(new Indicator(source))).plots);
    };

    const live = new PineTS(provider as any, 'LIVE', tf, undefined, firstBar);
    const pages = (live as any).run(new Indicator(source), undefined, bars * 4) as AsyncGenerator<any>;
    let tick = 0;
    for await (const ctx of pages) {
        if (ctx === null) continue;
        const problems = differences(outputs(ctx.plots), await fresh());
        if (problems.length) return { tick, problems };
        if (tick === ticks) break;
        tick++;
        market.spike = spikes[tick % spikes.length];
        if (market.spike === 0) market.visibleUntil += stepMin * MIN;
        market.now = market.visibleUntil;
    }
    await pages.return(undefined);
    return { tick, problems: [] as string[] };
}
