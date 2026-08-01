$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.env')) {
    npm run setup
}
if (-not (Test-Path -LiteralPath 'dist\index.js')) {
    npm run build
}
npm start
