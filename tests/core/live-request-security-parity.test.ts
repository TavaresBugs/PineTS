// SPDX-License-Identifier: AGPL-3.0-only
// Live ticks on a script that keeps state across bars and reads other timeframes through
// request.security: after any number of ticks the output equals a from-scratch run over the
// same data. Needs the forming-bar rollback (live-rollback.test.ts), updateTail() on
// runPretranspiled() contexts (updateTail-pretranspiled.test.ts) and the close time of live
// candles that have none (live-candle-closetime.test.ts) together: the secondary contexts are
// pretranspiled slices refreshed by updateTail(), and the synthetic market omits the close time
// of the bar still forming on every timeframe.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveMarket, liveParity } from './liveParity';

const END = Date.UTC(2026, 8, 30, 20, 0);

const fixture = `//@version=6
// Live-tick rollback fixture: every value here must be the same whether the forming bar was
// computed once or re-run on each tick. Exercises state that persists across bars: var
// collections (array, map, matrix, UDT), drawings created / changed / deleted from them,
// function-local var, a var first reached late, request.security with and without gaps.
indicator("live parity fixture", overlay = true, max_boxes_count = 100, max_lines_count = 100, max_labels_count = 100)

type Zone
    float top
    float bottom
    int born
    box b

var zones = array.new<Zone>()
var counts = map.new<string, int>()
var m = matrix.new<float>(2, 2, 0.0)
var closes = array.new_float()
var float acc = 0.0
var label hud = label.new(bar_index, high, "")
var line lastSwing = na

acc += close - open
array.push(closes, close)
if array.size(closes) > 20
    array.shift(closes)

atr = ta.atr(14)
if close > open and high - low > atr * 0.5
    array.push(zones, Zone.new(high, low, bar_index, box.new(bar_index, high, bar_index + 1, low)))

if array.size(zones) > 0
    for i = array.size(zones) - 1 to 0
        z = array.get(zones, i)
        box.set_right(z.b, bar_index)
        if close < z.bottom
            box.delete(z.b)
            array.remove(zones, i)

key = close > open ? "up" : "down"
map.put(counts, key, nz(map.get(counts, key)) + 1)
matrix.set(m, 0, 0, matrix.get(m, 0, 0) + close)

f() =>
    var int calls = 0
    calls += 1
    calls
fc = f()

late = 0.0
if bar_index > 5 and close > ta.sma(close, 50)
    var float firstLate = close
    late := firstLate

ph = ta.pivothigh(high, 3, 3)
if not na(ph)
    line.delete(lastSwing)
    lastSwing := line.new(bar_index - 3, ph, bar_index, ph)

label.set_xy(hud, bar_index, high)
label.set_text(hud, str.tostring(array.size(zones)) + "/" + str.tostring(map.get(counts, "up")))
if barstate.islast
    label.new(bar_index, low, str.tostring(close))

htf = request.security(syminfo.tickerid, "D", close)
htfGaps = request.security(syminfo.tickerid, "D", ta.sma(close, 3), gaps = barmerge.gaps_on)
[hh, ll] = request.security(syminfo.tickerid, "240", [ta.highest(high, 5), ta.lowest(low, 5)])

plot(acc, "acc")
plot(array.size(closes), "closesSize")
plot(array.size(zones), "zones")
plot(fc, "fcalls")
plot(late, "late")
plot(matrix.get(m, 0, 0), "matrix")
plot(ta.ema(close, 10), "ema")
plot(ta.highest(high, 10), "highest")
plot(ta.change(close), "change")
plot(htf, "htf")
plot(htfGaps, "htfGaps")
plot(hh, "hh")
plot(ll, "ll")
plot(close[1], "prevClose")
barcolor(close > open ? color.green : color.red)`;

describe('live ticks with request.security', () => {
    afterEach(() => vi.restoreAllMocks());

    it('match a from-scratch run after every tick (60m chart, D and 240 requests)', async () => {
        const result = await liveParity(fixture, { tf: '60', bars: 300, ticks: 24, stepMin: 10, market: new LiveMarket(END, 60) });
        expect(result.problems).toEqual([]);
        expect(result.tick).toBe(24);
    }, 60_000);
    it('match a from-scratch run after every tick (240 chart, W and M requests on still-open bars)', async () => {
        const source = `//@version=6
indicator("htf")
w = request.security(syminfo.tickerid, "W", close)
[mh, ml] = request.security(syminfo.tickerid, "M", [high, low])
wSma = request.security(syminfo.tickerid, "W", ta.sma(close, 4), gaps = barmerge.gaps_on)
plot(w, "w")
plot(mh, "mh")
plot(ml, "ml")
plot(wSma, "wSma")`;
        const result = await liveParity(source, { tf: '240', bars: 300, ticks: 24, stepMin: 30, market: new LiveMarket(END, 150) });
        expect(result.problems).toEqual([]);
        expect(result.tick).toBe(24);
    }, 60_000);
});
