@echo off
rem Inicia ODISEA-IX con el servidor local sin caché y abre el navegador.
cd /d "%~dp0"
where py >nul 2>nul && (py servidor.py & goto :eof)
python servidor.py
pause
