#!/bin/sh
# Ctrl+C race proof. usage: sh spikes/phase0/sigint-orphan-proof.sh
set -eu
mkdir -p spikes/phase0/out/s2logs
LOG=spikes/phase0/out/s2logs/orphan.log
ts() { date +%H:%M:%S.%3N; }
node spikes/phase0/orphan-proof.mjs > "$LOG" 2>&1 &
P=$!
sleep 0.7
echo "$(ts) parent pid=$P; direct child already gone, sleeper still alive:"
ps -eo pid,ppid,pgid,args | grep 'sleep 300' | grep -v grep | cut -c1-100
echo "$(ts) sending SIGINT to parent"
kill -INT "$P"
RC=0
wait "$P" || RC=$?
echo "$(ts) parent exited with code $RC (130 expected)"
echo "processes after parent exit:"
LEFT=$(ps -eo pid,ppid,pgid,args | grep 'sleep 300' | grep -v grep | cut -c1-100 || true)
echo "${LEFT:-none}"
echo "parent log:"; cat "$LOG"
[ "$RC" -eq 130 ] && [ -z "$LEFT" ]
