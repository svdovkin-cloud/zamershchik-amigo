@echo off
chcp 65001 >nul
title Замеры Amigo — макет сервера

echo.
echo   Замеры Amigo — макет сервера
echo   ===============================
echo.
echo   Откройте в браузере:  http://127.0.0.1:8787/
echo   PIN:                  1234
echo.
echo   Не закрывайте это окно, пока работаете с приложением.
echo   Чтобы остановить сервер — закройте окно или нажмите Ctrl+C.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\mock-backend.ps1" -Port 8787

echo.
echo   Сервер остановлен. Закройте это окно.
pause