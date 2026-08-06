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

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or
    -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'No se encontro Node.js. Ejecuta primero Instalar-Neurobot-Community.cmd.'
}

if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
    throw 'Faltan las dependencias. Ejecuta primero Instalar-Neurobot-Community.cmd.'
}

if (-not (Test-Path (Join-Path $repoRoot '.env'))) {
    Invoke-Npm -Arguments @('run', 'setup') -Description 'Creando la configuracion local'
}

if (-not (Test-Path (Join-Path $repoRoot 'dist\index.js'))) {
    Invoke-Npm -Arguments @('run', 'build') -Description 'Compilando Neurobot Community'
}

Write-Host "`nNEUROBOT COMMUNITY SE ESTA INICIANDO" -ForegroundColor Green
Write-Host 'Panel: http://127.0.0.1:3000' -ForegroundColor Yellow
Write-Host 'No cierres esta ventana mientras quieras mantener el bot activo.' -ForegroundColor Yellow
Write-Host 'Para detenerlo, presiona Ctrl+C.' -ForegroundColor Yellow

Start-Job -ScriptBlock {
    Start-Sleep -Seconds 4
    Start-Process 'http://127.0.0.1:3000'
} | Out-Null

& npm.cmd start
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Neurobot Community termino con codigo $exitCode. Revisa los mensajes anteriores."
}
