#!/bin/sh
# Start a long runNpm, send SIGINT to the parent, show no processes are left. usage: sh spikes/phase0/sigint-proof.sh
node spikes/phase0/timeout-proof.mjs sigint > spikes/phase0/out/s2logs/sigint.log 2>&1 &
P=$!
sleep 4
echo "parent pid=$P; processes before SIGINT:"
ps -eo pid,pgid,args | grep -E 'spike-tmo-marker|sleep 300|git --no-replace|npm install' | grep -v grep | cut -c1-110
kill -INT $P
wait $P
echo "parent exit code=$? (130 expected)"
echo "processes after parent exit:"
ps -eo pid,pgid,args | grep -E 'spike-tmo-marker|sleep 300|git --no-replace|npm install' | grep -v grep | cut -c1-110
echo "(end of list)"
