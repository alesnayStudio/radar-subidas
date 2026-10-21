"""Mantenimiento: python -m scanner.reclassify

Tras mejorar el clasificador, vuelve a clasificar los días ya guardados usando sus titulares (sin
descargar noticias), para que las estadísticas por catalizador sean coherentes. Mantiene el orden del
ranking que se mostró ese día; solo corrige etiqueta, nota y puntuación. Después recalcula las
rentabilidades pendientes, "Aguantan la subida" del último día y las estadísticas.
"""
import json
import sys
from datetime import date

from . import catalysts, config, history, news, scoring


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    labels: dict[tuple[str, str], dict] = {}
    files = sorted(config.DAILY_DIR.glob("*.json"))
    for f in files:
        day = json.loads(f.read_text(encoding="utf-8"))
        for r in day["top"]:
            old = r["catalyst"]["type"]
            r["catalyst"] = catalysts.classify(r["news"], r["earnings_ts"], r["market_date"],
                                               news.company_patterns(r["symbol"], r["name"]))
            r["news"] = catalysts.key_headlines_first(r["news"], r["catalyst"]["type"])
            r["score"], r["score_parts"] = scoring.score(r, r["catalyst"]["quality"])
            labels[(day["date"], r["symbol"])] = r
            if old != r["catalyst"]["type"]:
                print(f"  {day['date']} {r['symbol']:6} {old} -> {r['catalyst']['type']}")
        f.write_text(json.dumps(day, indent=1, ensure_ascii=False), encoding="utf-8")

    h = history.load()
    for p in h:
        r = labels.get((p["date"], p["symbol"]))
        if r:
            p.update(catalyst=r["catalyst"]["type"], catalyst_label=r["catalyst"]["label"], score=r["score"])

    last = files[-1].stem
    h = history.update_returns(h, date.fromisoformat(last))
    history.save(h)
    history.compute_stats(h)

    # Rehace "Aguantan la subida" del último día (por si se calculó con la última vela incompleta)
    latest = json.loads(files[-1].read_text(encoding="utf-8"))
    latest["holding_up"] = {**history.holding_up(h, last), "window": config.HOLD_WINDOW}
    for path in (files[-1], config.DATA_DIR / "latest.json"):
        path.write_text(json.dumps(latest, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"Reclasificados {len(labels)} registros en {len(files)} días; estadísticas recalculadas.")


if __name__ == "__main__":
    main()
