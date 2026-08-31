@echo off
title Passerelle SMS - API + Console
chcp 65001 >nul

cd /d "%~dp0api"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERREUR] Node.js n'est pas disponible dans le PATH.
    echo Installez Node.js v22.13+ puis réessayez.
    pause
    exit /b 1
)

rem ------------------------------------------------------------------
rem Variables d'environnement (valeurs par défaut si non définies)
rem   PORT_API (défaut 3250) - API
rem   PORT_WEB (défaut 3251) - console web
rem   DATA_DIR (défaut api\data)- dossier de la base de données
rem   ADMIN_PASSWORD (défaut admin) - mot de passe admin
rem ------------------------------------------------------------------
if not defined PORT_API     set PORT_API=3250
if not defined PORT_WEB     set PORT_WEB=3251
if not defined DATA_DIR     set DATA_DIR=%cd%\data
if not defined ADMIN_PASSWORD set ADMIN_PASSWORD=admin

echo Passerelle SMS - démarrage...
echo   API      : http://localhost:%PORT_API%
echo   Console  : http://localhost:%PORT_WEB%
echo   Données  : %DATA_DIR%
echo ---------------------------------------------------------

node server.js

if errorlevel 1 (
    echo.
    echo [ERREUR] L'application s'est arrêtée avec le code %errorlevel%.
    pause
)
