"""Database engine and ORM models. SQLite for pilots, PostgreSQL/TimescaleDB in production."""
from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text,
                        create_engine, Index)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

from . import config

connect_args = {"check_same_thread": False} if config.DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(config.DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
Base = declarative_base()


def utcnow():
    return datetime.now(timezone.utc)


class Reading(Base):
    """One timestamped, geotagged sensor record from a device."""
    __tablename__ = "readings"
    id = Column(Integer, primary_key=True)
    device = Column(String(64), index=True, nullable=False)
    ts = Column(DateTime(timezone=True), index=True, nullable=False)
    lat = Column(Float, nullable=False)
    lon = Column(Float, nullable=False)
    ph = Column(Float); orp = Column(Float); turbidity = Column(Float); uv = Column(Float)
    temp = Column(Float); conductivity = Column(Float); do = Column(Float)
    extra = Column(JSON, default=dict)          # any additional sensor channels
    zone = Column(String(16))                    # salinity class used for the baseline
    z = Column(JSON, default=dict)               # z-score per parameter vs rolling baseline
    est = Column(JSON, default=dict)             # {compound: {mu, lo, hi, conf}}
    status = Column(String(8), default="ok")     # ok | warn | bad
    __table_args__ = (Index("ix_readings_device_ts", "device", "ts"),)


class Compound(Base):
    """Flexible micropollutant database: compounds are rows, not code."""
    __tablename__ = "compounds"
    id = Column(String(16), primary_key=True)
    name = Column(String(128), nullable=False)
    cls = Column(String(128)); cas = Column(String(32)); kow = Column(Float)
    unit = Column(String(16), nullable=False, default="µg/L")
    level = Column(Float)      # screening level for alerts, in `unit`
    pnec = Column(Float)       # µg/L, for RQ = MEC / PNEC
    bg = Column(Float, default=0)
    method = Column(String(256)); rt = Column(Float); src = Column(Text)


class HplcResult(Base):
    """Laboratory reference result: the analytical ground truth."""
    __tablename__ = "hplc_results"
    id = Column(String(128), primary_key=True)
    sample_id = Column(String(64), index=True)
    ts = Column(DateTime(timezone=True), index=True, nullable=False)
    lat = Column(Float, nullable=False); lon = Column(Float, nullable=False)
    compound = Column(String(16), ForeignKey("compounds.id"), index=True, nullable=False)
    conc = Column(Float, nullable=False)    # in the compound's unit
    lod = Column(Float); below = Column(Boolean, default=False)
    method = Column(String(256)); notes = Column(Text); origin = Column(String(16), default="upload")
    sensors = Column(JSON)                  # optional sensor values supplied with the sample
    station = Column(String(32))


class Source(Base):
    """Potential pollution source used for spatial investigation."""
    __tablename__ = "sources"
    id = Column(String(32), primary_key=True)
    name = Column(String(128)); type = Column(String(64))
    lat = Column(Float); lon = Column(Float); basis = Column(Text)
    sigma = Column(Float); load = Column(Float); prof = Column(JSON); lbl = Column(String(16))


class Event(Base):
    """Consecutive abnormal readings grouped into one pollution event."""
    __tablename__ = "events"
    id = Column(Integer, primary_key=True)
    device = Column(String(64), index=True)
    start = Column(DateTime(timezone=True), index=True); end = Column(DateTime(timezone=True))
    status = Column(String(8)); n = Column(Integer, default=1)
    lat = Column(Float); lon = Column(Float)
    peak_est = Column(Float); peak_conf = Column(String(8)); compound = Column(String(16))
    drivers = Column(JSON)          # [{k, z}]
    nearest_source = Column(String(32)); source_dist_m = Column(Float)
    weather = Column(JSON)          # Open-Meteo context
    place = Column(JSON)            # OpenStreetMap / Nominatim place name
    notified = Column(Boolean, default=False)


class ModelVersion(Base):
    """Model registry. One active version per compound."""
    __tablename__ = "model_versions"
    id = Column(Integer, primary_key=True)
    compound = Column(String(16), index=True); version = Column(Integer)
    algo = Column(String(16)); features = Column(JSON); metrics = Column(JSON)
    path = Column(String(512)); created_at = Column(DateTime(timezone=True), default=utcnow)
    active = Column(Boolean, default=True)


class ReactorRun(Base):
    __tablename__ = "reactor_runs"
    id = Column(String(32), primary_key=True)
    catalyst = Column(String(64)); dose = Column(Float); light = Column(String(64))
    compound = Column(String(16)); rows = Column(JSON); origin = Column(String(16)); rep = Column(String(32))


class SurveyResponse(Base):
    __tablename__ = "survey_responses"
    id = Column(Integer, primary_key=True)
    respondent_id = Column(String(64)); disposal_method = Column(String(128))
    answers = Column(JSON); origin = Column(String(16))


class Interview(Base):
    __tablename__ = "interviews"
    id = Column(Integer, primary_key=True)
    theme = Column(String(64)); text = Column(Text); origin = Column(String(16))


class SamplingRequest(Base):
    __tablename__ = "sampling_requests"
    id = Column(Integer, primary_key=True)
    event_id = Column(String(32)); lat = Column(Float); lon = Column(Float)
    compound = Column(String(16)); note = Column(Text)
    created_at = Column(DateTime(timezone=True), default=utcnow); done = Column(Boolean, default=False)


def init_db():
    Base.metadata.create_all(engine)
    _add_missing_columns()


def _add_missing_columns():
    """Additive migration: new nullable columns are added to existing tables (e.g. after an upgrade)."""
    from sqlalchemy import inspect, text
    insp = inspect(engine)
    with engine.begin() as con:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name not in have and col.nullable and not col.primary_key:
                    con.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{col.name}" {col.type.compile(engine.dialect)}'))
