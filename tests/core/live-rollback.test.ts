// SPDX-License-Identifier: AGPL-3.0-only
// A live session runs the history once, then re-runs only the forming bar on every tick, after
// rolling back what the previous run of that bar did. TradingView runs every tick from the state
// the previous bar left (only `varip` keeps what earlier ticks did), so after any number of ticks
// the output must equal a from-scratch run over the same data.
//
// The rollback used to restore only each variable Series' length and last value. A Series holds
// a reference to a collection or object, so the contents of arrays, maps, matrices, UDT instances
// and drawings kept what the discarded runs did, plot points piled up (one per tick), and
// variables and function scopes first created on the forming bar survived it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveMarket, liveParity } from './liveParity';

const END = Date.UTC(2026, 8, 30, 20, 0);
const header = '//@version=6\nindicator("live", overlay = true, max_boxes_count = 100, max_lines_count = 100, max_labels_count = 100)\n';

// 60-minute chart, ticks every 10 minutes: same-bar updates (with price spikes that come back)
// and bar closes in between.
async function expectParity(body: string) {
    const result = await liveParity(header + body, { tf: '60', bars: 200, ticks: 12, stepMin: 10, market: new LiveMarket(END, 30) });
    expect(result.problems).toEqual([]);
    expect(result.tick).toBe(12);
}

describe('live ticks: rollback of the forming bar', () => {
    afterEach(() => vi.restoreAllMocks());

    it('plot points: one per bar', async () => {
        await expectParity('plot(close, "c")\nplot(ta.ema(close, 10), "ema")');
    });

    it('var array, map and matrix contents', async () => {
        await expectParity(`var closes = array.new_float()
var counts = map.new<string, int>()
var m = matrix.new<float>(2, 2, 0.0)
array.push(closes, close)
if array.size(closes) > 20
    array.shift(closes)
key = close > open ? "up" : "down"
map.put(counts, key, nz(map.get(counts, key)) + 1)
matrix.set(m, 0, 0, matrix.get(m, 0, 0) + close)
plot(array.size(closes), "size")
plot(array.sum(closes), "sum")
plot(nz(map.get(counts, "up")), "up")
plot(matrix.get(m, 0, 0), "m")`);
    });

    it('UDT fields and drawings held in a var array', async () => {
        await expectParity(`type Zone
    float top
    float bottom
    box b
var zones = array.new<Zone>()
if close > open and high - low > ta.atr(14) * 0.5
    array.push(zones, Zone.new(high, low, box.new(bar_index, high, bar_index + 1, low)))
if array.size(zones) > 0
    for i = array.size(zones) - 1 to 0
        z = array.get(zones, i)
        z.top := math.max(z.top, high)
        box.set_right(z.b, bar_index)
        if close < z.bottom
            box.delete(z.b)
            array.remove(zones, i)
plot(array.size(zones), "zones")`);
    });

    it('drawings: var label moved every bar, lines replaced, labels on the last bar', async () => {
        await expectParity(`var label hud = label.new(bar_index, high, "")
var line lastSwing = na
ph = ta.pivothigh(high, 3, 3)
if not na(ph)
    line.delete(lastSwing)
    lastSwing := line.new(bar_index - 3, ph, bar_index, ph)
label.set_xy(hud, bar_index, high)
label.set_text(hud, str.tostring(close))
if barstate.islast
    label.new(bar_index, low, str.tostring(close))
plot(close, "c")`);
    });

    it('function-local var and a var first reached on the forming bar', async () => {
        await expectParity(`f() =>
    var int calls = 0
    calls += 1
    calls
fc = f()
late = 0.0
if bar_index > 5 and close > ta.sma(close, 50)
    var float firstLate = close
    late := firstLate
plot(fc, "calls")
plot(late, "late")`);
    });
    it('a drawing deleted by a discarded tick comes back', async () => {
        // The -3% spike tick deletes the box; the tick after it brings the price back.
        await expectParity(`var box b = box.new(bar_index, high, bar_index + 1, low)
if close < open * 0.975
    box.delete(b)
box.set_right(b, bar_index)
plot(close, "c")`);
    });

    it('variables and function scopes first created by a discarded tick', async () => {
        // Only the +3% / +5% spike ticks reach these blocks: the first creates the var and the
        // function's local scope, which must not survive into the next tick.
        await expectParity(`g() =>
    var float seen = close
    seen
v = 0.0
w = 0.0
if close > open * 1.025
    var float first = close
    v := first
    w := g()
plot(v, "v")
plot(w, "w")`);
    });
});
