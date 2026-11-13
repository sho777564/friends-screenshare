param([string]$Target,[switch]$NoLaunch)
$ErrorActionPreference='Stop'
$payloadRoot=Join-Path $PSScriptRoot 'payload'
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'update-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function Read-UpdateHash([string]$file){
    $stream=[IO.File]::OpenRead($file)
    $hasher=[Security.Cryptography.SHA256]::Create()
    try{return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}
    finally{$stream.Dispose();$hasher.Dispose()}
}
function Test-ClientFolder([string]$folder){
    if(-not $folder){return $false}
    $pkg=Join-Path $folder 'package.json'
    if(-not(Test-Path -LiteralPath $pkg)-or-not(Test-Path -LiteralPath (Join-Path $folder 'runtime\electron.exe'))){return $false}
    try{return (Get-Content -LiteralPath $pkg -Raw -Encoding UTF8|ConvertFrom-Json).name -eq 'friends-screen-share-desktop'}catch{return $false}
}
if(-not $Target){
    foreach($candidate in @($PSScriptRoot,(Split-Path $PSScriptRoot -Parent))){if(Test-ClientFolder $candidate){$Target=$candidate;break}}
}
if(-not $Target){
    Add-Type -AssemblyName System.Windows.Forms
    $picker=New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description='Select the existing Friends client folder containing Start-Friends.cmd and runtime.'
    if($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK){exit 1}
    $Target=$picker.SelectedPath
}
if(-not(Test-ClientFolder $Target)){throw 'This is not an existing Friends desktop client. Select the folder containing package.json and runtime\electron.exe.'}
$targetRoot=[IO.Path]::GetFullPath($Target).TrimEnd('\')
$runtimePath=Join-Path $targetRoot 'runtime\electron.exe'
$running=Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object {$_.ExecutablePath -eq $runtimePath}
if($running){throw 'Please close Friends completely, then run this updater again. Your call was left untouched.'}
$nativePath=Join-Path $targetRoot 'native\CoopInput.exe'
if(Test-Path -LiteralPath $nativePath){
    try{$nativeProbe=[IO.File]::Open($nativePath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$nativeProbe.Dispose()}
    catch{throw 'The collaboration component is still running or locked. Close Friends completely before updating; no files were changed.'}
}
$backupRoot=Join-Path $targetRoot ('.rollback\before-2.6.6-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach($entry in $manifest.files){
    $relative=$entry.path.Replace('/',[IO.Path]::DirectorySeparatorChar)
    $source=[IO.Path]::GetFullPath((Join-Path $payloadRoot $relative))
    $destination=[IO.Path]::GetFullPath((Join-Path $targetRoot $relative))
    if(-not $source.StartsWith(([IO.Path]::GetFullPath($payloadRoot)+'\'),[StringComparison]::OrdinalIgnoreCase)-or-not $destination.StartsWith(($targetRoot+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid update path.'}
    if((Read-UpdateHash $source) -ne $entry.sha256){throw ('Update file checksum mismatch: '+$relative)}
}
foreach($entry in $manifest.files){
    $relative=$entry.path.Replace('/',[IO.Path]::DirectorySeparatorChar)
    $source=Join-Path $payloadRoot $relative;$destination=Join-Path $targetRoot $relative
    if(Test-Path -LiteralPath $destination){$backup=Join-Path $backupRoot $relative;New-Item -ItemType Directory -Force -Path (Split-Path $backup -Parent)|Out-Null;Copy-Item -LiteralPath $destination -Destination $backup}
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent)|Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Force
    if((Read-UpdateHash $destination) -ne $entry.sha256){throw ('Copied file checksum mismatch: '+$relative)}
}
Write-Host 'Updated to Friends 2.6.6. Existing voice settings and the runtime were preserved.'
Write-Host ('Rollback: '+$backupRoot)
if(-not $NoLaunch){& (Join-Path $targetRoot 'Start-Friends.ps1')}
