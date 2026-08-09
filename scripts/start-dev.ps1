param(
    [switch]$Watch
)

$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
& chcp.com 65001 | Out-Null
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot
if (-not (Test-Path -LiteralPath '.env')) {
    npm run setup
}
$env:DEVELOPMENT_MODE = 'true'
$env:NODE_ENV = 'development'
$tsx = Join-Path $repositoryRoot 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path -LiteralPath $tsx)) {
    throw 'No se encontró tsx. Ejecuta npm install antes de iniciar el proyecto.'
}

Write-Host 'Compilando estilos Tailwind del panel...'
& npm.cmd run styles:build
if ($LASTEXITCODE -ne 0) {
    throw 'No fue posible compilar los estilos Tailwind del panel.'
}

if ($Watch) {
    & $tsx watch src/index.ts
} else {
    & $tsx src/index.ts
}
exit $LASTEXITCODE
