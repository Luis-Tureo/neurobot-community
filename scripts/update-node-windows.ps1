$ErrorActionPreference = 'Stop'

$MinimumVersion = [Version]'24.18.1'
$PackageId = 'OpenJS.NodeJS.LTS'

function Get-InstalledNodeVersion {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    return $null
  }

  $rawVersion = (& node --version 2>$null).Trim().TrimStart('v')
  $parsedVersion = $null
  if ([Version]::TryParse($rawVersion, [ref]$parsedVersion)) {
    return $parsedVersion
  }

  return $null
}

$currentVersion = Get-InstalledNodeVersion
if ($null -ne $currentVersion -and $currentVersion.Major -eq 24 -and $currentVersion -ge $MinimumVersion) {
  Write-Host "Node.js $currentVersion ya es compatible con Neurobot Community." -ForegroundColor Green
  exit 0
}

if ($null -ne $currentVersion) {
  Write-Host "Node.js actual: $currentVersion. Se instalará la versión LTS compatible." -ForegroundColor Yellow
} else {
  Write-Host 'Node.js no está disponible en esta sesión. Se instalará la versión LTS compatible.' -ForegroundColor Yellow
}

if ($null -eq (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'No se encontró winget. Instala Node.js 24 LTS desde https://nodejs.org y vuelve a ejecutar npm run runtime:check.'
}

$wingetArguments = @(
  '--id', $PackageId,
  '--exact',
  '--silent',
  '--accept-package-agreements',
  '--accept-source-agreements'
)

$listedPackage = & winget list --id $PackageId --exact --accept-source-agreements 2>$null | Out-String
if ($LASTEXITCODE -eq 0 -and $listedPackage -match [Regex]::Escape($PackageId)) {
  Write-Host 'Actualizando Node.js LTS mediante winget...' -ForegroundColor Cyan
  & winget upgrade @wingetArguments
} else {
  Write-Host 'Instalando Node.js LTS mediante winget...' -ForegroundColor Cyan
  & winget install @wingetArguments
}

if ($LASTEXITCODE -ne 0) {
  throw "winget no pudo instalar o actualizar $PackageId. Código de salida: $LASTEXITCODE"
}

Write-Host ''
Write-Host 'Node.js LTS fue instalado o actualizado.' -ForegroundColor Green
Write-Host 'Cierra esta ventana de PowerShell, abre una nueva y ejecuta:' -ForegroundColor Yellow
Write-Host '  node --version'
Write-Host '  npm run runtime:check'
