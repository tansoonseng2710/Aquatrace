"""Measured environmental concentrations (MEC) from prior USM studies in the study area.

Source: Amir Irham bin Khairul Nasrul (2024), "The study of pharmaceutical compound concentration
mapping at sewage treatment plant (STP) and Sg. Pinang downstream", USM, Tables 3.2-3.5, which
compiles:
  - Khasawneh (2022): points 1-2, near the Jelutong STP influent and effluent
  - Teoh Jay Kee (2022): points 3-5, Jelutong STP effluent discharge and downstream
  - Sharifah Nurul Sofhia (2023): points 6-10 = Sungai Pinang SP1-SP5
Values are ng/L as reported: [minimum, maximum, mean]. A few rows report a mean above the maximum
(e.g. ATL point 4 and 5); they are kept as published and flagged in the dashboard.

These are reference context only. They have no paired sensor readings, so they never enter model training.
"""

LITERATURE_POINTS = [
    {"pt": 1, "study": "Khasawneh (2022)", "site": "Jelutong STP, influent area", "lat": 5.3919194, "lon": 100.3194583},
    {"pt": 2, "study": "Khasawneh (2022)", "site": "Jelutong STP, effluent area", "lat": 5.3973361, "lon": 100.3230333},
    {"pt": 3, "study": "Teoh (2022)", "site": "Jelutong STP effluent discharge", "lat": 5.39725, "lon": 100.3241472},
    {"pt": 4, "study": "Teoh (2022)", "site": "Effluent channel, downstream", "lat": 5.394832, "lon": 100.327103},
    {"pt": 5, "study": "Teoh (2022)", "site": "Sg. Pinang downstream of STP", "lat": 5.399644, "lon": 100.332162},
    {"pt": 6, "study": "Sharifah (2023)", "site": "SP1 Persiaran Stadium (hospital drain)", "lat": 5.410733, "lon": 100.313743},
    {"pt": 7, "study": "Sharifah (2023)", "site": "SP2 Kampung Rawa", "lat": 5.408132, "lon": 100.322845},
    {"pt": 8, "study": "Sharifah (2023)", "site": "SP3 Jalan S.P. Chelliah drain", "lat": 5.40827222, "lon": 100.3256222},
    {"pt": 9, "study": "Sharifah (2023)", "site": "SP4 Jalan Sungai", "lat": 5.40783, "lon": 100.325927},
    {"pt": 10, "study": "Sharifah (2023)", "site": "SP5 Jelutong (before sea)", "lat": 5.403843, "lon": 100.330476},
]

# compound -> point -> [min, max, mean] in ng/L
LITERATURE_NG_L = {
    "ATL": {1: [90, 1020, 591], 2: [40, 367, 207], 3: [11, 210, 130], 4: [75, 219, 223], 5: [70, 196, 428],
            6: [49091, 98811, 68794], 7: [39791, 81786, 61323], 8: [50531, 82632, 60570], 9: [47248, 119527, 68564], 10: [34831, 56751, 46870]},
    "CBZ": {1: [430, 3200, 1293], 2: [120, 1450, 764], 3: [175, 613, 426], 4: [130, 732, 302], 5: [89, 438, 231],
            6: [294, 976, 635], 7: [342, 354, 348], 8: [381, 19204, 9828], 9: [50, 7968, 3758], 10: [0, 0, 0]},
    "DIC": {1: [123, 1439, 887], 2: [120, 746, 484], 3: [137, 563, 306], 4: [48, 219, 103], 5: [42, 173, 89],
            6: [1198, 17678, 6710], 7: [1224, 28311, 10314], 8: [1661, 2386, 2023], 9: [1237, 18620, 5687], 10: [1314, 1585, 1453]},
    "KTP": {1: [20, 286, 155], 2: [15, 150, 74], 3: [35, 138, 66], 4: [34, 83, 58], 5: [32, 62, 48],
            6: [4572, 4572, 4572], 7: [1061, 2466, 1764], 8: [7332, 7332, 7332], 9: [2490, 2490, 2490], 10: [0, 0, 0]},
}

SOURCE = ("Amir Irham (2024), USM, Tables 3.2-3.5; compiled from Khasawneh (2022), Teoh (2022) and "
          "Sharifah Nurul Sofhia (2023). Values below LOD were reported as 0.")


def literature() -> dict:
    pts = []
    for p in LITERATURE_POINTS:
        vals = {c: {"min": v[p["pt"]][0] / 1000, "max": v[p["pt"]][1] / 1000, "mean": v[p["pt"]][2] / 1000,
                    "flag": v[p["pt"]][2] > v[p["pt"]][1]} for c, v in LITERATURE_NG_L.items()}
        pts.append({**p, "unit": "µg/L", "values": vals})
    return {"source": SOURCE, "points": pts}
