@echo off
rem Atto Cuan v1.5.0 - satu siklus (dipanggil Task Scheduler). Kredensial dari .env, tidak dicetak.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" src\sentinel.v150.mjs >> data\cycle.log 2>&1
