#!/usr/bin/env python3
"""PocketSphinx keyword-spotting helper for pi-web's voice wake word.

Reads JSON lines on stdin:
    {"id": "<request-id>", "audio": "<base64 16 kHz int16 mono PCM>"}

Writes JSON lines on stdout:
    {"id": "<request-id>", "detected": "jarvis" | "finalize" | null}

Two PocketSphinx decoders run in parallel (one per keyword). Offline, no keys.
"""

import base64
import json
import sys

from pocketsphinx import Config, Decoder

KEYWORDS = {
    "jarvis": 1e-20,
    "finalize": 1e-20,
}


def main() -> None:
    decoders = {
        kw: Decoder(Config(keyphrase=kw, kws_threshold=thr))
        for kw, thr in KEYWORDS.items()
    }

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue

        pcm = base64.b64decode(req.get("audio", "") or "")
        detected = None
        for kw, decoder in decoders.items():
            decoder.start_utt()
            decoder.process_raw(pcm, False, False)
            decoder.end_utt()
            if decoder.hyp() is not None:
                detected = kw
                break

        sys.stdout.write(json.dumps({"id": req.get("id"), "detected": detected}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
