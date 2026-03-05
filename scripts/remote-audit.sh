#!/bin/bash
ssh -i ~/.ssh/google_compute_engine mykolat@34.179.171.213 \
  "cd ~/indic-bot && npm run audit:bot"
