# Radar de Subidas

Web personal que cada día de mercado muestra las **10 mejores acciones de EE.UU. que suben más de un 6 %** con un
catalizador detrás (resultados, analistas, OPAs...), y que **sigue qué pasa con ellas** a 1, 5 y 20 sesiones para
construir estadísticas propias.

Todo gratis: datos de Yahoo Finance (`yfinance`) + Google News RSS, automatizado con GitHub Actions y publicado con GitHub Pages.

> Herramienta de análisis personal. No es asesoramiento financiero.

## Cómo funciona

```
GitHub Actions (L-V 21:30 UTC, tras el cierre)
  └─ python -m scanner.main
       1. screener.py   Yahoo: subidas >6% en NYSE/Nasdaq + filtros de calidad
       2. news.py       titulares de las 25 mejores candidatas (Google News + Yahoo)
       3. catalysts.py  clasifica el motivo de la subida
       4. scoring.py    puntuación 0-100 -> Top 10
       5. history.py    guarda la selección y calcula rentabilidades +1/+5/+20 sesiones
  └─ commit de docs/data/*.json  ->  GitHub Pages sirve docs/ como web
```

| Archivo | Qué contiene |
|---|---|
| `scanner/config.py` | **Todos los umbrales** (subida mínima, capitalización, RVOL...). Empieza por aquí para ajustar. |
| `docs/` | La web (HTML + CSS + JS, sin compilación) |
| `docs/data/latest.json` | Último escaneo |
| `docs/data/daily/AAAA-MM-DD.json` | Archivo de cada día |
| `docs/data/history.json` | Todas las selecciones con su evolución posterior |
| `docs/data/stats.json` | Estadísticas por tipo de catalizador |

## Usarlo en tu ordenador

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m scanner.main            # escanea y actualiza el histórico
.venv\Scripts\python -m scanner.main --no-history   # solo prueba, no toca el histórico
.venv\Scripts\python -m http.server 8765 -d docs   # ver la web en http://localhost:8765
```

Si ejecutas el escáner con el mercado abierto, los datos son provisionales (la web lo indica). La ejecución
automática tras el cierre sobrescribe ese día con los datos definitivos.

## Publicarlo gratis en GitHub (una sola vez)

1. Crea una cuenta en https://github.com si no la tienes.
2. Crea un repositorio nuevo (por ejemplo `radar-subidas`). Puede ser **público** (Actions ilimitado) o
   **privado** (2.000 min/mes gratis; este proyecto usa ~3 min/día, de sobra). Ojo: en cuentas gratuitas,
   GitHub Pages solo funciona con repositorios **públicos**.
3. En esta carpeta:
   ```bash
   git init -b main
   git add .
   git commit -m "Radar de Subidas: primera versión"
   git remote add origin https://github.com/TU_USUARIO/radar-subidas.git
   git push -u origin main
   ```
4. En GitHub → *Settings → Pages* → Source: **Deploy from a branch**, Branch: **main**, carpeta **/docs** → Save.
   La web quedará en `https://TU_USUARIO.github.io/radar-subidas/`.
5. En *Settings → Actions → General → Workflow permissions* marca **Read and write permissions**
   (para que el robot pueda guardar los datos).
6. En la pestaña *Actions* → *Escaneo diario* → **Run workflow** para probarlo sin esperar a la noche.

## Ideas para las siguientes versiones

- Europa (Xetra, Euronext, BME, LSE) con su propio horario de escaneo.
- Clasificación del catalizador con un LLM (más precisa que las palabras clave).
- Alertas por Telegram con el top del día.
- Mini-gráfico de cada acción y comparación con su sector.
