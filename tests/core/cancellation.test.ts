// SPDX-License-Identifier: AGPL-3.0-only
// Cooperative cancellation. The bar loop gives the event loop a turn at least every 30 ms, so a
// host that runs PineTS on its main thread or in a worker stays responsive during a long run and
// can stop a run it no longer needs (e.g. after a timeframe switch): `cancel()` makes the run
// reject with an AbortError at its next checkpoint, and `stream().stop()` cancels the stream's
// run without reporting an error.

import { describe, it, expect, vi } from 'vitest';
import { PineTS } from '../../src/PineTS.class';

const MINUTE = 60_000;
const T0 = Date.UTC(2024, 0, 1);
const BARS = 20_000;
const bars = Array.from({ length: BARS }, (_, i) => {
    const close = 100 + Math.sin(i / 50) * 10;
    return { openTime: T0 + i * MINUTE, closeTime: T0 + (i + 1) * MINUTE, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1 };
});

const code = `//@version=6
indicator("work")
plot(ta.ema(close, 20) + ta.rsi(close, 14) + ta.stdev(close, 50), "p")
`;

const isAbort = (e: any) => e?.name === 'AbortError';

describe('cooperative cancellation', () => {
    it('lets timers fire while a run is in progress', async () => {
        const order: string[] = [];
        setTimeout(() => order.push('timer'), 0);
        let ticks = 0;
        const interval = setInterval(() => ticks++, 5);
        try {
            await new PineTS(bars, 'TEST', '1').run(code);
            order.push('run');
        } finally {
            clearInterval(interval);
        }
        expect(order).toEqual(['timer', 'run']);
        expect(ticks).toBeGreaterThan(1);
    });

    it('cancel() during a run rejects it with an AbortError', async () => {
        const pine = new PineTS(bars, 'TEST', '1');
        await pine.ready();
        setTimeout(() => (pine as any).cancel?.(), 0);
        const error = await pine.run(code).then(
            () => null,
            (e) => e,
        );
        expect(isAbort(error)).toBe(true);
    });

    it('a cancelled instance does not start another run', async () => {
        const pine = new PineTS(bars.slice(0, 100), 'TEST', '1');
        await pine.ready();
        (pine as any).cancel?.();
        await expect(pine.run(code)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('stream().stop() cancels the run and reports no error', async () => {
        const pine = new PineTS(bars, 'TEST', '1');
        await pine.ready();
        const cancel = vi.fn();
        (pine as any).cancel = ((original) =>
            function (this: any) {
                cancel();
                return original?.call(this);
            })((pine as any).cancel);

        const stream = pine.stream(code, { live: false, pageSize: BARS });
        const errors: any[] = [];
        let pages = 0;
        stream.on('error', (e: any) => errors.push(e));
        stream.on('data', () => pages++);
        setTimeout(() => stream.stop(), 0);
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(cancel).toHaveBeenCalled();
        expect(pages).toBe(0);
        expect(errors).toEqual([]);
    });

    it('a stream that is not stopped still emits its page', async () => {
        const pine = new PineTS(bars.slice(0, 2000), 'TEST', '1');
        await pine.ready();
        const stream = pine.stream(code, { live: false, pageSize: 2000 });
        const page = await new Promise<any>((resolve, reject) => {
            stream.on('data', resolve);
            stream.on('error', reject);
        });
        expect(page.plots['p'].data).toHaveLength(2000);
    });
});
