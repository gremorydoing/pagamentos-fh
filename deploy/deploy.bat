@echo off
chcp 65001 >nul
title Deploy Pagamentos FH

echo.
echo  Pagamentos FH - Deploy
echo  ----------------------------------------

cd /d "%~dp0.."

set "LATEST="
for /f "delims=" %%f in ('dir /b /o-d "deploy\pagamentos-fh-v*.html" 2^>nul') do (
    if not defined LATEST set "LATEST=%%f"
)

if not defined LATEST (
    echo  ERRO: Nenhum arquivo pagamentos-fh-vXX.html em deploy/
    pause
    exit /b 1
)

echo  Arquivo: %LATEST%
copy /y "deploy\%LATEST%" "index.html" >nul
echo  Copiado para index.html

git add index.html

set "MSG=%LATEST:~0,-5%"
git commit -m "%MSG%"
echo  Commit feito

echo  Enviando para o GitHub...
git push origin main

if %errorlevel%==0 (
    echo.
    echo  Pronto! Netlify atualiza em 30 segundos.
) else (
    echo  ERRO no push. Faz um Pull no VSCode e tenta de novo.
)

echo.
pause