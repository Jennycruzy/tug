"""Re-compute the 7-day pre-record figures (copy picks and fade picks, 15-22 Oct) from the stored raw fills.
Usage: python3 -I stats_7d.py <dir>   (reads plain or .gz JSON)
Inputs: discover_all.json (Strike /v2/copy/discover pages, 22 Oct), copy_fills7d.json and
counter_fills7d.json ([address, Hyperliquid userFillsByTime replies] for 15-22 Oct), markets.json (Strike /v2/markets)."""
import gzip, json, sys, os
d = sys.argv[1]

def load(name):
    p = os.path.join(d, name)
    if os.path.exists(p):
        return json.load(open(p))
    return json.load(gzip.open(p + '.gz', 'rt'))

strike = {s.split('-')[0] for s in load('markets.json')['markets']}
def mapc(c):
    if c.startswith('@'): return None
    b = c.split(':')[-1]
    return b if b in strike else None
for name, f, want_loss in [('top-250 copy picks', 'copy_fills7d.json', False), ('fade picks', 'counter_fills7d.json', True)]:
    rows = load(f)
    pnl = notional = 0.0; active = moved = 0
    for addr, fills in rows:
        t = [y for y in fills if mapc(y['coin'])]
        if not t: continue
        active += 1
        p = sum(float(y.get('closedPnl', 0)) for y in t)
        pnl += p; notional += sum(float(y['px']) * float(y['sz']) for y in t)
        moved += (p < 0) if want_loss else (p > 0)
    print(f"{name}: active on Strike markets {active}, {'lost' if want_loss else 'gained'} {moved}, closed PnL {pnl/1e6:.2f}M on {notional/1e6:.1f}M notional")
