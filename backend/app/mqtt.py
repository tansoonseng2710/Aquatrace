"""Optional MQTT ingest. Devices publish JSON readings to aquatrace/<device>/readings.
Enabled when MQTT_HOST is set. Uses the same pipeline as HTTP ingest."""
import json
import logging

import paho.mqtt.client as mqtt

from . import config, pipeline
from .db import SessionLocal

log = logging.getLogger("aquatrace.mqtt")


def _on_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload)
        device = payload.get("device") or msg.topic.split("/")[1]
        with SessionLocal() as db:
            pipeline.process_reading(db, payload, device, notify_async=pipeline.enrich_and_notify)
    except Exception as e:
        log.warning("bad MQTT message on %s: %s", msg.topic, e)


def start_mqtt():
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="aquatrace-api")
    if config.MQTT_USER:
        c.username_pw_set(config.MQTT_USER, config.MQTT_PASS)
    c.on_connect = lambda cl, u, f, rc, p=None: (cl.subscribe(config.MQTT_TOPIC), log.info("MQTT subscribed to %s", config.MQTT_TOPIC))
    c.on_message = _on_message
    c.connect(config.MQTT_HOST, config.MQTT_PORT, keepalive=60)
    c.loop_forever(retry_first_connection=True)
