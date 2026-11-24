@echo off
chcp 65001 >nul
title KLM PDF - Membuat installer .exe
cd /d "%~dp0"
echo.
echo  =============================================
echo    KLM PDF - Membuat installer Windows (.exe)
echo  =============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [!] Node.js belum terpasang.
  echo      Unduh versi LTS dari https://nodejs.org lalu jalankan file ini lagi.
  echo.
  start https://nodejs.org/
  pause
  exit /b 1
)

echo  [1/2] Memasang bahan pembuat (sekali saja, butuh internet)...
call npm install
if errorlevel 1 goto gagal

echo.
echo  [2/2] Membuat installer...
call npm run dist
if errorlevel 1 goto gagal

echo.
echo  SELESAI! Installer ada di folder "dist":
dir /b dist\*.exe
echo.
start "" "%~dp0dist"
pause
exit /b 0

:gagal
echo.
echo  [!] Gagal membuat installer. Pastikan internet aktif lalu coba lagi.
pause
exit /b 1
