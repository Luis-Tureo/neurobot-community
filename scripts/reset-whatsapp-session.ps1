$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$sessionPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'data\whatsapp-session'))

if (-not $sessionPath.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'La ruta de sesión está fuera del proyecto.'
}
if (-not (Test-Path -LiteralPath $sessionPath -PathType Container)) {
    Write-Output 'No existe una sesión local que restablecer.'
    exit 0
}

$confirmation = Read-Host 'Detén el bot. Escribe RESTABLECER para mover la sesión a una copia recuperable'
if ($confirmation -cne 'RESTABLECER') {
    Write-Output 'Operación cancelada.'
    exit 0
}

$backupName = 'whatsapp-session-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$backupPath = Join-Path (Split-Path -Parent $sessionPath) $backupName
$resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $backupPath))
if (-not $resolvedParent.StartsWith($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'La ruta de respaldo está fuera del proyecto.'
}
Move-Item -LiteralPath $sessionPath -Destination $backupPath
Write-Output "Sesión movida a $backupPath. Se solicitará un QR en el próximo inicio."
