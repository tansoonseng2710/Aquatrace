"""Synthetic Sungai Pinang / George Town coast water model used for demo seeding and the device simulator.

Everything produced here is SYNTHETIC. Real elements: sampling points SP1–SP5 (Sharifah Nurul Sofhia, 2023),
HPLC method conditions and PNEC values (same thesis), photocatalysis benchmarks (Khasawneh, 2022).
Coastal stations and the Jelutong STP outfall position are approximate.
"""
from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone

from .services.core import dist_m

PLACES = {
    "UP": (5.41360, 100.30870), "SP1": (5.410733, 100.313743), "SP2": (5.408132, 100.322845),
    "SP3": (5.408349, 100.325677), "SP4": (5.407830, 100.325927), "SP5": (5.403843, 100.330476),
    "MOUTH": (5.40330, 100.33560), "NCST": (5.41230, 100.34330), "SCST": (5.39350, 100.33620), "OUTF": (5.39520, 100.33380),
}
ROUTE = [PLACES[k] for k in ["SP1", "SP2", "SP3", "SP4", "SP5", "MOUTH", "NCST", "MOUTH", "OUTF", "SCST", "MOUTH", "SP5", "SP4", "SP3", "SP2", "SP1"]]
STATIONS = ["SP1", "SP2", "SP3", "SP4", "SP5", "MOUTH", "NCST", "OUTF", "SCST"]

SOURCES = [
    dict(id="SRC-HOSP", name="Hospital effluent drain", type="Hospital effluent", lat=5.41090, lon=100.31330, sigma=260, load=1.0, lbl="left",
         basis="Sharifah (2023): SP1 chosen for hospital effluent released via drain", prof=dict(PCM=0.38, ATL=95, DIC=9, CBZ=0.6, KTP=2.5)),
    dict(id="SRC-RAWA", name="Kampung Rawa settlement", type="Unsewered settlement", lat=5.40830, lon=100.32250, sigma=230, load=1.3, lbl="above",
         basis="Sharifah (2023): SP2, impractical sewage system at unplanned settlement", prof=dict(PCM=0.30, ATL=40, DIC=14, CBZ=0.9, KTP=4)),
    dict(id="SRC-DRAIN", name="Commercial / residential drain", type="Urban drain", lat=5.40840, lon=100.32560, sigma=180, load=0.8,
         basis="Sharifah (2023): SP3, runoff from residential and commercial areas", prof=dict(PCM=0.16, ATL=18, DIC=11, CBZ=0.7, KTP=3)),
    dict(id="SRC-STP", name="Jelutong STP effluent outfall", type="Sewage treatment plant", lat=5.39520, lon=100.33300, sigma=420, load=0.35,
         basis="Teoh (2022): Jelutong STP, largest centralised STP on Penang Island. Coastal outfall position approximate; measured effluent discharge point is 5.39725 N, 100.32415 E (Amir Irham 2024, pt 3)", prof=dict(PCM=0.03, ATL=8, DIC=6, CBZ=4.5, KTP=0.8)),
]

COMPOUNDS = [
    dict(id="PCM", name="Paracetamol", cls="Analgesic / antipyretic", cas="103-90-2", kow=0.46, unit="mg/L", level=0.15, pnec=None, bg=0.012,
         method="SPE + HPLC-UV (λmax ≈ 243 nm)", rt=None, src="Project target compound. PNEC not set: enter from your ERA source."),
    dict(id="DIC", name="Diclofenac", cls="NSAID", cas="15307-86-5", kow=4.51, unit="µg/L", level=10, pnec=14.5, bg=0.3,
         method="SPE + HPLC-UV 254 nm, C18", rt=10.466, src="PNEC, RT: Sharifah (2023); log Kow: Khasawneh (2022)"),
    dict(id="CBZ", name="Carbamazepine", cls="Anticonvulsant", cas="298-46-4", kow=2.77, unit="µg/L", level=3, pnec=35.4, bg=0.15,
         method="SPE + HPLC-UV 254 nm, C18", rt=4.161, src="PNEC, RT: Sharifah (2023); log Kow: Khasawneh (2022)"),
    dict(id="ATL", name="Atenolol", cls="β-blocker", cas="29122-68-7", kow=0.16, unit="µg/L", level=60, pnec=200, bg=1.0,
         method="SPE + HPLC-UV 254 nm, C18", rt=2.175, src="PNEC, RT: Sharifah (2023); log Kow: Khasawneh (2022)"),
    dict(id="KTP", name="Ketoprofen", cls="NSAID", cas="22071-15-4", kow=3.12, unit="µg/L", level=4, pnec=32, bg=0.1,
         method="SPE + HPLC-UV 254 nm, C18", rt=7.279, src="PNEC, RT: Sharifah (2023)"),
    dict(id="MPL", name="Microplastics", cls="Particulate (emerging)", cas="–", kow=None, unit="particles/L", level=None, pnec=None, bg=0,
         method="Filtration + µ-FTIR / Raman", rt=None, src="Placeholder for future particle-count datasets"),
]
SPEED_M_PER_MIN = 110
LOCAL_TZ = timezone(timedelta(hours=8))


