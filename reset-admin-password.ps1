# Réinitialise le mot de passe admin (compte sans login, variable ADMIN_PASSWORD).
# Usage : .\reset-admin-password.ps1 [-NouveauMotDePasse "monMotDePasse"] [-Force]
param(
    [string]$NouveauMotDePasse,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile     = Join-Path $ProjectRoot '.env'
$ComposeFile = Join-Path $ProjectRoot 'docker-compose.yml'

function Get-NouveauMotDePasse {
    $new = $env:ADMIN_PASSWORD
    if (-not $new) {
        $pass1 = Read-Host -AsSecureString 'Nouveau mot de passe admin'
        $pass2 = Read-Host -AsSecureString 'Confirmez le mot de passe admin'
        $s1 = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass1))
        $s2 = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
            [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass2))
        if ($s1 -ne $s2) {
            Write-Error 'Les deux saisies ne correspondent pas.'
        }
        if ($s1.Length -lt 8) {
            Write-Error 'Le mot de passe admin doit contenir au moins 8 caractères.'
        }
        $new = $s1
    }
    return $new
}

function Set-EnvValue {
    param([string]$File, [string]$Key, [string]$Value)
    $lines = if (Test-Path $File) { @(Get-Content -LiteralPath $File) } else { @() }
    $escaped = [System.Text.RegularExpressions.Regex]::Escape($Key)
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^$escaped\s*=") {
            $lines[$i] = "$Key=$Value"
            $found = $true
        }
    }
    if (-not $found) {
        $lines += "$Key=$Value"
    }
    Set-Content -LiteralPath $File -Value $lines -Encoding UTF8
}

function Set-ComposeEnv {
    $updated = (Get-Content -LiteralPath $ComposeFile -Raw) -replace
        'ADMIN_PASSWORD=[^\r\n]*', 'ADMIN_PASSWORD=${ADMIN_PASSWORD:-CHANGEZ_MOI}'
    Set-Content -LiteralPath $ComposeFile -Value $updated -Encoding UTF8
}

# --- Vérifications préalables ---
if (-not $PsBoundParameters.ContainsKey('Force') -and (Test-Path $EnvFile) -and
    (Select-String -LiteralPath $EnvFile -Pattern '^ADMIN_PASSWORD\s*=' -Quiet)) {
    $answer = Read-Host 'Un mot de passe admin existe déjà. Le remplacer ? (o/N)'
    if ($answer -notmatch '^(o|O|oui)$') { Write-Host 'Annulé.' -ForegroundColor Yellow; exit 0 }
}

# --- Saisie / chargement du nouveau mot de passe ---
if (-not $NouveauMotDePasse) {
    $NouveauMotDePasse = Get-NouveauMotDePasse
}

# --- Application ---
Set-EnvValue -File $EnvFile -Key 'ADMIN_PASSWORD' -Value $NouveauMotDePasse
Set-ComposeEnv
Write-Host "ADMIN_PASSWORD mis à jour dans $EnvFile" -ForegroundColor Green

# --- Relance du conteneur ---
if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host 'Reconstruction du conteneur...' -ForegroundColor Cyan
    docker compose -f $ComposeFile up -d --force-recreate
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Erreur Docker. Vérifiez $ComposeFile et relancez manuellement : docker compose up -d --force-recreate" -ForegroundColor Yellow
        exit $LASTEXITCODE
    }
} else {
    Write-Host 'docker introuvable : mot de passe mis à jour, relancez le conteneur manuellement.' -ForegroundColor Yellow
}

Write-Host 'Mot de passe admin réinitialisé.' -ForegroundColor Green
