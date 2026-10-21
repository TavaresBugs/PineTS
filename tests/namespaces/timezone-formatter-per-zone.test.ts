// SPDX-License-Identifier: AGPL-3.0-only
// Calendar parts in an IANA timezone come from one Intl.DateTimeFormat per timezone. Building a
// formatter costs ~10x more than formatting with one, and every session / time-component call
// on every bar used to build a new one.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PineTS } from '../../src/PineTS.class';
import { getDatePartsInTimezone } from '../../src/namespaces/Time';

const HOUR = 3_600_000;
// 2024-03-10 04:00 UTC: New York switches from EST (UTC-5) to EDT (UTC-4) at 07:00 UTC.
const T0 = Date.UTC(2024, 2, 10, 4);
const BARS = 6;
const bars = Array.from({ length: BARS }, (_, i) => ({
    openTime: T0 + i * HOUR,
    closeTime: T0 + (i + 1) * HOUR,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
}));

const code = `//@version=6
indicator("tz")
plot(hour(time, "America/New_York"), "ny")
plot(dayofweek(time, "America/New_York"), "nyDow")
plot(hour(time, "Asia/Tokyo"), "tokyo")
plot(hour(time, "Not/AZone"), "bad")
`;

const values = (plots: any, name: string) => plots[name].data.map((p: any) => p.value);

describe('IANA timezone calendar parts', () => {
    afterEach(() => vi.restoreAllMocks());

    it('build one formatter per timezone', async () => {
        // Timezones no other test in this file uses: their formatters do not exist yet.
        const spy = vi.spyOn(Intl, 'DateTimeFormat');
        await new PineTS(bars, 'TEST', '60').run(`//@version=6
indicator("tz")
plot(hour(time, "America/Chicago") + minute(time, "America/Chicago"), "chicago")
plot(dayofmonth(time, "Australia/Sydney"), "sydney")
`);
        const zones = spy.mock.calls.map(([, options]) => options?.timeZone).filter((tz) => tz === 'America/Chicago' || tz === 'Australia/Sydney');
        expect(zones.sort()).toEqual(['America/Chicago', 'Australia/Sydney']);
    });

    it('stay correct across a DST change', async () => {
        const { plots } = await new PineTS(bars, 'TEST', '60').run(code);
        // 04:00–09:00 UTC: 23:00, 00:00, 01:00 EST (Sat, Sun, Sun), then 03:00, 04:00, 05:00 EDT.
        expect(values(plots, 'ny')).toEqual([23, 0, 1, 3, 4, 5]);
        expect(values(plots, 'nyDow')).toEqual([7, 1, 1, 1, 1, 1]);
        expect(values(plots, 'tokyo')).toEqual([13, 14, 15, 16, 17, 18]);
    });

    it('fall back to UTC for an unknown timezone on every call', async () => {
        const { plots } = await new PineTS(bars, 'TEST', '60').run(code);
        expect(values(plots, 'bad')).toEqual([4, 5, 6, 7, 8, 9]);
    });

    it('return a fresh object for repeated timestamps', () => {
        const a = getDatePartsInTimezone(T0, 'Europe/Paris');
        a.hour = 99;
        expect(getDatePartsInTimezone(T0, 'Europe/Paris').hour).toBe(5);
    });
});
