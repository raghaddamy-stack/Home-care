@echo off
REM One-command start on Windows: installs, builds, and serves on http://localhost:3000
cd /d "%~dp0"
cd backend && call npm ci || exit /b 1
cd ..\web && call npm ci && call npm run build || exit /b 1
cd ..\backend
echo Open http://localhost:3000
call npm start
