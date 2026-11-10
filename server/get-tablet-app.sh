#!/bin/sh
# Downloads the latest tablet order pad (from the HPOS repository) so this server can serve it to the tablets.
cd "$(dirname "$0")" && mkdir -p tablet && curl -fsSL https://raw.githubusercontent.com/roshrpa/HPOS/main/index.html -o tablet/index.html && echo "Tablet order pad updated"
