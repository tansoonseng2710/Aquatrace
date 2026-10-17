#!/bin/sh
# Assemble the single-file dashboard and the phone transmitter page from src/
cd "$(dirname "$0")"
{ cat src/head.html; cat src/body.html; echo '<script>'; cat src/sensormodel.js src/core.js src/ml.js src/map.js src/fleet.js src/ui.js src/fleetui.js src/nodeui.js src/mlapi.js src/studio.js; echo '</script>'; } > index.html
{ cat src/boat.html; echo '<script>'; cat src/sensormodel.js src/boat.js; echo '</script>'; echo '</body>'; echo '</html>'; } > boat.html
echo "built index.html ($(wc -c < index.html) bytes), boat.html ($(wc -c < boat.html) bytes)"
