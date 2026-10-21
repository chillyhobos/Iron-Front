@echo off
rem Double-click to host Iron Front from this PC: installs and builds the game when
rem needed, starts it, and can open a tunnel so friends anywhere can join.
title Iron Front
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Iron Front needs Node.js to run, and it isn't installed yet.
  echo Install the LTS version from https://nodejs.org ^(opening it now^),
  echo then double-click this file again.
  echo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

node scripts\play.mjs %*
echo.
pause
