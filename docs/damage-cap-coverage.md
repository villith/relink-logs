# Damage-cap model coverage

How much of every character's logged damage caps the model explains.
A hit is **verified** when its cap sits exactly where the formula
puts it (`cap = trunc(base × K/100)`, integer K); **explained** hits
are off that grid for a known, named reason (a state buff easing
in/out, a half-percent build, the Cobalt crit band). Coverage =
verified + explained.

Regenerate after new logs with:

```sh
cargo run --release -p gbfr-logs --example cap_residual_scan -- --last 5000 --markdown > docs/damage-cap-coverage.md
```

| Character | Capped hits | Verified | Explained | Unaccounted | Coverage |
|---|---:|---:|---:|---:|---:|
| Eustace | 21972 | 21972 | 0 | 0 | 100.00% |
| Rackam | 18418 | 16027 | 2367 | 24 | 99.87% |
| Fraux | 17159 | 17159 | 0 | 0 | 100.00% |
| Id | 16520 | 15789 | 705 | 26 | 99.84% |
| Percival | 5032 | 5032 | 0 | 0 | 100.00% |
| Rosetta | 2413 | 0 | 2413 | 0 | 100.00% |
| Eugen | 1952 | 1952 | 0 | 0 | 100.00% |
| Io | 1189 | 1189 | 0 | 0 | 100.00% |
| Lancelot | 1184 | 1184 | 0 | 0 | 100.00% |
| Zeta | 972 | 972 | 0 | 0 | 100.00% |
| Yodarha | 910 | 910 | 0 | 0 | 100.00% |
| Ferry | 774 | 774 | 0 | 0 | 100.00% |
| Sandalphon | 524 | 524 | 0 | 0 | 100.00% |
| Gallanza | 276 | 276 | 0 | 0 | 100.00% |
| Fediel | 265 | 0 | 0 | 265 | 0.00% |
| Siegfried | 184 | 184 | 0 | 0 | 100.00% |
| Tweyen | 176 | 176 | 0 | 0 | 100.00% |
| Gran | 85 | 85 | 0 | 0 | 100.00% |
| Seofon | 78 | 78 | 0 | 0 | 100.00% |
| Katalina | 72 | 72 | 0 | 0 | 100.00% |

Corpus total: 90155 capped hits, 99.65% covered.

## Unaccounted

- log 2560, Fediel (Pl2900, actor 0xf0000003): 265 unexplained hits (max dev +0.000) — constant K≈307.299, one stable unknown source all fight
- log 2535, Rackam (Pl0300, actor 0xf0000001): 12 unexplained hits (max dev -113.910)
- log 2582, Id (Pl1900, actor 0xf0000003): 9 unexplained hits (max dev +0.000) — constant K≈2389.937, one stable unknown source all fight
- log 2572, Id (Pl1900, actor 0xf0000003): 9 unexplained hits (max dev +0.000)
- log 2537, Rackam (Pl0300, actor 0xf0000001): 8 unexplained hits (max dev -165.096)
- log 2605, Id (Pl1900, actor 0xf0000003): 3 unexplained hits (max dev +69.931)
- log 2525, Rackam (Pl0300, actor 0xf0000001): 3 unexplained hits (max dev -179.596)
- log 2608, Id (Pl1900, actor 0xf0000003): 1 unexplained hits (max dev +0.000)
- log 2607, Id (Pl1900, actor 0xf0000003): 1 unexplained hits (max dev +0.000)
- log 2602, Id (Pl1900, actor 0xf0000003): 1 unexplained hits (max dev -82.671)
- log 2596, Id (Pl1900, actor 0xf0000003): 1 unexplained hits (max dev -35.049)
- log 2554, Rackam (Pl0300, actor 0xf0000003): 1 unexplained hits (max dev -228.900)
- log 2544, Id (Pl1900, actor 0xf0000003): 1 unexplained hits (max dev -102.835)
