"""Puntuación compuesta 0-100. No ordenamos solo por % de subida: premiamos subidas con volumen,
catalizador de calidad y cierre fuerte, que son las que históricamente tienen más continuidad."""
import math

# Peso máximo de cada componente (suman 100)
WEIGHTS = {"move": 20, "rvol": 30, "catalyst": 30, "close": 10, "size": 10}


def _clip(x, lo=0.0, hi=1.0):
    return max(lo, min(hi, x))


def components(r: dict, catalyst_quality: float | None = None) -> dict:
    mcap = r.get("market_cap") or 1e9
    return {
        # 6% -> 0 ; 26%+ -> máximo. Más allá suele ser exceso/euforia.
        "move": _clip((r["change_pct"] - 6) / 20),
        # RVOL 1.5 -> 0 ; 6+ -> máximo
        "rvol": _clip((r["rvol"] - 1.5) / 4.5),
        "catalyst": 0.5 if catalyst_quality is None else catalyst_quality,
        "close": _clip(r["close_strength"]),
        # 1.000 M$ -> 0 ; 100.000 M$+ -> máximo
        "size": _clip(math.log10(mcap / 1e9) / 2),
    }


def score(r: dict, catalyst_quality: float | None = None) -> tuple[float, dict]:
    comp = components(r, catalyst_quality)
    pts = {k: round(v * WEIGHTS[k], 1) for k, v in comp.items()}
    return round(sum(pts.values()), 1), pts
