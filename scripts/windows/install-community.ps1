$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location $repoRoot

function Invoke-Npm {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    Write-Host "`n==> $Description" -ForegroundColor Cyan
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Fallo: $Description (codigo $LASTEXITCODE)."
    }
}

Write-Host 'Instalador local de Neurobot Community' -ForegroundColor Green
Write-Host "Carpeta: $repoRoot"

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue

if (-not $nodeCommand -or -not $npmCommand) {
    throw 'No se encontro Node.js. Instala Node.js 24 o posterior y vuelve a ejecutar este archivo.'
}

$nodeVersion = (& node.exe --version).Trim().TrimStart('v')
$npmVersion = (& npm.cmd --version).Trim()
$nodeMajor = [int]($nodeVersion.Split('.')[0])
$npmMajor = [int]($npmVersion.Split('.')[0])

Write-Host "Node.js: $nodeVersion"
Write-Host "npm: $npmVersion"

if ($nodeMajor -lt 24) {
    throw "Se necesita Node.js 24 o posterior. Version detectada: $nodeVersion."
}

if ($npmMajor -lt 11) {
    throw "Se necesita npm 11 o posterior. Version detectada: $npmVersion."
}

if (-not (Test-Path (Join-Path $repoRoot 'package-lock.json'))) {
    throw 'No se encontro package-lock.json. Verifica que ejecutaste el instalador dentro del repositorio correcto.'
}

Invoke-Npm -Arguments @('ci') -Description 'Instalando dependencias exactas'
Invoke-Npm -Arguments @('run', 'setup') -Description 'Creando la configuracion local y secretos'
Invoke-Npm -Arguments @('run', 'db:init') -Description 'Preparando la base de datos'
Invoke-Npm -Arguments @('run', 'check') -Description 'Validando codigo, pruebas y compilacion'

Write-Host "`nINSTALACION COMPLETADA" -ForegroundColor Green
Write-Host 'Ahora ejecuta Iniciar-Neurobot-Community.cmd.' -ForegroundColor Yellow
Write-Host 'En el primer inicio se mostrara la contrasena temporal del panel. Guardala.' -ForegroundColor Yellow
Write-Host 'Luego abre http://127.0.0.1:3000 y vincula WhatsApp mediante el codigo QR.' -ForegroundColor Yellow