class World:
    def __init__(self, t0: datetime, seed: int = 20240714, days: int = 9):
        self.rng = random.Random(seed)
        self.t0 = t0
        self.route_len = sum(dist_m(*ROUTE[i - 1], *ROUTE[i]) for i in range(1, len(ROUTE)))
        self.rains, self.pulses = [], []
        for d in range(days):
            if self.rng.random() < 0.55:
                day = (t0 + timedelta(days=d)).astimezone(LOCAL_TZ).replace(hour=14 + self.rng.randrange(5), minute=self.rng.randrange(60))
                self.rains.append((day, 0.5 + self.rng.random() * 1.8, 0.35 + self.rng.random() * 0.65))
        for _ in range(14 * days // 7):
            s = self.rng.choice(SOURCES)
            self.pulses.append((s["id"], t0 + timedelta(minutes=self.rng.random() * days * 1440), timedelta(minutes=25 + self.rng.random() * 70), 2.2 + self.rng.random() * 1.8))

    def pos(self, ts: datetime):
        d = ((ts - self.t0).total_seconds() / 60 * SPEED_M_PER_MIN) % self.route_len
        for i in range(1, len(ROUTE)):
            seg = dist_m(*ROUTE[i - 1], *ROUTE[i])
            if d <= seg:
                f = d / seg if seg else 0
                return ROUTE[i - 1][0] + (ROUTE[i][0] - ROUTE[i - 1][0]) * f, ROUTE[i - 1][1] + (ROUTE[i][1] - ROUTE[i - 1][1]) * f
            d -= seg
        return ROUTE[0]

    def rain(self, ts):
        r = 0.0
        for t, dur, i in self.rains:
            dt = (ts - t).total_seconds() / 3600
            if dt < 0:
                continue
            r = max(r, i * min(1, dt / 0.3) if dt < dur else i * math.exp(-(dt - dur) / 2.5))
        return min(1.0, r)

    def strength(self, src_id, ts):
        lt = ts.astimezone(LOCAL_TZ); h = lt.hour + lt.minute / 60
        a = 0.55 + 0.35 * math.exp(-((h - 9) ** 2) / 6) + 0.3 * math.exp(-((h - 20) ** 2) / 5) - 0.2 * math.exp(-((h - 3.5) ** 2) / 5)
        for sid, t, dur, k in self.pulses:
            if sid == src_id and t <= ts <= t + dur:
                a *= k
        return a

    def sample(self, ts: datetime):
        g = self.rng.gauss
        lat, lon = self.pos(ts)
        rain = self.rain(ts)
        s0 = min(1, max(0, (lon - 100.3312) / 0.006)); sf = s0 * s0 * (3 - 2 * s0)
        dil = (1 - 0.62 * sf) * (1 - 0.4 * rain)
        s = 0.04
        conc = {c["id"]: c["bg"] or 0 for c in COMPOUNDS}
        for src in SOURCES:
            w = self.strength(src["id"], ts) * math.exp(-0.5 * (dist_m(lat, lon, src["lat"], src["lon"]) / src["sigma"]) ** 2)
            s += w * src["load"]
            for k, v in src["prof"].items():
                conc[k] += w * v
        se0 = s * dil; se = se0 / (1 + 0.35 * se0)
        days = (ts - self.t0).total_seconds() / 86400
        dom = (0.5 + 0.5 * math.sin(2 * math.pi * days / 3.3) * math.cos(2 * math.pi * days / 1.7)) * (1 - 0.7 * sf)
        conc = {k: v * dil * math.exp(0.12 * g(0, 1)) for k, v in conc.items()}
        lt = ts.astimezone(LOCAL_TZ); h = lt.hour + lt.minute / 60
        r = dict(
            ph=min(9, max(5.5, 7.25 - 0.55 * se + 0.72 * sf - 0.12 * rain + 0.04 * g(0, 1))),
            orp=322 - 205 * se - 30 * dom + 25 * sf - 28 * rain + 10 * g(0, 1),
            turbidity=max(0.3, (4 + 7 * se + 42 * rain * (1 - 0.5 * sf)) * math.exp(0.12 * g(0, 1))),
            uv=max(0.01, 0.05 + 0.42 * se + 0.16 * dom + 0.11 * rain + 0.012 * math.sin(2 * math.pi * h / 24) + 0.012 * g(0, 1)),
            temp=29.2 + 1.1 * math.sin(2 * math.pi * (h - 9) / 24) - 0.9 * rain + 0.1 * g(0, 1),
            conductivity=max(50, (460 + 820 * se) * (1 - sf) * (1 - 0.35 * rain) + 42000 * sf + 25 * g(0, 1)),
            do=min(12, max(0.2, 6.8 - 3.1 * se + 0.9 * math.sin(2 * math.pi * (h - 8) / 24) + 0.3 * sf + 0.15 * g(0, 1))),
        )
        return {"ts": ts, "lat": round(lat + 2e-5 * g(0, 1), 6), "lon": round(lon + 2e-5 * g(0, 1), 6), **{k: round(v, 4) for k, v in r.items()}}, conc
