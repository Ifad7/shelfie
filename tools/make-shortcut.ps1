# Creates a "Shelfie" button (shortcut) on the Desktop and in the Start menu.
# Clicking it starts Shelfie with its window minimised, and your browser opens on your library.
param([string[]]$Folders)

$root   = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'Shelfie-Windows.bat'
$icon   = Join-Path $root 'static\shelfie.ico'

if (-not $Folders) {
    $Folders = @(
        [Environment]::GetFolderPath('Desktop'),
        (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs')
    )
}

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in $Folders) {
    if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Path $folder -Force | Out-Null }
    $link = $shell.CreateShortcut((Join-Path $folder 'Shelfie.lnk'))
    $link.TargetPath       = $target
    $link.WorkingDirectory = $root
    $link.IconLocation     = "$icon,0"
    $link.WindowStyle      = 7          # start minimised: the black window stays out of the way
    $link.Description      = 'Shelfie - your personal library'
    $link.Save()
}
Write-Host '  Added a "Shelfie" button to your Desktop and Start menu.'
