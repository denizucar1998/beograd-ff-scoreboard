# Beograd FF Scoreboard

Statisk scoreboard-side bygget 1:1 fra design-eksporten.

## Kør lokalt

```bash
python3 -m http.server 4173
```

Åbn: `http://localhost:4173/`

## Indhold

- `index.html`: Hele appen (React via CDN + inline CSS/JS)
- `assets/beograd-bg/*.jpg`: Dynamiske baggrundsbilleder (rotation hvert 30. sekund)
